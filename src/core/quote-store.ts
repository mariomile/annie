/**
 * The preventivi of an instance, in `quotes.json` (outside the workspace): the next progressive
 * number of each year and every quote, revisions included. Changed under the shared file lock;
 * `quotes.json.bak` keeps a copy of the last state written, as `invoices.json.bak` does. A number
 * is never given twice: the counter only grows, even when a quote is dropped because its document
 * could not be made. Read never throws: a file that does not read (or is past the size cap) is
 * `broken`, and nothing is written over it. A year past its cap still reads; only new quotes of
 * that year are refused.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import type { Marker } from "./marker.ts";
import { baseOrder, QUOTE_LIMITS, type Quote, QuoteError, type QuoteStatus, quoteNumber, revisionNumber, validQuote } from "./quotes.ts";

type Book = { readonly next: Readonly<Record<string, number>>; readonly quotes: readonly Quote[] };

export type QuoteBook = { readonly quotes: readonly Quote[]; readonly broken: boolean };

export const QUOTES_BROKEN = "l'archivio dei preventivi (quotes.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: {}, quotes: [] };

/** A quote whose document is still being made: it is not marked nor redone until it is ready. */
export const PREPARING = "il preventivo è ancora in preparazione: riprova tra poco";
const YEAR = /^\d{4}$/;

