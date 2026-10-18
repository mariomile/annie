/**
 * The preventivi of an instance, in `quotes.json` (outside the workspace): the next progressive
 * number of each year and every quote, revisions included. Changed under the shared file lock;
 * `quotes.json.bak` keeps the last state written. A number is never given twice: the counter
 * only grows, even when a quote is dropped because its document could not be made. Read never
 * throws: a file that does not read is `broken`, and nothing is written over it.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateJsonFile } from "./locked-json.ts";
import type { Marker } from "./marker.ts";
import { QUOTE_LIMITS, type Quote, QuoteError, type QuoteStatus, quoteNumber, revisionNumber, validQuote } from "./quotes.ts";

type Book = { readonly next: Readonly<Record<string, number>>; readonly quotes: readonly Quote[] };

export type QuoteBook = { readonly quotes: readonly Quote[]; readonly broken: boolean };

export const QUOTES_BROKEN = "l'archivio dei preventivi (quotes.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: {}, quotes: [] };

export class QuoteStore {
	private readonly file: string;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "quotes.json");
	}

	/** Never throws. */
	read(): QuoteBook {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { quotes: [], broken: false };
			return { quotes: [], broken: true };
		}
		let book: Book | undefined;
		try {
			book = validBook(JSON.parse(text));
		} catch {
			book = undefined;
		}
		return book === undefined ? { quotes: [], broken: true } : { quotes: book.quotes, broken: false };
	}

	/** A new quote with the next number of `year`: `make` gets the number and gives the quote. QuoteError when full. */
	create(year: number, make: (number: string) => Quote): Quote {
		let made: Quote | undefined;
		this.update((book) => {
			if (book.quotes.length >= QUOTE_LIMITS.quotes) throw new QuoteError(`ci sono già ${QUOTE_LIMITS.quotes} preventivi salvati, il massimo: non ne faccio altri`);
			const key = String(year);
			const n = Math.max(book.next[key] ?? 1, 1);
			const quote = make(quoteNumber(year, n));
			checked(quote);
			made = quote;
			return { next: { ...book.next, [key]: n + 1 }, quotes: [...book.quotes, quote] };
		});
		return made as Quote;
	}

	/**
	 * A new revision of the quote numbered `number`, which must still be the latest of its base:
	 * `make` gets it and the new number. The old one becomes superseded.
	 */
	revise(number: string, make: (previous: Quote, number: string) => Quote): Quote {
		let made: Quote | undefined;
		this.update((book) => {
			if (book.quotes.length >= QUOTE_LIMITS.quotes) throw new QuoteError(`ci sono già ${QUOTE_LIMITS.quotes} preventivi salvati, il massimo: non ne faccio altri`);
			const previous = book.quotes.find((q) => q.number === number);
			if (previous === undefined) throw new QuoteError(`il preventivo ${number} non c'è più`);
			if (book.quotes.some((q) => q.base === previous.base && q.revision > previous.revision)) throw new QuoteError(`il preventivo ${number} è già stato rifatto: parti dall'ultima versione`);
			if (previous.revision >= QUOTE_LIMITS.revisions) throw new QuoteError(`il preventivo ${previous.base} ha già ${QUOTE_LIMITS.revisions} versioni: fanne uno nuovo`);
			const quote = make(previous, revisionNumber(previous.base, previous.revision + 1));
			checked(quote);
			made = quote;
			const old: Quote = { ...previous, status: "superseded", replacedBy: quote.number };
			return { ...book, quotes: [...book.quotes.map((q) => (q === previous ? old : q)), quote] };
		});
		return made as Quote;
	}

	/** Set the status of `number`: the status there was before. */
	setStatus(number: string, status: Exclude<QuoteStatus, "superseded">, mark: Marker): QuoteStatus {
		let before: QuoteStatus = "open";
		this.update((book) => {
			const quote = book.quotes.find((q) => q.number === number);
			if (quote === undefined) throw new QuoteError(`il preventivo ${number} non c'è più`);
			before = quote.status;
			if (before === "superseded") throw new QuoteError(`il preventivo ${number} è stato sostituito da ${quote.replacedBy ?? "una revisione"}`);
			if (before === status) return book;
			const { statusMark: _, ...rest } = quote;
			const next: Quote = status === "open" ? rest : { ...rest, status, statusMark: mark };
			return { ...book, quotes: book.quotes.map((q) => (q === quote ? { ...next, status } : q)) };
		});
		return before;
	}

	/** Where the document of `number` is. */
	setFile(number: string, file: string): void {
		this.update((book) => ({ ...book, quotes: book.quotes.map((q) => (q.number === number ? { ...q, file } : q)) }));
	}

	/**
	 * Drop the quote `number` (its document could not be made); the number stays used. A revision
	 * dropped gives the status back to the one it replaced.
	 */
	drop(number: string): void {
		this.update((book) => {
			const quote = book.quotes.find((q) => q.number === number);
			if (quote === undefined) return book;
			const quotes = book.quotes
				.filter((q) => q !== quote)
				.map((q) => {
					if (q.replacedBy !== number) return q;
					const { replacedBy: _, ...rest } = q;
					return { ...rest, status: "open" as const };
				});
			return { ...book, quotes };
		});
	}

	/** The change under the lock; then a copy of what was written in quotes.json.bak. */
	private update(change: (book: Book) => Book): void {
		if (this.read().broken) throw new QuoteError(QUOTES_BROKEN);
		let changed = false;
		try {
			updateJsonFile<unknown>(this.file, EMPTY, (raw) => {
				const book = validBook(raw);
				if (book === undefined) throw new QuoteError(QUOTES_BROKEN);
				const next = change(book);
				changed = next !== book;
				return changed ? next : raw;
			});
		} catch (error) {
			if (error instanceof SyntaxError) throw new QuoteError(QUOTES_BROKEN);
			throw error;
		}
		if (changed && existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
	}
}

/** What is written always reads back. */
function checked(quote: Quote): void {
	if (!validQuote(quote)) throw new QuoteError("il preventivo non è valido: non l'ho salvato");
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, quotes } = raw as Book;
	if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined;
	if (!Object.entries(next).every(([y, n]) => /^\d{4}$/.test(y) && Number.isInteger(n) && n >= 1 && n <= 1_000_000)) return undefined;
	if (!Array.isArray(quotes) || quotes.length > QUOTE_LIMITS.quotes || !quotes.every(validQuote)) return undefined;
	const numbers = new Set(quotes.map((q) => q.number));
	if (numbers.size !== quotes.length) return undefined;
	// Every number below its year's counter: a counter behind a quote would give that number again.
	for (const q of quotes) {
		const [year, seq] = q.base.split("-");
		if (Number(seq) >= (next[year as string] ?? 1)) return undefined;
	}
	return raw as Book;
}
