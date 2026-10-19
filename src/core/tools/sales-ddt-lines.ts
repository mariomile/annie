/**
 * Goods that went out with a DDT and are invoiced another way, so the magazzino never moves twice:
 * - an invoice dictated with voci that a DDT of the customer took out already (issued, not billed,
 *   in no draft; or given back by a credit note for the wrong customer): said before the draft,
 *   with the choice of billing them as the fattura differita of that DDT (the lines point at the
 *   DDT lines: no scarico, the DDT billed at issue) or as goods apart; the same voce in another
 *   quantity or unit is asked too (a part of the DDT's goods goes the differita and reso way);
 * - the credit note for goods back with a DDT di reso of a DDT already billed: its lines priced as
 *   the invoice billed them, each pointing at the reso's line, so it does not put the goods back a
 *   second time and the margins find the cost of the DDT they went out with.
 * Names and descriptions only inside the fences.
 */
import { type Ddt, DDT_LIMITS, dueDayOf, isIssuedDdt, type IssuedDdt } from "../ddt.ts";
import { italianLongDate } from "../italian-format.ts";
import type { SalesBook } from "../sales-invoice-store.ts";
import { type DdtRef, type IssuedInvoice, isIssued } from "../sales-invoices.ts";
import { stockUnit } from "../stock.ts";
import { qtyOf, qtyText } from "../stock-sums.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { lineQty } from "./ddt-render.ts";
import { ddtInvoicesOf, ddtWords, lineKey, netOf, returnsOf, sameCustomer, unbilled } from "./sales-ddt.ts";
import type { Known } from "./sales-invoice-buyer.ts";
import type { SalesEnv } from "./sales-invoice-env.ts";
import type { GivenLine } from "./sales-invoice-input.ts";
import { fenced } from "./sales-invoice-render.ts";

/** The dictated lines bound to their DDTs, or kept apart; with what to say. */
export type Shipped = { readonly given: readonly GivenLine[]; readonly ddt?: readonly DdtRef[]; readonly notes: readonly string[] };

const QTY = /^\d{1,10}(?:\.\d{1,3})?$/;
const sameUnit = (a: string | undefined, b: string | undefined): boolean => a === undefined || b === undefined || stockUnit(a) === stockUnit(b);
const sameQty = (a: string, b: bigint): boolean => QTY.test(a) && qtyOf(a) === b;

/**
 * Lines dictated to `who`: those with a voce that a DDT took out already, in the very quantity left
 * of its line. Undefined when none (or the DDTs are not here); the question when the person did not
 * say yet (`args.shipped`: "ddt" to bind them, "apart" for other goods).
 */
