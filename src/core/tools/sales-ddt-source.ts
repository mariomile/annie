/**
 * La fattura differita's lines. «fai la fattura differita di ottobre per Rossi» drafts an invoice
 * (TD24, sales-invoice-draft.ts, the same draft path) with every vendita DDT of that client issued
 * in the month and not billed, nor in another draft: one line per DDT line, each pointing at its
 * DDT and line (DatiDDT in the XML), net of the resi that came back from it. A conto visione DDT
 * goes in only when the person says the client keeps the goods. Prices come from the listino (a
 * line with its voce, in the voce's unit) or from the person, goods by goods: never invented. The
 * redo of a differita sent to the wrong customer takes its very lines again. The invoice is due by
 * the 15th of the month after the DDTs. Names and descriptions only inside the fences.
 */
import { type Ddt, DDT_LIMITS, dueDayOf, isIssuedDdt, type IssuedDdt } from "../ddt.ts";
import { DDT_BROKEN } from "../ddt-store.ts";
import { n1 } from "../format-words.ts";
import { daysBetween } from "../italian-calendar.ts";
import { italianLongDate } from "../italian-format.ts";
import { spellingKey } from "../name-keys.ts";
import { type Period, PeriodError, readPeriod } from "../periods.ts";
import { listLines } from "../price-list-lines.ts";
import { DEFERRED_TYPE, FIELD_LIMITS } from "../sales-invoice-rules.ts";
import type { SalesBook } from "../sales-invoice-store.ts";
import { type DdtRef, isIssued, SALES_LIMITS } from "../sales-invoices.ts";
import { stockUnit } from "../stock.ts";
import { qtyOf, qtyText } from "../stock-sums.ts";
import { cleanText, isProblem, readAmount } from "../text-input.ts";
import { lineQty } from "./ddt-render.ts";
import { clientKey, ddtClientSaid, ddtInvoicesOf, ddtWords, type DdtInvoices, netOf, type Returns, returnsOf, unbilled } from "./sales-ddt.ts";
import { findBuyer, type Known } from "./sales-invoice-buyer.ts";
import { findIssued, type SalesEnv } from "./sales-invoice-env.ts";
import { type GivenLine, readLines } from "./sales-invoice-input.ts";
import { fenced } from "./sales-invoice-render.ts";

/** What a fattura differita's draft starts from: the customer, the lines (each with its DDT line), the DDTs, the notes. */
export type DdtSource = { readonly known: Known; readonly given: readonly GivenLine[]; readonly ddt: readonly DdtRef[]; readonly notes: readonly string[] };

const monthWords = (month: string) => italianLongDate(`${month}-01`).replace(/^1 /, "");
const monthOnly = (month: string) => monthWords(month).replace(/ \d{4}$/, "");

/** The goods a price is asked for: the same words and unit, wherever they are. */
const goodsKey = (description: string, unit: string | undefined) => `${spellingKey(description)}|${unit === undefined ? "" : stockUnit(unit)}`;

/**
 * The prices said goods by goods: [{description, unit, price}] (the unit only when the same goods
 * come in two units); a map of goods to the price as read, or the answer to give.
 */
function pricesSaid(raw: unknown, wanted: readonly { readonly description: string; readonly unit?: string }[]): Map<string, string> | string {
	const out = new Map<string, string>();
	if (raw === undefined) return out;
	if (!Array.isArray(raw) || raw.length > SALES_LIMITS.lines) return "Errore: i prezzi sono un elenco, ognuno con la merce (come te l'ho detta) e il prezzo per unità senza IVA.";
	for (const p of raw) {
		const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
		const what = cleanText(o.description, DDT_LIMITS.description, "la merce del prezzo");
		if (isProblem(what) || what === undefined) return "Errore: ogni prezzo dice la merce, come te l'ho detta, e il prezzo per unità senza IVA.";
		const unit = cleanText(o.unit, DDT_LIMITS.unit, "l'unità");
		if (isProblem(unit)) return `Errore: ${unit.problem}.`;
		const price = readAmount(o.price, 4, "il prezzo", fenced);
		if (isProblem(price)) return `Errore: ${price.problem}.`;
		if (price === undefined || Number(price) <= 0) return ["Errore: il prezzo di questa merce è un importo maggiore di zero, senza IVA:", fenced(what)].join("\n");
		const matches = [...new Set(wanted.filter((w) => spellingKey(w.description) === spellingKey(what) && (unit === undefined || (w.unit !== undefined && stockUnit(w.unit) === stockUnit(unit)))).map((w) => goodsKey(w.description, w.unit)))];
		if (matches.length > 1) return ["Questa merce è nei DDT in più unità: dimmi il prezzo per ognuna, con l'unità.", fenced(what)].join("\n");
		for (const k of matches) out.set(k, price);
	}
	return out;
}

