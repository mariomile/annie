/**
 * The arithmetic of the spese, exact: amounts are canonical decimal strings read into bigint
 * cents (quote-sums.ts' scaled), never floats; the VAT taken out of a total with a rate is rounded
 * half up to the cent, as a preventivo with prices VAT included does. And the periods asked
 * about: a month («ottobre», «2026-10»), a quarter («T3 2026») or a year («2026»), with the one
 * before to compare against. A month or quarter without a year is the closest one not to come.
 */
import { DateError, parseMonth } from "./dates.ts";
import { CATEGORIES, type Category, type Expense, ExpenseError } from "./expenses.ts";
import { closestMonthYear } from "./invoice-windows.ts";
import { addDays, daysBetween, daysInMonth, isoDate, MONTH_NAMES } from "./italian-calendar.ts";
import { scaled, type VatRate } from "./quote-sums.ts";
import { fold } from "./text-match.ts";

/** A canonical decimal string («42.5») in cents. */
export function cents(value: string): bigint {
	return scaled(value, 2);
}

/** Cents back to a canonical decimal string: 4250n → «42.5». */
export function centsValue(value: bigint): string {
	const digits = value.toString().padStart(3, "0");
	const fraction = digits.slice(-2).replace(/0+$/, "");
	const integer = digits.slice(0, -2);
	return fraction === "" ? integer : `${integer}.${fraction}`;
}

/** numerator / denominator rounded half up, both positive. */
function halfUp(numerator: bigint, denominator: bigint): bigint {
	return (numerator * 2n + denominator) / (denominator * 2n);
}

/** The VAT in a total that includes it at `rate`: total − total × 100 / (100 + rate), the imponibile rounded half up. */
export function vatInGross(gross: bigint, rate: VatRate): bigint {
	return gross - halfUp(gross * 100n, BigInt(100 + rate));
}

export type PeriodKind = "month" | "quarter" | "year";

/** A span of whole days, both ends included, with how a person names it and how a file does. */
export type Period = {
	readonly kind: PeriodKind;
	readonly from: string;
	readonly to: string;
	/** «ottobre 2026», «3º trimestre 2026», «2026». */
	readonly label: string;
	/** «2026-10», «2026-T3», «2026»: digits, «-» and «T» only, safe in a file name. */
	readonly slug: string;
};

const QUARTER = /^(?:(\d{4})\s*[- ]?\s*)?(?:t|q|trim(?:estre)?\.?\s*)\s*([1-4])(?:\s*[- /]?\s*(\d{4}))?$/;
const QUARTER_WORDS = /^(primo|secondo|terzo|quarto|[1-4]\s*(?:o|°|º)?)\s+trimestre(?:\s+(?:del\s+)?(\d{4}))?$/;
const ORDINALS: Readonly<Record<string, number>> = { primo: 1, secondo: 2, terzo: 3, quarto: 4 };

export function monthPeriod(year: number, month: number): Period {
	return {
		kind: "month",
		from: isoDate(year, month, 1),
		to: isoDate(year, month, daysInMonth(year, month)),
		label: `${MONTH_NAMES[month - 1]} ${year}`,
		slug: `${year}-${String(month).padStart(2, "0")}`,
	};
}

export function quarterPeriod(year: number, quarter: number): Period {
	const first = (quarter - 1) * 3 + 1;
	return { kind: "quarter", from: isoDate(year, first, 1), to: isoDate(year, first + 2, daysInMonth(year, first + 2)), label: `${quarter}º trimestre ${year}`, slug: `${year}-T${quarter}` };
}

export function yearPeriod(year: number): Period {
	return { kind: "year", from: isoDate(year, 1, 1), to: isoDate(year, 12, 31), label: String(year), slug: String(year) };
}