export function shippedLines(env: SalesEnv, args: Record<string, unknown>, who: Known, given: readonly GivenLine[], book: SalesBook): Shipped | string | undefined {
	if (args.shipped !== undefined && args.shipped !== "ddt" && args.shipped !== "apart") return "Errore: dimmi se la merce è già partita con il DDT o se è altra merce.";
	if (env.ddt === undefined || !given.some((l) => l.item !== undefined)) return undefined;
	const book_ = env.ddt.read();
	if (book_.broken) return undefined;
	const replace = typeof args.replace === "string" ? args.replace.trim().toUpperCase() : undefined;
	const links = ddtInvoicesOf(book.invoices, replace);
	const returns = returnsOf(book_.ddts);
	const id = { name: who.name, ...((who.card?.id ?? who.previous?.card) === undefined ? {} : { card: who.card?.id ?? who.previous?.card }), ...((who.card?.vat ?? who.previous?.vat) === undefined ? {} : { vat: who.card?.vat ?? who.previous?.vat }), ...((who.card?.cf ?? who.previous?.cf) === undefined ? {} : { cf: who.card?.cf ?? who.previous?.cf }) };
	const pool = book_.ddts.filter((d): d is IssuedDdt => unbilled(d, links, returns) && !links.draft.has(d.id) && (sameCustomer(d.client, id) || links.released.has(d.id))).sort((a, b) => a.day.localeCompare(b.day) || a.seq - b.seq);
	const used = new Set<string>();
	const bound = given.map((g) => {
		if (g.item === undefined) return undefined;
		for (const d of pool)
			for (const l of d.lines) {
				const k = `${d.id}#${l.n}`;
				if (l.item !== g.item || used.has(k) || !sameUnit(g.unit, l.unit) || !sameQty(g.quantity, netOf(d, l.n, returns))) continue;
				used.add(k);
				return { d, l };
			}
		return undefined;
	});
	const found = bound.filter((b) => b !== undefined);
	// The same voce on a DDT left to bill, in another quantity or unit: always asked, never unloaded silently.
	const near = given.flatMap((g, i) => {
		if (g.item === undefined || bound[i] !== undefined) return [];
		for (const d of pool) for (const l of d.lines) if (l.item === g.item && netOf(d, l.n, returns) > 0n) return [{ g, d, l }];
		return [];
	});
	if (found.length === 0 && near.length === 0) return undefined;
	if (args.shipped === "apart") return { given, notes: ["Fatturo le voci come merce a parte, non quella partita con i DDT: emessa la fattura, la scarico dal magazzino."] };
	if (near.length > 0) {
		const rows = near.map(({ g, d, l }) => {
			const left = { ...l, qty: qtyText(netOf(d, l.n, returns)) };
			const less = sameUnit(g.unit, l.unit) && QTY.test(g.quantity) && qtyOf(g.quantity) < qtyOf(left.qty) ? `: ${lineQty({ ...left, qty: qtyText(qtyOf(left.qty) - qtyOf(g.quantity)) })} in meno` : "";
			return `• Al cliente è già partito il ${ddtWords({ number: d.number, date: d.day })} con ${lineQty(left)} di ${l.description}; in fattura ${lineQty({ qty: g.quantity, ...(g.unit === undefined ? {} : { unit: g.unit }) })}${less}`;
		});
		const ask = `${near.length === 1 ? "Una voce è" : `${near.length} voci sono`} su un DDT ancora da fatturare, ma in un'altra quantità (nel riquadro): è una parte di quella merce (allora la fattura va fatta come fattura differita del DDT, e quello che non tiene il cliente torna con un DDT di reso) o è merce diversa?`;
		if (args.shipped === "ddt") return [`${ask} Se è la merce del DDT, fai prima il DDT di reso per quello che torna, poi la fattura differita del mese del DDT: così il magazzino non si scarica due volte. Non ho preparato niente.`, fenced(rows.join("\n"))].join("\n");
		return [`${ask} Chiedilo a chi ti scrive: se è merce diversa, rifai la bozza come merce a parte; se è la merce del DDT, fai il DDT di reso e la fattura differita.`, fenced(rows.join("\n"))].join("\n");
	}
	if (args.shipped === undefined) {
		const visione = found.some((b) => b.d.causale === "conto_visione");
		return [
			`${n(found.length)} già ${found.length === 1 ? "partita" : "partite"} con un DDT, come nel riquadro: le fatturo come fattura differita di quel DDT, così non le scarico due volte dal magazzino?${visione ? " Una è in conto visione: fatturarla vuol dire che il cliente la tiene." : ""} Chiedilo a chi ti scrive: se sì, rifai la bozza legando le voci ai DDT; se è altra merce, rifalla come merce a parte.`,
			fenced(found.map((b) => `• ${lineQty(b.l)} di ${b.l.description}: già partiti con il ${ddtWords({ number: b.d.number, date: b.d.day })}`).join("\n")),
		].join("\n");
	}
	// Bound: every line left of each DDT is in the invoice, so the DDT is billed whole.
	const ddts = [...new Map(found.map((b) => [b.d.id, b.d])).values()];
	for (const d of ddts) {
		const missing = d.lines.filter((l) => netOf(d, l.n, returns) > 0n && !used.has(`${d.id}#${l.n}`));
		if (missing.length > 0) return [`Il ${ddtWords({ number: d.number, date: d.day })} ha anche altre righe che in questa fattura non ci sono (nel riquadro): per fatturarlo tutto, fai la fattura differita del suo mese, oppure detta anche quelle righe.`, fenced(missing.map((l) => `• ${lineQty({ ...l, qty: qtyText(netOf(d, l.n, returns)) })} di ${l.description}`).join("\n"))].join("\n");
	}
	const lines = given.map((g, i) => {
		const b = bound[i];
		return b === undefined ? g : { ...g, ddt: { id: b.d.id, line: b.l.n } };
	});
	const refs = [...ddts].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ id: d.id, number: d.number, date: d.day }));
	const due = dueDayOf((refs[0] as DdtRef).date);
	return {
		given: lines,
		ddt: refs,
		notes: [`È la fattura differita (TD24) di ${refs.length === 1 ? "un DDT" : `${refs.length} DDT`}: le voci legate ai DDT non scaricano il magazzino (la merce è uscita con i DDT); emessa, segno i DDT come fatturati. Va emessa entro il ${italianLongDate(due)}.`],
	};
}

const n = (count: number) => (count === 1 ? "Una voce è" : `${count} voci sono`);

