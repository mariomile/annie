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
import { DRAFT_ID, type IssuedInvoice, invoiceNumber, invoiceProblem, isIssued, type Numbering, progressiveCode, SALES_LIMITS, type SalesInvoice, SalesInvoiceError, validCall, validInvoice } from "./sales-invoices.ts";
import { isMarker } from "./stored-fields.ts";

/**
 * The person's choices, said once: how the number is written, whether the bollo is charged to the
 * customer, whether a professional's invoice to a company has the ritenuta, and, per year, the last
 * number issued before Owni (0: none), so Owni goes on from there.
 */
export type SalesSettings = Marker & {
	readonly numbering?: Numbering;
	readonly bolloToClient?: boolean;
	readonly ritenutaToBusiness?: boolean;
	readonly lastBefore?: Readonly<Record<string, number>>;
};

/** The latest date of the year among the company's own invoices in `fatture/emesse/`, and its file: the numbering follows the dates. */
export type DateFloor = { readonly date: string; readonly file: string };

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

export const SALES_BROKEN = "l'archivio delle fatture emesse (sales-invoices.json) non si legge: non lo cambio, perché andrebbe perso. Non va cancellato: con l'istanza ferma, va rimessa al suo posto la copia sales-invoices.json.bak";

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
	 * Issue the draft `id` dated `date`: under the lock it takes the next number of that year, the
	 * only rule: past the counter and the last number said before Owni (nothing else moves it),
	 * and the next file progressive; `make` gives the invoice issued. The invoice `callId` issued
	 * already, when there is one (a call run again). SalesInvoiceError when the draft is gone,
	 * issued already, the year is full, or the date comes before the latest of the year (the
	 * store's, or `floor`'s: a file in `fatture/emesse/`, named).
	 */
	issue(id: string, callId: string, date: string, floor: DateFloor | undefined, make: (draft: SalesInvoice, number: string, seq: number, progressive: string) => SalesInvoice): IssuedInvoice {
		let made: IssuedInvoice | undefined;
		updateBook(this.book, (book) => {
			made = book.invoices.find((i): i is IssuedInvoice => isIssued(i) && i.issueCall === callId);
			if (made !== undefined) return book;
			const draft = book.invoices.find((i) => i.id === id);
			if (draft === undefined) throw new SalesInvoiceError("la bozza non c'è più");
			if (isIssued(draft)) throw new SalesInvoiceError(`è già emessa con il numero ${draft.number}`);
			const year = Number(date.slice(0, 4));
			const seq = nextSeq(book, year);
			if (seq > SALES_LIMITS.perYear) throw new SalesInvoiceError(`le fatture del ${year} sono arrivate al massimo di ${SALES_LIMITS.perYear}`);
			const later = book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.year === year && i.date > date).sort((a, b) => b.seq - a.seq)[0];
			if (later !== undefined) throw new SalesInvoiceError(`c'è già la fattura n. ${later.number} con una data successiva: la numerazione deve seguire le date`);
			if (floor !== undefined && floor.date.slice(0, 4) === String(year) && floor.date > date) throw new SalesInvoiceError(`nel file ${floor.file} c'è una fattura di quest'anno con una data successiva: la numerazione deve seguire le date`);
			const issued = make(draft, invoiceNumber(year, seq, book.settings?.numbering ?? "plain"), seq, progressiveCode(book.nextFile));
			const problem = invoiceProblem(issued);
			if (!isIssued(issued) || problem !== undefined) throw new SalesInvoiceError(`la fattura non è valida, non l'ho emessa: va controllato ${problem ?? "il numero"}`);
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
			if (inv.file !== undefined) throw new SalesInvoiceError("il file della fattura è già scritto");
			made = { ...rest, progressive: progressiveCode(book.nextFile) };
			return checkedBook({ ...book, nextFile: book.nextFile + 1, invoices: book.invoices.map((i) => (i === inv ? (made as SalesInvoice) : i)) });
		});
		return made as IssuedInvoice;
	}

	/** Remove the draft `id`, under the lock: refused when it is gone or issued meanwhile. False when `callId` removed it already. */
	removeDraft(id: string, callId: string): boolean {
		return this.update(callId, (state) => {
			const draft = state.invoices.find((i) => i.id === id);
			if (draft === undefined) throw new SalesInvoiceError(`la bozza ${id} non c'è più`);
			if (isIssued(draft)) throw new SalesInvoiceError(`la bozza ${id} è stata emessa intanto, con il numero ${draft.number}: una fattura emessa non si toglie, si storna con una nota di credito`);
			return { ...state, invoices: state.invoices.filter((i) => i !== draft) };
		});
	}

	/** Every needed step of the issue of `id` is done. True when this call marked it (it was not finished). */
	setFinished(id: string): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			const inv = book.invoices.find((i) => i.id === id);
			if (inv === undefined || !isIssued(inv)) throw new SalesInvoiceError("la fattura non c'è più");
			if (inv.finished === true) return book;
			fresh = true;
			return checkedBook({ ...book, invoices: book.invoices.map((i) => (i === inv ? { ...inv, finished: true as const } : i)) });
		});
		return fresh;
	}

	/** The issue of the invoice `id` recorded in the audit (after it is finished): an audit not yet marked is written on the next run. */
	setAudited(id: string): void {
		updateBook(this.book, (book) => {
			const inv = book.invoices.find((i) => i.id === id);
			if (inv === undefined || !isIssued(inv)) throw new SalesInvoiceError("la fattura non c'è più");
			if (inv.audited === true) return book;
			return checkedBook({ ...book, invoices: book.invoices.map((i) => (i === inv ? { ...inv, audited: true as const } : i)) });
		});
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

/** The number the next invoice of `year` takes: past the counter and the last number said before Owni. */
export function nextSeq(book: Pick<SalesState, "next" | "settings">, year: number): number {
	return Math.max(book.next[String(year)] ?? 1, (book.settings?.lastBefore?.[String(year)] ?? 0) + 1);
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
	const lastBefore = s.lastBefore === undefined || (typeof s.lastBefore === "object" && s.lastBefore !== null && !Array.isArray(s.lastBefore) && Object.entries(s.lastBefore).every(([y, n]) => YEAR.test(y) && Number.isInteger(n) && n >= 0 && n < SALES_LIMITS.perYear));
	return lastBefore && (s.numbering === undefined || s.numbering === "plain" || s.numbering === "year") && (s.bolloToClient === undefined || typeof s.bolloToClient === "boolean") && (s.ritenutaToBusiness === undefined || typeof s.ritenutaToBusiness === "boolean");
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
