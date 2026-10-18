/**
 * Le fatture emesse of an instance, in `sales-invoices.json` (outside the workspace): the drafts
 * and the invoices issued, the next number of each year, the next draft id and file progressive,
 * the person's two choices (how the number is written, whether the bollo is charged to the
 * customer) and the ids of the calls that wrote. Changed under the shared file lock through
 * json-book.ts, with the copy `sales-invoices.json.bak`. A number is given only when an invoice is
 * issued, under the lock, and the counter only grows: two issues at once never get the same
 * number, a draft removed never takes one, and none is skipped. Read never throws: a file that does
 * not read is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import type { Marker } from "./marker.ts";
import { DRAFT_ID, type IssuedInvoice, invoiceNumber, isIssued, type Numbering, progressiveCode, SALES_LIMITS, type SalesInvoice, SalesInvoiceError, validCall, validInvoice } from "./sales-invoices.ts";
import { isMarker } from "./stored-fields.ts";

/** The person's choices, said once: how the number is written, and whether the bollo is charged to the customer. */
export type SalesSettings = Marker & { readonly numbering?: Numbering; readonly bolloToClient?: boolean };

/** What a change works on. */
export type SalesState = {
	readonly settings?: SalesSettings;
	readonly next: Readonly<Record<string, number>>;
	readonly nextDraft: number;
	readonly nextFile: number;
	readonly invoices: readonly SalesInvoice[];
};

type Book = SalesState & { readonly calls: readonly string[] };

export type SalesBook = Book & { readonly broken: boolean };

export const SALES_BROKEN = "l'archivio delle fatture emesse (sales-invoices.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: {}, nextDraft: 1, nextFile: 1, invoices: [], calls: [] };
const YEAR = /^\d{4}$/;

export class SalesInvoiceStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "sales-invoices.json"),
			empty: EMPTY,
			maxBytes: SALES_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new SalesInvoiceError(SALES_BROKEN),
			full: () => new SalesInvoiceError("l'archivio delle fatture emesse è pieno: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): SalesBook {
		const book = readBook(this.book);
		return book === undefined ? { ...EMPTY, broken: true } : { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). False when the call wrote already. SalesInvoiceError
	 * from `change` stops it with nothing written.
	 */
	update(callId: string, change: (state: SalesState) => SalesState): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) return book;
			const { calls, ...state } = book;
			const next = change(state);
			if (next === state) return book;
			fresh = true;
			return checkedBook({ ...next, calls: [...calls, callId].slice(-SALES_LIMITS.calls) });
		});
		return fresh;
	}

	/**
	 * Issue the draft `id` dated `date`: under the lock it takes the next number of that year and
	 * the next file progressive, and `make` gives the invoice issued. The invoice `callId` issued
	 * already, when there is one (a call run again). SalesInvoiceError when the draft is gone,
	 * issued already, the year is full, or the date comes before the last invoice's of the year.
	 */
	issue(id: string, callId: string, date: string, make: (draft: SalesInvoice, number: string, seq: number, progressive: string) => SalesInvoice): IssuedInvoice {
		let made: IssuedInvoice | undefined;
		updateBook(this.book, (book) => {
			made = book.invoices.find((i): i is IssuedInvoice => isIssued(i) && i.issueCall === callId);
			if (made !== undefined) return book;
			const draft = book.invoices.find((i) => i.id === id);
			if (draft === undefined) throw new SalesInvoiceError("la bozza non c'è più");
			if (isIssued(draft)) throw new SalesInvoiceError(`è già emessa con il numero ${draft.number}`);
			const year = Number(date.slice(0, 4));
			const seq = Math.max(book.next[String(year)] ?? 1, 1);
			if (seq > SALES_LIMITS.perYear) throw new SalesInvoiceError(`le fatture del ${year} sono arrivate al massimo di ${SALES_LIMITS.perYear}`);
			const last = book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.year === year).reduce((d, i) => (i.date > d ? i.date : d), "");
			if (last > date) throw new SalesInvoiceError("c'è già una fattura di quest'anno con una data successiva: la numerazione deve seguire le date");
			const issued = make(draft, invoiceNumber(year, seq, book.settings?.numbering ?? "plain"), seq, progressiveCode(book.nextFile));
			if (!isIssued(issued) || !validInvoice(issued)) throw new SalesInvoiceError("la fattura non è valida: non l'ho emessa");
			made = issued;
			return checkedBook({ ...book, next: { ...book.next, [String(year)]: seq + 1 }, nextFile: book.nextFile + 1, invoices: book.invoices.map((i) => (i === draft ? issued : i)) });
		});
		return made as IssuedInvoice;
	}

	/** A new file progressive for the invoice `id` (its file name was taken in the workspace). */
	newProgressive(id: string): IssuedInvoice {
		let made: IssuedInvoice | undefined;
		updateBook(this.book, (book) => {
			const inv = book.invoices.find((i) => i.id === id);
			if (inv === undefined || !isIssued(inv)) throw new SalesInvoiceError("la fattura non c'è più");
			const { file: _f, pdf: _p, ...rest } = inv;
			made = { ...rest, progressive: progressiveCode(book.nextFile) };
			return checkedBook({ ...book, nextFile: book.nextFile + 1, invoices: book.invoices.map((i) => (i === inv ? (made as SalesInvoice) : i)) });
		});
		return made as IssuedInvoice;
	}

	/** Where the files of the invoice `id` are, now written. */
	setFiles(id: string, files: { readonly file?: string; readonly pdf?: string }): void {
		updateBook(this.book, (book) => {
			const inv = book.invoices.find((i) => i.id === id);
			if (inv === undefined || !isIssued(inv)) throw new SalesInvoiceError("la fattura non c'è più");
			if ((files.file === undefined || inv.file === files.file) && (files.pdf === undefined || inv.pdf === files.pdf)) return book;
			const next: SalesInvoice = { ...inv, ...(files.file === undefined ? {} : { file: files.file }), ...(files.pdf === undefined ? {} : { pdf: files.pdf }) };
			return checkedBook({ ...book, invoices: book.invoices.map((i) => (i === inv ? next : i)) });
		});
	}
}

