/**
 * News headlines for instances: the RSS and Atom feeds of public newspapers and agencies, chosen
 * by the operator (a short built-in list by default). Only those fixed addresses are fetched:
 * nothing the person writes, a topic included, leaves the server. Feeds are read with a few
 * linear-time scans, never an XML library, and everything they say is untrusted text.
 */
import { getText, type HttpProblem } from "./http.ts";
import { pool } from "./pool.ts";

/** The sections a feed can be tagged with: what people ask for («le ultime di economia»). */
export const NEWS_SECTIONS = ["ultima ora", "italia", "mondo", "economia", "tecnologia", "sport"] as const;
export type NewsSection = (typeof NEWS_SECTIONS)[number];

export type NewsFeed = {
	/** Shown with every headline and matched by the tool's source: 1 to 40 characters. */
	readonly name: string;
	/** An https address, fixed by the operator. */
	readonly url: string;
	readonly section?: NewsSection;
};

export type NewsConfig = { readonly feeds: readonly NewsFeed[] };

/** Feeds the operator may list in ANNIE_NEWS_FEEDS, at most. */
export const MAX_FEEDS = 30;
/** A feed's name, at most, in characters. */
export const MAX_FEED_NAME = 40;

/**
 * The built-in feeds, when the operator sets no ANNIE_NEWS_FEEDS: well-known public feeds,
 * Italian first, one or more per section. The addresses could not be fetched where this list was
 * written: verify them with `pnpm annie check`, which fetches each one and names those that fail.
 */
