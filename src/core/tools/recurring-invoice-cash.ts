/**
 * Le fatture ricorrenti in the previsione di cassa (ADR 0088): each recurring invoice's periods
 * up to the forecast's horizon, as money expected, until they are issued. Read only.
 *
 * Choices:
 * - The periods to draft: the one due and not drafted yet (the next sweep makes it), then those due
 *   after today, within the end month and the number of invoices; never one whose months a draft or
 *   an invoice covers, never one missed while down or paused (not made by itself), never a paused
 *   recurring invoice's.
 * - Their amount: the draft's total to pay, as sales_invoices would make it today (the listino's
 *   prices, VAT in, the cassa, the bollo when the customer pays it, the ritenuta and the split
 *   payment off, the customer's kind from the card's own partita IVA or codice fiscale). When that
 *   cannot be told (a voce gone, no regime yet) the period is not counted, and said.
 * - Their day: the due day, or today for the one due now (its draft is made today), plus the
 *   recurring invoice's payment days (default as sales_invoices', fine mese when said).
 * - The drafts made and not issued: counted as drafts to issue, at their own total to pay, due
 *   by their own terms from the day they can be issued (their due day, today at the earliest).
 *   Found by the drafts' lineage (the run's call, a draft made in its place, the same canone
 *   removed and added again), each draft once. Issued, they count among the invoices to collect.
 */
import type { ExpectedCanone } from "../cashflow-sources.ts";
import { dueDates } from "../dates.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { type ListSource, listLines } from "../price-list-lines.ts";
import { addMonths, CADENCES, dueDate, duePeriod, firstPeriod, overlaps, periodLabel, type RecurringCustomer, rangeLabel, type Schedule, within } from "../recurring-invoices.ts";
import type { RecurringBook, RecurringStore } from "../recurring-invoice-store.ts";
import { DEFAULT_PAYMENT_DAYS, FIELD_LIMITS, INVOICE_TYPE, PA_CODE, REGIME_ORDINARIO } from "../sales-invoice-rules.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type BuyerKind, isIssued, regimeOf } from "../sales-invoices.ts";
import type { TaxStore } from "../tax-store.ts";
import { isProblem } from "../text-input.ts";
import { billedFor, coveredMonths, invoiceOf, sameCustomer, type SalesReads } from "./recurring-invoice-run.ts";
import { dueOf } from "./sales-invoice-env.ts";
import { readCassa, readLines, readNatura, readRitenuta, readVatRate, withRates } from "./sales-invoice-input.ts";

/** What the canoni are read from. */
export type CanoneSources = SalesReads & {
	readonly recurring: Pick<RecurringStore, "read">;
	readonly company: Pick<InvoiceStore, "read">;
	readonly taxes?: Pick<TaxStore, "read">;
	readonly priceList?: ListSource["priceList"];
};

export type Canoni = {
	readonly expected: readonly ExpectedCanone[];
	/** Periods in the horizon whose amount cannot be told now: not counted. */
	readonly unpriced: number;
	/** The recurring invoices' file does not read: none counted. */
	readonly broken: boolean;
};

/** The canoni expected from today to `end` (see the choices above). */
export function expectedCanoni(src: CanoneSources, today: string, end: string): Canoni {
	const book = src.recurring.read();
	if (book.broken) return { expected: [], unpriced: 0, broken: true };
	const expected: ExpectedCanone[] = [...draftedCanoni(src, book, today, end)];
	let unpriced = 0;
	for (const s of book.schedules) {
		if (s.status !== "active") continue;
		const covered = coveredMonths(src, book, s);
		const toPay = canoneToPay(src, s);
		for (const period of periodsAhead(s, today, end, covered)) {
			const date = payDate(s, period, today);
			if (date > end) continue;
			if (toPay === undefined) {
				unpriced++;
				continue;
			}
			expected.push({ id: s.id, period, label: periodLabel(s, period), customer: s.customer.name, date, cents: toPay });
		}
	}
	return { expected, unpriced, broken: false };
}

/** The drafts the recurring invoices made, not issued yet, each once: by their runs, and those of the same canone removed and added again. */
function draftedCanoni(src: CanoneSources, book: RecurringBook, today: string, end: string): ExpectedCanone[] {
	const out: ExpectedCanone[] = [];
	const seen = new Set<string>();
	const take = (s: Schedule, period: string, months: number, call: string) => {
		const draft = invoiceOf(src, call);
		if (draft === undefined || isIssued(draft) || seen.has(draft.id)) return;
		seen.add(draft.id);
		const from = later(dueDate(period, s.day), today);
		const date = later(dueOf(draft, from) ?? from, today);
		if (date > end) return;
		out.push({ id: s.id, period, label: rangeLabel(period, months), customer: draft.buyer.name, date, cents: salesTotals(draft).toPay, draft: draft.id });
	};
	for (const s of book.schedules) {
		for (const r of book.runs) if (r.schedule === s.id && r.state === "drafted") take(s, r.period, r.months, r.call);
		for (const b of billedFor(src, book, s)) take(s, b.period, b.months, b.call);
	}
	return out;
}

