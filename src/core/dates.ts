/**
 * Date arithmetic with the Italian calendar, exact and offline, for date_calc: reading dates as
 * Italians write them, spans in days, weeks, months and working days, adding to a date, the due
 * dates of an invoice, ages. Pure functions on YYYY-MM-DD; "today" is always passed in.
 */
import { addDays, daysBetween, daysInMonth, easterSunday, type Holiday, holidayOn, isoDate, italianHolidays, openWeekday, realDate, weekdayOf, type WorkingWeek, workingDay } from "./italian-calendar.ts";

/** A date that cannot be read, does not exist or is out of range: the reason in Italian. */
export class DateError extends Error {}

export const FIRST_YEAR = 1900;
export const LAST_YEAR = 2200;
/** More than 40 years of working days: a typo, and a long loop. */
export const MAX_WORKING_DAYS = 10_000;

const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"] as const;
const WEEKDAYS = ["lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato", "domenica"];

/** Named days, by year: the movable ones follow Easter. */
const NAMED: Readonly<Record<string, (year: number) => string>> = {
	natale: (y) => isoDate(y, 12, 25),
	capodanno: (y) => isoDate(y, 1, 1),
	epifania: (y) => isoDate(y, 1, 6),
	befana: (y) => isoDate(y, 1, 6),
	ferragosto: (y) => isoDate(y, 8, 15),
	"santo stefano": (y) => isoDate(y, 12, 26),
	"san silvestro": (y) => isoDate(y, 12, 31),
	pasqua: (y) => easterSunday(y),
	pasquetta: (y) => addDays(easterSunday(y), 1),
	"lunedi dell'angelo": (y) => addDays(easterSunday(y), 1),
};

/**
 * How to place a date written without a year (or with two digits): "next" is its first
 * occurrence from the reference day on (Natale is this year's, or next year's once past) and a
 * two-digit year the closest century; "past" is its latest occurrence up to the reference day
 * (an invoice already issued, a birth).
 */
export type YearRule = "next" | "past";

/**
 * A date as people write it: 2027-03-15, 15/03/2027, 15/3/27, 15.03.2027, 15/03, «15 marzo
 * 2027», «1° novembre», «lunedì 2 giugno», oggi, domani, ieri, dopodomani, Natale, Pasqua 2030.
 */
export type DateReading = {
	readonly rule?: YearRule;
	/** The day a missing year is placed from: today unless given (the start of a span, for its end). */
	readonly reference?: string;
	/** A birth needs its year: without one the date is refused. */
	readonly yearNeeded?: boolean;
};

