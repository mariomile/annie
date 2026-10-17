/**
 * JSON or text from the operator's services (search, weather, exchange rates): one GET with a
 * timeout and a size cap, every failure handed to the caller to name in its own words. Never the
 * address or the key.
 */

export type HttpProblem = { readonly kind: "status"; readonly status: number } | { readonly kind: "unreachable" | "too_big" | "unreadable" };

export type GetInit = {
	readonly fetch: typeof fetch;
	readonly headers?: Record<string, string>;
	/** Larger bodies are refused unread. */
	readonly maxBytes: number;
	/** For the whole exchange, body included: 15 seconds unless a large file needs longer. */
	readonly timeoutMs?: number;
};

/** Thrown by `capped` only, turned into the caller's error by getText. */
class BodyTooLarge extends Error {}

/** The JSON object at `url`, or the caller's error for what went wrong. */
export async function getJson(url: URL, init: GetInit, error: (problem: HttpProblem) => Error): Promise<object> {
	const text = await getText(url, { ...init, headers: { accept: "application/json", ...init.headers } }, error);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw error({ kind: "unreadable" });
	}
	if (typeof body !== "object" || body === null) throw error({ kind: "unreadable" });
	return body;
}

/** The body at `url` as text, or the caller's error for what went wrong. */
export async function getText(url: URL, init: GetInit, error: (problem: HttpProblem) => Error): Promise<string> {
	let response: Response;
	try {
		response = await init.fetch(url, { headers: { ...init.headers }, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
	} catch {
		throw error({ kind: "unreachable" });
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw error({ kind: "status", status: response.status });
	}
	try {
		return await capped(response, init.maxBytes);
	} catch (cause) {
		throw error({ kind: cause instanceof BodyTooLarge ? "too_big" : "unreachable" });
	}
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
			throw new BodyTooLarge();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Text without tags or entities a service may still put in. */
export function plain(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e] ?? "")
		.replace(/\s+/g, " ")
		.trim();
}
