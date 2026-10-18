/**
 * The days the scadenzario's `due` asks about (invoice-tools.ts): a range from today, a month,
 * or from/to. A month or a day written without a year is the one closest to today, within six
 * months either way: «settembre» asked in October is the one just gone, «dicembre» asked in
 * October is the coming one, «dicembre» asked in January the one just gone.
 */
import { endOfMonth, parseMonth, readDate } from "./dates.ts";
import { InvoiceError } from "./invoices.ts";
import { addDays, daysBetween, daysInMonth, isoDate, MONTH_NAMES, realDate, weekdayOf } from "./italian-calendar.ts";
import { italianDate, italianWeekday } from "./italian-format.ts";

export const RANGES = ["oggi", "settimana", "mese", "prossimi", "scadute"] as const;
export type Range = (typeof RANGES)[number];

/** Days ahead when nothing else is asked. */
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;

/**
 * The days asked. `lead` starts the summary line («Fino a domenica 25/10»). A window from today
 * (`overdue`) also shows what is overdue; a month or from/to shows only its days.
 */
export type Window = {
	readonly from?: string;
	readonly to?: string;
	readonly overdue: boolean;
	readonly label: string;
	readonly lead: string;
	/** `settimana`: instalments without a due date are only counted. */
	readonly week: boolean;
};

export type WindowArgs = { readonly range?: Range; readonly days?: number; readonly month?: string; readonly from?: string; readonly to?: string };

/** «12/10», with the year when it is not this year's. */
export function dayMonth(date: string, today: string): string {
	return date.slice(0, 4) === today.slice(0, 4) ? italianDate(date).slice(0, 5) : italianDate(date);
}

/** «lun 12/10». */
export function dayShort(date: string, today: string): string {
	return `${italianWeekday(date).slice(0, 3)} ${dayMonth(date, today)}`;
}

/** Of the years around today's, the one that puts `month` closest to today; a tie (six months either way) goes forward. */
export function closestMonthYear(month: number, today: string): number {
	const year = Number(today.slice(0, 4));
	const now = year * 12 + Number(today.slice(5, 7));
	const distance = (y: number) => y * 12 + month - now;
	return [year, year + 1, year - 1].reduce((best, y) => {
		const d = Math.abs(distance(y));
		const b = Math.abs(distance(best));
		return d < b || (d === b && y > best) ? y : best;
	});
}

/** Of the years around today's, the one that puts month-day `monthDay` («12-20») closest to today; a tie goes forward. */
export function closestYear(monthDay: string, today: string): number {
	const year = Number(today.slice(0, 4));
	let best: { year: number; days: number } | undefined;
	for (const y of [year, year + 1, year - 1]) {
		const date = `${String(y).padStart(4, "0")}-${monthDay}`;
		if (!realDate(date)) continue;
		const days = Math.abs(daysBetween(today, date));
		if (best === undefined || days < best.days || (days === best.days && y > best.year)) best = { year: y, days };
	}
	return best?.year ?? year;
}

/** The window of a `due` call; the weekday mismatches of the dates written go to `warnings`. */
export function windowOf(args: WindowArgs, today: string, warnings: string[]): Window {
	const text = (value: string | undefined) => (value !== undefined && value.trim() !== "" ? value : undefined);
	const year = Number(today.slice(0, 4));
	const month = text(args.month);
	if (month !== undefined) {
		const parsed = parseMonth(month, today);
		const y = /\d/.test(month) ? parsed.year : closestMonthYear(parsed.month, today);
		const from = isoDate(y, parsed.month, 1);
		const name = `${MONTH_NAMES[parsed.month - 1]}${y === year ? "" : ` ${y}`}`;
		const to = isoDate(y, parsed.month, daysInMonth(y, parsed.month));
		return { from, to, overdue: false, label: `Scadenze di ${name}`, lead: `${name.startsWith("a") ? "Ad" : "A"} ${name}`, week: false };
	}
	if (text(args.from) !== undefined || text(args.to) !== undefined) {
		const read = (t: string): { date: string; yearless: boolean } => {
			const first = readDate(t, today);
			// Without a year, the closest to today; read again from that year for the weekday check.
			const r = first.yearless ? readDate(t, today, { reference: `${closestYear(first.date.slice(5), today)}-01-01` }) : first;
			if (r.warning !== undefined) warnings.push(r.warning);
			return r;
		};
		const from = text(args.from) === undefined ? today : read(args.from as string).date;
		let to = addDays(from, DEFAULT_DAYS);
		if (text(args.to) !== undefined) {
			const r = read(args.to as string);
			to = r.date;
			const next = `${Number(to.slice(0, 4)) + 1}${to.slice(4)}`;
			if (to < from && r.yearless && realDate(next)) to = next;
		}
		if (to < from) throw new InvoiceError("to viene prima di from");
		const label = `Scadenze dal ${italianDate(from)} al ${italianDate(to)}`;
		return { from, to, overdue: false, label, lead: `Dal ${dayMonth(from, today)} al ${dayMonth(to, today)}`, week: false };
	}
	const until = (to: string) => `Fino a ${italianWeekday(to)} ${dayMonth(to, today)}`;
	switch (args.range) {
		case "scadute":
			return { overdue: true, label: "Fatture scadute e non segnate pagate", lead: "Scadute", week: false };
		case "oggi":
			return { from: today, to: today, overdue: true, label: "Scadenze di oggi", lead: `Oggi, ${italianWeekday(today)} ${dayMonth(today, today)}`, week: false };
		case "settimana": {
			// On a Saturday or Sunday «questa settimana» is the one coming.
			const weekday = weekdayOf(today);
			const weekend = weekday === 0 || weekday === 6;
			const sunday = addDays(today, weekday === 0 ? 7 : weekday === 6 ? 8 : 7 - weekday);
			const label = weekend ? "Scadenze della prossima settimana" : "Scadenze della settimana";
			return { from: today, to: sunday, overdue: true, label, lead: until(sunday), week: true };
		}
		case "mese": {
			const last = endOfMonth(today);
			return { from: today, to: last, overdue: true, label: "Scadenze da oggi a fine mese", lead: until(last), week: false };
		}
		default: {
			const days = args.range === "prossimi" && args.days !== undefined ? args.days : DEFAULT_DAYS;
			const to = addDays(today, days);
			return { from: today, to, overdue: true, label: `Scadenze dei prossimi ${days} giorni`, lead: until(to), week: false };
		}
	}
}