/** The month the person said («ottobre», «mese scorso»): one month only; the answer to give otherwise. */
function monthSaid(raw: unknown, day: string): (Pick<Period, "from" | "to"> & { readonly month: string }) | string {
	let p: Period;
	try {
		p = readPeriod(String(raw), day);
	} catch (error) {
		if (error instanceof PeriodError) return `Errore: ${error.message}.`;
		throw error;
	}
	if (p.from.slice(0, 7) !== p.to.slice(0, 7)) return "Errore: la fattura differita raccoglie i DDT di un mese solo: dimmi il mese, come «ottobre».";
	return { from: p.from, to: p.to, month: p.from.slice(0, 7) };
}

/** A reso in words: «reso n. 14/2026», or the client's own DDT. */
const resoWords = (r: Ddt) => (isIssuedDdt(r) ? `reso n. ${r.number}` : `reso con il DDT del cliente n. ${r.theirs?.number ?? ""}`);

/** What the resi took off the DDTs billed, said in the fence: «Rossi ti ha reso 2 pezzi di Toner del DDT n. 12/2026 (reso n. 14/2026): li tolgo dalla fattura, così fatturo 8 pezzi.» */
function nettedNotes(picked: readonly IssuedDdt[], returns: Returns): string[] {
	const rows: string[] = [];
	for (const d of picked) {
		const got = returns.get(d.id);
		if (got === undefined) continue;
		for (const l of d.lines) {
			const back = got.back.get(l.n) ?? 0n;
			if (back <= 0n) continue;
			const net = qtyOf(l.qty) - back;
			const said = { unit: l.unit } as { readonly unit?: string };
			const resi = got.resi.filter((r) => r.lines.length > 0).map(resoWords).join(", ");
			rows.push(`${d.client.name} ti ha reso ${lineQty({ ...said, qty: qtyText(back) })} di ${l.description} del DDT n. ${d.number} (${resi}): ${net > 0n ? `li tolgo dalla fattura, così fatturo ${lineQty({ ...said, qty: qtyText(net) })}.` : "li tolgo dalla fattura, quella riga non la fatturo."}`);
		}
	}
	return rows.length === 0 ? [] : [fenced(rows.join("\n"))];
}

/**
 * The draft's source for «la fattura differita di <mese> per <cliente>»: the client's DDTs of the
 * month to bill (see above), not in another draft (but the one `replace` names). The month as
 * said, or the only month with DDTs to bill; with several, two invoices are proposed. The conto
 * visione ones asked about (kept: billed; else left out). Prices asked goods by goods.
 */
