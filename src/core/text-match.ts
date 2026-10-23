/**
 * Matching a person's words against text, the Italian way (ADR 0035), shared by the search in the
 * workspace's files and the liste: words match at the start of a word, without accents and case
 * («fattur» finds «Fatture», «perche» finds «perché»), long words also their singular or plural,
 * words in quotes together as a phrase. Folding keeps the text's length, so a position in the
 * folded text is the same position in the original.
 */

/** Words a query may hold, and characters: a question, not a document. */
export const QUERY_LIMITS = { terms: 8, chars: 200 } as const;

/** Occurrences counted per word in a file: enough to rank, not a full count of a long book. */
const HITS_PER_TERM = 200;

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
		"perche trova trovami cerca cercami dimmi mostrami fammi dammi mandami vedere detto diceva dice parlato parlare file documento documenti"
	).split(" "),
);

/** Shortest word whose ending is dropped: shorter ones (names like «Rossi», «Verdi») stay whole, and so do words written with a capital. */
const STEM_FROM = 6;

/**
 * The query's words and phrases, folded: what is in quotes stays one phrase, a word repeated
 * counts once, the part after an apostrophe is the word («dell'ordine» is «ordine»). Stopwords and
 * single letters are dropped unless nothing else is left. Each word of a phrase starts and ends
 * with a letter or a digit, so the space between them in the pattern can match in one way only.
 */
export function parseQuery(query: string): QueryTerm[] {
	const raw: { word: string; phrase: boolean; capital: boolean }[] = [];
	for (const m of query.slice(0, QUERY_LIMITS.chars).matchAll(/"([^"]*)"|«([^»]*)»|“([^”]*)”|„([^“”]*)[“”]|(\S+)/g)) {
		const quoted = m[1] ?? m[2] ?? m[3] ?? m[4];
		if (quoted !== undefined) {
			const words = quoted.split(/\s+/).map(trim).filter((w) => w !== "");
			if (words.length > 0) raw.push({ word: fold(words.join(" ")), phrase: words.length > 1, capital: false });
			continue;
		}
		const word = trim((m[5] ?? "").split(/['‘’ʼ]/).at(-1) ?? "");
		if (word !== "") raw.push({ word: fold(word), phrase: false, capital: /^\p{Lu}/u.test(word) });
	}
	const unique = [...new Map(raw.map((t) => [t.word, t])).values()];
	const telling = unique.filter((t) => t.phrase || ([...t.word].length > 1 && !STOPWORDS.has(t.word)));
	return (telling.length > 0 ? telling : unique).slice(0, QUERY_LIMITS.terms).map(({ word, phrase, capital }) => ({ word, phrase, stem: phrase || capital ? word : stem(word) }));
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

/** At most `max` characters: a longer text is cut to `max - 1` and ends with «…», never through the middle of an emoji. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 2)) ? max - 2 : max - 1;
	return `${text.slice(0, end)}…`;
}

export type Hit = { readonly at: number; readonly term: number };

/**
 * The terms as patterns that find where they start a word: the words of a phrase may be apart by
 * spaces, line breaks and punctuation («Rossi, Mario»); a number matches whole at its end too, so
 * 42 is not 420; an accent written as a separate mark (as macOS writes file names) is skipped, so
 * «resume» finds «résumé» either way. Build them once to test many texts.
 */
export function termPatterns(terms: readonly QueryTerm[]): RegExp[] {
	return terms.map((term) => {
		const words = term.stem.split(" ").map((w) => [...w].map((c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("\\p{M}*"));
		const end = /\p{N}$/u.test(term.stem) ? "(?!\\p{N})" : "";
		return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${words.join("\\p{M}*[\\s\\p{P}]+")}${end}`, "gu");
	});
}

/** Where the terms start a word in the folded text, in order; at most HITS_PER_TERM per term. */
export function findHits(text: string, terms: readonly QueryTerm[], patterns: readonly RegExp[] = termPatterns(terms)): Hit[] {
	const hits: Hit[] = [];
	patterns.forEach((pattern, index) => {
		pattern.lastIndex = 0;
		let count = 0;
		for (let m = pattern.exec(text); m !== null && count < HITS_PER_TERM; m = pattern.exec(text), count++) hits.push({ at: m.index, term: index });
	});
	return hits.sort((a, b) => a.at - b.at);
}

