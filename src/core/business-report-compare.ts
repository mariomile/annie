/**
 * The comparisons and the months of the business report, pure: the span a period is compared
 * with (the one before, or the same days of last year), the change of each money figure in euros
 * and percent (none when there was nothing before or it would mislead: never a division by
 * zero), the biggest changes, and the last months for a trend.
 */
import { type Figures, MONEY_KEYS, type MoneyKey, moneyOf, REPORT_LIMITS, type Span } from "./business-report.ts";
import { addDays, daysBetween, daysInMonth, isoDate, realDate } from "./italian-calendar.ts";
import { comparedSpans, type Period, percentChange } from "./periods.ts";
import type { Problem } from "./text-input.ts";
import { fold } from "./text-match.ts";

export type Delta = { readonly key: MoneyKey; readonly now: bigint; readonly before: bigint; readonly diff: bigint; readonly percent?: string };

/**
 * «+12,5%» or «−3%» from `before` to `now`; undefined when a percent would mislead: `before` zero
 * or below (a margine from −100 € to 1.109 € is no percent), or under a tenth of `now` either way
 * (from 10 € to 1.000 € is said in euros, never «+9.900%»).
 */
export function signedPercent(now: bigint, before: bigint): string | undefined {
	if (before <= 0n) return undefined;
	const absNow = now < 0n ? -now : now;
	if (before * 10n < absNow) return undefined;
	return percentChange(now, before);
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

/** What a figure is made of: margine of incassato and spese; what is left after taxes of those, the margine and the taxes. A figure is not said first when what it is made of already is. */
const PARENTS: Readonly<Partial<Record<MoneyKey, readonly MoneyKey[]>>> = { margine: ["incassato", "spese"], inTasca: ["incassato", "spese", "margine", "tasse"] };
const FIRST: readonly MoneyKey[] = ["fatturato", "incassato", "spese"];

/**
 * The changes to say first, at most REPORT_LIMITS.biggestChanges, none that did not move: the
 * fatturato, the incassato and the spese first, the largest in euros first; then the margine, the
 * taxes and what is left after them, only when what they are made of has not been said.
 */
export function biggest(list: readonly Delta[], n: number = REPORT_LIMITS.biggestChanges): Delta[] {
	const abs = (v: bigint) => (v < 0n ? -v : v);
	const bySize = (a: Delta, b: Delta) => (abs(b.diff) > abs(a.diff) ? 1 : abs(b.diff) < abs(a.diff) ? -1 : MONEY_KEYS.indexOf(a.key) - MONEY_KEYS.indexOf(b.key));
	const moved = list.filter((d) => d.diff !== 0n);
	const out = moved.filter((d) => FIRST.includes(d.key)).sort(bySize).slice(0, n);
	for (const d of moved.filter((x) => !FIRST.includes(x.key)).sort(bySize)) {
		if (out.length >= n) break;
		if ((PARENTS[d.key] ?? []).some((k) => out.some((o) => o.key === k))) continue;
		out.push(d);
	}
	return out;
}

export type Against = "previous" | "last_year";

/** What to compare with, as the person or the model says it: the period before (default) or the same days of last year. */
export function readAgainst(value: unknown): Against | Problem {
	if (value === undefined) return "previous";
	const t = typeof value === "string" ? fold(value).replace(/[_-]+/g, " ").trim() : "";
	if (/^(?:previous|precedente|prima|periodo precedente|mese prima|mese precedente)$/.test(t)) return "previous";
	if (/^(?:last year|anno scorso|anno prima|stesso periodo dell anno scorso|stesso periodo anno scorso)$/.test(t)) return "last_year";
	return { problem: "against è previous (il periodo prima) o last_year (lo stesso periodo dell'anno scorso)" };
}

/**
 * The two spans of a comparison. Against the period before: a period that is over against the
 * whole one before; one under way, its days so far against as many days of the one before
 * (periods.ts comparedSpans); a span of days against as many days right before it. Against last
 * year: the same days a year back. `asked`: the span asked and, when it was a period, the period.
 */
export function comparedTo(asked: { readonly span: Span; readonly period?: Period }, against: Against, today: string): { readonly now: Span; readonly before: Span } {
	if (against === "last_year") return { now: asked.span, before: lastYearSpan(asked.span) };
	if (asked.period !== undefined) {
		const c = comparedSpans(asked.period, today);
		return { now: c.now, before: c.before };
	}
	return { now: asked.span, before: spanBefore(asked.span) };
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
