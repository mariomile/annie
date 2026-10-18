/**
 * Durations and time ranges of work as a person says them, in whole minutes: «3 ore», «3h»,
 * «2h30», «2 ore e mezza», «1,5» (hours), «90 minuti», «2:15», «mezz'ora», and ranges «9-12:30»,
 * «dalle 9 alle 12:30». Decimal hours are taken to the minute half up (1,33 h is 80 minutes). A
 * range that goes past midnight («22-2») is refused, not split: the person records the two days
 * apart, so each entry stays on the day it was worked.
 */
import { fold } from "./text-match.ts";

/** One entry: at least a minute, at most a whole day. */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 24 * 60;

export type DurationProblem = { readonly problem: string };

const TOO_SHORT = "la durata è meno di un minuto: dimmi quanto hai lavorato, come «3 ore», «2h30», «90 minuti» o «2:15»";
const TOO_LONG = "la durata è più di 24 ore: una voce è al più un giorno. Se sono più giorni, registra una voce per giorno";
const BAD = "non capisco la durata: scrivila come «3 ore», «2h30», «1,5», «90 minuti» o «2:15»";

const HOUR_WORD = "(?:h|hr|hrs|ore|ora)";
const MINUTE_WORD = "(?:m|min|mins|minuti|minuto|')";
/** «1,5», «2», «0.75»: hours. */
const BARE = /^(\d{1,2})(?:[.,](\d{1,2}))?$/;
/** «2:15», «2.15h» is not this: a colon only. */
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const MINUTES_ONLY = new RegExp(`^(\\d{1,4}) ?${MINUTE_WORD}\\.?$`);
/** «3 ore», «1,5h», «2h30», «2 ore e 30», «2 ore e 30 minuti», «2h 30m». */
const HOURS = new RegExp(`^(\\d{1,2})(?:[.,](\\d{1,2}))? ?${HOUR_WORD}\\.?(?: ?(?:e )?(\\d{1,2}) ?(?:${MINUTE_WORD}\\.?)?)?$`);

/** Words for halves and quarters turned into digits: «un'ora e mezza» is «1 ora e 30 min». */
function digits(text: string): string {
	return text
		.replace(/\btre quarti d'? ?ora\b/g, "45 min")
		.replace(/\bun quarto d'? ?ora\b/g, "15 min")
		.replace(/\bmezz'? ?ora\b|\bmezza ora\b/g, "30 min")
		.replace(/\bun'? ?ora\b/g, "1 ora")
		.replace(/\be (?:mezza|mezzo)\b/g, "e 30")
		.replace(/\be tre quarti\b/g, "e 45")
		.replace(/\be un quarto\b/g, "e 15");
}

/** Hours with up to two decimals («1», «33») in minutes, half up. */
function hoursToMinutes(whole: string, fraction: string | undefined): number {
	const hundredths = Number(whole) * 100 + Number((fraction ?? "").padEnd(2, "0"));
	// hundredths × 60 / 100, half up, in integers.
	return Math.floor((hundredths * 60 * 2 + 100) / 200);
}

function bounded(minutes: number): number | DurationProblem {
	if (minutes < MIN_MINUTES) return { problem: TOO_SHORT };
	if (minutes > MAX_MINUTES) return { problem: TOO_LONG };
	return minutes;
}

/**
 * A duration in whole minutes: a JSON number is hours; a text is one of the forms above. A
 * problem, said to the person, when it does not read or is under a minute or over 24 hours.
 */
export function parseDuration(value: unknown): number | DurationProblem {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return { problem: TOO_SHORT };
		if (value > 24) return { problem: TOO_LONG };
		return bounded(Math.round(value * 60));
	}
	if (typeof value !== "string" || value.length > 40) return { problem: BAD };
	const t = digits(fold(value).replace(/\s+/g, " ").trim());
	const bare = BARE.exec(t);
	if (bare !== null) return bounded(hoursToMinutes(bare[1] as string, bare[2]));
	const clock = CLOCK.exec(t);
	if (clock !== null) {
		if (Number(clock[2]) >= 60) return { problem: BAD };
		return bounded(Number(clock[1]) * 60 + Number(clock[2]));
	}
	const minutes = MINUTES_ONLY.exec(t);
	if (minutes !== null) return bounded(Number(minutes[1]));
	const hours = HOURS.exec(t);
	if (hours !== null) {
		const extra = hours[3] === undefined ? 0 : Number(hours[3]);
		// «1,5 ore e 20» mixes two ways: not guessed.
		if (hours[3] !== undefined && (hours[2] !== undefined || extra >= 60)) return { problem: BAD };
		return bounded(hoursToMinutes(hours[1] as string, hours[2]) + extra);
	}
	return { problem: BAD };
}

/** A time of day as «09:00». */
export type ClockTime = string;

export type TimeRange = { readonly start: ClockTime; readonly end: ClockTime; readonly minutes: number };

const TIME = "(\\d{1,2})(?:[:.,h](\\d{2}))?";
const RANGE = new RegExp(`^(?:(?:dalle|dall'|dalla|da) ?)?(?:ore )?${TIME} ?(?:-|–|—|alle|all'|a|fino alle) ?(?:ore )?${TIME}$`);
const BAD_RANGE = "non capisco l'orario: scrivilo come «9-12:30» o «dalle 9 alle 12:30»";

/** «9», «12:30», «24:00» (only as an end) to minutes since midnight; undefined when it is no time. */
function clockMinutes(hours: string, minutes: string | undefined, end: boolean): number | undefined {
	const h = Number(hours);
	const m = minutes === undefined ? 0 : Number(minutes);
	if (m >= 60 || h > 24 || (h === 24 && (m > 0 || !end))) return undefined;
	return h * 60 + m;
}

/** Minutes since midnight as «09:05». */
export function clockText(minutes: number): ClockTime {
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * A range of the same day: «9-12:30», «9:00-12:30», «dalle 9 alle 12.30», «14h30-18». An end at
 * or before the start (past midnight) is refused: two entries, one per day.
 */
export function parseRange(value: unknown): TimeRange | DurationProblem {
	if (typeof value !== "string" || value.length > 40) return { problem: BAD_RANGE };
	const m = RANGE.exec(fold(value).replace(/\s+/g, " ").trim());
	if (m === null) return { problem: BAD_RANGE };
	const start = clockMinutes(m[1] as string, m[2], false);
	const end = clockMinutes(m[3] as string, m[4], true);
	if (start === undefined || end === undefined) return { problem: BAD_RANGE };
	if (end === start) return { problem: "l'orario finisce quando comincia: ricontrollalo" };
	if (end < start) return { problem: "l'orario passa la mezzanotte: registralo come due voci, una per giorno (fino alle 24:00 e dalle 0:00)" };
	return { start: clockText(start), end: clockText(end), minutes: end - start };
}

/** Minutes as «3:05», for tables and CSV. */
export function hm(minutes: number): string {
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Minutes in words: «1 ora», «3 ore», «2 ore e 30 minuti», «45 minuti». */
export function hoursText(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	const hours = h === 0 ? "" : h === 1 ? "1 ora" : `${h} ore`;
	const mins = m === 0 ? "" : m === 1 ? "1 minuto" : `${m} minuti`;
	return [hours, mins].filter((x) => x !== "").join(" e ") || "0 minuti";
}
