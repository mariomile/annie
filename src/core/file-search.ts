/**
 * Searching the words inside the workspace's files (ADR 0035): notes, transcripts, the text of
 * documents people sent. Pure: the caller reads the files and gives their text; this ranks the
 * files and cuts the passages around the words text-match.ts found.
 */

import { findHits, fold, type Hit, type QueryTerm } from "./text-match.ts";

/** Characters shown before and after a hit in a passage. */
const BEFORE = 80;
const AFTER = 160;

export type Passage = {
	/** Where the passage starts in the file's text: file_read's offset. */
	readonly at: number;
	/** Where the hit it was cut around is. */
	readonly hit: number;
	/** The passage on one line, «…» where it was cut. */
	readonly text: string;
};

export type Wall = { readonly start: number; readonly end: number };

/**
 * Up to `max` passages around the hits, each with as many different terms as can be had: the
 * first shows the terms close together, when they are; the next ones the terms not seen yet, then
 * other places where they occur. A passage stays between the `walls` around its hit (a document's
 * page and sheet lines, sorted), so it shows the page the words are on and not the end of the one before.
 */
export function passagesAround(text: string, hits: readonly Hit[], max: number, walls: readonly Wall[] = []): Passage[] {
	const windows = hits.map((h) => {
		const { before, after } = wallsAround(walls, h.at);
		const start = Math.max(0, h.at - BEFORE, before?.end ?? 0);
		const end = Math.min(text.length, h.at + AFTER, after?.start ?? text.length);
		return { hit: h.at, start, end, terms: new Set(hits.filter((o) => o.at >= start && o.at < end).map((o) => o.term)) };
	});
	const seen = new Set<number>();
	const chosen: typeof windows = [];
	while (chosen.length < max) {
		let best: (typeof windows)[number] | undefined;
		let bestNew = -1;
		for (const w of windows) {
			if (chosen.some((c) => w.start < c.end && c.start < w.end)) continue;
			const fresh = [...w.terms].filter((t) => !seen.has(t)).length;
			if (fresh > bestNew) [best, bestNew] = [w, fresh];
		}
		if (best === undefined) break;
		chosen.push(best);
		for (const t of best.terms) seen.add(t);
	}
	return chosen.sort((a, b) => a.start - b.start).map((w) => cut(text, w.start, w.end, w.hit));
}

/** The last wall that ends at or before `at` and the first that starts after it, by binary search. */
function wallsAround(walls: readonly Wall[], at: number): { before?: Wall; after?: Wall } {
	let low = 0;
	let high = walls.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((walls[mid] as Wall).start > at) high = mid;
		else low = mid + 1;
	}
	// walls[low] is the first to start after `at`; the one before it may still reach past `at`.
	const previous = walls[low - 1];
	const before = previous !== undefined && previous.end <= at ? previous : walls[low - 2];
	return { ...(before === undefined ? {} : { before }), ...(walls[low] === undefined ? {} : { after: walls[low] as Wall }) };
}

/** text[start, end) widened to whole words, on one line, with «…» where it does not reach the edge. */
function cut(text: string, start: number, end: number, hit: number): Passage {
	let from = start;
	while (from > 0 && from > start - 20 && /[\p{L}\p{N}]/u.test(text[from - 1] as string)) from--;
	let to = end;
	while (to < text.length && to < end + 20 && /[\p{L}\p{N}]/u.test(text[to] as string)) to++;
	while (from < hit && /\s/.test(text[from] as string)) from++;
	const body = text.slice(from, to).replace(/\s+/g, " ").trim();
	return { at: from, hit, text: `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}` };
}

export type FileMatch = {
	readonly path: string;
	/** For each of the query's terms, whether the file has it, in its name or its text. */
	readonly has: readonly boolean[];
	/** How many of the query's terms the file has. */
	readonly found: number;
	/** The terms it lacks, as the person wrote them (folded). */
	readonly missing: readonly string[];
	/** How many terms are in the file's name. */
	readonly inName: number;
	/** How often the terms occur, on a log scale so a long file does not win by length. */
	readonly frequency: number;
	readonly passages: readonly Passage[];
	readonly modifiedAt: string;
};

/** How a file answers the query: its text's hits and its name. A file with none of the terms is no match. */
export function matchFile(file: { readonly path: string; readonly modifiedAt: string; readonly text: string; readonly walls?: readonly Wall[] }, terms: readonly QueryTerm[], maxPassages: number): FileMatch | undefined {
	const hits = findHits(fold(file.text), terms);
	const inName = new Set(findHits(fold(file.path.split("/").at(-1) ?? file.path), terms).map((h) => h.term));
	const inText = new Set(hits.map((h) => h.term));
	const has = terms.map((_, i) => inName.has(i) || inText.has(i));
	const found = has.filter(Boolean).length;
	if (found === 0) return undefined;
	return {
		path: file.path,
		has,
		found,
		missing: terms.filter((_, i) => !has[i]).map((t) => t.word),
		inName: inName.size,
		frequency: terms.reduce((n, _, i) => n + Math.log2(1 + hits.filter((h) => h.term === i).length), 0),
		passages: passagesAround(file.text, hits, maxPassages, file.walls),
		modifiedAt: file.modifiedAt,
	};
}

/**
 * Best first: more terms found; then the rarer terms, among the `searched` files, so a file with
 * «recesso» beats one with only «contratto»; then terms in the name, how often they occur, and the
 * file changed last.
 */
export function rankMatches<M extends FileMatch>(matches: readonly M[], searched: number): M[] {
	const terms = matches[0]?.has.length ?? 0;
	const weight = Array.from({ length: terms }, (_, i) => Math.log2(1 + Math.max(searched, matches.length) / Math.max(1, matches.filter((m) => m.has[i]).length)));
	const ranked = matches.map((m) => ({ m, rarity: m.has.reduce((n, has, i) => n + (has ? (weight[i] ?? 0) : 0), 0) }));
	ranked.sort(({ m: a, rarity: ra }, { m: b, rarity: rb }) => b.found - a.found || rb - ra || b.inName - a.inName || b.frequency - a.frequency || b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
	return ranked.map((r) => r.m);
}
