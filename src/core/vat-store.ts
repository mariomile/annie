/**
 * La liquidazione IVA's own state, in `vat.json` of an instance (outside the workspace): the
 * periodicity, the F24 the person marks paid, the deductibility marks, the figures said per year
 * and the ids of the calls that wrote (a call run again writes nothing twice). Changed under the
 * shared file lock through json-book.ts, with the copy `vat.json.bak`. Read never throws: a file
 * that does not read is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { type DeductMark, type PaidMark, VAT_LIMITS, validCall, validMark, validPaid, validSettings, validYear, VatError, type VatSettings, type YearFigures } from "./vat.ts";

/** What a change works on. */
export type VatState = { readonly settings?: VatSettings; readonly paid: readonly PaidMark[]; readonly marks: readonly DeductMark[]; readonly years: readonly YearFigures[] };

type Book = VatState & { readonly calls: readonly string[] };

export type VatBook = Book & { readonly broken: boolean };

export const VAT_BROKEN = "i dati della liquidazione IVA (vat.json) non si leggono: non li cambio, perché andrebbero persi. Va sistemato il file, o rimessa la copia vat.json.bak, nella cartella dell'agente";

const EMPTY: Book = { paid: [], marks: [], years: [], calls: [] };

export class VatStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "vat.json"),
			empty: EMPTY,
			maxBytes: VAT_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new VatError(VAT_BROKEN),
			full: () => new VatError("i dati della liquidazione IVA sono pieni: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): VatBook {
		const book = readBook(this.book);
		return book === undefined ? { ...EMPTY, broken: true } : { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one.
	 * False when the call wrote already (run again), and then nothing changes. What `change` gives is
	 * checked as the file is: a VatError, nothing written, when it does not hold.
	 */
	update(callId: string, change: (state: VatState) => VatState): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) return book;
			fresh = true;
			const { calls, ...state } = book;
			const made = change(state);
			const next: Book = {
				...made,
				paid: made.paid.slice(-VAT_LIMITS.paid),
				marks: made.marks.slice(-VAT_LIMITS.marks),
				years: [...made.years].sort((a, b) => a.year - b.year).slice(-VAT_LIMITS.years),
				calls: [...calls, callId].slice(-VAT_LIMITS.calls),
			};
			if (validBook(next) === undefined) throw new VatError("i dati non sono validi: non li ho salvati");
			return next;
		});
		return fresh;
	}
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { settings, paid, marks, years, calls } = raw as Book;
	if (settings !== undefined && !validSettings(settings)) return undefined;
	if (!Array.isArray(paid) || paid.length > VAT_LIMITS.paid || !paid.every(validPaid)) return undefined;
	if (new Set(paid.map((p) => p.key)).size !== paid.length) return undefined;
	if (!Array.isArray(marks) || marks.length > VAT_LIMITS.marks || !marks.every(validMark)) return undefined;
	if (new Set(marks.map((m) => m.vat ?? `#${m.invoice}`)).size !== marks.length) return undefined;
	if (!Array.isArray(years) || years.length > VAT_LIMITS.years || !years.every(validYear)) return undefined;
	if (new Set(years.map((y) => y.year)).size !== years.length) return undefined;
	if (!Array.isArray(calls) || calls.length > VAT_LIMITS.calls || !calls.every(validCall)) return undefined;
	return raw as Book;
}
