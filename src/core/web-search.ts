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
};

export type SearchResult = { readonly title: string; readonly url: string; readonly snippet: string; readonly age?: string };

export type SearchOptions = {
	/** Results wanted, 1 to 10. */
	readonly count?: number;
	/** Only pages from the last day, week, month or year. */
	readonly freshness?: "day" | "week" | "month" | "year";
};

export type WebSearch = (query: string, options?: SearchOptions) => Promise<SearchResult[]>;

/** The service refused or failed: a reason the model can pass on, never the key. */
export class WebSearchError extends Error {}

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

/** Brave Search's web endpoint (the same API at any address, for tests). */
export function braveSearch(config: WebSearchConfig, fetchImpl: typeof fetch = fetch): WebSearch {
	return async (query, options = {}) => {
		const url = new URL(config.url);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(Math.min(10, Math.max(1, options.count ?? 5))));
		url.searchParams.set("text_decorations", "false");
		if (options.freshness !== undefined) url.searchParams.set("freshness", FRESHNESS[options.freshness]);
		let response: Response;
		try {
			response = await fetchImpl(url, { headers: { accept: "application/json", "x-subscription-token": config.apiKey }, signal: AbortSignal.timeout(15_000) });
		} catch {
			throw new WebSearchError("il servizio di ricerca non risponde");
		}
		if (response.status === 401 || response.status === 403) throw new WebSearchError("il servizio di ricerca rifiuta la chiave del server");
		if (response.status === 429) throw new WebSearchError("troppe ricerche in poco tempo, riprova fra poco");
		if (!response.ok) throw new WebSearchError(`il servizio di ricerca risponde ${response.status}`);
		const body = (await response.json().catch(() => ({}))) as { web?: { results?: unknown[] } };
		return (body.web?.results ?? []).flatMap((item) => {
			const r = item as { title?: unknown; url?: unknown; description?: unknown; age?: unknown };
			if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) return [];
			return [
				{
					title: plain(r.title).slice(0, 300),
					url: r.url.slice(0, 2000),
					snippet: plain(r.description).slice(0, 600),
					...(typeof r.age === "string" && r.age !== "" ? { age: r.age.slice(0, 40) } : {}),
				},
			];
		});
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
