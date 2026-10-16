import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/**
 * Reading a public web page for an instance, without letting it reach anything else: only
 * http(s), only hosts the policy allows, never an address inside a network (loopback, private,
 * link-local, the cloud's metadata endpoint), checked on the address actually connected to (so
 * a DNS answer that changes between check and connect does not help), and again after every
 * redirect. Bounded in size and time.
 */
export type WebFetchOptions = {
	/** Whether this host may be read at all (the instance's egress policy). */
	readonly hostAllowed: (host: string) => boolean;
	/** Whether an address may be connected to; public addresses only unless a test says otherwise. */
	readonly addressAllowed?: (address: string) => boolean;
	readonly maxBytes?: number;
	readonly timeoutMs?: number;
	readonly maxRedirects?: number;
};

export type WebPage = { readonly url: string; readonly status: number; readonly contentType: string; readonly body: string; readonly truncated: boolean };

export class WebFetchRefused extends Error {
	override readonly name = "WebFetchRefused";
}

export async function webFetch(url: string, options: WebFetchOptions): Promise<WebPage> {
	let current = url;
	for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
		const target = checkedUrl(current, options);
		const answer = await get(target, options);
		if (answer.status >= 300 && answer.status < 400 && answer.location !== undefined) {
			current = new URL(answer.location, target).toString();
			continue;
		}
		return { url: target.toString(), status: answer.status, contentType: answer.contentType, body: answer.body, truncated: answer.truncated };
	}
	throw new WebFetchRefused("troppi redirect");
}

function checkedUrl(raw: string, options: WebFetchOptions): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new WebFetchRefused("indirizzo non valido");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebFetchRefused("solo indirizzi http e https");
	if (url.username !== "" || url.password !== "") throw new WebFetchRefused("niente credenziali nell'indirizzo");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) !== 0 && !(options.addressAllowed ?? publicAddress)(host)) throw new WebFetchRefused(`${host} è un indirizzo interno`);
	if (!options.hostAllowed(host)) throw new WebFetchRefused(`${host} non è tra i siti che questa istanza può leggere`);
	return url;
}

function get(url: URL, options: WebFetchOptions): Promise<{ status: number; location?: string; contentType: string; body: string; truncated: boolean }> {
	const allowed = options.addressAllowed ?? publicAddress;
	const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
	const timeoutMs = options.timeoutMs ?? 15_000;
	// The check runs on the address the socket connects to.
	const lookup = (hostname: string, opts: object, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
		dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
			if (error) return callback(error, "");
			const list = addresses as LookupAddress[];
			const bad = list.find((a) => !allowed(a.address));
			if (bad !== undefined) return callback(new WebFetchRefused(`${hostname} porta a un indirizzo interno`), "");
			if ((opts as { all?: boolean }).all) return callback(null, list);
			callback(null, list[0]?.address ?? "", list[0]?.family);
		});
	};
	return new Promise((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = send(url, { method: "GET", lookup, headers: { "user-agent": "Annie/1.0 (+https://github.com/mariomile/annie)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" } }, (res: IncomingMessage) => {
			const status = res.statusCode ?? 0;
			const contentType = String(res.headers["content-type"] ?? "");
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				return resolve({ status, location: res.headers.location, contentType, body: "", truncated: false });
			}
			const chunks: Buffer[] = [];
			let size = 0;
			let truncated = false;
			res.on("data", (chunk: Buffer) => {
				if (truncated) return;
				size += chunk.length;
				if (size > maxBytes) {
					truncated = true;
					chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
					res.destroy();
					return resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8"), truncated });
				}
				chunks.push(chunk);
			});
			res.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8"), truncated }));
			res.on("error", reject);
		});
		req.setTimeout(timeoutMs, () => req.destroy(new WebFetchRefused(`nessuna risposta in ${timeoutMs / 1000} secondi`)));
		req.on("error", reject);
		req.end();
	});
}

/** Public unicast addresses only: no loopback, private, link-local, CGNAT, multicast or reserved ranges. */
export function publicAddress(address: string): boolean {
	const v4 = isIP(address) === 4 ? address : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	if (v4 !== undefined) {
		const [a = 0, b = 0] = v4.split(".").map(Number);
		if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 192 && b === 0) return false;
		if (a === 198 && (b === 18 || b === 19)) return false;
		return true;
	}
	if (isIP(address) !== 6) return false;
	const lower = address.toLowerCase();
	if (lower === "::" || lower === "::1") return false;
	// fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 64:ff9b:: NAT64 to anything.
	if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("64:ff9b:")) return false;
	return true;
}

/** The readable text of an HTML page, and its title. */
export function pageText(html: string): { title: string; text: string } {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const text = html
		.replace(/<(script|style|noscript|svg|template|title)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*/g, "\n\n")
		.trim();
	return { title: decodeEntities(title), text };
}

function decodeEntities(text: string): string {
	return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