/** The reso named: «14/2026» (ours) or the client's own DDT number; a reso issued or recorded, of a DDT. */
function resoNamed(raw: unknown, ddts: readonly Ddt[]): Ddt | string {
	const said = cleanText(raw, 30, "il reso");
	if (isProblem(said) || said === undefined) return "Errore: dimmi il numero del DDT di reso.";
	const t = said.trim().replace(/^(?:ddt|reso)\s*(?:di reso)?\s*(?:n\.?|numero)?\s*/i, "");
	const m = /^(\d{1,5})(?:\s*\/\s*(\d{4}))?$/.exec(t);
	const resi = ddts.filter((d) => d.causale === "reso" && d.status === "issued" && d.of !== undefined);
	const ours = m === null ? [] : resi.filter((d) => isIssuedDdt(d) && d.seq === Number(m[1]) && (m[2] === undefined || d.year === Number(m[2]))).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
	const theirs = resi.filter((d) => d.theirs !== undefined && d.theirs.number.toLowerCase() === t.toLowerCase());
	return ours[0] ?? theirs[0] ?? ["Non trovo un DDT di reso emesso o registrato con questo numero, che torni da un nostro DDT.", fenced(said.slice(0, DDT_LIMITS.name))].join("\n");
}

/** What a credit note for a reso starts from: the invoice it corrects, its lines, the notes. */
export type ResoCredit = { readonly original: IssuedInvoice; readonly given: readonly GivenLine[]; readonly notes: readonly string[] };

/**
 * The credit note for the goods of the reso `args.reso`, back from a DDT already billed: each reso
 * line priced as the invoice billed the DDT's line, never more than it billed.
 */
export function resoCredit(env: SalesEnv, args: Record<string, unknown>, book: SalesBook): ResoCredit | string {
	if (env.ddt === undefined) return "Errore: qui non vedo i DDT: detta le voci della nota di credito.";
	const ddtBook = env.ddt.read();
	if (ddtBook.broken) return "Errore: i DDT non si leggono: detta le voci della nota di credito.";
	const reso = resoNamed(args.reso, ddtBook.ddts);
	if (typeof reso === "string") return reso;
	const source = ddtBook.ddts.find((d) => d.id === reso.of);
	if (source === undefined || !isIssuedDdt(source)) return "Errore: non trovo il DDT da cui torna questo reso.";
	const billedBy = book.invoices.find((i): i is IssuedInvoice => isIssued(i) && i.type !== "TD04" && (i.ddt ?? []).some((d) => d.id === source.id) && !book.invoices.some((c) => c.release === true && c.related?.id === i.id && isIssued(c)));
	if (billedBy === undefined) return `Il DDT n. ${source.number} non è ancora fatturato: il reso si toglie dalla fattura differita del suo mese, senza nota di credito.`;
	if (book.invoices.some((i) => i.type === "TD04" && i.lines.some((l) => l.ddt?.id === reso.id))) return "Errore: per questo reso c'è già una nota di credito (o una sua bozza).";
	// What this reso took off each line of its DDT, and what the resi before it had: a reso the
	// differita already netted (the invoice billed the line less it) needs no credit note.
	const at = ddtBook.ddts.indexOf(reso);
	const before = returnsOf(ddtBook.ddts.slice(0, at)).get(source.id)?.back;
	const upTo = returnsOf(ddtBook.ddts.slice(0, at + 1)).get(source.id)?.back;
	const given: GivenLine[] = [];
	for (const src of source.lines) {
		const b0 = before?.get(src.n) ?? 0n;
		const b1 = upTo?.get(src.n) ?? 0n;
		if (b1 <= b0) continue;
		const billed = billedBy.lines.find((l) => l.ddt?.id === source.id && l.ddt.line === src.n);
		const r = reso.lines.find((x) => lineKey(x) === lineKey(src));
		if (billed === undefined || r === undefined || !QTY.test(billed.quantity)) return ["Errore: questa merce del reso non è tra le righe fatturate del DDT: detta le voci della nota di credito.", fenced(r?.description ?? src.description)].join("\n");
		const netted = qtyOf(src.qty) - qtyOf(billed.quantity);
		const from = b0 > netted ? b0 : netted;
		const qty = b1 - from;
		if (qty <= 0n) continue;
		given.push({
			description: billed.description,
			quantity: qtyText(qty),
			price: billed.price,
			vat: billed.vat,
			...(billed.unit === undefined ? {} : { unit: billed.unit }),
			...(billed.discount === undefined ? {} : { discount: billed.discount }),
			...(billed.natura === undefined ? {} : { natura: billed.natura }),
			...(billed.reference === undefined ? {} : { reference: billed.reference }),
			...(billed.item === undefined ? {} : { item: billed.item }),
			ddt: { id: reso.id, line: r.n },
		});
	}
	if (given.length === 0) return `Questo reso l'ho già tolto dalla fattura n. ${billedBy.number} (la fattura differita l'ha fatturato al netto del reso): non serve una nota di credito.`;
	const what = isIssuedDdt(reso) ? `il reso n. ${reso.number}` : `il reso con il DDT del cliente n. ${reso.theirs?.number ?? ""}`;
	return { original: billedBy, given, notes: [`È la nota di credito della merce tornata con ${what}, ai prezzi della fattura n. ${billedBy.number}: la merce è già rientrata in magazzino con il reso, la nota di credito non la rimette una seconda volta.`] };
}
