/**
 * Dates that come back every so many months, keeping a day of the month: shared by the rinnovi
 * (renewal-dates.ts) and the voci of the previsione di cassa. A day 31 is always the month's last
 * day (28/29 February, then 31 March again): the anchor day never drifts.
 */
import { addMonths } from "./dates.ts";
import { daysInMonth, isoDate } from "./italian-calendar.ts";

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
