/**
 * Exchange rates for instances: the European Central Bank's euro foreign exchange reference
 * rates, 29 currencies against the euro in 2026, published around 16:00 CET on TARGET working
 * days. Official, free and without a key; only fixed public files are fetched, so nothing about
 * the person leaves the server. The XML is read with a few strict patterns, never an XML library.
 */
import { getText, type HttpProblem } from "./http.ts";

export type ExchangeRatesConfig = {
	/** The folder of the ECB's files, e.g. https://www.ecb.europa.eu/stats/eurofxref. */
	readonly url: string;
};

export const DEFAULT_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref";
/** The first day of the reference rates. */
export const FIRST_RATES_DATE = "1999-01-04";
/** Frankfurt's time (the same as Rome's) when the day's rates are out. */
const PUBLICATION_TIME = "16:00";
/** Frankfurt's time after which a working day without rates is taken as a day without them. */
const GIVE_UP_TIME = "18:00";

export type DayRates = {
	/** YYYY-MM-DD. */
	readonly date: string;
	/** Units of each currency for one euro; EUR itself is not listed. */
	readonly rates: ReadonlyMap<string, number>;
};

/**
 * Why the day used is not the day asked: a weekend, a TARGET holiday, today before 16:00, today
 * between 16:00 and 18:00 with nothing yet, today after 18:00 with nothing, or a past working day
 * the ECB skipped.
 */
export type Fallback = "weekend" | "holiday" | "not_yet" | "late" | "not_published" | "missing";

export type RatesOn = { readonly asked: string; readonly today: string; readonly day: DayRates; readonly fallback?: Fallback };

/** The days from the one in force at `since` to the one in force at the end, both included. */
export type RatesSeries = { readonly since: string; readonly until: string; readonly days: readonly DayRates[] };

export type ExchangeRates = {
	/** Today in Frankfurt, YYYY-MM-DD. */
	today(): string;
	/** The rates of `date` (YYYY-MM-DD, today if not given), or of the last day published before it. */
	rateOn(date?: string): Promise<RatesOn>;
	/** The days from `since` (at most a year back) to `until` (today if not given). */
	series(since: string, until?: string): Promise<RatesSeries>;
};

/** A date out of range, a missing day or a failed download: a reason in Italian, never the address. */
export class ExchangeRateError extends Error {}

