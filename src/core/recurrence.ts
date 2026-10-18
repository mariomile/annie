/**
 * Dates that come back every so many months keeping a day of the month, or every so many days (a
 * week, a fortnight): shared by the rinnovi (renewal-dates.ts, months only) and the voci of the
 * previsione di cassa. A day 31 is always the month's last day (28/29 February, then 31 March
 * again): the anchor day never drifts.
 */
import { addMonths } from "./dates.ts";
import { addDays, daysBetween, daysInMonth, isoDate } from "./italian-calendar.ts";

/** `months` after `date` (before it when negative), on day `day` of that month or its last day when shorter: the anchor day is kept, never drifts. */
export function rollDate(date: string, months: number, day: number): string {
	const first = addMonths(`${date.slice(0, 7)}-01`, months).date;
	const [year, month] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))];
	return isoDate(year, month, Math.min(day, daysInMonth(year, month)));
}

/** The dates from `from` to `until` (both included), stepping `months` from `first` on day `day`; at most 400 steps. */
export function datesBetween(first: string, months: number, day: number, from: string, until: string): string[] {
	const out: string[] = [];
	let d = first;
	for (let i = 0; d <= until && i < 400; i++) {
		if (d >= from) out.push(d);
		d = rollDate(d, months, day);
	}
	return out;
}

/** How a date comes back: every `months` months keeping day `day`, or every `days` days (a week, a fortnight). */
export type Recurrence = { readonly months: number; readonly day: number } | { readonly days: number };

/** The date one step after `date`. */
export function stepDate(date: string, r: Recurrence): string {
	return "days" in r ? addDays(date, r.days) : rollDate(date, r.months, r.day);
}

/** The dates from `from` to `until` (both included), stepping by `r` from `first`; a first date long gone is caught up without walking its whole past. */
export function recurringDates(first: string, r: Recurrence, from: string, until: string): string[] {
	if ("months" in r) {
		let start = first;
		if (first < from) {
			const gone = (Number(from.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(first.slice(5, 7));
			const steps = Math.floor(gone / r.months) - 1;
			if (steps > 0) start = rollDate(first, steps * r.months, r.day);
		}
		return datesBetween(start, r.months, r.day, from, until);
	}
	let d = first;
	if (d < from) d = addDays(d, Math.floor(daysBetween(d, from) / r.days) * r.days);
	const out: string[] = [];
	for (let i = 0; d <= until && i < 400; i++) {
		if (d >= from) out.push(d);
		d = addDays(d, r.days);
	}
	return out;
}
