/**
 * A day of the past as a person says it, for what is recorded once done (a spesa, ore di lavoro):
 * today when not said, «ieri», «l'altro ieri», a weekday, a date. The words of the answers are
 * the caller's (DayWords), the rules the same.
 */
import { DateError, readDate } from "../dates.ts";
import { addDays, daysBetween, realDate, weekdayOf } from "../italian-calendar.ts";
import { italianDate, italianWeekday } from "../italian-format.ts";
import { fold } from "../text-match.ts";
import type { Problem } from "./quote-input.ts";

/** How the caller names the field («date è la data della spesa») and why a day to come is refused. */
export type DayWords = { readonly field: string; readonly future: string };

const FIRST_DAY = "2000-01-01";

const WEEKDAYS = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"];
const WEEKDAY = new RegExp(`^(?:(?:il|lo|la) )?(${WEEKDAYS.join("|")})(?: (scors[oa])| (\\d{1,2}))?$`);
/** «stamattina», «stamani», «stasera», «oggi pomeriggio»: today. */
const TODAY_WORDS = /^(?:stamattina|stamani|stamane|stasera|stanotte|stamattina presto|oggi (?:in )?(?:mattina|pomeriggio|sera))$/;
/** A part of the day after the day itself, dropped: «ieri pomeriggio» is «ieri». */
const PART_OF_DAY = /(?:,? (?:in |di |nel |alla |la )?(?:mattina|mattinata|pomeriggio|sera|serata|notte)(?: presto| tardi)?)$/;
const BAD_DAY = "scrivi la data come 12/10 o 12/10/2026, oppure ieri, oggi o sabato";
/** A date without a year placed further back than this: said, it may be last year by mistake. */
const FAR_BACK_DAYS = 300;

/**
 * The day of a record (a spesa, ore di lavoro): today when not said (also «stamattina», «stasera»);
 * a part of the day after it is dropped («ieri pomeriggio»); «ieri», «l'altro ieri», a
 * weekday («sabato», «la domenica»: the last one up to today; «sabato scorso»: the last one before today; «venerdì 16»:
 * the last 16th up to today, which must be a Friday), a date (without a year the latest one
 * gone, with a note when that is almost a year back). Never a day to come, nor before 2000.
 */
export function readPastDay(value: unknown, today: string, words: DayWords): { date: string; note?: string } | Problem {
	if (value === undefined) return { date: today };
	if (typeof value !== "string" || value.trim() === "" || value.length > 40) return { problem: `${words.field}: ${BAD_DAY}` };
	const said = fold(value).replace(/\s+/g, " ").trim();
	if (TODAY_WORDS.test(said)) return { date: today };
	// «ieri pomeriggio», «lunedì mattina», «sabato sera»: the day is what counts.
	const t = said.replace(PART_OF_DAY, "").trim();
	const text = t === said ? value : t;
	if (t === "") return { problem: `non capisco la data: ${BAD_DAY}` };
	let date: string;
	let yearless = false;
	const weekday = WEEKDAY.exec(t);
	if (weekday !== null) {
		const wanted = WEEKDAYS.indexOf(weekday[1] as string);
		if (weekday[3] !== undefined) {
			const day = Number(weekday[3]);
			let candidate: string | undefined;
			// The last such day of the month up to today, in the last twelve months.
			for (let back = 0; back < 12 && candidate === undefined; back++) {
				const month = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - back, 1)).toISOString().slice(0, 7);
				const c = `${month}-${String(day).padStart(2, "0")}`;
				if (realDate(c) && c <= today) candidate = c;
			}
			if (candidate === undefined) return { problem: `non capisco la data: ${BAD_DAY}` };
			if (weekdayOf(candidate) !== wanted) return { problem: `il ${italianDate(candidate)} è ${italianWeekday(candidate)}, non ${weekday[1]}: ${BAD_DAY}` };
			date = candidate;
		} else {
			const back = (weekdayOf(today) - wanted + 7) % 7;
			date = addDays(today, -(back === 0 && weekday[2] !== undefined ? 7 : back));
		}
	} else {
		try {
			const read = readDate(/^l'? ?altro ?ieri$/.test(t) ? "altro ieri" : text, today, { rule: "past" });
			date = read.date;
			yearless = read.yearless;
		} catch (error) {
			if (error instanceof DateError) return { problem: `non capisco la data: ${BAD_DAY}` };
			throw error;
		}
	}
	if (date > today) return { problem: `la data ${italianDate(date)} non è ancora arrivata: ${words.future}` };
	if (date < FIRST_DAY) return { problem: "la data è prima del 2000: ricontrollala" };
	if (yearless && daysBetween(date, today) > FAR_BACK_DAYS) return { date, note: `Ho messo il ${italianDate(date)}: se era un'altra data correggila con op edit.` };
	return { date };
}
