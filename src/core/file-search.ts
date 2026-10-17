/**
 * Searching the words inside the workspace's files (ADR 0035): notes, transcripts, the text of
 * documents people sent. Pure: the caller reads the files and gives their text; this finds the
 * words, ranks the files and cuts the passages around what it found.
 *
 * Words match at the start of a word, without accents and case: «fattur» finds «Fatture»,
 * «perche» finds «perché». Words in quotes match together, as a phrase. Folding keeps the text's
 * length, so a position in the folded text is the same position in the original: the offset
 * file_read takes.
 */

/** Words a query may hold, and characters: a question, not a document. */
export const QUERY_LIMITS = { terms: 8, chars: 200 } as const;

/** Occurrences counted per word in a file: enough to rank, not a full count of a long book. */
const HITS_PER_TERM = 200;

/** Characters shown before and after a hit in a passage. */
const BEFORE = 80;
const AFTER = 160;

/**
 * The query's words, folded: what is in quotes stays one phrase, a word repeated counts once.
 * Single letters are dropped (they would match half the text) unless nothing else is left.
 */
export function parseQuery(query: string): string[] {
	const text = fold(query.slice(0, QUERY_LIMITS.chars));
	const raw: string[] = [];
	for (const m of text.matchAll(/"([^"]*)"|«([^»]*)»|(\S+)/g)) {
		const quoted = m[1] ?? m[2];
		const term = (quoted ?? m[3] ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ");
		if (term !== "") raw.push(term);
	}
	const unique = [...new Set(raw)];
	const long = unique.filter((t) => [...t].length > 1);
	return (long.length > 0 ? long : unique).slice(0, QUERY_LIMITS.terms);
}

const folded = new Map<string, string>();

/** One character without accents and in lower case, always as long as it was. */
function foldChar(c: string): string {
	const known = folded.get(c);
	if (known !== undefined) return known;
	const base = c.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
	const lower = c.toLowerCase();
	const out = base.length === c.length ? base : lower.length === c.length ? lower : c;
	if (folded.size < 5000) folded.set(c, out);
	return out;
}

/** The text in lower case and without accents, character for character as long as the original. */
export function fold(text: string): string {
	return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)).replace(/[^\x00-\x7f]/gu, foldChar);
}

export type Hit = { readonly at: number; readonly term: number };

/**
 * Where the terms start a word in the folded text, in order; at most HITS_PER_TERM per term. The
 * words of a phrase may be apart by any space, a line break included.
 */
export function findHits(text: string, terms: readonly string[]): Hit[] {
	const hits: Hit[] = [];
	terms.forEach((term, index) => {
		const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+")}`, "gu");
		let count = 0;
		for (let m = pattern.exec(text); m !== null && count < HITS_PER_TERM; m = pattern.exec(text), count++) hits.push({ at: m.index, term: index });
	});
	return hits.sort((a, b) => a.at - b.at);
}

export type Passage = {
	/** Where the passage starts in the file's text: file_read's offset. */
	readonly at: number;
	/** Where the hit it was cut around is. */
	readonly hit: number;
	/** The passage on one line, «…» where it was cut. */
	readonly text: string;
};

/**
 * Up to `max` passages around the hits, each with as many different terms as can be had: the
 * first shows the terms close together, when they are; the next ones the terms not seen yet.
 * A passage stays between the `walls` around its hit (a document's page and sheet lines), so it
 * shows the page the words are on and not the end of the one before.
 */
export function passagesAround(text: string, hits: readonly Hit[], max: number, walls: readonly { readonly start: number; readonly end: number }[] = []): Passage[] {
	const windows = hits.map((h) => {
		const start = Math.max(0, h.at - BEFORE, ...walls.filter((w) => w.end <= h.at).map((w) => w.end));
		const end = Math.min(text.length, h.at + AFTER, ...walls.filter((w) => w.start > h.at).map((w) => w.start));
		return { hit: h.at, start, end, terms: new Set(hits.filter((o) => o.at >= start && o.at < end).map((o) => o.term)) };
	});
	const seen = new Set<number>();
	const chosen: typeof windows = [];
	while (chosen.length < max) {
		let best: (typeof windows)[number] | undefined;
		let bestNew = 0;
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
	/** How many of the query's terms the file has, in its name or its text. */
	readonly found: number;
	/** The terms it lacks, as the query wrote them (folded). */
	readonly missing: readonly string[];
	readonly score: number;
	readonly passages: readonly Passage[];
	readonly modifiedAt: string;
};

/**
 * How a file answers the query: its text's hits and its name. A file with none of the terms is no
 * match. More terms found ranks first, then a term in the name, then how often the terms occur.
 */
export function matchFile(file: { readonly path: string; readonly modifiedAt: string; readonly text: string; readonly walls?: readonly { readonly start: number; readonly end: number }[] }, terms: readonly string[], maxPassages: number): FileMatch | undefined {
	const hits = findHits(fold(file.text), terms);
	const name = fold(file.path.split("/").at(-1) ?? file.path);
	const inName = new Set(findHits(name, terms).map((h) => h.term));
	const inText = new Set(hits.map((h) => h.term));
	const found = terms.filter((_, i) => inName.has(i) || inText.has(i)).length;
	if (found === 0) return undefined;
	const counts = terms.map((_, i) => hits.filter((h) => h.term === i).length);
	const frequency = counts.reduce((n, c) => n + Math.log2(1 + c), 0);
	return {
		path: file.path,
		found,
		missing: terms.filter((_, i) => !inName.has(i) && !inText.has(i)),
		score: found * 1000 + inName.size * 100 + Math.min(frequency, 99),
		passages: passagesAround(file.text, hits, maxPassages, file.walls),
		modifiedAt: file.modifiedAt,
	};
}

/** Best first; between equals, the file changed last. */
export function rankMatches(matches: readonly FileMatch[]): FileMatch[] {
	return [...matches].sort((a, b) => b.score - a.score || b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
}
