/**
 * The what_if of la liquidazione IVA, read only: what paying a received invoice by a day, or a
 * purchase not made yet, moves in the period it falls in. Nothing is saved; the names it repeats
 * stay inside the IVA's fence.
 */
import { euros } from "../format-words.ts";
import { matchesParty } from "../invoices.ts";
import { addDays, MONTH_NAMES } from "../italian-calendar.ts";
import { scaled } from "../quote-sums.ts";
import { isProblem } from "../text-input.ts";
import { periodOfDay, periodSpan } from "../vat.ts";
import type { VatDoc } from "../vat-docs.ts";
import type { VatPeriod } from "../vat-rules.ts";
import { type Liquidation, periodAt, share, type VatInputs } from "../vat-sums.ts";
import { readItemAmount } from "../money-input.ts";
import { withDate } from "../italian-format.ts";
import { readDay, fenced } from "./vat-settlement-input.ts";
import { docText, ESTIMATE_NOTE, periodIn, periodOf } from "./vat-settlement-render.ts";

const RATES = ["4", "5", "10", "22"] as const;
const NOTHING_SAVED = "Non ho salvato niente.";
/** How far ahead a what_if may look: the deadlines are known about a year ahead. */
const AHEAD_DAYS = 366;

/** The rate said, one of the Italian ones; 22 when not said. */
function readRate(value: unknown): string | { problem: string } {
	if (value === undefined) return "22";
	const t = String(value).trim().replace(/%$/, "").replace(",", ".").trim();
	const n = Number(t);
	const found = RATES.find((r) => Number(r) === n);
	return t !== "" && found !== undefined ? found : { problem: "rate è l'aliquota IVA: 22, 10, 5 o 4" };
}

/** The period's amounts before and after, in words: the credit first; what is due only when one side has some. */
function compare(before: Liquidation, after: Liquidation): string[] {
	const of = `IVA ${periodOf(after.period)}`;
	const lines: string[] = [];
	if (before.credit !== after.credit) lines.push(`${of}: il credito che passa al periodo dopo va da ${euros(before.credit)} a ${euros(after.credit)}.`);
	if (before.due > 0n || after.due > 0n) lines.push(`${of}: da versare da ${euros(before.due)} a ${euros(after.due)}.`);
	if (before.under !== after.under) lines.push(`Sotto il minimo da versare, rimandato al periodo dopo: da ${euros(before.under)} a ${euros(after.under)}.`);
	if (lines.length === 0) lines.push(`${of}: non cambia niente da versare.`);
	return lines;
}

/** The inputs as of `day`'s period end when that period has not begun: its figures with what the periods before carry in. */
function asOf(i: VatInputs, day: string): VatInputs {
	const { from, to } = periodSpan(periodOfDay(day, i.periodicity));
	return from > i.today ? { ...i, today: to } : i;
}

/** «il 30 novembre»: a period's last day, without the year. */
const shortDay = (day: string) => withDate("il", day).replace(/ \d{4}$/, "");

/** «a dicembre», «al 1º trimestre 2027»: the period after `p`, the year said only when it changes. */
function nextIn(p: VatPeriod): string {
	const next: VatPeriod = p.kind === "month" ? (p.n === 12 ? { year: p.year + 1, kind: "month", n: 1 } : { ...p, n: p.n + 1 }) : p.n === 4 ? { year: p.year + 1, kind: "quarter", n: 1 } : { ...p, n: p.n + 1 };
	const year = next.year === p.year ? "" : ` ${next.year}`;
	return next.kind === "month" ? `a ${MONTH_NAMES[next.n - 1]}${year}` : `al ${next.n}º trimestre${year}`;
}

/** The received documents the person means: by supplier (name or partita IVA) and number. */
function chosen(docs: readonly VatDoc[], supplier: string | undefined, number: string | undefined): VatDoc[] {
	const same = (a: string, b: string) => a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
	return docs.filter((d) => d.side === "purchase" && !d.integration && (supplier === undefined || matchesParty(d.party, supplier)) && (number === undefined || (d.number !== undefined && same(d.number, number))));
}

/**
 * The what_if: with supplier or invoice, paying that received invoice by `date` (default the end of
 * the current period): only IVA per cassa (deferred) moves, the rest already counts when received;
 * with amount, a purchase with that imponibile at `rate` received on `date`.
 */