export function ddtSource(env: SalesEnv, args: Record<string, unknown>, book: SalesBook, day: string): DdtSource | string {
	if (env.ddt === undefined) return "Errore: qui non vedo i DDT: detta le voci della fattura.";
	const ddtBook = env.ddt.read();
	if (ddtBook.broken) return `Errore: ${DDT_BROKEN}.`;
	if (typeof args.customer !== "string" || args.customer.trim() === "") return "Errore: dimmi di quale cliente fare la fattura differita.";
	if (args.kept !== undefined && typeof args.kept !== "boolean") return "Errore: se il cliente tiene la merce in conto visione è sì o no.";
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const links = ddtInvoicesOf(book.invoices, replace);
	const returns = returnsOf(ddtBook.ddts);
	const open = ddtBook.ddts.filter((d) => unbilled(d, links, returns));
	const who = ddtClientSaid(args.customer.slice(0, DDT_LIMITS.name), ddtBook.ddts.filter((d) => isIssuedDdt(d) && (d.causale === "vendita" || d.causale === "conto_visione")));
	if (typeof who === "string") return who;
	if ("none" in who) return ["Non trovo DDT di vendita emessi per questo cliente:", fenced(args.customer.slice(0, DDT_LIMITS.name)), "La fattura differita raccoglie i DDT emessi: se la merce è partita senza DDT, detta le voci della fattura."].join("\n");
	const key = clientKey(who);
	const mine = open.filter((d) => clientKey(d.client) === key);
	let period: Pick<Period, "from" | "to"> & { readonly month: string };
	if (args.period !== undefined) {
		const said = monthSaid(args.period, day);
		if (typeof said === "string") return said;
		period = said;
	} else {
		const months = [...new Set(mine.filter((d) => !links.draft.has(d.id)).map((d) => d.day.slice(0, 7)))].sort();
		if (months.length > 1) return `Ha DDT da fatturare di ${months.map(monthOnly).join(" e di ")}: preparo ${n1(months.length, "una fattura differita", "# fatture differite")}, una per mese? Chiedilo a chi ti scrive: se sì, rifai la fattura con il primo mese, poi con l'altro.`;
		// None free: the latest month of those in a draft, so the answer says the draft.
		const month = months[0] ?? mine.map((d) => d.day.slice(0, 7)).sort().at(-1) ?? day.slice(0, 7);
		period = { from: `${month}-01`, to: `${month}-31`, month };
	}
	const inMonth = mine.filter((d) => d.day.slice(0, 7) === period.month && d.day >= period.from && d.day <= period.to);
	let picked = inMonth.filter((d) => !links.draft.has(d.id)).sort((a, b) => a.day.localeCompare(b.day) || a.seq - b.seq);
	const visione = picked.filter((d) => d.causale === "conto_visione");
	if (visione.length > 0 && args.kept === undefined) {
		return [
			`Tra i DDT di ${monthWords(period.month)} ${n1(visione.length, "uno è in conto visione", "# sono in conto visione")} (nel riquadro): il cliente tiene la merce (la fatturo) o la rende (si fa un DDT di reso)? Chiedilo a chi ti scrive, poi rifai la fattura dicendo se la tiene.`,
			fenced(visione.map((d) => `• ${ddtWords({ number: d.number, date: d.day })}: conto visione da ${n1(daysBetween(d.day, day), "un giorno", "# giorni")}`).join("\n")),
		].join("\n");
	}
	if (args.kept === false) picked = picked.filter((d) => d.causale !== "conto_visione");
	if (picked.length === 0) {
		const held = [...new Set(inMonth.map((d) => links.draft.get(d.id)).filter((x) => x !== undefined))];
		if (held.length > 0) return `I DDT di ${monthWords(period.month)} di questo cliente sono già in una bozza di fattura (${held.join(", ")}: non serve dirlo a chi ti scrive): emetti quella, oppure la rifaccio prendendo il suo posto.`;
		return `Nessun DDT da fatturare per questo cliente a ${monthWords(period.month)}: sono già fatturati, oppure non ce ne sono.`;
	}
	const rows = picked.flatMap((d) => d.lines.flatMap((l) => {
		const net = netOf(d, l.n, returns);
		return net <= 0n ? [] : [{ d, l, qty: qtyText(net) }];
	}));
	if (rows.length > SALES_LIMITS.lines) return `Errore: verrebbero più di ${SALES_LIMITS.lines} righe: sono troppi DDT per una fattura sola.`;
	const list = env.priceList?.read();
	const voci = list === undefined || list.broken ? [] : list.items;
	// A row priced from the listino: its voce, in the voce's own unit; any other is asked, never priced by Annie.
	const fromList = (l: Ddt["lines"][number]) => {
		const voce = l.item === undefined ? undefined : voci.find((v) => v.id === l.item);
		if (voce === undefined) return false;
		return l.unit === undefined || voce.unit === undefined || stockUnit(l.unit) === stockUnit(voce.unit);
	};
	const asked = rows.filter((r) => !fromList(r.l));
	const prices = pricesSaid(args.prices, asked.map((r) => ({ description: r.l.description, ...(r.l.unit === undefined ? {} : { unit: r.l.unit }) })));
	if (typeof prices === "string") return prices;
	const unpriced = asked.filter((r) => !prices.has(goodsKey(r.l.description, r.l.unit)));
	if (unpriced.length > 0) return pricesAsk(unpriced);
	const raw = rows.map((r) => {
		const own = prices.get(goodsKey(r.l.description, r.l.unit));
		// The person's price wins over the voce's (price-list-lines.ts: what the line gives itself).
		return { description: r.l.description.slice(0, FIELD_LIMITS.descrizione), quantity: r.qty, ...(r.l.unit === undefined ? {} : { unit: r.l.unit }), ...(r.l.item === undefined ? {} : { item: r.l.item }), ...(own === undefined ? {} : { price: own }) };
	});
	const filled = listLines({ ...(env.priceList === undefined ? {} : { priceList: env.priceList }), company: env.company, taxes: env.taxes }, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione, doc: { vat: args.vat, natura: args.natura }, keepItem: true });
	if (filled !== undefined && "ask" in filled) return filled.ask;
	const given = readLines(filled?.lines ?? raw);
	if (isProblem(given)) return `Errore: ${given.problem}.`;
	const withDdt: GivenLine[] = given.map((g, i) => {
		const r = rows[i] as (typeof rows)[number];
		return { ...g, ...(r.l.item === undefined ? {} : { item: r.l.item }), ddt: { id: r.d.id, line: r.l.n } };
	});
	const cards = env.clients?.read();
	const found = findBuyer(who.name, cards === undefined || cards.broken ? [] : cards.cards, book.invoices, { ...(who.vat === undefined ? {} : { vat: who.vat }), ...(who.cf === undefined ? {} : { cf: who.cf }) });
	const known: Known = found.kind === "exact" ? { ...found.known, name: who.name } : { name: who.name };
	const due = dueDayOf(`${period.month}-01`);
	const kept = picked.filter((d) => d.causale === "conto_visione").length;
	return {
		known,
		given: withDdt,
		ddt: picked.map((d) => ({ id: d.id, number: d.number, date: d.day })),
		notes: [
			`È la fattura differita (TD24) di ${n1(picked.length, "un DDT", "# DDT")} di ${monthWords(period.month)}: va emessa entro il ${italianLongDate(due)}, il 15 del mese dopo i DDT. I DDT li segno come fatturati quando la fattura è emessa.`,
			"La merce è già uscita dal magazzino con i DDT: la fattura non la scarica di nuovo.",
			...(kept === 0 ? [] : [`Fatturo anche ${n1(kept, "il DDT in conto visione", "i # DDT in conto visione")}: chi ti scrive ha detto che il cliente tiene la merce.`]),
			...nettedNotes(picked, returns),
			...(filled?.notes ?? []),
			...(prices.size > 0 ? ["Li metto nel listino, i prezzi che mi hai detto, così la prossima volta non te li chiedo? Se chi ti scrive dice di sì, aggiungili al listino (merce, unità e prezzo): il listino chiede la sua conferma."] : []),
			...unbilledElsewhere(open, key, period.month, links),
		],
	};
}

