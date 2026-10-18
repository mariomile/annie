/**
 * The taxes of a span of the business report, an estimate to check with the commercialista, from
 * the modules that already estimate them and never on their own:
 *
 * - forfettario with a tax profile (taxes.ts): each year's estimate (tax-sums.ts yearEstimate), as a
 *   share of each incasso: the span's incassi in that year × the year's imposta and contributi /
 *   the year's incassi, half up. This year is projected to its end, as the taxes tool does (the
 *   fixed contributions of a whole year never fall on the first incassi alone); past years on
 *   their incassi. A span over two years takes each year's own share.
 * - ordinario: the IVA a debito less the IVA a credito of the span's documents (vat-sums.ts on
 *   vat-docs.ts, the person's deductibility marks included); IRPEF and contributions are not
 *   estimated. A credit is no tax to put aside: zero, and said.
 * - anything else: not estimated, and why (no regime, no profile, a register that does not read).
 */
import type { Span, TaxPart } from "./business-report.ts";
import { cashBook } from "./cash-book.ts";
import type { Invoice } from "./invoices.ts";
import { halfUp } from "./quote-sums.ts";
import type { TaxProfile, YearFigures } from "./taxes.ts";
import { type CalendarInputs, yearEstimate, yearIncassi } from "./tax-sums.ts";
import type { VatDoc } from "./vat-docs.ts";
import { figuresOf } from "./vat-sums.ts";

/** What the taxes are estimated from: the regime and, for the forfettario, the profile. */
export type TaxSetting =
	| { readonly kind: "forfettario"; readonly profile: TaxProfile; readonly years: readonly YearFigures[] }
	| { readonly kind: "ordinario" }
	| { readonly kind: "none"; readonly why: "no_regime" | "no_profile" | "unreadable_taxes" | "unreadable_vat" };

export type TaxSources = {
	readonly tax: TaxSetting;
	/** The scadenzario; undefined when it does not read. */
	readonly invoices?: readonly Invoice[];
	/** The documents of la liquidazione IVA; undefined when no register of invoices reads. */
	readonly docs?: readonly VatDoc[];
	readonly today: string;
	readonly dayOf: (at: string) => string;
};

/** The years a span touches, each with the part of the span inside it. */
function yearParts(span: Span): { readonly year: number; readonly from: string; readonly to: string }[] {
	const parts: { year: number; from: string; to: string }[] = [];
	for (let year = Number(span.from.slice(0, 4)); year <= Number(span.to.slice(0, 4)); year++) {
		const from = `${year}-01-01` > span.from ? `${year}-01-01` : span.from;
		const to = `${year}-12-31` < span.to ? `${year}-12-31` : span.to;
		parts.push({ year, from, to });
	}
	return parts;
}

function forfettario(s: TaxSources & { readonly invoices: readonly Invoice[] }, setting: Extract<TaxSetting, { kind: "forfettario" }>, span: Span): TaxPart {
	const inputs: CalendarInputs = { profile: setting.profile, figures: setting.years, incassi: yearIncassi(s.invoices, s.today, s.dayOf), today: s.today };
	let cents = 0n;
	let percent: number | undefined;
	const current = Number(s.today.slice(0, 4));
	for (const part of yearParts(span)) {
		// This year's share as the taxes tool takes it: on the year projected to its end, so a year's fixed contributions are not all put on the incassi so far; past years on their incassi.
		const e = part.year === current ? yearEstimate(inputs, part.year) : yearEstimate(inputs, part.year, inputs.incassi(part.year).cents);
		if (e.incassi <= 0n) continue;
		// The same incassi the taxes count: the cash book's, by the day paid.
		const inPart = cashBook(s.invoices, [], part, s.dayOf).totalIn;
		cents += halfUp(inPart * e.total, e.incassi);
		if (e.setAsidePercent !== undefined) percent = e.setAsidePercent;
	}
	return { kind: "forfettario", cents, ...(percent === undefined ? {} : { percent }) };
}

/** The taxes to put aside for `span` (see above). */
export function taxesIn(s: TaxSources, span: Span): TaxPart {
	const setting = s.tax;
	if (setting.kind === "none") return { kind: "none", why: setting.why };
	if (setting.kind === "forfettario") {
		const invoices = s.invoices;
		return invoices === undefined ? { kind: "none", why: "unreadable_invoices" } : forfettario({ ...s, invoices }, setting, span);
	}
	if (s.docs === undefined) return { kind: "none", why: "unreadable_invoices" };
	const f = figuresOf(s.docs, span.from, span.to);
	const net = f.debito - f.credito;
	return { kind: "iva", cents: net > 0n ? net : 0n, credit: net < 0n };
}
