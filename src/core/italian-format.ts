/**
 * Numbers, money and dates as they are read in Italy, for every tool that writes them: a point
 * for thousands, a comma for decimals, days and months in Italian.
 */
import { localMinute } from "./cron.ts";

const NUMBER = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });
const DAY = new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const WEEKDAY = new Intl.DateTimeFormat("it-IT", { weekday: "long", timeZone: "UTC" });

/** Amounts from this on are refused by italianMoney: a double holds exact cents only up to Number.MAX_SAFE_INTEGER / 100, about 9e13. */
export const MAX_MONEY = 9e13;

/** 12,5: at most one decimal, with a comma. */
export function italianNumber(value: number): string {
	return NUMBER.format(value);
}

/** A result as it is read in Italy, to 12 significant digits: 1.234,5; with `decimals` exactly that many. */
export function formatResult(value: number, decimals?: number): string {
	const exact = Number(value.toPrecision(12));
	if (Math.abs(exact) >= 1e15 || (exact !== 0 && Math.abs(exact) < 1e-9)) return exact.toExponential(6).replace(".", ",");
	return new Intl.NumberFormat("it-IT", decimals === undefined ? { maximumFractionDigits: 10, useGrouping: true } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true }).format(exact);
}

/** 1.234.567,89: money to the cent (or to the unit, with 0 decimals), never in exponent notation; a RangeError from MAX_MONEY on. */
export function italianMoney(value: number, decimals = 2): string {
	if (!Number.isFinite(value) || Math.abs(value) >= MAX_MONEY) throw new RangeError("amount too large to write to the cent");
	return new Intl.NumberFormat("it-IT", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true }).format(value);
}

/** 2026-10-17 → sabato 17 ottobre; the first of the month is 1º. */
export function italianDay(date: string): string {
	return DAY.format(new Date(`${date}T00:00:00Z`)).replace(/ 1 /, " 1º ");
}

/** 2026-10-17 → 17/10/2026. */
export function italianDate(date: string): string {
	return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

/** 2026-10-17 → sabato. */
export function italianWeekday(date: string): string {
	return WEEKDAY.format(new Date(`${date}T00:00:00Z`));
}

/** An instant as 17/10/2026 22:10 in `timeZone`, with cron's cached formatter. */
export function italianDateTime(at: number, timeZone: string): string {
	const minute = localMinute(new Date(at), timeZone);
	return `${italianDate(minute.slice(0, 10))} ${minute.slice(-5)}`;
}

/** 1 → 01: days and months as dates write them. */
export function twoDigits(n: number): string {
	return String(n).padStart(2, "0");
}

/** The first letter in capitals: a sentence that starts with a name or a weekday. */
export function capitalized(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const MONTHS_LONG = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

/** 2027-03-12 → 12 marzo 2027: a date in a sentence (tables keep 12/03/2027). */
export function italianLongDate(date: string): string {
	return `${Number(date.slice(8, 10))} ${MONTHS_LONG[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The prepositions a date follows in a sentence, and their elided forms before «8» and «11». */
const ELIDED: Readonly<Record<DatePreposition, string>> = { il: "l'", del: "dell'", dal: "dall'", al: "all'", nel: "nell'", sul: "sull'" };
export type DatePreposition = "il" | "del" | "dal" | "al" | "nel" | "sul";

/**
 * A date after its preposition, as Italian writes it: «il 12 marzo 2027», «l'8 marzo 2027»,
 * «dall'11 ottobre 2026», «il 1º gennaio 2027» (the first of the month is an ordinal).
 */
export function withDate(preposition: DatePreposition, date: string): string {
	const day = Number(date.slice(8, 10));
	const rest = italianLongDate(date).slice(String(day).length);
	if (day === 1) return `${preposition} 1º${rest}`;
	if (day === 8 || day === 11) return `${ELIDED[preposition]}${day}${rest}`;
	return `${preposition} ${day}${rest}`;
}