export function whatIf(args: Record<string, unknown>, i: VatInputs, docs: readonly VatDoc[]): string {
	for (const k of ["supplier", "invoice"] as const) if (args[k] !== undefined && (typeof args[k] !== "string" || (args[k] as string).trim() === "")) return `Errore: ${k} è un testo.`;
	const supplier = args.supplier as string | undefined;
	const number = args.invoice as string | undefined;
	const current = periodSpan(periodOfDay(i.today, i.periodicity));
	const date = readDay(args.date, i.today, "date", true) ?? current.to;
	if (isProblem(date)) return `Errore: ${date.problem}.`;
	if (date > addDays(i.today, AHEAD_DAYS)) return "Errore: date: dimmi un giorno entro un anno da oggi.";
	if (supplier !== undefined || number !== undefined) {
		if (args.amount !== undefined) return "Errore: dimmi o una fattura ricevuta (supplier, invoice) o un acquisto nuovo (amount), non tutti e due.";
		return payInvoice(i, docs, supplier, number, date, args.date !== undefined);
	}
	if (args.amount === undefined) return "Errore: dimmi la fattura ricevuta (supplier e invoice) o l'imponibile di un acquisto nuovo (amount).";
	const amount = readItemAmount(args.amount, fenced);
	if (amount === undefined || isProblem(amount)) return `Errore: ${amount === undefined ? "amount è l'imponibile in euro" : amount.problem}.`;
	const rate = readRate(args.rate);
	if (typeof rate !== "string") return `Errore: ${rate.problem}.`;
	if (date < i.today) return "Errore: date: per un acquisto nuovo dimmi un giorno da oggi in poi.";
	const taxable = scaled(amount, 2);
	const tax = share(taxable, rate);
	const doc: VatDoc = { key: "what-if", side: "purchase", source: "xml", date, received: date, credit: false, integration: false, party: { name: "acquisto ipotetico" }, rows: [{ rate, taxable, tax, esigibilita: "I" }] };
	const at = asOf(i, date);
	const before = periodAt(at, date);
	const after = periodAt({ ...at, docs: [...docs, doc] }, date);
	if (before === undefined || after === undefined) return `Errore: non riesco a calcolare il periodo di quel giorno. ${NOTHING_SAVED}`;
	return [
		`Un acquisto di ${euros(taxable)} + IVA al ${rate}% (IVA ${euros(tax)}) ricevuto ${args.date === undefined ? "entro fine periodo" : withDate("il", date)} si detrae ${periodIn(after.period)}, il periodo in cui ricevi la fattura, se l'IVA è detraibile tutta:`,
		...compare(before, after),
		`Se la fattura arriva dopo ${shortDay(after.to)}, la detrazione passa ${nextIn(after.period)}: non è un risparmio, cambia solo quando.`,
		ESTIMATE_NOTE,
		NOTHING_SAVED,
	].join("\n");
}

function payInvoice(i: VatInputs, docs: readonly VatDoc[], supplier: string | undefined, number: string | undefined, date: string, dated: boolean): string {
	const said = [number, supplier].filter((x) => x !== undefined).join(", ");
	const found = chosen(docs, supplier, number);
	if (found.length === 0) return `Non trovo una fattura ricevuta così: chiedi a chi ti scrive il fornitore e il numero.\n${fenced(said)}\n${NOTHING_SAVED}`;
	const deferred = found.filter((d) => d.paidOn === undefined && d.rows.some((r) => r.esigibilita === "D"));
	if (deferred.length === 0) {
		const one = found.length === 1 ? found[0] : undefined;
		const counted = one === undefined ? "" : ` (questa conta ${periodIn(periodOfDay(one.received ?? one.date, i.periodicity))})`;
		return [`L'IVA di queste fatture si detrae nel periodo in cui le ricevi${counted}, non quando le paghi: pagare prima o dopo non cambia la liquidazione IVA.`, fenced(found.slice(0, 5).map(docText).join("\n")), ESTIMATE_NOTE, NOTHING_SAVED].join("\n");
	}
	if (deferred.length > 1 && number === undefined) return `Di questo fornitore ci sono più fatture con IVA per cassa da pagare: chiedi a chi ti scrive quale, con il numero.\n${fenced(deferred.slice(0, 5).map(docText).join("\n"))}\n${NOTHING_SAVED}`;
	const paidDocs = docs.map((d) => (deferred.includes(d) ? { ...d, paidOn: date } : d));
	const at = asOf(i, date);
	const before = periodAt(at, date);
	const after = periodAt({ ...at, docs: paidDocs }, date);
	if (before === undefined || after === undefined) return `Errore: non riesco a calcolare il periodo di quel giorno. ${NOTHING_SAVED}`;
	const tax = deferred.reduce((n, d) => n + d.rows.filter((r) => r.esigibilita === "D").reduce((m, r) => m + (d.percent === undefined ? r.tax : share(r.tax, d.percent)), 0n), 0n);
	return [
		`Con l'IVA per cassa la detrai quando paghi: pagando ${dated ? `entro ${withDate("il", date)}` : "entro fine periodo"} detrai circa ${euros(tax)} ${periodIn(after.period)}.`,
		...compare(before, after),
		"Se paghi dopo, la detrazione passa al periodo del pagamento: cambia quando, non quanto.",
		fenced(deferred.slice(0, 5).map(docText).join("\n")),
		ESTIMATE_NOTE,
		NOTHING_SAVED,
	].join("\n");
}