/** What is written always reads back. */
function checkedBook(book: Book): Book {
	if (validBook(book) === undefined) throw new SalesInvoiceError("l'archivio delle fatture non sarebbe valido: non l'ho salvato");
	return book;
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 60_000_000;

function validSettings(v: unknown): boolean {
	if (v === undefined) return true;
	if (!isMarker(v)) return false;
	const s = v as SalesSettings;
	return (s.numbering === undefined || s.numbering === "plain" || s.numbering === "year") && (s.bolloToClient === undefined || typeof s.bolloToClient === "boolean");
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextDraft) || !counter(b.nextFile) || !validSettings(b.settings)) return undefined;
	if (typeof b.next !== "object" || b.next === null || Array.isArray(b.next) || !Object.entries(b.next).every(([y, n]) => YEAR.test(y) && counter(n))) return undefined;
	if (!Array.isArray(b.invoices) || b.invoices.length > SALES_LIMITS.invoices || !b.invoices.every(validInvoice)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > SALES_LIMITS.calls || !b.calls.every(validCall)) return undefined;
	// Ids, numbers and progressives never given twice: each below its counter, each once.
	const ids = new Set<string>();
	const numbers = new Set<string>();
	const files = new Set<string>();
	for (const i of b.invoices) {
		if (Number(DRAFT_ID.exec(i.id)?.[1]) >= b.nextDraft || ids.has(i.id)) return undefined;
		ids.add(i.id);
		if (!isIssued(i)) continue;
		const key = `${i.year}|${i.seq}`;
		if (i.seq >= (b.next[String(i.year)] ?? 1) || numbers.has(key) || parseInt(i.progressive, 36) >= b.nextFile || files.has(i.progressive)) return undefined;
		numbers.add(key);
		files.add(i.progressive);
	}
	return b;
}
