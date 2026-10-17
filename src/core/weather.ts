/**
 * Weather for instances: Open-Meteo (EU) finds a place by name, then gives its conditions now
 * and a forecast day by day. No key for non-commercial use; a commercial plan adds one (and
 * customer- hosts). Only the place name and its coordinates leave the server.
 */
import { capped, plain } from "./web-search.ts";

export type WeatherConfig = {
	/** The forecast endpoint, e.g. https://api.open-meteo.com/v1/forecast. */
	readonly forecastUrl: string;
	/** The geocoding endpoint, e.g. https://geocoding-api.open-meteo.com/v1/search. */
	readonly geocodingUrl: string;
	/** Only for a commercial plan: sent as the apikey parameter. */
	readonly apiKey?: string;
	/** Weather requests a tenant may make in a day, all its instances together. */
	readonly maxPerDay: number;
};

export const DEFAULT_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const DEFAULT_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
/** The longest forecast Open-Meteo gives, in days. */
export const MAX_FORECAST_DAYS = 16;

export type Place = {
	readonly name: string;
	readonly admin1?: string;
	readonly country?: string;
	/** Two capital letters, e.g. IT. */
	readonly countryCode?: string;
	readonly latitude: number;
	readonly longitude: number;
	/** An IANA zone, e.g. Europe/Rome. */
	readonly timezone?: string;
	/** 0 when the service does not say. */
	readonly population: number;
};

export type CurrentWeather = {
	/** Local time at the place, YYYY-MM-DDTHH:MM. */
	readonly time: string;
	readonly code?: number;
	readonly temperature?: number;
	readonly feelsLike?: number;
	readonly humidity?: number;
	readonly precipitation?: number;
	readonly wind?: number;
	readonly gusts?: number;
	readonly isDay?: boolean;
};

export type DayForecast = {
	/** YYYY-MM-DD, local. */
	readonly date: string;
	readonly code?: number;
	readonly min?: number;
	readonly max?: number;
	readonly precipitation?: number;
	readonly rainChance?: number;
	readonly windMax?: number;
	/** Local HH:MM. */
	readonly sunrise?: string;
	readonly sunset?: string;
	readonly uvMax?: number;
};

export type Forecast = { readonly current?: CurrentWeather; readonly days: readonly DayForecast[] };

export type Weather = {
	/** Up to five places with this name, in this country (two letters) if given. */
	geocode(name: string, country?: string): Promise<Place[]>;
	/** Now and `days` days from today, 1 to 16. */
	forecast(place: Place, days: number): Promise<Forecast>;
};

/** The service refused or failed: a reason the model can pass on, never the key or the address. */
export class WeatherError extends Error {}

/** A place and a forecast are a few kilobytes: anything past this is not an answer. */
const MAX_BODY = 1024 * 1024;
const CURRENT = ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation", "weather_code", "wind_speed_10m", "wind_gusts_10m", "is_day"];
const DAILY = ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max", "wind_speed_10m_max", "sunrise", "sunset", "uv_index_max"];

/** Open-Meteo's geocoding and forecast APIs (the same APIs at any address, for tests). */
export function openMeteo(config: WeatherConfig, fetchImpl: typeof fetch = fetch): Weather {
	const get = async (endpoint: string, params: Record<string, string>): Promise<unknown> => {
		const url = new URL(endpoint);
		for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
		if (config.apiKey !== undefined) url.searchParams.set("apikey", config.apiKey);
		return fetchJson(url, fetchImpl);
	};
	return {
		async geocode(name, country) {
			const body = await get(config.geocodingUrl, { name, count: "5", language: "it", format: "json", ...(country === undefined ? {} : { countryCode: country }) });
			const results = (body as { results?: unknown }).results;
			return Array.isArray(results) ? results.flatMap(placeOf) : [];
		},
		async forecast(place, days) {
			const body = await get(config.forecastUrl, {
				latitude: String(place.latitude),
				longitude: String(place.longitude),
				current: CURRENT.join(","),
				daily: DAILY.join(","),
				timezone: place.timezone ?? "auto",
				forecast_days: String(Math.min(MAX_FORECAST_DAYS, Math.max(1, Math.floor(days)))),
			});
			const { current, daily } = body as { current?: unknown; daily?: unknown };
			const now = currentOf(current);
			return { ...(now === undefined ? {} : { current: now }), days: daysOf(daily) };
		},
	};
}

/** One request, its JSON parsed; every failure as a WeatherError in Italian. */
async function fetchJson(url: URL, fetchImpl: typeof fetch): Promise<unknown> {
	let text: string;
	try {
		const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new WeatherError(statusReason(response.status));
		}
		text = await capped(response, MAX_BODY, () => new WeatherError("il servizio meteo ha mandato una risposta troppo grande"));
	} catch (error) {
		if (error instanceof WeatherError) throw error;
		throw new WeatherError("il servizio meteo non risponde");
	}
	try {
		const body: unknown = JSON.parse(text);
		if (typeof body !== "object" || body === null) throw new Error("not an object");
		return body;
	} catch {
		throw new WeatherError("il servizio meteo ha risposto in modo illeggibile");
	}
}

