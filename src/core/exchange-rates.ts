/**
 * Exchange rates for instances: the European Central Bank's euro foreign exchange reference
 * rates, about thirty currencies against the euro, published around 16:00 CET on TARGET working
 * days. Official, free and without a key; only a fixed public file is fetched, so nothing about
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
export const PUBLICATION_TIME = "16:00";

export type DayRates = {
	/** YYYY-MM-DD. */
	readonly date: string;
	/** Units of each currency for one euro; EUR itself is not listed. */
	readonly rates: ReadonlyMap<string, number>;
};

/** Why the day used is not the day asked: a weekend, a TARGET holiday, or today's rates not out (yet). */
export type Fallback = "weekend" | "holiday" | "not_yet" | "not_published";

export type RatesOn = { readonly asked: string; readonly day: DayRates; readonly fallback?: Fallback };

export type ExchangeRates = {
	/** The rates of `date` (YYYY-MM-DD, today if not given), or of the last day published before it. */
	rateOn(date?: string): Promise<RatesOn>;
};

/** A date out of range, a missing day or a failed download: a reason in Italian, never the address. */
export class ExchangeRateError extends Error {}

type Source = { readonly file: string; readonly ttlMs: number; readonly maxBytes: number; readonly timeoutMs: number };

const HOUR = 3600_000;
const MB = 1024 * 1024;
/** One day: a couple of kilobytes. */
const DAILY: Source = { file: "eurofxref-daily.xml", ttlMs: HOUR, maxBytes: MB / 4, timeoutMs: 15_000 };
/** About 64 working days: under 100 kilobytes. */
const RECENT: Source = { file: "eurofxref-hist-90d.xml", ttlMs: 6 * HOUR, maxBytes: 2 * MB, timeoutMs: 15_000 };
/** Since 1999: some 7,000 days of about 30 currencies, around 9 MB in 2026 and a third of a megabyte more each year. */
const HISTORY: Source = { file: "eurofxref-hist.xml", ttlMs: 24 * HOUR, maxBytes: 32 * MB, timeoutMs: 60_000 };
/** Days the 90-day file reaches back. */
const RECENT_DAYS = 90;
/** The longest run without rates is four days (Good Friday to Easter Monday): a longer one means a file is missing days. */
const MAX_GAP_DAYS = 7;
/** Real days list 30 to 40 currencies: more is not the ECB's file. */
const MAX_CURRENCIES = 64;
/** From the old Turkish lira (about 1.9 million for a euro) to the pound: anything outside is not a rate. */
const MIN_RATE = 0.0001;
const MAX_RATE = 10_000_000;

/** The ECB's files at config.url, each kept in memory for its time; the history only when asked for a date older than 90 days. */
export function ecbRates(config: ExchangeRatesConfig, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): ExchangeRates {
	const cache = new Map<string, { at: number; days: Promise<DayRates[]> }>();
	const load = (source: Source): Promise<DayRates[]> => {
		const at = now().getTime();
		const hit = cache.get(source.file);
		if (hit !== undefined && at - hit.at < source.ttlMs) return hit.days;
		// Shared by calls at the same time; a failure is forgotten, so the next call tries again.
		const days = fetchDays(config.url, source, fetchImpl);
		cache.set(source.file, { at, days });
		days.catch(() => {
			if (cache.get(source.file)?.days === days) cache.delete(source.file);
		});
		return days;
	};
	return {
		async rateOn(date) {
			const { today, time } = frankfurtNow(now());
			const asked = date ?? today;
			checkDate(asked, today);
			const source = asked === today ? DAILY : asked >= addDays(today, -RECENT_DAYS) ? RECENT : HISTORY;
			let day = latestOn(await load(source), asked);
			if (day === undefined && source === RECENT) day = latestOn(await load(HISTORY), asked);
			if (day === undefined || addDays(day.date, MAX_GAP_DAYS) < asked) throw new ExchangeRateError("la BCE non ha cambi pubblicati vicino a quella data");
			const fallback = fallbackOf(asked, day.date, today, time);
			return { asked, day, ...(fallback === undefined ? {} : { fallback }) };
		},
	};
}

/** Units of `to` for one unit of `from`, through the euro; undefined when the ECB does not publish one of them that day. */
export function rateBetween(day: DayRates, from: string, to: string): number | undefined {
	const perEuro = (currency: string) => (currency === "EUR" ? 1 : day.rates.get(currency));
	const fromRate = perEuro(from);
	const toRate = perEuro(to);
	return fromRate === undefined || toRate === undefined ? undefined : toRate / fromRate;
}

/** The currencies of that day, the euro included, in alphabetical order. */
export function currenciesOf(day: DayRates): string[] {
	return [...day.rates.keys(), "EUR"].sort();
}

const TAG = /<Cube\b([^<>]*)>/g;
const TIME = /^\s+time=(["'])(\d{4}-\d{2}-\d{2})\1\s*$/;
const RATE = /^\s+currency=(["'])([A-Z]{3})\1\s+rate=(["'])(\d{1,8}(?:\.\d{1,10})?)\3\s*\/$/;

/**
 * The days of an ECB file, oldest first. Only `<Cube time="YYYY-MM-DD">` and, inside it,
 * `<Cube currency="XXX" rate="n"/>` count; any other text is ignored. A real date from 1999 on,
 * three capital letters, a plain decimal in range: anything else is dropped, and a day that
 * repeats a currency or lists too many is dropped whole.
 */
export function parseEcbXml(xml: string): DayRates[] {
	const days = new Map<string, Map<string, number>>();
	let date: string | undefined;
	for (const [, attributes = ""] of xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "").matchAll(TAG)) {
		if (attributes.trim() === "") continue;
		const time = TIME.exec(attributes);
		if (time !== null || /\btime\s*=/.test(attributes)) {
			const value = time?.[2];
			date = value !== undefined && realDate(value) && value >= FIRST_RATES_DATE && !days.has(value) ? value : undefined;
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

function checkDate(date: string, today: string): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !realDate(date)) throw new ExchangeRateError("la data va scritta come AAAA-MM-GG, ed esistere");
	if (date > today) throw new ExchangeRateError("la data è nel futuro: i cambi di un giorno escono quel giorno verso le 16:00");
	if (date < FIRST_RATES_DATE) throw new ExchangeRateError("i cambi di riferimento della BCE partono dal 4 gennaio 1999");
}

function fallbackOf(asked: string, used: string, today: string, time: string): Fallback | undefined {
	if (used === asked) return undefined;
	const weekday = new Date(`${asked}T00:00:00Z`).getUTCDay();
	if (weekday === 0 || weekday === 6) return "weekend";
	if (asked === today) return time < PUBLICATION_TIME ? "not_yet" : "not_published";
	return "holiday";
}

const FRANKFURT = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Today's date and the time in Frankfurt, where the rates are published. */
function frankfurtNow(now: Date): { today: string; time: string } {
	const p = Object.fromEntries(FRANKFURT.formatToParts(now).map((part) => [part.type, part.value]));
	return { today: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** YYYY-MM-DD that exists (no 30 February). */
function realDate(date: string): boolean {
	const parsed = Date.parse(`${date}T00:00:00Z`);
	return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