export const DEFAULT_NEWS_FEEDS: readonly NewsFeed[] = [
	{ name: "ANSA Ultima ora", url: "https://www.ansa.it/sito/notizie/topnews/topnews_rss.xml", section: "ultima ora" },
	{ name: "Rai News", url: "https://www.rainews.it/rss/tutti", section: "ultima ora" },
	{ name: "Il Post", url: "https://www.ilpost.it/feed/", section: "italia" },
	{ name: "ANSA Cronaca", url: "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml", section: "italia" },
	{ name: "ANSA Mondo", url: "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml", section: "mondo" },
	{ name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", section: "mondo" },
	{ name: "ANSA Economia", url: "https://www.ansa.it/sito/notizie/economia/economia_rss.xml", section: "economia" },
	{ name: "ANSA Tecnologia", url: "https://www.ansa.it/sito/notizie/tecnologia/tecnologia_rss.xml", section: "tecnologia" },
	{ name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", section: "tecnologia" },
	{ name: "ANSA Sport", url: "https://www.ansa.it/sito/notizie/sport/sport_rss.xml", section: "sport" },
];

export type Headline = {
	readonly title: string;
	/** An http(s) address, shown to the person and never fetched here. */
	readonly link?: string;
	/** Plain text, at most SUMMARY_CHARS. */
	readonly summary?: string;
	/** Milliseconds since the epoch; undefined when the feed gave no date that can be trusted. */
	readonly published?: number;
};

export type FeedResult = { readonly feed: NewsFeed; readonly headlines: readonly Headline[] } | { readonly feed: NewsFeed; readonly error: string };

export type News = {
	readonly feeds: readonly NewsFeed[];
	/** The headlines of each feed, in the feeds' order: a feed that fails is named, never thrown. */
	read(feeds: readonly NewsFeed[]): Promise<FeedResult[]>;
};

/** A failed download or a file that is not a feed: a reason in Italian, never the address. */
export class NewsError extends Error {}

const MINUTE = 60_000;
/** A feed is a few hundred kilobytes at most; past this it is not a feed. */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
/** Feeds fetched at once: enough for the list in a few seconds, without a burst. */
const CONCURRENCY = 4;
/** A feed is kept this long: news moves, but not by the minute. */
const TTL_MS = 10 * MINUTE;
/** A failed feed is answered with the same error for this long, without asking again. */
const FAILURE_TTL_MS = 2 * MINUTE;
/** Items read from one feed, at most. */
export const MAX_ITEMS = 100;
export const SUMMARY_CHARS = 240;
const TITLE_CHARS = 300;
const LINK_CHARS = 2000;
/** A date this far ahead of the clock is a clock out of step and taken as now; further ahead, a date not to trust. */
const FUTURE_SLACK_MS = 10 * MINUTE;

type Entry = { readonly at: number; readonly result: Promise<Headline[]>; failed?: boolean };

/** The feeds in config, each kept in memory for ten minutes (a failure for two), fetched four at a time. */
export function feedNews(config: NewsConfig, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): News {
	const cache = new Map<string, Entry>();
	const load = (feed: NewsFeed): Promise<Headline[]> => {
		const at = now().getTime();
		const hit = cache.get(feed.url);
		if (hit !== undefined && at - hit.at < (hit.failed === true ? FAILURE_TTL_MS : TTL_MS)) return hit.result;
		const entry: Entry = { at, result: fetchFeed(feed, fetchImpl, now) };
		entry.result.catch(() => {
			entry.failed = true;
		});
		cache.set(feed.url, entry);
		return entry.result;
	};
	return {
		feeds: config.feeds,
		read: (feeds) =>
			pool(feeds, CONCURRENCY, async (feed): Promise<FeedResult> => {
				try {
					return { feed, headlines: await load(feed) };
				} catch (error) {
					return { feed, error: error instanceof NewsError ? error.message : "non risponde" };
				}
			}),
	};
}

async function fetchFeed(feed: NewsFeed, fetchImpl: typeof fetch, now: () => Date): Promise<Headline[]> {
	const xml = await getText(new URL(feed.url), { fetch: fetchImpl, headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" }, maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS }, newsError);
	if (!looksLikeFeed(xml)) throw new NewsError("non ha mandato un feed");
	return parseFeed(xml, feed.url, now().getTime());
}

function newsError(problem: HttpProblem): NewsError {
	if (problem.kind === "status") return new NewsError(`risponde ${problem.status}`);
	return new NewsError({ unreachable: "non risponde", too_big: "ha mandato un file troppo grande", unreadable: "ha mandato un file illeggibile" }[problem.kind]);
}

/**
 * An RSS, RDF or Atom document: markup from the first character (after a byte order mark and
 * spaces) and the root element within the first kilobytes. A web page, JSON or an error text is
 * refused: fail closed rather than read headlines out of something else.
 */
export function looksLikeFeed(text: string): boolean {
	const head = text.slice(0, 4096).replace(/^\ufeff/, "");
	return /^\s*</.test(head) && !/<html[\s>]/i.test(head) && /<(?:rss|feed|rdf:RDF)[\s>]/.test(head);
}

/**
 * The items of an RSS 2.0 or 1.0 feed, or the entries of an Atom one, in the feed's order, at most
 * MAX_ITEMS. Each needs a title; a link counts only when http(s) (resolved against the feed's
 * address), and a date only when it parses and is not more than ten minutes ahead of `now` (up to
 * ten minutes ahead it is taken as now). Every scan moves forward with indexOf, so any input, a
 * hostile one included, is read in linear time.
 */
export function parseFeed(xml: string, base: string, now: number): Headline[] {
	const atom = !/<(?:rss|rdf:RDF)[\s>]/.test(xml.slice(0, 4096)) && /<feed[\s>]/.test(xml.slice(0, 4096));
	const headlines: Headline[] = [];
	for (const block of elements(xml, atom ? "entry" : "item")) {
		const title = clip(plainText(inner(block, ["title"]) ?? ""), TITLE_CHARS);
		if (title === "") continue;
		const link = atom ? atomLink(block, base) : webLink(plainText(inner(block, ["link"]) ?? "") || guidLink(block), base);
		const summary = clip(plainText(inner(block, atom ? ["summary", "content"] : ["description", "content:encoded"]) ?? ""), SUMMARY_CHARS);
		const published = trustedDate(parseDate(plainText(inner(block, atom ? ["published", "updated"] : ["pubDate", "dc:date"]) ?? "")), now);
		headlines.push({ title, ...(link === undefined ? {} : { link }), ...(summary === "" ? {} : { summary }), ...(published === undefined ? {} : { published }) });
		if (headlines.length >= MAX_ITEMS) break;
	}
	return headlines;
}

/** The contents of each `<tag …>…</tag>` in turn; an element left open ends the scan. */
function* elements(xml: string, tag: string): Generator<string> {
	const open = `<${tag}`;
	const close = `</${tag}>`;
	let from = 0;
	for (;;) {
		const start = xml.indexOf(open, from);
		if (start < 0) return;
		const after = xml.charAt(start + open.length);
		if (after !== ">" && !/\s/.test(after)) {
			from = start + open.length;
			continue;
		}
		const bodyStart = xml.indexOf(">", start);
		if (bodyStart < 0) return;
		if (xml.charAt(bodyStart - 1) === "/") {
			from = bodyStart + 1;
			continue;
		}
		const end = xml.indexOf(close, bodyStart);
		if (end < 0) return;
		yield xml.slice(bodyStart + 1, end);
		from = end + close.length;
	}
}

/** The contents of the first of `tags` found in the block. */
function inner(block: string, tags: readonly string[]): string | undefined {
	for (const tag of tags) {
		for (const found of elements(block, tag)) return found;
	}
	return undefined;
}

/** An Atom entry's link: the first `rel="alternate"` or without rel, else the first with an href. */
function atomLink(block: string, base: string): string | undefined {
	const links = [...block.matchAll(/<link\b([^<>]*)>/g)].map(([, attributes = ""]) => ({ rel: attribute(attributes, "rel"), href: attribute(attributes, "href") }));
	const chosen = links.find((l) => l.href !== undefined && (l.rel === undefined || l.rel === "alternate")) ?? links.find((l) => l.href !== undefined);
	return chosen?.href === undefined ? undefined : webLink(decodeEntities(chosen.href), base);
}

/** An RSS guid when it is a permalink: the link of feeds that leave `<link>` out. */
function guidLink(block: string): string {
	const match = /<guid\b([^<>]*)>/.exec(block);
	if (match === null || attribute(match[1] ?? "", "isPermaLink") === "false") return "";
	return plainText(inner(block, ["guid"]) ?? "");
}

function attribute(attributes: string, name: string): string | undefined {
	return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes)?.slice(1).find((v) => v !== undefined);
}

/** An http(s) address, resolved against the feed's; anything else (javascript:, data:…) is no link. */
function webLink(raw: string, base: string): string | undefined {
	const text = raw.trim();
	if (text === "" || text.length > LINK_CHARS) return undefined;
	try {
		const url = new URL(text, base);
		return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The text of a feed field: CDATA unwrapped, entities decoded, then tags (and what scripts and
 * styles hold) dropped, twice, since many feeds escape their HTML once more; control characters
 * and runs of spaces become one space.
 */
export function plainText(raw: string): string {
	const once = stripTags(unwrapCdata(raw));
	return stripTags(decodeEntities(once))
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** CDATA sections as their literal text, entities decoded outside them. An unclosed one runs to the end. */
function unwrapCdata(raw: string): string {
	let out = "";
	let from = 0;
	for (;;) {
		const start = raw.indexOf("<![CDATA[", from);
		if (start < 0) return out + decodeEntities(raw.slice(from));
		out += decodeEntities(raw.slice(from, start));
		const end = raw.indexOf("]]>", start + 9);
		if (end < 0) return out + raw.slice(start + 9);
		out += raw.slice(start + 9, end);
		from = end + 3;
	}
}

/** Tags out, and the contents of script and style with them. `[^<>]` keeps the scan linear. */
function stripTags(text: string): string {
	return dropBlocks(text, ["script", "style"]).replace(/<[^<>]*>/g, " ");
}

/** `<script…>…</script>` and the like removed whole; an unclosed one takes the rest. */
function dropBlocks(text: string, tags: readonly string[]): string {
	let out = text;
	for (const tag of tags) {
		const lower = out.toLowerCase();
		if (!lower.includes(`<${tag}`)) continue;
		let kept = "";
		let from = 0;
		for (;;) {
			const start = lower.indexOf(`<${tag}`, from);
			if (start < 0) {
				kept += out.slice(from);
				break;
			}
			kept += `${out.slice(from, start)} `;
			const end = lower.indexOf(`</${tag}`, start);
			if (end < 0) break;
			const close = lower.indexOf(">", end);
			from = close < 0 ? out.length : close + 1;
		}
		out = kept;
	}
	return out;
}

/** The named entities feeds use, beyond XML's five: Italian letters, quotes and dashes. */
const ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	agrave: "à",
	aacute: "á",
	egrave: "è",
	eacute: "é",
	igrave: "ì",
	iacute: "í",
	ograve: "ò",
	oacute: "ó",
	ugrave: "ù",
	uacute: "ú",
	Agrave: "À",
	Egrave: "È",
	Eacute: "É",
	Igrave: "Ì",
	Ograve: "Ò",
	Ugrave: "Ù",
	ccedil: "ç",
	ntilde: "ñ",
	auml: "ä",
	ouml: "ö",
	uuml: "ü",
	szlig: "ß",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	middot: "·",
	bull: "•",
	euro: "€",
	pound: "£",
	deg: "°",
	copy: "©",
	reg: "®",
	trade: "™",
};

/** Named and numeric entities; an unknown name stays as written, a code point that is not a character becomes a space. */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (whole, decimal?: string, hex?: string, name?: string) => {
		if (name !== undefined) return ENTITIES[name] ?? whole;
		const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
		return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code < 0x20 ? " " : String.fromCodePoint(code);
	});
}

/** At most `max` characters, cut at a space with an ellipsis. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** RFC 822's zones, and the European ones Italian feeds write though the RFC has no name for them. */
const ZONES: Readonly<Record<string, number>> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, WET: 0, WEST: 1, BST: 1, CET: 1, CEST: 2 };
const RFC822 = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([+-])(\d{2}):?(\d{2})|([A-Za-z]{1,5}))?$/;
const ISO8601 = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?)?\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i;