export class QuoteStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "quotes.json"),
			empty: EMPTY,
			maxBytes: QUOTE_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new QuoteError(QUOTES_BROKEN),
			full: () => new QuoteError("l'archivio dei preventivi è pieno: non ne salvo altri"),
		};
	}

	/** Never throws. */
	read(): QuoteBook {
		const book = readBook(this.book);
		return book === undefined ? { quotes: [], broken: true } : { quotes: book.quotes, broken: false };
	}

	/** The number of the quote `callId` made, once its document is written; undefined otherwise (or when the file does not read). */
	finished(callId: string): string | undefined {
		const quote = this.read().quotes.find((q) => q.callId === callId);
		return quote?.file === undefined ? undefined : quote.number;
	}

	/**
	 * A new quote with the next number of `year`: `make` gets the number and gives the quote. The
	 * quote made by `callId` already, when there is one (a call run again). QuoteError when the year is full.
	 */
	create(year: number, callId: string, make: (number: string) => Quote): Quote {
		let made: Quote | undefined;
		this.update((book) => {
			made = book.quotes.find((q) => q.callId === callId);
			if (made !== undefined) return book;
			yearRoom(book, year);
			const key = String(year);
			const n = Math.max(book.next[key] ?? 1, 1);
			const quote = checked(make(quoteNumber(year, n)));
			made = quote;
			return { next: { ...book.next, [key]: n + 1 }, quotes: [...book.quotes, quote] };
		});
		return made as Quote;
	}

	/**
	 * A new revision of the quote numbered `number`, which must still be the latest of its base and
	 * not accepted (checked here, under the lock): `make` gets it and the new number. The old one
	 * becomes superseded, keeping the status it had. The revision made by `callId` already, if any.
	 */
	revise(number: string, callId: string, make: (previous: Quote, number: string) => Quote): Quote {
		let made: Quote | undefined;
		this.update((book) => {
			made = book.quotes.find((q) => q.callId === callId);
			if (made !== undefined) return book;
			const previous = book.quotes.find((q) => q.number === number);
			if (previous === undefined) throw new QuoteError(`il preventivo ${number} non c'è più`);
			if (book.quotes.some((q) => q.base === previous.base && q.revision > previous.revision)) throw new QuoteError(`il preventivo ${number} è già stato rifatto: parti dall'ultima versione`);
			if (previous.file === undefined) throw new QuoteError(PREPARING);
			if (previous.status === "accepted") throw new QuoteError(`il preventivo ${number} è già accettato. Se il cliente ha chiesto di cambiarlo, prima rimettilo aperto con set_status open, solo se chi ti scrive lo conferma`);
			if (previous.revision >= QUOTE_LIMITS.revisions) throw new QuoteError(`il preventivo ${previous.base} ha già ${QUOTE_LIMITS.revisions} versioni: fanne uno nuovo`);
			yearRoom(book, baseOrder(previous)[0]);
			const quote = checked(make(previous, revisionNumber(previous.base, previous.revision + 1)));
			made = quote;
			const { statusMark, ...rest } = previous;
			const was = previous.status as Exclude<QuoteStatus, "superseded">;
			const old: Quote = { ...rest, status: "superseded", replacedBy: quote.number, before: { status: was, ...(statusMark === undefined ? {} : { mark: statusMark }) } };
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
			if (before === "superseded") throw new QuoteError(`il preventivo ${number} è stato sostituito da una revisione`);
			if (quote.file === undefined) throw new QuoteError(PREPARING);
			if (before === status) return book;
			const { statusMark: _, ...rest } = quote;
			const next: Quote = status === "open" ? { ...rest, status } : { ...rest, status, statusMark: mark };
			return { ...book, quotes: book.quotes.map((q) => (q === quote ? next : q)) };
		});
		return before;
	}

	/** Where the document of `number` is about to be written. */
	setPendingFile(number: string, path: string): void {
		this.changeQuote(number, (quote) => ({ ...quote, pendingFile: path }));
	}

	/** Where the document of `number` is, now written: the quote is ready. */
	setFile(number: string, file: string): void {
		this.changeQuote(number, ({ pendingFile: _, ...quote }) => ({ ...quote, file }));
	}

	/**
	 * A mail with the quote went (approved and sent): the day, and the address it went to when the
	 * person gave it (kept for the next time; the same address in other case is not a change).
	 */
	markSent(number: string, at: string, email?: string): void {
		this.changeQuote(number, (quote) => {
			const keep = email === undefined || email.toLowerCase() === quote.customer.email?.toLowerCase();
			return { ...quote, sentAt: at, ...(keep ? {} : { customer: { ...quote.customer, email: email.toLowerCase() } }) };
		});
	}

	/** The fattura `invoice` billed the quote `number` (sales_invoices): set once, the same again is no change. */
	markInvoiced(number: string, invoice: string): void {
		this.changeQuote(number, (quote) => (quote.invoice === invoice ? quote : { ...quote, invoice }));
	}

	private changeQuote(number: string, change: (quote: Quote) => Quote): void {
		this.update((book) => {
			const quote = book.quotes.find((q) => q.number === number);
			if (quote === undefined) throw new QuoteError(`il preventivo ${number} non c'è più`);
			const next = checked(change(quote));
			return { ...book, quotes: book.quotes.map((q) => (q === quote ? next : q)) };
		});
	}

	/**
	 * Drop the quote `number` (its document could not be made); the number stays used. A revision
	 * dropped gives the one it replaced back its status, and who set it.
	 */
	drop(number: string): void {
		this.update((book) => {
			const quote = book.quotes.find((q) => q.number === number);
			if (quote === undefined) return book;
			const quotes = book.quotes
				.filter((q) => q !== quote)
				.map((q): Quote => {
					if (q.replacedBy !== number) return q;
					const { replacedBy: _r, before, ...rest } = q;
					return { ...rest, status: before?.status ?? "open", ...(before?.mark === undefined ? {} : { statusMark: before.mark }) };
				});
			return { ...book, quotes };
		});
	}

	/** The change under the lock; then a copy of what was written in quotes.json.bak. */
	private update(change: (book: Book) => Book): void {
		updateBook(this.book, change);
	}
}

/** QuoteError when `year` has its cap of quotes. */
function yearRoom(book: Book, year: number): void {
	const count = book.quotes.filter((q) => baseOrder(q)[0] === year).length;
	if (count >= QUOTE_LIMITS.perYear) throw new QuoteError(`ci sono già ${QUOTE_LIMITS.perYear} preventivi del ${year}, il massimo per un anno: non ne faccio altri`);
}

/** What is written always reads back. */
function checked(quote: Quote): Quote {
	if (!validQuote(quote)) throw new QuoteError("il preventivo non è valido: non l'ho salvato");
	return quote;
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, quotes } = raw as Book;
	if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined;
	if (!Object.entries(next).every(([y, n]) => YEAR.test(y) && Number.isInteger(n) && n >= 1 && n <= 1_000_000)) return undefined;
	if (!Array.isArray(quotes) || !quotes.every(validQuote)) return undefined;
	const numbers = new Set(quotes.map((q) => q.number));
	if (numbers.size !== quotes.length) return undefined;
	// Every number below its year's counter: a counter behind a quote would give that number again.
	for (const q of quotes) {
		const [year, seq] = baseOrder(q);
		if (seq >= (next[String(year)] ?? 1)) return undefined;
	}
	return raw as Book;
}
