/**
 * Durations and time ranges of work as a person says them, in whole minutes: «3 ore», «3h»,
 * «2h30», «2 ore e mezza», «due ore e mezza», «1,5» (hours), «90 minuti», «2:15», «mezz'ora»,
 * and ranges «9-12:30», «dalle 9 alle 13 con un'ora di pausa». Decimal hours are taken to the
 * minute half up (1,33 h is 80 minutes). Two digits after a dot are minutes («8.30» is 8 hours
 * and 30), but «1.25» and «1.50» read two ways; after a comma they are hundredths only for ,25
 * ,50 ,75 («1,75» is 1 hour and 45), and anything else under 60 («1,30») reads two ways: asked,
 * never guessed. A JSON number is hours only when whole, a half or a quarter: 8.3 is asked. A range that goes
 * past midnight («22-2») is refused, not split: the person records the two days apart, so each
 * entry stays on the day it was worked. «Mezza giornata», «tutta la mattina» are no duration:
 * the person is asked how many hours.
 */
import { fold } from "./text-match.ts";

/** One entry: at least a minute, at most a whole day. */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 24 * 60;

export type DurationProblem = { readonly problem: string };

const TOO_SHORT = "la durata è meno di un minuto: dimmi quanto hai lavorato, come «3 ore», «2h30», «90 minuti» o «2:15»";
const TOO_LONG = "la durata è più di 24 ore: una voce è al più un giorno. Se sono più giorni, registra una voce per giorno";
const BAD = "non capisco la durata: scrivila come «3 ore», «2h30», «1,5», «90 minuti» o «2:15»";
const VAGUE = "non è una durata precisa: chiedi a chi ti scrive quante ore sono, poi registrale";

/** Amounts of time that are no number of hours: asked. */
const VAGUE_WORDS = /\b(?:mezza giornata|mezza mattinata|giornata(?: intera| piena)?|tutta la (?:mattina|mattinata|giornata|sera|serata|notte)|tutto il (?:giorno|pomeriggio)|tutto il di|un paio d'? ?ore|qualche ora|un po'|mattinata|pomeriggio)\b/;

/** A part of the day after a duration: «2 ore di pomeriggio», «mezz'ora la sera». */
const AFTER_DURATION = /^(.*(?:\d|\bore\b|\bora\b|\bminut[oi]\b|\bh\b).*?),? (?:di |nel |al |in |la |alla )?(?:mattina|mattinata|pomeriggio|sera|serata|notte)$/;

const HOUR_WORD = "(?:h|hr|hrs|ore|ora)";
const MINUTE_WORD = "(?:m|min|mins|minuti|minuto|')";
const NUMBER = "(\\d{1,2})(?:([.,])(\\d{1,2}))?";
/** «1,5», «2», «8.30»: hours. */
const BARE = new RegExp(`^${NUMBER}$`);
/** «2:15». */
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const MINUTES_ONLY = new RegExp(`^(\\d{1,4}) ?${MINUTE_WORD}\\.?$`);
/** «3 ore», «1,5h», «2h30», «2 ore e 30», «2 ore e 30 minuti», «2h 30m». */
const HOURS = new RegExp(`^${NUMBER} ?${HOUR_WORD}\\.?(?: ?(?:e )?(\\d{1,2}) ?(?:${MINUTE_WORD}\\.?)?)?$`);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
	un: 1,
	uno: 1,
	una: 1,
	due: 2,
	tre: 3,
	quattro: 4,
	cinque: 5,
	sei: 6,
	sette: 7,
	otto: 8,
	nove: 9,
	dieci: 10,
	undici: 11,
	dodici: 12,
	quindici: 15,
	venti: 20,
	trenta: 30,
	quaranta: 40,
	quarantacinque: 45,
	cinquanta: 50,
	novanta: 90,
};
const NUMBER_WORD = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