/**
 * An RFC 822 date (RSS's pubDate: «Sat, 17 Oct 2026 14:32:00 +0200») or an ISO 8601 one (Atom,
 * dc:date: «2026-10-17T14:32:00Z»), in milliseconds; a time without a zone is UTC. Undefined for
 * anything else, or a day or time that does not exist.
 */
export function parseDate(text: string): number | undefined {
	const value = text.trim();
	if (value === "" || value.length > 64) return undefined;
	const rfc = RFC822.exec(value);
	if (rfc !== null) {
		const [, day, monthName = "", yearText = "", hour, minute, second, sign, zoneHours, zoneMinutes, zoneName] = rfc;
		const month = MONTHS.indexOf(monthName.toLowerCase());
		const year = yearText.length === 2 ? (Number(yearText) < 50 ? 2000 : 1900) + Number(yearText) : Number(yearText);
		let offset = 0;
		if (sign !== undefined) offset = (sign === "-" ? -1 : 1) * (Number(zoneHours) * 60 + Number(zoneMinutes));
		else if (zoneName !== undefined) {
			const hours = ZONES[zoneName.toUpperCase()];
			if (hours === undefined) return undefined;
			offset = hours * 60;
		}
		return month < 0 ? undefined : utc(year, month, Number(day), Number(hour), Number(minute), Number(second ?? 0), offset);
	}
	const iso = ISO8601.exec(value);
	if (iso === null) return undefined;
	const [, year, month, day, hour, minute, second, , sign, zoneHours, zoneMinutes] = iso;
	const offset = sign === undefined ? 0 : (sign === "-" ? -1 : 1) * (Number(zoneHours) * 60 + Number(zoneMinutes));
	return utc(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0), offset);
}

/** The instant, when every field is in range (no 30 February, no 25:00). */
function utc(year: number, month: number, day: number, hour: number, minute: number, second: number, offsetMinutes: number): number | undefined {
	if (hour > 23 || minute > 59 || second > 60 || Math.abs(offsetMinutes) > 14 * 60) return undefined;
	const local = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
	const check = new Date(local);
	if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
	return local - offsetMinutes * MINUTE;
}

/** Up to ten minutes ahead: a clock out of step, taken as now. Further ahead: not a date to trust. */
function trustedDate(at: number | undefined, now: number): number | undefined {
	if (at === undefined) return undefined;
	if (at <= now) return at;
	return at - now <= FUTURE_SLACK_MS ? now : undefined;
}