/** The period of `today`'s month. */
export function currentMonth(today: string): Period {
	return monthPeriod(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
}

const quarterOf = (date: string) => Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;

/**
 * A period as a person writes it: «ottobre», «ottobre 2025», «2026-10», «10/2026», «T3 2026»,
 * «Q3», «3° trimestre», «terzo trimestre 2026», «2026», «mese», «trimestre», «anno» (the current
 * ones). A month without a year is the closest to today (invoice-windows.ts); a quarter without a
 * year is this year's, or last year's when it has not started yet. ExpenseError otherwise.
 */
export function readPeriod(text: string, today: string): Period {
	const t = fold(text).replace(/\s+/g, " ").trim();
	const year = Number(today.slice(0, 4));
	if (t === "" || t === "mese" || t === "questo mese" || t === "mese corrente") return currentMonth(today);
	if (t === "mese scorso") return previousPeriod(currentMonth(today));
	if (t === "trimestre" || t === "questo trimestre") return quarterPeriod(year, quarterOf(today));
	if (t === "trimestre scorso") return previousPeriod(quarterPeriod(year, quarterOf(today)));
	if (t === "anno" || t === "quest'anno" || t === "anno corrente") return yearPeriod(year);
	if (t === "anno scorso") return yearPeriod(year - 1);
	const yearOnly = /^(?:anno )?(\d{4})$/.exec(t);
	if (yearOnly !== null) return checkedYear(Number(yearOnly[1]), text);
	const q = QUARTER.exec(t);
	const w = q === null ? QUARTER_WORDS.exec(t) : null;
	if (q !== null || w !== null) {
		const quarter = q !== null ? Number(q[2]) : (ORDINALS[(w as RegExpExecArray)[1] as string] ?? Number.parseInt((w as RegExpExecArray)[1] as string, 10));
		const said = q !== null ? (q[1] ?? q[3]) : (w as RegExpExecArray)[2];
		const y = said === undefined ? (quarter > quarterOf(today) ? year - 1 : year) : Number(said);
		checkedYear(y, text);
		return quarterPeriod(y, quarter);
	}
	try {
		const parsed = parseMonth(text, today);
		const y = /\d{4}/.test(t) || /^\d{1,2}[/.-]\d{2,4}$/.test(t) ? parsed.year : closestMonthYear(parsed.month, today);
		checkedYear(y, text);
		return monthPeriod(y, parsed.month);
	} catch (error) {
		if (error instanceof DateError) throw new ExpenseError(`non riconosco il periodo «${text.slice(0, 40)}»: scrivilo come «ottobre», «ottobre 2026», «T3 2026» o «2026»`);
		throw error;
	}
}

function checkedYear(year: number, text: string): Period {
	if (year < 2000 || year > 2100) throw new ExpenseError(`l'anno nel periodo «${text.slice(0, 40)}» non va: dal 2000 al 2100`);
	return yearPeriod(year);
}

/** The period before, of the same kind: September for October, T2 for T3, 2025 for 2026. */
export function previousPeriod(p: Period): Period {
	const year = Number(p.from.slice(0, 4));
	const month = Number(p.from.slice(5, 7));
	if (p.kind === "year") return yearPeriod(year - 1);
	if (p.kind === "quarter") return quarterOf(p.from) === 1 ? quarterPeriod(year - 1, 4) : quarterPeriod(year, quarterOf(p.from) - 1);
	return month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
}

export function inPeriod(date: string, p: Pick<Period, "from" | "to">): boolean {
	return date >= p.from && date <= p.to;
}

/** A span of days: the period, or the part of it up to today. */
export type Span = { readonly from: string; readonly to: string };

/**
 * What a period is compared with. A period that is over: the whole period before. One under way
 * (today inside it): its days up to today, against as many days of the one before, from its start
 * and never past its end («dal 1 al 18 ottobre» against «dal 1 al 18 settembre»).
 */
export function comparedSpans(p: Period, today: string): { readonly now: Span; readonly before: Span; readonly partial: boolean } {
	const prev = previousPeriod(p);
	if (!inPeriod(today, p) || today === p.to) return { now: { from: p.from, to: p.to }, before: { from: prev.from, to: prev.to }, partial: false };
	const days = daysBetween(p.from, today);
	const end = addDays(prev.from, days);
	return { now: { from: p.from, to: today }, before: { from: prev.from, to: end > prev.to ? prev.to : end }, partial: true };
}

export type CategoryTotal = { readonly category: Category; readonly total: bigint; readonly count: number };

export type Totals = {
	readonly count: number;
	/** The totals paid, VAT included. */
	readonly total: bigint;
	/** The VAT recorded; `withoutVat` expenses have none recorded. */
	readonly vat: bigint;
	readonly withoutVat: number;
	/** Largest first; a tie by the list's order. */
	readonly categories: readonly CategoryTotal[];
};

/** The totals of the expenses dated in `span`. */
export function totalsOf(expenses: readonly Expense[], span: Span): Totals {
	const within = expenses.filter((e) => inPeriod(e.date, span));
	const byCategory = new Map<Category, { total: bigint; count: number }>();
	let total = 0n;
	let vat = 0n;
	let withoutVat = 0;
	for (const e of within) {
		const amount = cents(e.amount);
		total += amount;
		if (e.vat === undefined) withoutVat++;
		else vat += cents(e.vat);
		const seen = byCategory.get(e.category) ?? { total: 0n, count: 0 };
		byCategory.set(e.category, { total: seen.total + amount, count: seen.count + 1 });
	}
	const categories = [...byCategory]
		.map(([category, s]) => ({ category, ...s }))
		.sort((a, b) => (a.total === b.total ? CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) : a.total > b.total ? -1 : 1));
	return { count: within.length, total, vat, withoutVat, categories };
}

/** «+12,5%» or «-3%» from `before` to `now`, to one decimal, half away from zero; undefined when before is zero. */
export function percentChange(now: bigint, before: bigint): string | undefined {
	if (before === 0n) return undefined;
	const diff = now - before;
	const abs = diff < 0n ? -diff : diff;
	const tenths = halfUp(abs * 1000n, before);
	const text = `${tenths / 10n}${tenths % 10n === 0n ? "" : `,${tenths % 10n}`}`;
	return `${diff < 0n ? "-" : "+"}${text}%`;
}
