/**
 * Web search for instances (ADR 0017): the operator's search service answers a query with
 * titles, addresses and snippets. Brave Search by default, an independent index; the key is
 * the operator's, the query is the only thing that leaves.
 */

/** The instance's switch: in its egress connectors, set by the owner. */
export const WEB_SEARCH_CONNECTOR = "web_search";

export type WebSearchConfig = {
	/** The search endpoint, e.g. https://api.search.brave.com/res/v1/web/search. */
	readonly url: string;
	readonly apiKey: string;
	/** Where results come from and in which language, unless a search asks otherwise: IT and it by default. */
	readonly country: string;
	readonly language: string;
	/** Searches a tenant may make in a day, all its instances together. */
	readonly maxPerDay: number;
};

export type SearchResult = { readonly title: string; readonly url: string; readonly snippet: string; readonly age?: string };

export type SearchOptions = {
	/** Results wanted, 1 to 10. */
	readonly count?: number;
	/** Only pages from the last day, week, month or year. */
	readonly freshness?: "day" | "week" | "month" | "year";
	/** Results from this country (two letters), or ALL; the server's default otherwise. */
	readonly country?: string;
};

export type WebSearch = (query: string, options?: SearchOptions) => Promise<SearchResult[]>;

/** The service refused or failed: a reason the model can pass on, never the key. */
export class WebSearchError extends Error {}

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;
/** Ten results are a few kilobytes: anything past this is not an answer. */
const MAX_BODY = 1024 * 1024;

/** Brave Search's web endpoint (the same API at any address, for tests). */
export function braveSearch(config: WebSearchConfig, fetchImpl: typeof fetch = fetch): WebSearch {
	return async (query, options = {}) => {
		const url = new URL(config.url);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(Math.min(10, Math.max(1, options.count ?? 5))));
		url.searchParams.set("country", options.country ?? config.country);
		url.searchParams.set("search_lang", config.language);
		url.searchParams.set("text_decorations", "false");
		if (options.freshness !== undefined) url.searchParams.set("freshness", FRESHNESS[options.freshness]);
		let response: Response;
		let text: string;
		try {
			response = await fetchImpl(url, { headers: { accept: "application/json", "x-subscription-token": config.apiKey }, signal: AbortSignal.timeout(15_000) });
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new WebSearchError(
					response.status === 401 || response.status === 403 ? "il servizio di ricerca rifiuta la chiave del server" : response.status === 429 ? "troppe ricerche in poco tempo, riprova fra poco" : `il servizio di ricerca risponde ${response.status}`,
				);
			}
			text = await capped(response, MAX_BODY);
		} catch (error) {
			if (error instanceof WebSearchError) throw error;
			throw new WebSearchError("il servizio di ricerca non risponde");
		}
		let body: { web?: { results?: unknown[] } };
		try {
			body = JSON.parse(text) as typeof body;
		} catch {
			throw new WebSearchError("il servizio di ricerca ha risposto in modo illeggibile");
		}
		return (body.web?.results ?? []).flatMap((item) => {
			const r = item as { title?: unknown; url?: unknown; description?: unknown; age?: unknown };
			if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) return [];
			return [
				{
					title: plain(r.title).slice(0, 300),
					url: r.url.slice(0, 2000),
					snippet: plain(r.description).slice(0, 600),
					...(typeof r.age === "string" && r.age !== "" ? { age: plain(r.age).slice(0, 40) } : {}),
				},
			];
		});
	};
}

/** The body as text, refused past `max` bytes. */
async function capped(response: Response, max: number): Promise<string> {
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			throw new WebSearchError("il servizio di ricerca ha mandato una risposta troppo grande");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * At most `max` searches a day per tenant, counted in this process (a restart starts the day
 * again): a loop or a task gone wrong cannot spend the operator's quota.
 */
export function dailyLimit(max: number, now: () => Date = () => new Date()): (tenant: string) => boolean {
	const counter = dailyCounter(max, now);
	return (tenant) => {
		if (counter.left(tenant) < 1) return false;
		counter.spend(tenant, 1);
		return true;
	};
}

/** The same daily count, read and spent apart: what is spent only when it worked (pictures). */
export function dailyCounter(max: number, now: () => Date = () => new Date()): { left(tenant: string): number; spend(tenant: string, n: number): void } {
	const used = new Map<string, number>();
	const keyOf = (tenant: string) => `${tenant} ${now().toISOString().slice(0, 10)}`;
	return {
		left: (tenant) => Math.max(0, max - (used.get(keyOf(tenant)) ?? 0)),
		spend: (tenant, n) => {
			if (used.size > 1000) used.clear();
			used.set(keyOf(tenant), (used.get(keyOf(tenant)) ?? 0) + n);
		},
	};
}

/** Text without tags or entities the service may still put in. */
function plain(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e] ?? "")
		.replace(/\s+/g, " ")
		.trim();
}