/** «Mi mancano 2 prezzi (per unità, senza IVA)»: the goods without a price, grouped, with where they are and how many in all. */
function pricesAsk(unpriced: readonly { readonly d: IssuedDdt; readonly l: Ddt["lines"][number]; readonly qty: string }[]): string {
	const groups = new Map<string, { description: string; unit?: string; ddts: Set<string>; qty: bigint }>();
	for (const r of unpriced) {
		const k = goodsKey(r.l.description, r.l.unit);
		const g = groups.get(k) ?? { description: r.l.description, ...(r.l.unit === undefined ? {} : { unit: r.l.unit }), ddts: new Set<string>(), qty: 0n };
		g.ddts.add(r.d.id);
		g.qty += qtyOf(r.qty);
		groups.set(k, g);
	}
	const rows = [...groups.values()].map((g) => `• ${g.description}: ${g.ddts.size > 1 ? `in ${g.ddts.size} DDT, ${lineQty({ qty: qtyText(g.qty), ...(g.unit === undefined ? {} : { unit: g.unit }) })} in tutto` : lineQty({ qty: qtyText(g.qty), ...(g.unit === undefined ? {} : { unit: g.unit }) })}`);
	return [`Mi ${n1(groups.size, "manca un prezzo", "mancano # prezzi")} (per unità, senza IVA): la merce è nel riquadro, non è nel listino. A quanto la fatturo? Chiedilo a chi ti scrive, non inventarlo, poi rifai la fattura con i prezzi, merce per merce.`, fenced(rows.join("\n"))].join("\n");
}