/** Words for numbers, halves and quarters turned into digits: «due ore e mezza» is «2 ore e 30». */
function digits(text: string): string {
	return text
		.replace(/\btre quarti d'? ?ora\b/g, "45 min")
		.replace(/\bun quarto d'? ?ora\b/g, "15 min")
		.replace(/\bmezz'? ?ora\b|\bmezza ora\b/g, "30 min")
		.replace(/\bun'? ?ora\b/g, "1 ora")
		.replace(/\be (?:mezza|mezzo)\b/g, "e 30")
		.replace(/\be tre quarti\b/g, "e 45")
		.replace(/\be un quarto\b/g, "e 15")
		.replace(NUMBER_WORD, (w) => String(NUMBER_WORDS[w]));
}

/** Hours with up to two hundredths («1», «33») in minutes, half up. */
function hundredthsToMinutes(whole: string, fraction: string): number {
	const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	// hundredths × 60 / 100, half up, in integers.
	return Math.floor((hundredths * 60 * 2 + 100) / 200);
}

/** Two ways to read «8.3» or «1,30»: asked, with how to write it so it reads one way. */
function twoWays(said: string, whole: string, fraction: string): DurationProblem {
	const asMinutes = Number(whole) * 60 + Number(fraction.padEnd(2, "0"));
	return { problem: `«${said}» vuol dire ${hoursText(asMinutes)} o ${hoursText(hundredthsToMinutes(whole, fraction))}? Chiedi a chi ti scrive, o passa la durata come ${whole}:${fraction.padEnd(2, "0")} (ore e minuti)` };
}

/**
 * «8» «8.30» «1,5» «1,75» in minutes. After a comma: one digit, or ,25 ,50 ,75, are hours and
 * hundredths; other two digits under 60 read two ways. After a dot: ,5 and .75 are hours (.75
 * cannot be minutes); .25 .50 and other single digits read two ways; other two digits under 60
 * are minutes («8.30»).
 */
function numberMinutes(whole: string, sep: string | undefined, fraction: string | undefined): number | DurationProblem {
	if (fraction === undefined) return Number(whole) * 60;
	const said = `${whole}${sep}${fraction}`;
	const n = Number(fraction.padEnd(2, "0"));
	if (n === 0) return Number(whole) * 60;
	if (sep === ".") {
		if (fraction === "5" || fraction === "75") return hundredthsToMinutes(whole, fraction);
		if (fraction.length === 1 || n === 25 || n === 50) return twoWays(said, whole, fraction);
		return n < 60 ? Number(whole) * 60 + n : { problem: BAD };
	}
	if (fraction.length === 1 || n === 25 || n === 50 || n === 75) return hundredthsToMinutes(whole, fraction);
	return n < 60 ? twoWays(said, whole, fraction) : { problem: BAD };
}

function bounded(minutes: number | DurationProblem): number | DurationProblem {
	if (typeof minutes !== "number") return minutes;
	if (minutes < MIN_MINUTES) return { problem: TOO_SHORT };
	if (minutes > MAX_MINUTES) return { problem: TOO_LONG };
	return minutes;
}

/**
 * A duration in whole minutes: a JSON number is hours; a text is one of the forms above. A
 * problem, said to the person, when it does not read, reads two ways, is under a minute or over 24 hours.
 */
export function parseDuration(value: unknown): number | DurationProblem {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Math.round(value * 60) < MIN_MINUTES) return { problem: TOO_SHORT };
		if (value > 24) return { problem: TOO_LONG };
		// Whole hours, halves and quarters only: 8.3 or 1.33 may be hours and minutes.
		const quarters = value * 4;
		if (Math.abs(quarters - Math.round(quarters)) > 1e-9) {
			const [whole = "0", fraction = ""] = String(value).split(".");
			return fraction.length <= 2 ? twoWays(String(value), whole, fraction) : { problem: `«${value}» non è una durata chiara: chiedi a chi ti scrive quante ore e minuti sono, e passala come testo («2:15», «2 ore e 15»)` };
		}
		return bounded(Math.round(value * 60));
	}
	if (typeof value !== "string" || value.length > 60) return { problem: BAD };
	// «2 ore di pomeriggio»: the part of the day after a duration goes.
	const folded = fold(value).replace(/\s+/g, " ").trim().replace(AFTER_DURATION, "$1");
	if (VAGUE_WORDS.test(folded)) return { problem: `«${value.trim().slice(0, 40)}» ${VAGUE}` };
	const t = digits(folded);
	const bare = BARE.exec(t);
	if (bare !== null) return bounded(numberMinutes(bare[1] as string, bare[2], bare[3]));
	const clock = CLOCK.exec(t);
	if (clock !== null) {
		if (Number(clock[2]) >= 60) return { problem: BAD };
		return bounded(Number(clock[1]) * 60 + Number(clock[2]));
	}
	const minutes = MINUTES_ONLY.exec(t);
	if (minutes !== null) return bounded(Number(minutes[1]));
	const hours = HOURS.exec(t);
	if (hours !== null) {
		const extra = hours[4] === undefined ? 0 : Number(hours[4]);
		// «1,5 ore e 20» mixes two ways: not guessed.
		if (hours[4] !== undefined && (hours[3] !== undefined || extra >= 60)) return { problem: BAD };
		const base = numberMinutes(hours[1] as string, hours[2], hours[3]);
		return bounded(typeof base === "number" ? base + extra : base);
	}
	return { problem: BAD };
}

/** A time of day as «09:00». */
export type ClockTime = string;

export type TimeRange = { readonly start: ClockTime; readonly end: ClockTime; readonly minutes: number; readonly pause?: number };

const TIME = "(\\d{1,2})(?:[:.,h](\\d{2}))?";
const RANGE = new RegExp(`^(?:(?:dalle|dall'|dalla|da) ?)?(?:ore )?${TIME} ?(?:-|–|—|alle|all'|a|fino alle) ?(?:ore )?${TIME}$`);
/** «…, con un'ora di pausa», «… meno mezz'ora di pausa», «…, pausa 30 minuti». */
const PAUSE = /(?:, ?| )(?:(?:con|meno|e) (.+?) di pausa(?: pranzo)?|(?:con )?pausa(?: pranzo)?(?: di)? (.+))$/;
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
 * A range of the same day: «9-12:30», «9:00-12:30», «dalle 9 alle 12.30», «14h30-18», with a
 * pause taken off when said in it («con un'ora di pausa») or given apart (`pause`). An end at or
 * before the start (past midnight) is refused: two entries, one per day.
 */
export function parseRange(value: unknown, pause?: unknown): TimeRange | DurationProblem {
	if (typeof value !== "string" || value.length > 80) return { problem: BAD_RANGE };
	let t = fold(value).replace(/\s+/g, " ").trim();
	let pauseSaid: unknown = pause;
	const p = PAUSE.exec(t);
	if (p !== null) {
		if (pause !== undefined) return { problem: "la pausa è detta due volte: dammela una volta sola" };
		pauseSaid = p[1] ?? p[2];
		t = t.slice(0, p.index).trim();
	}
	const m = RANGE.exec(t);
	if (m === null) return { problem: BAD_RANGE };
	const start = clockMinutes(m[1] as string, m[2], false);
	const end = clockMinutes(m[3] as string, m[4], true);
	if (start === undefined || end === undefined) return { problem: BAD_RANGE };
	if (end === start) return { problem: "l'orario finisce quando comincia: ricontrollalo" };
	if (end < start) return { problem: "l'orario passa la mezzanotte: registralo come due voci, una per giorno (fino alle 24:00 e dalle 0:00)" };
	const range = { start: clockText(start), end: clockText(end), minutes: end - start };
	if (pauseSaid === undefined) return range;
	const off = parseDuration(pauseSaid);
	if (typeof off !== "number") return { problem: `la pausa: ${off.problem}` };
	if (off >= range.minutes) return { problem: "la pausa è lunga quanto l'orario o di più: ricontrollala" };
	return { ...range, minutes: range.minutes - off, pause: off };
}

/** Minutes as «3:05», for tables, lists and CSV. */
export function hm(minutes: number): string {
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Minutes in words, for sentences: «1 ora», «3 ore», «2 ore e 30 minuti», «45 minuti». */
export function hoursText(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	const hours = h === 0 ? "" : h === 1 ? "1 ora" : `${h} ore`;
	const mins = m === 0 ? "" : m === 1 ? "1 minuto" : `${m} minuti`;
	return [hours, mins].filter((x) => x !== "").join(" e ") || "0 minuti";
}
