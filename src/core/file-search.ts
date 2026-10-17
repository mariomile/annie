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

/** A word or phrase of the query: as the person wrote it (folded), and the form searched. */
export type QueryTerm = {
	readonly word: string;
	/** The start searched: a long word without its ending, so «fatture» finds «fattura». */
	readonly stem: string;
	/** In quotes: the words match together, in this order. */
	readonly phrase: boolean;
};

/**
 * Words that say nothing about a file: articles, prepositions, common verbs and the words of a
 * request («trovami», «diceva»). Left out of a query unless it holds nothing else, or they are in quotes.
 */
const STOPWORDS = new Set(
	(
		"il lo la i gli le un uno una di del dello della dei degli delle dell a al allo alla ai agli alle all da dal dallo dalla dai dagli dalle dall " +
		"in nel nello nella nei negli nelle nell con col su sul sullo sulla sui sugli sulle sull per tra fra e ed o od ma se che chi cui non piu " +
		"come dove quando quale quali quanto quanta cosa ci si mi ti vi ne c e sono ho hai ha abbiamo avete hanno era erano stato stata " +
		"questo questa questi queste quello quella quelli quelle mio mia miei mie tuo tua suo sua nostro nostra loro " +
		"trova trovami cerca cercami dimmi mostrami fammi dammi mandami vedere detto diceva dice parlato parlare file documento documenti"
	).split(" "),
);

/** Shortest word whose ending is dropped: shorter ones (names like «Rossi», «Verdi») stay whole. */
const STEM_FROM = 6;

/**
 * The query's words and phrases, folded: what is in quotes stays one phrase, a word repeated
 * counts once, the part after an apostrophe is the word («dell'ordine» is «ordine»). Stopwords and
 * single letters are dropped unless nothing else is left.
 */
export function parseQuery(query: string): QueryTerm[] {
	const text = fold(query.slice(0, QUERY_LIMITS.chars));
	const raw: { word: string; phrase: boolean }[] = [];
	for (const m of text.matchAll(/"([^"]*)"|«([^»]*)»|“([^”]*)”|„([^“”]*)[“”]|(\S+)/g)) {
		const quoted = m[1] ?? m[2] ?? m[3] ?? m[4];
		const words = quoted === undefined ? (m[5] ?? "").split("'").slice(-1) : [quoted];
		for (const w of words) {
			const word = trim(w).replace(/\s+/g, " ");
			if (word !== "") raw.push({ word, phrase: quoted !== undefined && word.includes(" ") });
		}
	}
	const unique = [...new Map(raw.map((t) => [t.word, t])).values()];
	const telling = unique.filter((t) => t.phrase || ([...t.word].length > 1 && !STOPWORDS.has(t.word)));
	return (telling.length > 0 ? telling : unique).slice(0, QUERY_LIMITS.terms).map((t) => ({ ...t, stem: t.phrase ? t.word : stem(t.word) }));
}

/** Punctuation around a word, not inside it: «Rossi,» is «Rossi», «42/2026» stays. */
function trim(word: string): string {
	return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** A long Italian word without its ending vowel (two letters for -che, -chi, -ghe, -ghi). */
function stem(word: string): string {
	if ([...word].length < STEM_FROM || !/^\p{L}+$/u.test(word)) return word;
	if (/[cg]h[ei]$/.test(word)) return word.slice(0, -2);
	return /[aeio]$/.test(word) ? word.slice(0, -1) : word;
}

const folded = new Map<string, string>();

/** One character without accents and in lower case, always as long as it was. */
function foldChar(c: string): string {
	const known = folded.get(c);
	if (known !== undefined) return known;
	const base = c.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
	const lower = c.toLowerCase();
	const out = /^[‘’ʼ]$/.test(c) ? "'" : base.length === c.length ? base : lower.length === c.length ? lower : c;
	if (folded.size < 5000) folded.set(c, out);
	return out;
}

/** The text in lower case, without accents and with plain apostrophes, character for character as long as the original. */
export function fold(text: string): string {
	return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)).replace(/[^\x00-\x7f]/gu, foldChar);
}

export type Hit = { readonly at: number; readonly term: number };

/**
 * Where the terms start a word in the folded text, in order; at most HITS_PER_TERM per term. The
 * words of a phrase may be apart by spaces, line breaks and punctuation («Rossi, Mario»); a number
 * matches whole at its end too, so 42 is not 420.
 */
export function findHits(text: string, terms: readonly QueryTerm[]): Hit[] {
	const hits: Hit[] = [];
	terms.forEach((term, index) => {
		const words = term.stem.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
		const end = /\p{N}$/u.test(term.stem) ? "(?!\\p{N})" : "";
		const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s\\p{P}]+")}${end}`, "gu");
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
export function matchFile(file: { readonly path: string; readonly modifiedAt: string; readonly text: string; readonly walls?: readonly { readonly start: number; readonly end: number }[] }, terms: readonly QueryTerm[], maxPassages: number): FileMatch | undefined {
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
	const rarity = (m: M) => m.has.reduce((n, has, i) => n + (has ? (weight[i] ?? 0) : 0), 0);
	return [...matches].sort((a, b) => b.found - a.found || rarity(b) - rarity(a) || b.inName - a.inName || b.frequency - a.frequency || b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
}
