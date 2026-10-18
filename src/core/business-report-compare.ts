/**
 * The comparisons and the months of the business report, pure: the span a period is compared
 * with (the one before, or the same days of last year), the change of each money figure in euros
 * and percent (none when there was nothing before: never a division by zero), the biggest
 * changes, and the last months for a trend.
 */
import { type Figures, MONEY_KEYS, type MoneyKey, moneyOf, REPORT_LIMITS, type Span } from "./business-report.ts";
import { addDays, daysBetween, daysInMonth, isoDate, realDate } from "./italian-calendar.ts";
import { percentChange } from "./periods.ts";

export type Delta = { readonly key: MoneyKey; readonly now: bigint; readonly before: bigint; readonly diff: bigint; readonly percent?: string };

/**
 * «+12,5%» or «-3%» from `before` to `now`, measured on what `before` was however signed (a
 * margine that was negative and grew is a rise); undefined when `before` is zero.
 */
export function signedPercent(now: bigint, before: bigint): string | undefined {
	const base = before < 0n ? -before : before;
	return percentChange(base + (now - before), base);
}

/** The change of every money figure known in both. */
export function deltas(now: Figures, before: Figures): Delta[] {
	const out: Delta[] = [];
	for (const key of MONEY_KEYS) {
		const a = moneyOf(now, key);
		const b = moneyOf(before, key);
		if (a === undefined || b === undefined) continue;
		const percent = signedPercent(a, b);
		out.push({ key, now: a, before: b, diff: a - b, ...(percent === undefined ? {} : { percent }) });
	}
	return out;
}

/** The changes to say first: the largest in euros, either way, at most REPORT_LIMITS.biggestChanges; none that did not move. */
export function biggest(list: readonly Delta[], n: number = REPORT_LIMITS.biggestChanges): Delta[] {
	const abs = (v: bigint) => (v < 0n ? -v : v);
	return list
		.filter((d) => d.diff !== 0n)
		.slice()
		.sort((a, b) => (abs(b.diff) > abs(a.diff) ? 1 : abs(b.diff) < abs(a.diff) ? -1 : MONEY_KEYS.indexOf(a.key) - MONEY_KEYS.indexOf(b.key)))
		.slice(0, n);
}

/** A day a year back; the 29th of February is the 28th. */
export function yearBack(day: string): string {
	const back = `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
	return realDate(back) ? back : `${back.slice(0, 8)}28`;
}

/** The same days of last year. */
export function lastYearSpan(span: Span): Span {
	return { from: yearBack(span.from), to: yearBack(span.to) };
}

/** As many days as `span`, right before it: what a custom span is compared with. */
export function spanBefore(span: Span): Span {
	const days = daysBetween(span.from, span.to);
	const to = addDays(span.from, -1);
	return { from: addDays(to, -days), to };
}

/** The last `count` months to `today`, the oldest first; this month only up to today. */
export function lastMonths(today: string, count: number): Span[] {
	const out: Span[] = [];
	let year = Number(today.slice(0, 4));
	let month = Number(today.slice(5, 7));
	for (let i = 0; i < count; i++) {
		const from = isoDate(year, month, 1);
		const end = isoDate(year, month, daysInMonth(year, month));
		out.unshift({ from, to: end > today ? today : end });
		month--;
		if (month === 0) {
			month = 12;
			year--;
		}
	}
	return out;
}

/** The months of a span, each whole or cut at the span's ends, the oldest first. */
export function monthsOf(span: Span): Span[] {
	const out: Span[] = [];
	let year = Number(span.from.slice(0, 4));
	let month = Number(span.from.slice(5, 7));
	for (;;) {
		const from = isoDate(year, month, 1);
		if (from > span.to) break;
		const end = isoDate(year, month, daysInMonth(year, month));
		out.push({ from: from < span.from ? span.from : from, to: end > span.to ? span.to : end });
		month++;
		if (month === 13) {
			month = 1;
			year++;
		}
	}
	return out;
}