/** The client's DDTs to bill of other months: said, they go in their own invoice. */
function unbilledElsewhere(open: readonly IssuedDdt[], key: string, month: string, links: DdtInvoices): string[] {
	const other = open.filter((d) => clientKey(d.client) === key && d.day.slice(0, 7) !== month && !links.draft.has(d.id));
	if (other.length === 0) return [];
	const months = [...new Set(other.map((d) => d.day.slice(0, 7)))].sort().map(monthOnly);
	return [`Ha anche ${n1(other.length, "un DDT", "# DDT")} da fatturare di ${months.join(" e di ")}: preparo anche quella fattura differita, una per mese? Chiedilo a chi ti scrive.`];
}

/** The redo of a fattura differita sent to the wrong customer: its very lines (prices and DDTs), to the customer the person names. */
export type Redo = { readonly given: readonly GivenLine[]; readonly ddt: readonly DdtRef[]; readonly notes: readonly string[] };

/**
 * The fattura differita `args.redo` (its number), corrected by a credit note for the wrong customer
 * issued: its lines again, each with its DDT line, so the redo bills the same DDTs and the
 * magazzino does not move a second time. The answer to give when it cannot be redone.
 */
export function redoSource(env: SalesEnv, args: Record<string, unknown>, book: SalesBook): Redo | string {
	if (env.ddt === undefined) return "Errore: qui non vedo i DDT: detta le voci della fattura.";
	const ddtBook = env.ddt.read();
	if (ddtBook.broken) return `Errore: ${DDT_BROKEN}.`;
	const found = findIssued(book.invoices, String(args.redo)).filter((i) => i.type === DEFERRED_TYPE);
	if (found.length !== 1) return "Errore: non trovo una fattura differita emessa con quel numero (se è di un altro anno, dimmi l'anno).";
	const original = found[0] as (typeof found)[number];
	const credited = book.invoices.find((i) => i.release === true && i.related?.id === original.id);
	if (credited === undefined) return `Errore: la fattura n. ${original.number} non ha una nota di credito per il cliente sbagliato: prima va fatta quella (con il cliente sbagliato), emessa, e poi rifaccio la fattura.`;
	if (!isIssued(credited)) return `Prima va emessa la nota di credito della fattura n. ${original.number} per il cliente sbagliato: emessa quella, i DDT tornano da fatturare e rifaccio la fattura al cliente giusto.`;
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const links = ddtInvoicesOf(book.invoices, replace);
	for (const ref of original.ddt ?? []) {
		const d = ddtBook.ddts.find((x) => x.id === ref.id);
		if (d === undefined || d.status !== "issued") return `Errore: il DDT n. ${ref.number} non c'è più o è stato annullato: la fattura va rifatta dettando le voci.`;
		if (d.billed !== undefined || links.issued.has(d.id)) return `Errore: il DDT n. ${ref.number} è già fatturato di nuovo${d.billed === undefined ? "" : ` con la fattura n. ${d.billed.number}`}.`;
		if (links.draft.has(d.id)) return `I DDT della fattura n. ${original.number} sono già in una bozza di fattura (${links.draft.get(d.id) ?? ""}: non serve dirlo a chi ti scrive): emetti quella, oppure la rifaccio prendendo il suo posto.`;
	}
	const given: GivenLine[] = original.lines.map((l) => ({
		description: l.description,
		quantity: l.quantity,
		price: l.price,
		vat: l.vat,
		...(l.unit === undefined ? {} : { unit: l.unit }),
		...(l.discount === undefined ? {} : { discount: l.discount }),
		...(l.natura === undefined ? {} : { natura: l.natura }),
		...(l.reference === undefined ? {} : { reference: l.reference }),
		...(l.notFee === undefined ? {} : { notFee: l.notFee }),
		...(l.item === undefined ? {} : { item: l.item }),
		...(l.ddt === undefined ? {} : { ddt: l.ddt }),
	}));
	return { given, ddt: original.ddt ?? [], notes: [`Rifaccio la fattura n. ${original.number} al cliente giusto, come fattura differita (TD24) degli stessi DDT: stesse righe e prezzi, e il magazzino non si scarica di nuovo.`] };
}
