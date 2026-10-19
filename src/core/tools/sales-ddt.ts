/**
 * The fatture in uscita and i DDT: where each DDT stands with the invoices (the draft that holds
 * it, the invoice issued that billed it, and the credit note for the wrong customer that gives it
 * back to bill), what a reso took off a DDT not billed yet, and the checks and steps of an
 * invoice that bills DDTs: under the lock (two drafts never bill the same DDT), before a number is
 * taken (annulled, billed elsewhere, changed by a reso), before the yes (the 15th of the month
 * after), and after the issue (the DDTs marked billed, once; a credit note's DDTs given back). The
 * fattura differita's own lines are in sales-ddt-source.ts. Names only inside the fences.
 */
import { findNamed } from "../client-find.ts";
import { type Ddt, DDT_LIMITS, type DdtClient, dueDayOf, type IssuedDdt, billable, isIssuedDdt } from "../ddt.ts";
import { DDT_BROKEN } from "../ddt-store.ts";
import type { ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { italianLongDate, withDate } from "../italian-format.ts";
import { spellingKey } from "../name-keys.ts";
import { CREDIT_NOTE_TYPE } from "../sales-invoice-rules.ts";
import type { SalesState } from "../sales-invoice-store.ts";
import { type DdtRef, type IssuedInvoice, isIssued, type SalesInvoice, SalesInvoiceError, type SalesLine } from "../sales-invoices.ts";
import { stockUnit } from "../stock.ts";
import { qtyOf } from "../stock-sums.ts";
import type { SalesEnv } from "./sales-invoice-env.ts";
import { fenced } from "./sales-invoice-render.ts";

/** Where the DDTs stand with the invoices: the draft that holds each, and the invoice issued that billed it. */
export type DdtInvoices = { readonly draft: ReadonlyMap<string, string>; readonly issued: ReadonlyMap<string, string>; readonly released: ReadonlySet<string> };

/**
 * The DDTs held by a draft and billed by an invoice issued, but `except`; an invoice corrected by a
 * credit note for the wrong customer, issued, bills nothing any more: its DDTs are `released`.
 */
export function ddtInvoicesOf(invoices: readonly SalesInvoice[], except?: string): DdtInvoices {
	const draft = new Map<string, string>();
	const issued = new Map<string, string>();
	const released = new Set<string>();
	const gone = new Set(invoices.filter((i) => i.type === CREDIT_NOTE_TYPE && i.release === true && isIssued(i)).map((i) => i.related?.id));
	for (const inv of invoices) {
		if (inv.id === except) continue;
		for (const d of inv.ddt ?? []) {
			if (gone.has(inv.id)) released.add(d.id);
			else if (isIssued(inv)) issued.set(d.id, inv.number);
			else draft.set(d.id, inv.id);
		}
	}
	for (const id of [...issued.keys(), ...draft.keys()]) released.delete(id);
	return { draft, issued, released };
}

/** A DDT line as a reso matches it: its voce, else its words and unit. */
export const lineKey = (l: { readonly item?: string; readonly description: string; readonly unit?: string }) => (l.item !== undefined ? `i:${l.item}` : `d:${spellingKey(l.description)}|${l.unit === undefined ? "" : stockUnit(l.unit)}`);

/** What came back of each DDT (by id): per line, the thousandths the resi issued or recorded took off it, and the resi. */
export type Returns = ReadonlyMap<string, { readonly back: ReadonlyMap<number, bigint>; readonly resi: readonly Ddt[] }>;

/** The resi issued (ours) or recorded (the client's DDT), not annulled, each taken off the lines of the DDT it names, line by matching line. */
export function returnsOf(ddts: readonly Ddt[]): Returns {
	const out = new Map<string, { back: Map<number, bigint>; resi: Ddt[] }>();
	for (const r of ddts) {
		if (r.causale !== "reso" || r.of === undefined || r.status !== "issued") continue;
		const src = ddts.find((d) => d.id === r.of);
		if (src === undefined) continue;
		const got = out.get(src.id) ?? { back: new Map<number, bigint>(), resi: [] };
		got.resi.push(r);
		for (const l of r.lines) {
			let left = qtyOf(l.qty);
			for (const s of src.lines) {
				if (left <= 0n || lineKey(s) !== lineKey(l)) continue;
				const room = qtyOf(s.qty) - (got.back.get(s.n) ?? 0n);
				const take = room < left ? room : left;
				if (take <= 0n) continue;
				got.back.set(s.n, (got.back.get(s.n) ?? 0n) + take);
				left -= take;
			}
		}
		out.set(src.id, got);
	}
	return out;
}

/** A DDT's line net of its resi, in thousandths. */
export const netOf = (d: Ddt, n: number, returns: Returns): bigint => {
	const l = d.lines.find((x) => x.n === n);
	return l === undefined ? 0n : qtyOf(l.qty) - (returns.get(d.id)?.back.get(n) ?? 0n);
};

/** Every line of the DDT came back with a reso: nothing left to bill. */
export const allBack = (d: Ddt, returns: Returns): boolean => d.lines.every((l) => netOf(d, l.n, returns) <= 0n);

/**
 * A DDT still to bill: a vendita (or a conto visione) issued, not marked billed, not in an invoice
 * issued (a mark the issue did not finish yet), not all come back with a reso.
 */
export const unbilled = (d: Ddt, with_: DdtInvoices, returns?: Returns): d is IssuedDdt => billable(d) && !with_.issued.has(d.id) && (returns === undefined || !allBack(d, returns));

/** Who a DDT's client is, to group them: the card, else the partita IVA or codice fiscale, else the name. */
export const clientKey = (c: DdtClient): string => (c.card !== undefined ? `card:${c.card}` : c.vat !== undefined ? `vat:${c.vat.replace(/^IT/, "")}` : c.cf !== undefined ? `cf:${c.cf}` : `name:${spellingKey(c.name)}`);

/** Whether a DDT's client is the invoice's customer: the same card, partita IVA or codice fiscale, or the very name. */
export function sameCustomer(c: DdtClient, k: { readonly name: string; readonly card?: string; readonly vat?: string; readonly cf?: string }): boolean {
	if (c.card !== undefined && c.card === k.card) return true;
	if (c.vat !== undefined && k.vat !== undefined) return c.vat.replace(/^IT/, "") === k.vat.replace(/^IT/, "");
	if (c.cf !== undefined && k.cf !== undefined) return c.cf.toUpperCase() === k.cf.toUpperCase();
	return spellingKey(c.name) === spellingKey(k.name);
}

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

/** «DDT n. 12/2026 del 3 ottobre»: a DDT in a sentence, the year of its date left out. */
export const ddtWords = (d: { readonly number: string; readonly date: string }): string => `DDT n. ${d.number} ${withDate("del", d.date).replace(/ \d{4}$/, "")}`;

/** Under the store's lock: the DDTs of the draft are in no other draft and no invoice issued (two drafts at once never bill the same DDT). */
export function ddtHeld(state: SalesState, ddt: readonly DdtRef[] | undefined, replace: string | undefined): void {
	if (ddt === undefined) return;
	const links = ddtInvoicesOf(state.invoices, replace);
	const taken = ddt.find((d) => links.draft.has(d.id) || links.issued.has(d.id));
	if (taken === undefined) return;
	const issued = links.issued.get(taken.id);
	throw new SalesInvoiceError(issued !== undefined ? `il DDT n. ${taken.number} è già nella fattura n. ${issued}` : `il DDT n. ${taken.number} intanto è finito in un'altra bozza: emetti quella, oppure rifai questa prendendo il suo posto`);
}

/** Whether two quantities are the same number: canonical decimals of up to three places. */
const sameQty = (a: string, b: bigint): boolean => /^\d{1,10}(?:\.\d{1,3})?$/.test(a) && qtyOf(a) === b;

/**
 * Why the draft's DDTs cannot be billed now: annulled, billed by another invoice, changed by a
 * reso since the draft (a line's quantity is no longer what is left of it). Before a number is taken.
 */
export function ddtProblem(env: SalesEnv, draft: SalesInvoice): string | undefined {
	if (draft.ddt === undefined) return undefined;
	if (env.ddt === undefined) return "Errore: qui non vedo i DDT, quindi non posso segnarli come fatturati.";
	const book = env.ddt.read();
	if (book.broken) return `Errore: ${DDT_BROKEN}.`;
	const links = ddtInvoicesOf(env.book().invoices, draft.id);
	const returns = returnsOf(book.ddts);
	for (const ref of draft.ddt) {
		const d = book.ddts.find((x) => x.id === ref.id);
		if (d === undefined || !isIssuedDdt(d) || d.status !== "issued") return `Errore: il DDT n. ${ref.number} non c'è più o è stato annullato: va rifatta la bozza. Non ho usato nessun numero.`;
		if ((d.billed !== undefined && d.billed.invoice !== draft.id) || links.issued.has(d.id)) return `Errore: il DDT n. ${ref.number} è già fatturato${d.billed === undefined ? "" : ` con la fattura n. ${d.billed.number}`}: va rifatta la bozza. Non ho usato nessun numero.`;
		const mine = draft.lines.filter((l) => l.ddt?.id === d.id);
		const changed = d.lines.some((l) => {
			const net = netOf(d, l.n, returns);
			const billed = mine.filter((x) => x.ddt?.line === l.n);
			if (net <= 0n) return billed.length > 0;
			return billed.length !== 1 || !sameQty((billed[0] as SalesLine).quantity, net);
		});
		if (changed || mine.some((l) => !d.lines.some((x) => x.n === l.ddt?.line))) return `Errore: il DDT n. ${ref.number} è cambiato da quando ho preparato la bozza (forse è arrivato un reso): va rifatta. Non ho usato nessun numero.`;
	}
	return undefined;
}

/** Before the yes: the 15th of the month after the DDTs, said plainly, and that the magazzino does not move again. */
export function ddtPreview(draft: SalesInvoice, day: string): string[] {
	if (draft.ddt === undefined || draft.ddt.length === 0) return [];
	const first = [...draft.ddt].sort((a, b) => a.date.localeCompare(b.date))[0] as DdtRef;
	const due = dueDayOf(first.date);
	const out = [`È una fattura differita (TD24) di ${n1(draft.ddt.length, "un DDT", "# DDT")}: emessa, li segno come fatturati; la merce è già uscita dal magazzino con i DDT e non la scarico di nuovo.`];
	if (day > due) out.push(`Attenzione: la fattura differita dei DDT ${withDate("del", first.date)} andava emessa entro il ${italianLongDate(due)}: oggi è in ritardo. Dillo a chi ti scrive prima del sì: forse è il caso di sentire il commercialista.`);
	else if (day === due) out.push(`Va emessa oggi, ${italianLongDate(due)}: è l'ultimo giorno.`);
	else out.push(`Va emessa entro il ${italianLongDate(due)}.`);
	return out;
}

/**
 * After the issue, once however many times this runs: the DDTs of a fattura differita marked
 * billed; the DDTs of the invoice a credit note for the wrong customer corrects given back to bill.
 * A DDT file that does not read leaves the issue to complete.
 */
export async function markDdt(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const link = env.ddt;
	if (inv.type === CREDIT_NOTE_TYPE) return releaseDdt(env, inv, ctx);
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

/** A credit note for the wrong customer of a fattura differita, issued: its DDTs to bill again, to the right customer. */
async function releaseDdt(env: SalesEnv, inv: IssuedInvoice, ctx: ToolContext): Promise<{ notes: string[]; done: boolean }> {
	const of = inv.related;
	if (inv.release !== true || of === undefined) return { notes: [], done: true };
	const link = env.ddt;
	if (link === undefined) return { notes: ["Attenzione: qui non vedo i DDT, quindi non li ho rimessi da fatturare."], done: false };
	const n = await ctx.step("ddt-release", async () => {
		if (link.read().broken) return -1;
		try {
			return link.release(of.id);
		} catch {
			return -1;
		}
	});
	if (n < 0) return { notes: ["Attenzione: i DDT non si leggono, quindi non li ho rimessi da fatturare: la nota di credito è emessa, ma l'emissione resta da completare. Quando il file è sistemato, si completa emettendola di nuovo, con lo stesso numero."], done: false };
	return { notes: [`I DDT della fattura n. ${of.number} tornano da fatturare. Ora rifai la fattura al cliente giusto come fattura differita degli stessi DDT (dicendo che rifai la fattura n. ${of.number}): così il magazzino non si scarica di nuovo.`], done: true };
}