type Source = { readonly file: string; readonly ttlMs: number; readonly maxBytes: number; readonly timeoutMs: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MB = 1024 * 1024;
/** One day: a couple of kilobytes. Kept until the next publication is due, not for a fixed time. */
const DAILY: Source = { file: "eurofxref-daily.xml", ttlMs: 0, maxBytes: MB / 4, timeoutMs: 15_000 };
/** About 64 working days: under 100 kilobytes. */
const RECENT: Source = { file: "eurofxref-hist-90d.xml", ttlMs: 6 * HOUR, maxBytes: 2 * MB, timeoutMs: 15_000 };
/** Since 1999: some 7,000 days of about 30 currencies, by our estimate under 10 MB in 2026, growing a fraction of a megabyte a year. */
const HISTORY: Source = { file: "eurofxref-hist.xml", ttlMs: 6 * HOUR, maxBytes: 32 * MB, timeoutMs: 60_000 };
/** A failed download is answered with the same error for this long, without asking again. */
const FAILURE_TTL_MS = 2 * MINUTE;
/** After 16:00 a day's file without today is asked again at most this often, until 18:00. */
const RETRY_AFTER_PUBLICATION_MS = 5 * MINUTE;
/** After 18:00, for a late publication, at most this often until midnight. */
const RETRY_LATE_MS = HOUR;
/** Days the 90-day file reaches back. */
const RECENT_DAYS = 90;
/** How far back a trend may start. */
const SERIES_DAYS = 366;
/** The longest run without rates is four days (Good Friday to Easter Monday): a longer one means a file is missing days. */
const MAX_GAP_DAYS = 7;
/** Real days list 30 to 40 currencies: more is not the ECB's file. */
const MAX_CURRENCIES = 64;
/** From the old Turkish lira (about 1.9 million for a euro) to the pound: anything outside is not a rate. */
const MIN_RATE = 0.0001;
const MAX_RATE = 10_000_000;

/** A download: when, Frankfurt's time then, and what came of it once it is known. */
type Entry = { readonly at: number; readonly local: string; readonly days: Promise<DayRates[]>; latest?: string; failed?: boolean };

/** The ECB's files at config.url, each kept in memory for its time; the history only when asked for a date older than 90 days. */
export function ecbRates(config: ExchangeRatesConfig, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): ExchangeRates {
	const cache = new Map<string, Entry>();
	const fresh = (entry: Entry, source: Source, at: number, clock: Clock): boolean => {
		if (entry.failed === true) return at - entry.at < FAILURE_TTL_MS;
		if (entry.latest === undefined) return true; // still downloading: shared
		return source === DAILY ? dailyFresh(entry, at, clock) : at - entry.at < source.ttlMs;
	};
	const load = (source: Source): Promise<DayRates[]> => {
		const at = now().getTime();
		const clock = frankfurt(new Date(at));
		const hit = cache.get(source.file);
		if (hit !== undefined && fresh(hit, source, at, clock)) return hit.days;
		const entry: Entry = { at, local: `${clock.today} ${clock.time}`, days: fetchDays(config.url, source, fetchImpl) };
		entry.days.then(
			(days) => {
				entry.latest = days.at(-1)?.date;
			},
			() => {
				entry.failed = true;
			},
		);
		cache.set(source.file, entry);
		return entry.days;
	};
	/** The file for a day, falling back to the history when the 90 days' file does not reach it. */
	const daysFor = async (date: string, today: string): Promise<readonly DayRates[]> => {
		const source = date === today ? DAILY : date >= addDays(today, -RECENT_DAYS) ? RECENT : HISTORY;
		const days = await load(source);
		return source === RECENT && latestOn(days, date) === undefined ? load(HISTORY) : days;
	};
	return {
		today: () => frankfurt(now()).today,
		async rateOn(date) {
			const { today, time } = frankfurt(now());
			const asked = date ?? today;
			checkDate(asked, today);
			const day = inForce(await daysFor(asked, today), asked);
			const fallback = fallbackOf(asked, day.date, today, time);
			return { asked, today, day, ...(fallback === undefined ? {} : { fallback }) };
		},
		async series(since, until) {
			const { today } = frankfurt(now());
			const end = until ?? today;
			checkDate(since, today);
			checkDate(end, today);
			if (since < addDays(today, -SERIES_DAYS)) throw new ExchangeRateError("un andamento parte al più da un anno fa");
			if (since >= end) throw new ExchangeRateError("since va prima della data finale");
			let days = await daysFor(since, today);
			// The 90 days' and the full file can be hours old: today's rates come from the day's file.
			if (end === today) {
				const [latest] = await load(DAILY);
				if (latest !== undefined && latest.date > (days.at(-1)?.date ?? "")) days = [...days, latest];
			}
			const first = inForce(days, since);
			const last = inForce(days, end);
			return { since, until: end, days: days.filter((d) => d.date >= first.date && d.date <= last.date) };
		},
	};
}

const TAG = /<Cube\b([^<>]*)>/g;
const TIME = /^\s+time=(["'])(\d{4}-\d{2}-\d{2})\1\s*$/;
const RATE = /^\s+currency=(["'])([A-Z]{3})\1\s+rate=(["'])(\d{1,8}(?:\.\d{1,10})?)\3\s*\/$/;
const ENVELOPE_END = /^<\/(?:[A-Za-z_][\w.-]*:)?Envelope>\s*$/;

/**
 * The days of an ECB file, oldest first; none unless the file ends with its closing envelope
 * (a cut download is not trusted). Only `<Cube time="YYYY-MM-DD">` and, inside it,
 * `<Cube currency="XXX" rate="n"/>` count; any other text is ignored. A real date from 1999 on,
 * three capital letters, a plain decimal in range: anything else is dropped. A day that repeats a
 * currency or lists too many is dropped whole, and a date seen twice stays dropped.
 */
export function parseEcbXml(xml: string): DayRates[] {
	if (!ENVELOPE_END.test(xml.slice(xml.lastIndexOf("</")))) return [];
	const days = new Map<string, Map<string, number>>();
	const seen = new Set<string>();
	let date: string | undefined;
	for (const [, attributes = ""] of xml.matchAll(TAG)) {
		if (attributes.trim() === "") continue;
		const time = TIME.exec(attributes);
		if (time !== null || /\btime\s*=/.test(attributes)) {
			const value = time?.[2];
			date = value !== undefined && realDate(value) && value >= FIRST_RATES_DATE && !seen.has(value) ? value : undefined;
			if (value !== undefined && seen.has(value)) days.delete(value);
			if (value !== undefined) seen.add(value);
			if (date !== undefined) days.set(date, new Map());
			continue;
		}
		const rates = date === undefined ? undefined : days.get(date);
		const match = RATE.exec(attributes);
		if (rates === undefined || match === null) continue;
		const [, , code = "", , text = ""] = match;
		const value = Number(text);
		if (code === "EUR" || !(value >= MIN_RATE && value <= MAX_RATE)) continue;
		if (rates.has(code) || rates.size >= MAX_CURRENCIES) {
			days.delete(date as string);
			date = undefined;
			continue;
		}
		rates.set(code, value);
	}
	return [...days]
		.filter(([, rates]) => rates.size > 0)
		.map(([day, rates]) => ({ date: day, rates }))
		.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The TARGET closing days besides weekends: 1 January, Good Friday, Easter Monday, 1 May, 25 and 26 December. */
export function targetHoliday(date: string): boolean {
	const monthDay = date.slice(5);
	if (["01-01", "05-01", "12-25", "12-26"].includes(monthDay)) return true;
	const easter = easterSunday(Number(date.slice(0, 4)));
	return date === addDays(easter, -2) || date === addDays(easter, 1);
}

/** A weekday that is not a TARGET holiday: a day the ECB publishes. */
export function targetWorkingDay(date: string): boolean {
	return !weekend(date) && !targetHoliday(date);
}

/** Easter Sunday of a Gregorian year (the anonymous Gregorian computus), YYYY-MM-DD. */
function easterSunday(year: number): string {
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
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type Clock = { readonly today: string; readonly time: string };

/**
 * The day's file is fresh while it has the last publication due (the last working day up to
 * today, today only from 16:00). Without it: asked again every 5 minutes from 16:00, every hour
 * from 18:00 until midnight for a late publication, and from there kept: that day the ECB
 * published nothing.
 */
function dailyFresh(entry: Entry, at: number, clock: Clock): boolean {
	const expected = expectedPublication(clock);
	if ((entry.latest ?? "") >= expected) return true;
	const giveUp = `${expected} ${GIVE_UP_TIME}`;
	if (`${clock.today} ${clock.time}` >= giveUp) return entry.local >= giveUp && (clock.today !== expected || at - entry.at < RETRY_LATE_MS);
	return entry.local >= `${expected} ${PUBLICATION_TIME}` && at - entry.at < RETRY_AFTER_PUBLICATION_MS;
}

/** The last TARGET working day up to today, counting today only from 16:00. */
function expectedPublication({ today, time }: Clock): string {
	let day = time >= PUBLICATION_TIME ? today : addDays(today, -1);
	while (!targetWorkingDay(day)) day = addDays(day, -1);
	return day;
}

async function fetchDays(base: string, source: Source, fetchImpl: typeof fetch): Promise<DayRates[]> {
	const url = new URL(`${base.replace(/\/+$/, "")}/${source.file}`);
	const xml = await getText(url, { fetch: fetchImpl, headers: { accept: "application/xml, text/xml" }, maxBytes: source.maxBytes, timeoutMs: source.timeoutMs }, ratesError);
	const days = parseEcbXml(xml);
	if (days.length === 0) throw ratesError({ kind: "unreadable" });
	return days;
}

function ratesError(problem: HttpProblem): ExchangeRateError {
	if (problem.kind === "status") return new ExchangeRateError(`il servizio dei cambi della BCE risponde ${problem.status}`);
	return new ExchangeRateError({ unreachable: "il servizio dei cambi della BCE non risponde", too_big: "il servizio dei cambi della BCE ha mandato un file troppo grande", unreadable: "il servizio dei cambi della BCE ha mandato un file illeggibile" }[problem.kind]);
}

/** A file covers `date` when its first day is not after it: then the day is the last one up to it. */
function latestOn(days: readonly DayRates[], date: string): DayRates | undefined {
	if (days[0] === undefined || days[0].date > date) return undefined;
	return days.findLast((day) => day.date <= date);
}

/** The day in force at `date`, close enough to trust. */
function inForce(days: readonly DayRates[], date: string): DayRates {
	const day = latestOn(days, date);
	if (day === undefined || addDays(day.date, MAX_GAP_DAYS) < date) throw new ExchangeRateError("la BCE non ha cambi pubblicati vicino a quella data");
	return day;
}

/** A real YYYY-MM-DD from 1999-01-04 to today, or the reason it is not. */
export function checkDate(date: string, today: string): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !realDate(date)) throw new ExchangeRateError("la data va scritta come AAAA-MM-GG, ed esistere");
	if (date > today) throw new ExchangeRateError("la data è nel futuro: i cambi di un giorno escono quel giorno verso le 16:00");
	if (date < FIRST_RATES_DATE) throw new ExchangeRateError("i cambi di riferimento della BCE partono dal 04/01/1999");
}

function fallbackOf(asked: string, used: string, today: string, time: string): Fallback | undefined {
	if (used === asked) return undefined;
	if (weekend(asked)) return "weekend";
	if (targetHoliday(asked)) return "holiday";
	if (asked !== today) return "missing";
	if (time < PUBLICATION_TIME) return "not_yet";
	return time < GIVE_UP_TIME ? "late" : "not_published";
}

function weekend(date: string): boolean {
	const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
	return weekday === 0 || weekday === 6;
}

const FRANKFURT = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Today's date and the time in Frankfurt, where the rates are published. */
function frankfurt(now: Date): Clock {
	const p = Object.fromEntries(FRANKFURT.formatToParts(now).map((part) => [part.type, part.value]));
	return { today: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** YYYY-MM-DD that exists (no 30 February). */
function realDate(date: string): boolean {
	const parsed = Date.parse(`${date}T00:00:00Z`);
	return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

export function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
