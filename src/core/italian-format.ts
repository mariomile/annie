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

export type DatePreposition = "il" | "del" | "dal" | "al" | "nel" | "sul";
/** The prepositions a date follows in a sentence, and their elided forms before «8» and «11». */
const ELIDED: Readonly<Record<DatePreposition, string>> = { il: "l'", del: "dell'", dal: "dall'", al: "all'", nel: "nell'", sul: "sull'" };

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

/** «12/10» this year, «12/10/2025» another: a date in a table or a short sentence. */
export function dayMonth(date: string, today: string): string {
	return date.slice(0, 4) === today.slice(0, 4) ? italianDate(date).slice(0, 5) : italianDate(date);
}

/** A short date after its preposition, the year only when not this one: «il 12/11», «l'08/11», «dall'11/11/2027». */
export function withShortDate(preposition: DatePreposition, date: string, today: string): string {
	const day = Number(date.slice(8, 10));
	const text = dayMonth(date, today);
	return day === 8 || day === 11 ? `${ELIDED[preposition]}${text}` : `${preposition} ${text}`;
}

/** A date near today after its preposition, without the year: «il 1º novembre», «dall'8 novembre», «al 7 gennaio»; with it when far (two months before, ten after). */
export function withNearDate(preposition: DatePreposition, date: string, today: string): string {
	const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
	const full = withDate(preposition, date);
	return days >= -60 && days <= 300 ? full.replace(/ \d{4}$/, "") : full;
}

/** Whether a number is said starting with a vowel: uno, otto, undici, ottanta, ottocento («l'8%», «all'11%»). */
function vowelNumber(value: string): boolean {
	const whole = value.split(".")[0] ?? value;
	return whole === "1" || whole === "11" || whole.startsWith("8");
}

/** The sign of a change, amounts and percents alike: «+», or the minus «−» (U+2212) euros writes. */
export function signOf(negative: boolean): string {
	return negative ? "\u2212" : "+";
}

/** A percentage after its article or preposition, elided where Italian elides: «il 29%», «l'80%», «al 26,07%», «all'82%», «lo 0,40%». `value`: a number or a decimal with a point. */
export function withPercent(preposition: "il" | "al", value: string | number): string {
	const v = String(value);
	const text = `${v.replace(".", ",")}%`;
	if (vowelNumber(v)) return `${preposition === "il" ? "l'" : "all'"}${text}`;
	if (v.startsWith("0")) return `${preposition === "il" ? "lo" : "allo"} ${text}`;
	return `${preposition} ${text}`;
}

/** The month of a date in a sentence: «a novembre». */
export function monthName(date: string): string {
	return MONTHS_LONG[Number(date.slice(5, 7)) - 1] ?? "";
}

/** «a novembre», «ad agosto»: the month of a date after «a», with the «d» before a vowel. */
export function toMonth(date: string): string {
	const month = monthName(date);
	return `${/^[aeiou]/.test(month) ? "ad" : "a"} ${month}`;
}