export function parseDate(text: string, today: string, reading: DateReading = {}): string {
	const { rule = "next", reference = today, yearNeeded = false } = reading;
	const t = normalized(text);
	const noYear = () => new DateError(`manca l'anno nella data${shown(text)}: scrivilo per intero, come 03/04/1990`);
	const relative = { oggi: 0, domani: 1, ieri: -1, dopodomani: 2, "l'altro ieri": -2 }[t];
	if (relative !== undefined) return inRange(addDays(today, relative));
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
	if (m !== null) return built(Number(m[1]), Number(m[2]), Number(m[3]));
	m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?$/.exec(t);
	if (m !== null) {
		if (m[3] === undefined && yearNeeded) throw noYear();
		return dated(Number(m[1]), Number(m[2]), m[3], reference, rule);
	}
	m = /^(\d{1,2}) (?:di )?([a-z]+)(?: (?:del )?(\d{4}|\d{2}))?$/.exec(t);
	if (m !== null) {
		const month = monthNumber(m[2] as string);
		if (month !== undefined && m[3] === undefined && yearNeeded) throw noYear();
		if (month !== undefined) return dated(Number(m[1]), month, m[3], reference, rule);
	}
	m = /^([a-z' ]+?)(?: (?:del )?(\d{4}))?$/.exec(t);
	const named = m === null ? undefined : NAMED[m[1] as string];
	if (named !== undefined && m?.[2] !== undefined) return inRange(named(Number(m[2])));
	if (named !== undefined && yearNeeded) throw noYear();
	if (named !== undefined) return inRange(occurrence(named, reference, rule));
	throw new DateError(`non riconosco la data${shown(text)}: scrivila come 15/03/2027, 2027-03-15 o «15 marzo 2027»`);
}

/** A month: «novembre», «novembre 2026», «nov 26», 2026-11, 11/2026; without a year, its next occurrence (this month counts). */
export function parseMonth(text: string, today: string): { readonly year: number; readonly month: number } {
	const t = normalized(text);
	let year: number | undefined;
	let month: number | undefined;
	let m = /^(\d{4})-(\d{1,2})$/.exec(t);
	if (m !== null) [year, month] = [Number(m[1]), Number(m[2])];
	m = /^(\d{1,2})[/.-](\d{4})$/.exec(t);
	if (m !== null) [month, year] = [Number(m[1]), Number(m[2])];
	m = /^([a-z]+)(?: (?:del )?(\d{4}|\d{2}))?$/.exec(t);
	if (m !== null) {
		month = monthNumber(m[1] as string);
		if (m[2] !== undefined) year = m[2].length === 2 ? closestCentury(Number(m[2]), Number(today.slice(0, 4))) : Number(m[2]);
	}
	if (month === undefined) throw new DateError(`non riconosco il mese${shown(text)}: scrivilo come «novembre 2026» o 11/2026`);
	if (month < 1 || month > 12) throw new DateError(`${month} non è un mese`);
	const thisYear = Number(today.slice(0, 4));
	const resolved = year ?? (month >= Number(today.slice(5, 7)) ? thisYear : thisYear + 1);
	inRange(isoDate(resolved, month, 1));
	return { year: resolved, month };
}

/** A day of the year for the patron saint: 29/06, «29 giugno», 06-29 → MM-DD. */
export function parseDayMonth(text: string): string {
	const t = normalized(text);
	let day: number | undefined;
	let month: number | undefined;
	let m = /^(\d{1,2})[/.](\d{1,2})$/.exec(t);
	if (m !== null) [day, month] = [Number(m[1]), Number(m[2])];
	m = /^(\d{1,2}) (?:di )?([a-z]+)$/.exec(t);
	if (m !== null) [day, month] = [Number(m[1]), monthNumber(m[2] as string)];
	m = /^(\d{2})-(\d{2})$/.exec(t);
	if (m !== null) [month, day] = [Number(m[1]), Number(m[2])];
	if (day === undefined || month === undefined) throw new DateError(`non riconosco il giorno del patrono${shown(text)}: scrivilo come 29/06 o «29 giugno»`);
	checkDay(day, month, undefined);
	return isoDate(2000, month, day).slice(5);
}

/** Within 1900–2200, or the reason. */
export function inRange(date: string): string {
	const year = Number(date.slice(0, 4));
	if (year < FIRST_YEAR || year > LAST_YEAR) throw new DateError(`le date vanno dal ${FIRST_YEAR} al ${LAST_YEAR}`);
	return date;
}

export type IsoWeek = { readonly year: number; readonly week: number };

/** The ISO 8601 week: weeks start on Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(date: string): IsoWeek {
	const thursday = addDays(date, 3 - ((weekdayOf(date) + 6) % 7));
	const year = Number(thursday.slice(0, 4));
	return { year, week: Math.floor((dayOfYear(thursday) - 1) / 7) + 1 };
}

/** 1 for 1 January. */
export function dayOfYear(date: string): number {
	return daysBetween(`${date.slice(0, 4)}-01-01`, date) + 1;
}

/** The last day of the date's month. */
export function endOfMonth(date: string): string {
	const [year, month] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
	return isoDate(year, month, daysInMonth(year, month));
}

/** `months` later (earlier when negative), on the same day or, when the month is shorter, its last day (31/01 + 1 → 28/02 or 29/02). */
export function addMonths(date: string, months: number): { readonly date: string; readonly clamped: boolean } {
	const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
	const [year, month, day] = [Math.floor(index / 12), (index % 12) + 1, Number(date.slice(8, 10))];
	const last = daysInMonth(year, month);
	return { date: isoDate(year, month, Math.min(day, last)), clamped: day > last };
}

export type Span = {
	/** Calendar days from the first to the second date (the first not counted). */
	readonly days: number;
	readonly weeks: number;
	readonly weekDays: number;
	/** Whole months from the first date, then the days left. */
	readonly months: number;
	readonly monthDays: number;
	/** Working days counted: after the first date up to the second, or both included. */
	readonly workingDays: number;
	/** The holidays in the counted days, each with whether it fell on a working weekday (and so was taken off). */
	readonly holidays: readonly (Holiday & { readonly offWorkday: boolean })[];
};

/** From `from` to `to` (not before it). `inclusive` counts the first day's working day too. */
export function span(from: string, to: string, inclusive: boolean, week: WorkingWeek = {}): Span {
	const days = daysBetween(from, to);
	let months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
	if (addMonths(from, months).date > to) months -= 1;
	const counted = workingDaysIn(inclusive ? from : addDays(from, 1), to, week);
	return { days, weeks: Math.floor(days / 7), weekDays: days % 7, months, monthDays: daysBetween(addMonths(from, months).date, to), workingDays: counted.working, holidays: counted.holidays };
}

export type WorkingCount = { readonly working: number; readonly total: number; readonly holidays: readonly (Holiday & { readonly offWorkday: boolean })[] };

/** Working days from `from` to `to`, both included (none when `to` comes first), and the holidays among them. */
export function workingDaysIn(from: string, to: string, week: WorkingWeek = {}): WorkingCount {
	let working = 0;
	let total = 0;
	const holidays: (Holiday & { offWorkday: boolean })[] = [];
	const firstYear = Number(from.slice(0, 4));
	for (let year = firstYear; year <= Number(to.slice(0, 4)); year++) {
		for (const h of italianHolidays(year, week.patrono)) {
			if (h.date >= from && h.date <= to) holidays.push({ ...h, offWorkday: openWeekday(h.date, week) });
		}
	}
	for (let day = from; day <= to; day = addDays(day, 1)) {
		total += 1;
		if (workingDay(day, week)) working += 1;
	}
	return { working, total, holidays };
}

export const UNITS = ["days", "working_days", "weeks", "months", "years"] as const;
export type Unit = (typeof UNITS)[number];

export type Added = {
	readonly date: string;
	/** A month or year that landed past the end of a shorter month. */
	readonly clamped: boolean;
	/** Working days only: holidays on weekdays that were skipped. */
	readonly skipped: readonly Holiday[];
};

/** `amount` units after `date` (before it when negative). Working days do not count the starting day. */
export function addTo(date: string, amount: number, unit: Unit, week: WorkingWeek = {}): Added {
	if (unit === "months" || unit === "years") {
		const moved = addMonths(date, unit === "years" ? amount * 12 : amount);
		return { date: inRange(moved.date), clamped: moved.clamped, skipped: [] };
	}
	if (unit !== "working_days") return { date: inRange(addDays(date, unit === "weeks" ? amount * 7 : amount)), clamped: false, skipped: [] };
	if (Math.abs(amount) > MAX_WORKING_DAYS) throw new DateError(`al più ${MAX_WORKING_DAYS.toLocaleString("it-IT")} giorni lavorativi`);
	const step = Math.sign(amount);
	const skipped: Holiday[] = [];
	let day = date;
	for (let left = Math.abs(amount); left > 0; ) {
		day = inRange(addDays(day, step));
		if (workingDay(day, week)) left -= 1;
		else {
			const holiday = holidayOn(day, week.patrono);
			if (holiday !== undefined && openWeekday(day, week)) skipped.push({ date: day, name: holiday });
		}
	}
	return { date: day, clamped: false, skipped };
}

export type DueTerms = {
	/** «fine mese» (f.m.): after counting the days, the end of that month. */
	readonly endOfMonth: boolean;
	/** «giorno fisso»: then this day of the following month (the last day when the month is shorter). */
	readonly fixedDay?: number;
	readonly patrono?: string;
};

export type DueDate = {
	readonly days: number;
	readonly date: string;
	/** When a payment on that day cannot move: the first working day after, and why. */
	readonly slip?: { readonly to: string; readonly holiday?: string };
	/** The date when 30 days are counted as a month (30 gg f.m. from 31/01 → 28/02), as some accounting software does, when it differs. */
	readonly byMonths?: string;
};

/**
 * Due dates of an invoice, the Italian way. «60 gg d.f.» (data fattura) is 60 calendar days
 * after the invoice date. «60 gg f.m.» (fine mese) counts 60 days from the invoice date and then
 * moves to the end of that month: 15/10 + 60 = 14/12 → 31/12. That is the common practice; some
 * software instead counts 30 days as a calendar month (31/01 + 30 f.m. → 28/02 rather than 31/03),
 * so when the two differ the month count is given too. A «giorno fisso» then moves the date to
 * that day of the following month (60 gg f.m. + 10 → the 10th after the end of the month). A due
 * date is never moved silently: on a weekend or holiday the first working day after is given
 * beside it. Banks do not move money on Saturdays, so here Saturday is never a working day.
 */
export function dueDates(invoice: string, days: readonly number[], terms: DueTerms): DueDate[] {
	const week = terms.patrono === undefined ? {} : { patrono: terms.patrono };
	const settle = (date: string) => {
		const ended = terms.endOfMonth ? endOfMonth(date) : date;
		if (terms.fixedDay === undefined) return ended;
		const next = addMonths(`${ended.slice(0, 8)}01`, 1).date;
		return isoDate(Number(next.slice(0, 4)), Number(next.slice(5, 7)), Math.min(terms.fixedDay, daysInMonth(Number(next.slice(0, 4)), Number(next.slice(5, 7)))));
	};
	return days.map((n) => {
		const date = inRange(settle(addDays(invoice, n)));
		const byMonths = terms.endOfMonth && n > 0 && n % 30 === 0 ? settle(addMonths(invoice, n / 30).date) : undefined;
		let slip: DueDate["slip"];
		if (!workingDay(date, week)) {
			let to = addDays(date, 1);
			while (!workingDay(to, week)) to = addDays(to, 1);
			const holiday = holidayOn(date, terms.patrono);
			slip = { to, ...(holiday === undefined ? {} : { holiday }) };
		}
		return { days: n, date, ...(slip === undefined ? {} : { slip }), ...(byMonths !== undefined && byMonths !== date ? { byMonths } : {}) };
	});
}

export type Age = {
	readonly years: number;
	/** The next birthday, today when it is today. */
	readonly next: string;
	readonly daysToNext: number;
	/** Born on 29 February: in other years the birthday is counted on 1 March. */
	readonly leapling: boolean;
};

/**
 * Age in completed years on `today`. Someone born on 29 February completes a year on 1 March in
 * years without one, the reading Italian law gives to a term that falls on a missing day.
 */
export function ageOn(birth: string, today: string): Age {
	if (birth > today) throw new DateError("la data di nascita è nel futuro");
	const leapling = birth.slice(5) === "02-29";
	const anniversary = (year: number) => (leapling && !realDate(isoDate(year, 2, 29)) ? isoDate(year, 3, 1) : `${String(year).padStart(4, "0")}-${birth.slice(5)}`);
	const year = Number(today.slice(0, 4));
	const thisYear = anniversary(year);
	const years = year - Number(birth.slice(0, 4)) - (thisYear > today ? 1 : 0);
	const next = thisYear >= today ? thisYear : anniversary(year + 1);
	return { years, next, daysToNext: daysBetween(today, next), leapling };
}

/** Lower case, no accents, single spaces, «1°» as 1, without a leading article or weekday. */
function normalized(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[’`]/g, "'")
		.replace(/(\d)\s*[°ºª]/g, "$1")
		.replace(/[,]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:il|l'|lo|la) ?/, "")
		.replace(new RegExp(`^(?:${WEEKDAYS.join("|")}) (?=\\d)`), "")
		.trim();
}

/** A month's name or its first three or more letters (mar, sett). */
function monthNumber(word: string): number | undefined {
	if (word.length < 3) return undefined;
	const found = MONTHS.flatMap((name, i) => (name.startsWith(word) ? [i + 1] : []));
	return found.length === 1 ? found[0] : undefined;
}

/** A day and month with the year written (four or two digits) or not. */
function dated(day: number, month: number, year: string | undefined, reference: string, rule: YearRule): string {
	if (year === undefined) {
		checkDay(day, month, undefined);
		return inRange(occurrence((y) => isoDate(y, month, day), reference, rule));
	}
	const refYear = Number(reference.slice(0, 4));
	if (year.length === 4) return built(Number(year), month, day);
	const yy = Number(year);
	if (rule === "next") return built(closestCentury(yy, refYear), month, day);
	checkDay(day, month, undefined);
	// The latest century not after the reference day.
	for (const century of [Math.floor(refYear / 100) * 100, Math.floor(refYear / 100) * 100 - 100]) {
		const candidate = isoDate(century + yy, month, day);
		if (realDate(candidate) && candidate <= reference) return inRange(candidate);
	}
	return built(Math.floor(refYear / 100) * 100 - 100 + yy, month, day);
}

function closestCentury(yy: number, around: number): number {
	const candidates = [-100, 0, 100].map((shift) => Math.floor(around / 100) * 100 + shift + yy);
	return candidates.reduce((best, year) => (Math.abs(year - around) < Math.abs(best - around) ? year : best));
}

function built(year: number, month: number, day: number): string {
	checkDay(day, month, year);
	return inRange(isoDate(year, month, day));
}

/** A day that exists in its month (in its year when given; 29/02 is fine without one). */
function checkDay(day: number, month: number, year: number | undefined): void {
	if (month < 1 || month > 12) throw new DateError(`${month} non è un mese`);
	const name = MONTHS[month - 1] as string;
	const last = year === undefined ? daysInMonth(2000, month) : daysInMonth(year, month);
	if (day < 1 || day > last) {
		const which = year === undefined ? name : `${name} ${year}`;
		throw new DateError(`il ${day} ${which} non esiste: ${which} ha ${last} giorni`);
	}
}

/** The first occurrence from `reference` on, or the latest up to it; years without the day (29 February) are skipped. */
function occurrence(dateIn: (year: number) => string, reference: string, rule: YearRule): string {
	const year = Number(reference.slice(0, 4));
	for (let i = 0; i <= 8; i++) {
		const candidate = dateIn(rule === "next" ? year + i : year - i);
		if (realDate(candidate) && (rule === "next" ? candidate >= reference : candidate <= reference)) return candidate;
	}
	throw new DateError("non trovo quella data negli anni vicini");
}

/** User text for a message, after a space: quoted when short, never echoed when long. */
function shown(text: string): string {
	const t = text.trim();
	return t.length <= 40 && !/[\r\n<>«»]/.test(t) ? ` «${t}»` : "";
}