function statusReason(status: number): string {
	if (status === 401 || status === 403) return "il servizio meteo rifiuta la chiave del server";
	if (status === 429) return "troppe richieste al servizio meteo in poco tempo, riprova fra poco";
	if (status === 400) return "il servizio meteo non accetta la richiesta";
	return `il servizio meteo risponde ${status}`;
}

function placeOf(item: unknown): Place[] {
	const r = item as Record<string, unknown>;
	const name = text(r.name, 100);
	const latitude = finite(r.latitude);
	const longitude = finite(r.longitude);
	if (name === undefined || latitude === undefined || longitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
	const admin1 = text(r.admin1, 100);
	const country = text(r.country, 100);
	const countryCode = typeof r.country_code === "string" && /^[A-Za-z]{2}$/.test(r.country_code) ? r.country_code.toUpperCase() : undefined;
	const timezone = typeof r.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(r.timezone) ? r.timezone : undefined;
	const population = finite(r.population);
	return [
		{
			name,
			...(admin1 === undefined ? {} : { admin1 }),
			...(country === undefined ? {} : { country }),
			...(countryCode === undefined ? {} : { countryCode }),
			latitude,
			longitude,
			...(timezone === undefined ? {} : { timezone }),
			population: population !== undefined && population > 0 ? population : 0,
		},
	];
}

function currentOf(value: unknown): CurrentWeather | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const c = value as Record<string, unknown>;
	const time = localTime(c.time);
	if (time === undefined) return undefined;
	const fields = {
		code: wmo(c.weather_code),
		temperature: finite(c.temperature_2m),
		feelsLike: finite(c.apparent_temperature),
		humidity: finite(c.relative_humidity_2m),
		precipitation: finite(c.precipitation),
		wind: finite(c.wind_speed_10m),
		gusts: finite(c.wind_gusts_10m),
		isDay: c.is_day === 1 ? true : c.is_day === 0 ? false : undefined,
	};
	return { time, ...defined(fields) };
}

function daysOf(value: unknown): DayForecast[] {
	if (typeof value !== "object" || value === null) return [];
	const d = value as Record<string, unknown>;
	if (!Array.isArray(d.time)) return [];
	const at = (field: string, i: number): unknown => (Array.isArray(d[field]) ? (d[field] as unknown[])[i] : undefined);
	return d.time.slice(0, MAX_FORECAST_DAYS).flatMap((date: unknown, i: number) => {
		if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
		const fields = {
			code: wmo(at("weather_code", i)),
			min: finite(at("temperature_2m_min", i)),
			max: finite(at("temperature_2m_max", i)),
			precipitation: finite(at("precipitation_sum", i)),
			rainChance: finite(at("precipitation_probability_max", i)),
			windMax: finite(at("wind_speed_10m_max", i)),
			sunrise: localTime(at("sunrise", i))?.slice(11),
			sunset: localTime(at("sunset", i))?.slice(11),
			uvMax: finite(at("uv_index_max", i)),
		};
		return [{ date, ...defined(fields) }];
	});
}

/** The fields that have a value: optional properties stay absent, not undefined. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
	return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
	const clean = plain(value).slice(0, max);
	return clean === "" ? undefined : clean;
}

/** YYYY-MM-DDTHH:MM, as Open-Meteo writes local times. */
function localTime(value: unknown): string | undefined {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(0, 16) : undefined;
}

function wmo(value: unknown): number | undefined {
	const code = finite(value);
	return code !== undefined && Number.isInteger(code) ? code : undefined;
}

/** WMO weather codes, as Open-Meteo documents them, in Italian. */
export const WEATHER_CODES: Readonly<Record<number, string>> = {
	0: "sereno",
	1: "poco nuvoloso",
	2: "parzialmente nuvoloso",
	3: "coperto",
	45: "nebbia",
	48: "nebbia con brina",
	51: "pioviggine debole",
	53: "pioviggine moderata",
	55: "pioviggine intensa",
	56: "pioviggine gelata debole",
	57: "pioviggine gelata intensa",
	61: "pioggia debole",
	63: "pioggia moderata",
	65: "pioggia forte",
	66: "pioggia gelata debole",
	67: "pioggia gelata forte",
	71: "neve debole",
	73: "neve moderata",
	75: "neve forte",
	77: "neve granulosa",
	80: "rovesci deboli",
	81: "rovesci moderati",
	82: "rovesci violenti",
	85: "rovesci di neve deboli",
	86: "rovesci di neve forti",
	95: "temporale",
	96: "temporale con grandine debole",
	99: "temporale con grandine forte",
};

/** The words for a code; a code the table does not know is said as such. */
export function weatherWords(code: number | undefined): string {
	if (code === undefined) return "condizioni non indicate";
	return WEATHER_CODES[code] ?? `condizioni con codice ${code}`;
}

const NUMBER = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });
const DAY = new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** 12,5: at most one decimal, with a comma. */
export function italianNumber(value: number): string {
	return NUMBER.format(value);
}

/** 2026-10-17 → sabato 17 ottobre. */
export function italianDay(date: string): string {
	return DAY.format(new Date(`${date}T00:00:00Z`));
}
