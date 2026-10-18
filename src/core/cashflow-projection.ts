/**
 * The day-by-day projection of the previsione di cassa, pure and exact (bigint cents): from the
 * starting balance, every day from today to the horizon's end adds what comes in and takes off
 * what goes out (and the average spending of a day, when counted); the balance of a day is the one
 * at its end. The lowest point is the lowest end-of-day balance (the earliest day on a tie); the
 * first day below a threshold (zero: «in rosso») is the first end-of-day balance under it. Totals
 * by direction and source, the biggest movements (the average aside), and the rows of a compact
 * table: by week, Monday to Sunday, up to WEEKLY_MAX_DAYS; by month beyond.
 */
import type { Kind } from "./cashflow.ts";
import type { Movement, Source } from "./cashflow-sources.ts";
import { addDays, daysBetween, weekdayOf } from "./italian-calendar.ts";

/** Up to this many days the table is by week; beyond, by month. */
export const WEEKLY_MAX_DAYS = 92;
export const TOP_MOVEMENTS = 3;

export type DayRow = {
	readonly date: string;
	readonly in: bigint;
	readonly out: bigint;
	/** At the end of the day. */
	readonly balance: bigint;
	/** In first, then out; each by size, largest first. */
	readonly movements: readonly Movement[];
};

export type Point = { readonly date: string; readonly balance: bigint };

export type Bucket = { readonly from: string; readonly to: string; readonly in: bigint; readonly out: bigint; readonly balance: bigint; readonly lowest: Point };

export type Projection = {
	readonly start: bigint;
	readonly from: string;
	readonly to: string;
	readonly days: readonly DayRow[];
	readonly dailySpend: bigint;
	readonly end: bigint;
	readonly lowest: Point;
	/** The first day ending below zero. */
	readonly red?: Point;
	readonly totalIn: bigint;
	readonly totalOut: bigint;
	/** By direction and source: «in:invoice», «out:average»… */
	readonly bySource: ReadonlyMap<`${Kind}:${Source}`, bigint>;
	readonly top: readonly Movement[];
};

const bySize = (a: Movement, b: Movement) => (a.cents === b.cents ? a.date.localeCompare(b.date) : a.cents > b.cents ? -1 : 1);

/**
 * The projection from `start` on `from` to `to` (both included). Movements outside the days are
 * left out; `dailySpend` (cents, may be 0) goes out every day, as source «average».
 */
export function project(start: bigint, movements: readonly Movement[], from: string, to: string, dailySpend = 0n): Projection {
	const byDay = new Map<string, Movement[]>();
	for (const m of movements) {
		if (m.date < from || m.date > to) continue;
		const list = byDay.get(m.date) ?? [];
		list.push(m);
		byDay.set(m.date, list);
	}
	const bySource = new Map<`${Kind}:${Source}`, bigint>();
	const add = (key: `${Kind}:${Source}`, cents: bigint) => bySource.set(key, (bySource.get(key) ?? 0n) + cents);
	const days: DayRow[] = [];
	let balance = start;
	let totalIn = 0n;
	let totalOut = 0n;
	let lowest: Point | undefined;
	let red: Point | undefined;
	const count = daysBetween(from, to) + 1;
	for (let i = 0; i < count; i++) {
		const date = addDays(from, i);
		const list = (byDay.get(date) ?? []).sort((a, b) => (a.kind === b.kind ? bySize(a, b) : a.kind === "in" ? -1 : 1));
		let dayIn = 0n;
		let dayOut = dailySpend;
		if (dailySpend > 0n) add("out:average", dailySpend);
		for (const m of list) {
			if (m.kind === "in") dayIn += m.cents;
			else dayOut += m.cents;
			add(`${m.kind}:${m.source}`, m.cents);
		}
		balance += dayIn - dayOut;
		totalIn += dayIn;
		totalOut += dayOut;
		days.push({ date, in: dayIn, out: dayOut, balance, movements: list });
		if (lowest === undefined || balance < lowest.balance) lowest = { date, balance };
		if (red === undefined && balance < 0n) red = { date, balance };
	}
	const top = movements.filter((m) => m.date >= from && m.date <= to && m.source !== "average").sort(bySize).slice(0, TOP_MOVEMENTS);
	return { start, from, to, days, dailySpend, end: balance, lowest: lowest ?? { date: from, balance: start }, ...(red === undefined ? {} : { red }), totalIn, totalOut, bySource, top };
}

/** The first day ending below `threshold` (cents), if any. */
export function firstBelow(p: Projection, threshold: bigint): Point | undefined {
	const day = p.days.find((d) => d.balance < threshold);
	return day === undefined ? undefined : { date: day.date, balance: day.balance };
}

/** The rows of the compact table: by week (Monday to Sunday, the first and last ones cut by the horizon) up to WEEKLY_MAX_DAYS, by month beyond. */
export function buckets(p: Projection): Bucket[] {
	const weekly = p.days.length <= WEEKLY_MAX_DAYS;
	const out: Bucket[] = [];
	let current: { from: string; to: string; in: bigint; out: bigint; balance: bigint; lowest: Point } | undefined;
	for (const d of p.days) {
		const starts = current === undefined || (weekly ? weekdayOf(d.date) === 1 : d.date.slice(8, 10) === "01");
		if (starts) {
			if (current !== undefined) out.push(current);
			current = { from: d.date, to: d.date, in: 0n, out: 0n, balance: d.balance, lowest: { date: d.date, balance: d.balance } };
		}
		const c = current as NonNullable<typeof current>;
		c.to = d.date;
		c.in += d.in;
		c.out += d.out;
		c.balance = d.balance;
		if (d.balance < c.lowest.balance) c.lowest = { date: d.date, balance: d.balance };
	}
	if (current !== undefined) out.push(current);
	return out;
}
