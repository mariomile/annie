/**
 * La fattura differita: the fatture in uscita and i DDT. «fai la fattura differita di ottobre per
 * Rossi» drafts an invoice (sales-invoice-draft.ts, the same draft path) with every vendita DDT of
 * that client issued in the month and not billed, nor in another draft: one line per DDT line, each
 * pointing at its DDT and line (DatiDDT in the XML). Prices come from the listino (a line with its
 * voce, in the voce's unit) or from the person, row by row: never invented. The DDTs moved the
 * magazzino when issued, so the invoice does not move it again (sales-invoice-stock.ts saleOf), and
 * the margins find the cost on the DDT's scarico. The DDTs are marked billed only when the invoice
 * is issued (a step of the issue, like the magazzino); a draft bills nothing, and removing it
 * frees them. The invoice is due by the 15th of the month after the DDTs: said at the draft and
 * before the yes. Names and descriptions only inside the fences.
 */
import { findNamed } from "../client-find.ts";
import { type Ddt, DDT_LIMITS, type DdtClient, dueDayOf, type IssuedDdt, billable, isIssuedDdt } from "../ddt.ts";
import { DDT_BROKEN } from "../ddt-store.ts";
import type { ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { italianDate, italianLongDate } from "../italian-format.ts";
import { spellingKey } from "../name-keys.ts";
import { type Period, PeriodError, readPeriod } from "../periods.ts";
import { listLines } from "../price-list-lines.ts";
import { FIELD_LIMITS } from "../sales-invoice-rules.ts";
import type { SalesBook, SalesState } from "../sales-invoice-store.ts";
import { type DdtRef, type IssuedInvoice, isIssued, SALES_LIMITS, type SalesInvoice, SalesInvoiceError } from "../sales-invoices.ts";
import { stockUnit } from "../stock.ts";
import { isProblem, readAmount } from "../text-input.ts";
import { findBuyer, type Known } from "./sales-invoice-buyer.ts";
import type { SalesEnv } from "./sales-invoice-env.ts";
import { type GivenLine, readLines } from "./sales-invoice-input.ts";
import { fenced } from "./sales-invoice-render.ts";

/** Where the DDTs stand with the invoices: the draft that holds each, and the invoice issued that billed it. */
export type DdtInvoices = { readonly draft: ReadonlyMap<string, string>; readonly issued: ReadonlyMap<string, string> };

export function ddtInvoicesOf(invoices: readonly SalesInvoice[], except?: string): DdtInvoices {
	const draft = new Map<string, string>();
	const issued = new Map<string, string>();
	for (const inv of invoices) {
		if (inv.id === except) continue;
		for (const d of inv.ddt ?? []) {
			if (isIssued(inv)) issued.set(d.id, inv.number);
			else draft.set(d.id, inv.id);
		}
	}
	return { draft, issued };
}

/** A DDT still to bill: a vendita issued, not marked billed and not in an invoice issued (a mark the issue did not finish yet). */
export const unbilled = (d: Ddt, with_: DdtInvoices): d is IssuedDdt => billable(d) && !with_.issued.has(d.id);

/** Who a DDT's client is, to group them: the card, else the partita IVA or codice fiscale, else the name. */
export const clientKey = (c: DdtClient): string => (c.card !== undefined ? `card:${c.card}` : c.vat !== undefined ? `vat:${c.vat.replace(/^IT/, "")}` : c.cf !== undefined ? `cf:${c.cf}` : `name:${spellingKey(c.name)}`);

/** The DDTs' clients (each once, the latest DDT's way of writing it): to find the one named. */
function clientsOf(ddts: readonly Ddt[]): DdtClient[] {
	const seen = new Map<string, DdtClient>();
	for (const d of [...ddts].sort((a, b) => b.id.localeCompare(a.id))) if (!seen.has(clientKey(d.client))) seen.set(clientKey(d.client), d.client);
	return [...seen.values()];
}

/** The DDT client `said` names among `ddts`', the clients' rule (client-find.ts); the answer to give otherwise. */
export function ddtClientSaid(said: string, ddts: readonly Ddt[]): DdtClient | string | { readonly none: true } {
	const clients = clientsOf(ddts);
	const r = findNamed(
		clients.map((c) => ({ item: c, names: [c.name], ...(c.vat === undefined ? {} : { vat: c.vat.replace(/^IT/, "") }), ...(c.cf === undefined ? {} : { cf: c.cf }), ...(c.card === undefined ? {} : { ids: [c.card] }) })),
		said,
		DDT_LIMITS.name,
	);
	if (r.kind === "exact") return r.item;
	if (r.kind === "close") return ["Intendi uno di questi? Non so dire quale:", fenced(r.candidates.map((c) => `• ${c.name}${c.vat === undefined ? "" : `, P.IVA ${c.vat}`}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui."].join("\n");
	return { none: true };
}

/** What a fattura differita's draft starts from: the customer, the lines (each with its DDT line), the DDTs, the notes. */
export type DdtSource = { readonly known: Known; readonly given: readonly GivenLine[]; readonly ddt: readonly DdtRef[]; readonly notes: readonly string[] };

const monthWords = (month: string) => italianLongDate(`${month}-01`).replace(/^1 /, "");

/** The prices said row by row: [{row, price}]; a map of row to the price as read, or the answer to give. */
function pricesSaid(raw: unknown): Map<number, string> | string {
	const out = new Map<number, string>();
	if (raw === undefined) return out;
	if (!Array.isArray(raw) || raw.length > SALES_LIMITS.lines) return "Errore: i prezzi sono un elenco, ognuno con la riga e il prezzo per unità senza IVA.";
	for (const p of raw) {
		const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
		if (typeof o.row !== "number" || !Number.isInteger(o.row) || o.row < 1 || o.row > SALES_LIMITS.lines) return "Errore: ogni prezzo dice la riga (il numero nel riquadro) e il prezzo per unità senza IVA.";
		const price = readAmount(o.price, 4, `riga ${o.row}, prezzo`, fenced);
		if (isProblem(price)) return `Errore: ${price.problem}.`;
		if (price === undefined || Number(price) <= 0) return `Errore: il prezzo della riga ${o.row} è un importo maggiore di zero, senza IVA.`;
		out.set(o.row, price);
	}
	return out;
}

/**
 * The draft's source for «la fattura differita di <mese> per <cliente>»: the client's vendita
 * DDTs of the month, issued, not billed, not in another draft (but the one `replace` names). The
 * month as said («ottobre», «mese scorso»), or the only month with DDTs to bill; asked when there
 * are several. A row with no voce, or not in the voce's unit, needs its price said.
 */
export function ddtSource(env: SalesEnv, args: Record<string, unknown>, book: SalesBook, day: string): DdtSource | string {
	if (env.ddt === undefined) return "Errore: qui non vedo i DDT: detta le voci della fattura.";
	const ddtBook = env.ddt.read();
	if (ddtBook.broken) return `Errore: ${DDT_BROKEN}.`;
	if (typeof args.customer !== "string" || args.customer.trim() === "") return "Errore: dimmi di quale cliente fare la fattura differita.";
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const links = ddtInvoicesOf(book.invoices, replace);
	const open = ddtBook.ddts.filter((d) => unbilled(d, links));
	const who = ddtClientSaid(args.customer.slice(0, DDT_LIMITS.name), ddtBook.ddts.filter((d) => isIssuedDdt(d) && d.causale === "vendita"));
	if (typeof who === "string") return who;
	if ("none" in who) return ["Non trovo DDT di vendita emessi per questo cliente:", fenced(args.customer.slice(0, DDT_LIMITS.name)), "La fattura differita raccoglie i DDT emessi: se la merce è partita senza DDT, detta le voci della fattura."].join("\n");
	const key = clientKey(who);
	const mine = open.filter((d) => clientKey(d.client) === key);
	let period: Pick<Period, "from" | "to"> & { readonly month: string };
	if (args.period !== undefined) {
		let p: Period;
		try {
			p = readPeriod(String(args.period), day);
		} catch (error) {
			if (error instanceof PeriodError) return `Errore: ${error.message}.`;
			throw error;
		}
		if (p.from.slice(0, 7) !== p.to.slice(0, 7)) return "Errore: la fattura differita raccoglie i DDT di un mese solo: dimmi il mese, come «ottobre».";
		period = { from: p.from, to: p.to, month: p.from.slice(0, 7) };
	} else {
		const months = [...new Set(mine.filter((d) => !links.draft.has(d.id)).map((d) => d.day.slice(0, 7)))].sort();
		if (months.length > 1) return `Questo cliente ha DDT da fatturare in più mesi (${months.map(monthWords).join(", ")}): la fattura differita è una per mese. Chiedi a chi ti scrive di quale mese, poi rifai la fattura con il mese.`;
		// None free: the latest month of those in a draft, so the answer names the draft.
		const month = months[0] ?? mine.map((d) => d.day.slice(0, 7)).sort().at(-1) ?? day.slice(0, 7);
		period = { from: `${month}-01`, to: `${month}-31`, month };
	}
	const inMonth = mine.filter((d) => d.day.slice(0, 7) === period.month && d.day >= period.from && d.day <= period.to);
	const picked = inMonth.filter((d) => !links.draft.has(d.id)).sort((a, b) => a.day.localeCompare(b.day) || a.seq - b.seq);
	if (picked.length === 0) {
		const held = [...new Set(inMonth.map((d) => links.draft.get(d.id)).filter((x) => x !== undefined))];
		if (held.length > 0) return `Errore: i DDT di ${monthWords(period.month)} di questo cliente sono già nella bozza ${held.join(", ")}: emetti quella, oppure la rifaccio prendendo il suo posto.`;
		return `Nessun DDT da fatturare per questo cliente a ${monthWords(period.month)}: sono già fatturati, oppure non ce ne sono.`;
	}
	const rows = picked.flatMap((d) => d.lines.map((l) => ({ d, l })));
	if (rows.length > SALES_LIMITS.lines) return `Errore: verrebbero più di ${SALES_LIMITS.lines} righe: sono troppi DDT per una fattura sola.`;
	const prices = pricesSaid(args.prices);
	if (typeof prices === "string") return prices;
	const list = env.priceList?.read();
	const voci = list === undefined || list.broken ? [] : list.items;
	// A row priced from the listino: its voce, in the voce's own unit; any other is asked, never priced by Annie.
	const fromList = (l: Ddt["lines"][number]) => {
		const voce = l.item === undefined ? undefined : voci.find((v) => v.id === l.item);
		if (voce === undefined) return false;
		return l.unit === undefined || voce.unit === undefined || stockUnit(l.unit) === stockUnit(voce.unit);
	};
	const unpriced = rows.map((r, i) => ({ ...r, row: i + 1 })).filter((r) => !prices.has(r.row) && !fromList(r.l));
	if (unpriced.length > 0) {
		return [
			`Per la fattura differita mi serve il prezzo per unità, senza IVA, di ${n1(unpriced.length, "una riga dei DDT che non è una voce del listino", "# righe dei DDT che non sono voci del listino")} (o non nella sua unità): nel riquadro, con il numero della riga. Chiedilo a chi ti scrive, non inventarlo, poi rifai la fattura con i prezzi riga per riga.`,
			fenced(unpriced.map((r) => `${r.row}. DDT n. ${r.d.number}: ${r.l.description}, ${r.l.qty.replace(".", ",")}${r.l.unit === undefined ? "" : ` ${r.l.unit}`}`).join("\n")),
		].join("\n");
	}
	const raw = rows.map((r, i) => {
		const own = prices.get(i + 1);
		// The person's price wins over the voce's (price-list-lines.ts: what the line gives itself).
		return { description: r.l.description.slice(0, FIELD_LIMITS.descrizione), quantity: r.l.qty, ...(r.l.unit === undefined ? {} : { unit: r.l.unit }), ...(r.l.item === undefined ? {} : { item: r.l.item }), ...(own === undefined ? {} : { price: own }) };
	});
	const filled = listLines({ ...(env.priceList === undefined ? {} : { priceList: env.priceList }), company: env.company, taxes: env.taxes }, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione, doc: { vat: args.vat, natura: args.natura }, keepItem: true });
	if (filled !== undefined && "ask" in filled) return filled.ask;
	const given = readLines(filled?.lines ?? raw);
	if (isProblem(given)) return `Errore: ${given.problem}.`;
	const withDdt: GivenLine[] = given.map((g, i) => {
		const r = rows[i] as (typeof rows)[number];
		return { ...g, ...(r.l.item === undefined ? {} : { item: r.l.item }), ddt: { id: r.d.id, line: r.l.n } };
	});
	const found = findBuyer(who.name, cardsOf(env), book.invoices, { ...(who.vat === undefined ? {} : { vat: who.vat }), ...(who.cf === undefined ? {} : { cf: who.cf }) });
	const known: Known = found.kind === "exact" ? { ...found.known, name: who.name } : { name: who.name };
	const due = dueDayOf(`${period.month}-01`);
	return {
		known,
		given: withDdt,
		ddt: picked.map((d) => ({ id: d.id, number: d.number, date: d.day })),
		notes: [
			`È la fattura differita di ${n1(picked.length, "un DDT", "# DDT")} di ${monthWords(period.month)}: va emessa entro il ${italianLongDate(due)}, il 15 del mese dopo i DDT. I DDT li segno come fatturati quando la fattura è emessa.`,
			"La merce è già uscita dal magazzino con i DDT: la fattura non la scarica di nuovo.",
			...(filled?.notes ?? []),
			...(unbilledElsewhere(open, key, period.month, links)),
		],
	};
}

function cardsOf(env: SalesEnv) {
	const book = env.clients?.read();
	return book === undefined || book.broken ? [] : book.cards;
}

/** The client's DDTs to bill of other months: said, they go in their own invoice. */
function unbilledElsewhere(open: readonly IssuedDdt[], key: string, month: string, links: DdtInvoices): string[] {
	const other = open.filter((d) => clientKey(d.client) === key && d.day.slice(0, 7) !== month && !links.draft.has(d.id));
	if (other.length === 0) return [];
	const months = [...new Set(other.map((d) => d.day.slice(0, 7)))].sort().map(monthWords);
	return [`Questo cliente ha anche ${n1(other.length, "un DDT", "# DDT")} da fatturare di ${months.join(", ")}: vanno in una fattura differita a parte, una per mese.`];
}

/** Under the store's lock: the DDTs of the draft are in no other draft and no invoice issued (two drafts at once never bill the same DDT). */
export function ddtHeld(state: SalesState, ddt: readonly DdtRef[] | undefined, replace: string | undefined): void {
	if (ddt === undefined) return;
	const links = ddtInvoicesOf(state.invoices, replace);
	const taken = ddt.find((d) => links.draft.has(d.id) || links.issued.has(d.id));
	if (taken === undefined) return;
	const issued = links.issued.get(taken.id);
	throw new SalesInvoiceError(issued !== undefined ? `il DDT n. ${taken.number} è già nella fattura n. ${issued}` : `il DDT n. ${taken.number} intanto è finito nella bozza ${links.draft.get(taken.id) ?? ""}: emetti quella, oppure rifai questa prendendo il suo posto`);
}

/** Why the draft's DDTs cannot be billed now: annulled, billed by another invoice, changed. Before a number is taken. */
export function ddtProblem(env: SalesEnv, draft: SalesInvoice): string | undefined {
	if (draft.ddt === undefined) return undefined;
	if (env.ddt === undefined) return "Errore: qui non vedo i DDT, quindi non posso segnarli come fatturati.";
	const book = env.ddt.read();
	if (book.broken) return `Errore: ${DDT_BROKEN}.`;
	const links = ddtInvoicesOf(env.book().invoices, draft.id);
	for (const ref of draft.ddt) {
		const d = book.ddts.find((x) => x.id === ref.id);
		if (d === undefined || !isIssuedDdt(d) || d.status !== "issued") return `Errore: il DDT n. ${ref.number} non c'è più o è stato annullato: va rifatta la bozza. Non ho usato nessun numero.`;
		if ((d.billed !== undefined && d.billed.invoice !== draft.id) || links.issued.has(d.id)) return `Errore: il DDT n. ${ref.number} è già fatturato${d.billed === undefined ? "" : ` con la fattura n. ${d.billed.number}`}: va rifatta la bozza. Non ho usato nessun numero.`;
		const billedLines = draft.lines.filter((l) => l.ddt?.id === d.id).map((l) => l.ddt?.line);
		if (d.lines.some((l) => !billedLines.includes(l.n))) return `Errore: il DDT n. ${ref.number} è cambiato da quando ho preparato la bozza: va rifatta. Non ho usato nessun numero.`;
	}
	return undefined;
}

/** Before the yes: the 15th of the month after the DDTs, said plainly, and that the magazzino does not move again. */
export function ddtPreview(draft: SalesInvoice, day: string): string[] {
	if (draft.ddt === undefined || draft.ddt.length === 0) return [];
	const first = [...draft.ddt].sort((a, b) => a.date.localeCompare(b.date))[0] as DdtRef;
	const due = dueDayOf(first.date);
	const out = [`È una fattura differita di ${n1(draft.ddt.length, "un DDT", "# DDT")}: emessa, li segno come fatturati; la merce è già uscita dal magazzino con i DDT e non la scarico di nuovo.`];
	if (day > due) out.push(`Attenzione: la fattura differita dei DDT del ${italianDate(first.date)} andava emessa entro il ${italianLongDate(due)}: oggi è in ritardo. Dillo a chi ti scrive prima del sì: forse è il caso di sentire il commercialista.`);
	else out.push(`Va emessa entro il ${italianLongDate(due)}.`);
	return out;
}

/** The DDTs marked billed with the invoice issued, once however many times this runs. A DDT file that does not read leaves the issue to complete. */
export async function markDdt(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const link = env.ddt;
	const refs = inv.ddt;
	if (refs === undefined || refs.length === 0) return { notes: [], done: true };
	if (link === undefined) return { notes: ["Attenzione: qui non vedo i DDT, quindi non li ho segnati come fatturati."], done: false };
	const result = await ctx.step("ddt", async () => {
		if (link.read().broken) return { broken: true, marked: 0, refused: [] as string[] };
		try {
			const r = link.markBilled(
				refs.map((d) => d.id),
				{ invoice: inv.id, number: inv.number, day: inv.date },
			);
			return { broken: false, marked: r.marked.length, refused: refs.filter((d) => r.refused.includes(d.id)).map((d) => d.number) };
		} catch {
			return { broken: true, marked: 0, refused: [] as string[] };
		}
	});
	if (result.broken) return { notes: [`Attenzione: i DDT non si leggono, quindi non li ho segnati come fatturati: la fattura è emessa, ma l'emissione resta da completare. Quando il file è sistemato, si completa emettendo di nuovo questa fattura, con lo stesso numero.`], done: false };
	const notes = [`Ho segnato come ${n1(result.marked, "fatturato il DDT", "fatturati i # DDT")} della fattura differita.`];
	if (result.refused.length > 0) notes.push(`Attenzione: ${n1(result.refused.length, `il DDT n. ${result.refused[0]} non l'ho segnato`, `i DDT n. ${result.refused.join(", ")} non li ho segnati`)}: intanto è stato annullato o fatturato con un'altra fattura. Controlla con chi ti scrive.`);
	return { notes, done: true };
}
