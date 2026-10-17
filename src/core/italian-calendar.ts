/**
 * The Italian calendar's primitives, shared by the tools that reason on days: Easter, the
 * national holidays, adding days and today's date in a time zone. Dates are YYYY-MM-DD strings
 * read as UTC midnights, so no daylight saving change ever moves a day.
 */
import { localMinute } from "./cron.ts";

const DAY_MS = 86_400_000;

/** Easter Sunday of a Gregorian year (the anonymous Gregorian computus), YYYY-MM-DD. */
export function easterSunday(year: number): string {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return isoDate(year, month, day);
}

export function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`: negative when `to` comes first. */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** YYYY-MM-DD that exists (no 30 February). */
export function realDate(date: string): boolean {
	const parsed = Date.parse(`${date}T00:00:00Z`);
	return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

/** 0 is Sunday, 6 Saturday. */
export function weekdayOf(date: string): number {
	return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function weekend(date: string): boolean {
	const weekday = weekdayOf(date);
	return weekday === 0 || weekday === 6;
}

export function leapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 1 to 12 → 28 to 31. */
export function daysInMonth(year: number, month: number): number {
	return month === 2 ? (leapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 2026, 3, 5 → 2026-03-05. */
export function isoDate(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Today's date in `timeZone`, YYYY-MM-DD, with cron's cached formatter. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
	return localMinute(now, timeZone).slice(0, 10);
}

/** The months' Italian names, January first. */
export const MONTH_NAMES = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"] as const;

export type Holiday = { readonly date: string; readonly name: string };

/**
 * The first year the holidays below are right for: 2 June has been a holiday on its own day again
 * only since 2001, and the calendars before (Epifania off from 1977 to 1985, the older religious
 * holidays) differed.
 */
export const HOLIDAYS_SINCE = 2001;

/** The fixed national holidays (law 260/1949 as amended), month-day and name. */
const FIXED_HOLIDAYS: readonly (readonly [string, string])[] = [
	["01-01", "Capodanno"],
	["01-06", "Epifania"],
	["04-25", "Festa della Liberazione"],
	["05-01", "Festa del Lavoro"],
	["06-02", "Festa della Repubblica"],
	["08-15", "Ferragosto"],
	["11-01", "Ognissanti"],
	["12-08", "Immacolata Concezione"],
	["12-25", "Natale"],
	["12-26", "Santo Stefano"],
];

/** San Francesco d'Assisi, patron of Italy: a national holiday again from 2026 (law 151/2025). */
const SAN_FRANCESCO_SINCE = 2026;

/**
 * Italy's national holidays of `year` in date order, 4 October from 2026: right from
 * HOLIDAYS_SINCE on, and callers keep to those years. A `patrono` (MM-DD) adds the local patron
 * saint's day, unless it is already a holiday.
 */
export function italianHolidays(year: number, patrono?: string): Holiday[] {
	const easter = easterSunday(year);
	const prefix = String(year).padStart(4, "0");
	const fixed = FIXED_HOLIDAYS.map(([monthDay, name]) => ({ date: `${prefix}-${monthDay}`, name }));
	const days: Holiday[] = [...fixed, { date: easter, name: "Pasqua" }, { date: addDays(easter, 1), name: "Lunedì dell'Angelo (Pasquetta)" }];
	if (year >= SAN_FRANCESCO_SINCE) days.push({ date: isoDate(year, 10, 4), name: "San Francesco d'Assisi, patrono d'Italia" });
	if (patrono !== undefined) {
		const date = `${prefix}-${patrono}`;
		if (realDate(date) && !days.some((d) => d.date === date)) days.push({ date, name: "Santo patrono" });
	}
	return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

const cache = new Map<string, ReadonlyMap<string, string>>();
/** Years times patron days: more tables than this and the cache starts over. */
const MAX_CACHED = 512;

/** The holiday's name on `date`, or undefined; each year's table is worked out once. */
export function holidayOn(date: string, patrono?: string): string | undefined {
	const key = `${date.slice(0, 4)} ${patrono ?? ""}`;
	let table = cache.get(key);
	if (table === undefined) {
		table = new Map(italianHolidays(Number(date.slice(0, 4)), patrono).map((h) => [h.date, h.name]));
		if (cache.size >= MAX_CACHED) cache.clear();
		cache.set(key, table);
	}
	return table.get(date);
}

export type WorkingWeek = { readonly patrono?: string; readonly saturdayWorking?: boolean };

/** Monday to Friday, Saturday too with saturdayWorking: a working day unless it is a holiday. */
export function openWeekday(date: string, week: WorkingWeek = {}): boolean {
	const weekday = weekdayOf(date);
	return weekday !== 0 && (weekday !== 6 || week.saturdayWorking === true);
}

/** An open weekday that is not a national holiday nor the patrono. */
export function workingDay(date: string, week: WorkingWeek = {}): boolean {
	return openWeekday(date, week) && holidayOn(date, week.patrono) === undefined;
}

/**
 * The patron saint's day of the main capoluoghi only, by the city's name in lower case without
 * accents, MM-DD: for any other town the person gives the day.
 */
export const PATRONI: Readonly<Record<string, string>> = {
	milano: "12-07",
	roma: "06-29",
	torino: "06-24",
	genova: "06-24",
	firenze: "06-24",
	napoli: "09-19",
	bologna: "10-04",
	venezia: "04-25",
	bari: "12-06",
	palermo: "07-15",
	cagliari: "10-30",
	trieste: "11-03",
	trento: "06-26",
	verona: "05-21",
	padova: "06-13",
	perugia: "01-29",
	ancona: "05-04",
	"l'aquila": "06-10",
	catania: "02-05",
	brescia: "02-15",
	bergamo: "08-26",
	parma: "01-13",
	modena: "01-31",
};
