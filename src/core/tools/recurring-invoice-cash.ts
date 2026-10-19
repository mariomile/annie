/**
 * Le fatture ricorrenti in the previsione di cassa (ADR 0088): each active recurring invoice's
 * periods still to be drafted, up to the forecast's horizon, as money expected. Read only.
 *
 * Choices:
 * - The periods: the one due and not drafted yet (the next sweep makes it), then those due after
 *   today, within the end month and the number of invoices; never one whose months a draft or an
 *   invoice covers (the drafts' own lineage: a draft made in its place with sales_invoices too, and
 *   the same canone removed and added again), never one missed while down or paused (not made by
 *   itself), never a paused recurring invoice.
 * - The amount: the draft's total to pay, as sales_invoices would make it today (the listino's
 *   prices, VAT in, the cassa, the bollo when the customer pays it, the ritenuta and the split
 *   payment off). When that cannot be told (a voce gone, no regime yet) the period is not counted,
 *   and said.
 * - The day: the period's due day plus the recurring invoice's payment days (default as
 *   sales_invoices', fine mese when said), as the draft's due date would be.
 * - Never a customer's name: another agente reads the forecast too.
 */
import type { ExpectedCanone } from "../cashflow-sources.ts";
import { dueDates } from "../dates.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { type ListSource, listLines } from "../price-list-lines.ts";
import { addMonths, CADENCES, dueDate, duePeriod, firstPeriod, overlaps, periodLabel, type RecurringCustomer, type Schedule, within } from "../recurring-invoices.ts";
import type { RecurringStore } from "../recurring-invoice-store.ts";
import { DEFAULT_PAYMENT_DAYS, FIELD_LIMITS, INVOICE_TYPE, REGIME_ORDINARIO } from "../sales-invoice-rules.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type BuyerKind, regimeOf } from "../sales-invoices.ts";
import type { TaxStore } from "../tax-store.ts";
import { isProblem } from "../text-input.ts";
import { coveredMonths, type SalesReads } from "./recurring-invoice-run.ts";
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
	const expected: ExpectedCanone[] = [];
	let unpriced = 0;
	for (const s of book.schedules) {
		if (s.status !== "active") continue;
		const covered = coveredMonths(src, book, s);
		const toPay = canoneToPay(src, s);
		for (const period of periodsAhead(s, today, end, covered)) {
			const date = payDate(s, period);
			if (date > end) continue;
			if (toPay === undefined) {
				unpriced++;
				continue;
			}
			expected.push({ id: s.id, period, label: periodLabel(s, period), date, cents: toPay });
		}
	}
	return { expected, unpriced, broken: false };
}

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

/** The day the period's draft would be paid: its due day plus the payment days of its terms. */
function payDate(s: Schedule, period: string): string {
	const day = dueDate(period, s.day);
	const days = s.terms.payment_days ?? DEFAULT_PAYMENT_DAYS;
	return dueDates(day, [days], { endOfMonth: s.terms.end_of_month === true })[0]?.date ?? day;
}

/** The customer's kind as the draft would read it: a public office by its 6-character code, abroad by its country, a company by its partita IVA. */
function buyerKind(c: RecurringCustomer): BuyerKind {
	if (c.country !== undefined && c.country !== "IT") return "foreign";
	if (c.code?.length === 6) return "pa";
	return c.vat !== undefined || c.card !== undefined ? "business" : "private";
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
	const kind = buyerKind(s.customer);
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