const later = (a: string, b: string) => (a > b ? a : b);

/** The periods still to draft whose due day is up to `end`: the one due now and not drafted, then the next ones. */
function periodsAhead(s: Schedule, today: string, end: string, covered: ReadonlySet<string>): string[] {
	const out: string[] = [];
	const now = duePeriod(s, today, covered);
	if (now !== undefined) out.push(now.period);
	const step = CADENCES[s.cadence];
	for (let p = firstPeriod(s), i = 0; i < 400 && within(s, p); p = addMonths(p, step), i++) {
		const due = dueDate(p, s.day);
		if (due > end) break;
		if (due <= today || overlaps(s, p, covered)) continue;
		out.push(p);
	}
	return out;
}

/** The day the period's draft would be paid: from the day it is drafted (its due day, today for the one due now) plus the payment days of its terms. */
function payDate(s: Schedule, period: string, today: string): string {
	const day = later(dueDate(period, s.day), today);
	const days = s.terms.payment_days ?? DEFAULT_PAYMENT_DAYS;
	return dueDates(day, [days], { endOfMonth: s.terms.end_of_month === true })[0]?.date ?? day;
}

/**
 * The customer's kind as the draft would read it, from the card's own partita IVA and codice
 * fiscale too: abroad by its country or a foreign partita IVA, a public office by its 6-character
 * code (said, or of the last invoice to the same customer), a company by its partita IVA; a codice
 * fiscale alone is a private person (no ritenuta).
 */
function buyerKind(src: CanoneSources, c: RecurringCustomer): BuyerKind {
	const cards = c.card === undefined ? undefined : src.sales.clients?.read();
	const card = cards === undefined || cards.broken ? undefined : cards.cards.find((x) => x.id === c.card);
	const vat = c.vat ?? card?.vat;
	if ((c.country !== undefined && c.country !== "IT") || (vat !== undefined && /^[A-Z]{2}/i.test(vat) && !/^IT/i.test(vat))) return "foreign";
	const code = c.code ?? lastBuyer(src, c)?.code;
	if (code !== undefined && PA_CODE.test(code)) return "pa";
	return vat !== undefined ? "business" : "private";
}

/** The buyer of the newest invoice or draft to the same customer, whose code a draft takes. */
function lastBuyer(src: CanoneSources, c: RecurringCustomer) {
	const sales = src.sales.store.read();
	if (sales.broken) return undefined;
	return [...sales.invoices].reverse().find((i) => sameCustomer(src, { name: i.buyer.name, ...(i.buyer.card === undefined ? {} : { card: i.buyer.card }), ...(i.buyer.vat === undefined ? {} : { vat: i.buyer.vat }), ...(i.buyer.cf === undefined ? {} : { cf: i.buyer.cf }) }, c))?.buyer;
}

/** One period's total to pay, as the draft would have it today; undefined when it cannot be told. */
export function canoneToPay(src: CanoneSources, s: Schedule): bigint | undefined {
	const company = src.company.read();
	const taxes = src.taxes?.read();
	const profile = taxes === undefined || taxes.broken ? undefined : taxes.profile;
	const regime = regimeOf(company.broken ? undefined : company.company, profile);
	if (regime === undefined) return undefined;
	const raw = s.lines.map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)));
	const listed = listLines({ ...(src.priceList === undefined ? {} : { priceList: src.priceList }), company: src.company, ...(src.taxes === undefined ? {} : { taxes: src.taxes }) }, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione, doc: { vat: s.terms.vat, natura: s.terms.natura } });
	if (listed !== undefined && "ask" in listed) return undefined;
	const given = readLines(listed?.lines ?? raw);
	if (isProblem(given)) return undefined;
	const vat = readVatRate(s.terms.vat, "l'IVA");
	const natura = readNatura(s.terms.natura, "la natura");
	if (isProblem(vat) || isProblem(natura)) return undefined;
	const lines = withRates(given, { ...(vat === undefined ? {} : { vat }), ...(natura === undefined ? {} : { natura }) }, regime);
	if (isProblem(lines) || "missing" in lines) return undefined;
	const cassa = readCassa(s.terms.cassa);
	const sales = src.sales.store.read();
	const settings = sales.broken ? undefined : sales.settings;
	const kind = buyerKind(src, s.customer);
	// The ritenuta as said for this recurring invoice, else as the drafts to a company take it.
	const said = s.terms.ritenuta ?? (regime === REGIME_ORDINARIO && kind === "business" ? settings?.ritenutaToBusiness : undefined);
	const ritenuta = readRitenuta(said, regime, company.broken ? undefined : company.company?.cf, kind);
	const bollo = s.terms.bollo_to_client ?? settings?.bolloToClient;
	return salesTotals({
		type: INVOICE_TYPE,
		regime,
		lines,
		...(cassa === undefined || isProblem(cassa) || "missing" in cassa ? {} : { cassa }),
		...(ritenuta === undefined || isProblem(ritenuta) ? {} : { ritenuta }),
		...(bollo === undefined ? {} : { bolloToClient: bollo }),
		...(s.terms.split_payment === true ? { splitPayment: true as const } : {}),
	}).toPay;
}
