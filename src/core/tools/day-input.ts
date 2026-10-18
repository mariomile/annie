/**
 * A day as a person says it. Of the past, for what is recorded once done (a spesa, ore di lavoro):
 * today when not said, «ieri», «l'altro ieri», a weekday, a date; the words of the answers are
 * the caller's (DayWords), the rules the same. Of the future, for what is to do (a client's
 * ricontatto): «domani», «tra due settimane», «a fine mese», «a gennaio», a weekday, a date.
 */
import { addMonths, DateError, endOfMonth, readDate } from "../dates.ts";
import { addDays, daysBetween, holidayOn, MONTH_NAMES, realDate, weekdayOf, weekend, workingDay } from "../italian-calendar.ts";
import { italianDate, italianWeekday } from "../italian-format.ts";
import { fold } from "../text-match.ts";
import type { Problem } from "./quote-input.ts";

/** How the caller names the field («date è la data della spesa») and why a day to come is refused. */
export type DayWords = { readonly field: string; readonly future: string };

const FIRST_DAY = "2000-01-01";

/** Folded, Sunday first as weekdayOf counts them. */
export const WEEKDAYS = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"] as const;
const WEEKDAY = new RegExp(`^(?:(?:il|lo|la) )?(${WEEKDAYS.join("|")})(?: (scors[oa])| (\\d{1,2}))?$`);
/** «stamattina», «stamani», «stasera», «oggi pomeriggio»: today. */
const TODAY_WORDS = /^(?:stamattina|stamani|stamane|stasera|stamattina presto|oggi (?:in )?(?:mattina|pomeriggio|sera))$/;
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
		const wanted = WEEKDAYS.indexOf(weekday[1] as (typeof WEEKDAYS)[number]);
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

const NUMBERS: Readonly<Record<string, number>> = {
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
	tredici: 13,
	quattordici: 14,
	quindici: 15,
	sedici: 16,
	diciassette: 17,
	diciotto: 18,
	diciannove: 19,
	venti: 20,
	ventuno: 21,
	trenta: 30,
	quaranta: 40,
	quarantacinque: 45,
	cinquanta: 50,
	sessanta: 60,
	novanta: 90,
};

/**
 * A day to come as said: «oggi», «domani» (also «domani mattina»), «dopodomani», «tra due
 * settimane», «fra 10 giorni», «tra quattordici giorni», «tra un paio di settimane», «fra un mese»,
 * «lunedì», «lunedì prossimo», «la settimana prossima», «a fine mese», «a gennaio» (its 1st, the
 * next one after this month), a date (the next one). Undefined when it does not read.
 */
export function readFutureDay(text: string, today: string): string | undefined {
	let t = fold(text).replace(/\s+/g, " ").trim();
	t = t.replace(PART_OF_DAY, "").trim().replace(/^(?:il|lo|la|per|entro|verso) /, "");
	if (t === "oggi" || TODAY_WORDS.test(t)) return today;
	if (t === "domani") return addDays(today, 1);
	if (t === "dopodomani") return addDays(today, 2);
	if (/^(?:a |alla )?fine (?:del )?mese$/.test(t)) return endOfMonth(today);
	if (t === "settimana prossima" || t === "prossima settimana") return addDays(today, 7 - ((weekdayOf(today) + 6) % 7));
	const month = /^(?:a|ad|in|a inizio|ai primi di) ([a-z]+)$/.exec(t);
	const m = month === null ? -1 : MONTH_NAMES.indexOf(month[1] as (typeof MONTH_NAMES)[number]);
	if (m >= 0) {
		const year = Number(today.slice(0, 4));
		const thisMonth = Number(today.slice(5, 7)) - 1;
		return `${m > thisMonth ? year : year + 1}-${String(m + 1).padStart(2, "0")}-01`;
	}
	const rel = /^(?:tra|fra) (\d{1,3}|[a-z]+|un paio di) (giorn[oi]|settiman[ae]|mes[ei]|ann[oi])$/.exec(t);
	if (rel !== null) {
		const count = rel[1] as string;
		const n = count === "un paio di" ? 2 : /^\d+$/.test(count) ? Number(count) : NUMBERS[count];
		if (n === undefined || n < 1) return undefined;
		const unit = (rel[2] as string).slice(0, 3);
		if (unit === "gio") return addDays(today, n);
		if (unit === "set") return addDays(today, 7 * n);
		return addMonths(today, unit === "mes" ? n : 12 * n).date;
	}
	const weekday = new RegExp(`^(${WEEKDAYS.join("|")})(?: prossim[oa])?$`).exec(t);
	if (weekday !== null) {
		const wanted = WEEKDAYS.indexOf(weekday[1] as (typeof WEEKDAYS)[number]);
		const ahead = (wanted - weekdayOf(today) + 7) % 7;
		return addDays(today, ahead === 0 ? 7 : ahead);
	}
	try {
		return readDate(t, today, { rule: "next" }).date;
	} catch (error) {
		if (error instanceof DateError) return undefined;
		throw error;
	}
}

/** The first working day from `date` on (Saturdays, Sundays and holidays skipped), and why it moved: «cade di domenica» (a weekend first), «è festivo (Natale)». */
export function workingDayFrom(date: string): { readonly date: string; readonly why?: string } {
	if (workingDay(date)) return { date };
	let to = addDays(date, 1);
	while (!workingDay(to)) to = addDays(to, 1);
	const holiday = holidayOn(date);
	return { date: to, why: weekend(date) || holiday === undefined ? `cade di ${italianWeekday(date)}` : `è festivo (${holiday})` };
}
