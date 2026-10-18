/**
 * The CU received, in `withholding.json` of an instance (outside the workspace): each CU the
 * person said (client, year, compensi lordi, ritenute), the next progressive and the ids of the
 * calls that wrote (a call run again writes nothing twice). Changed under the shared file lock
 * through json-book.ts, with the copy `withholding.json.bak`. A CU said again for the same client
 * and year (a CU sostitutiva) takes the place of the one before, with the same id. Read never
 * throws: a file that does not read is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { CU_ID, type CuRecord, cuId, validCall, validCu, WITHHOLDING_LIMITS, WithholdingError } from "./withholding.ts";

type Book = { readonly next: number; readonly cus: readonly CuRecord[]; readonly calls: readonly string[] };

export type WithholdingBook = { readonly cus: readonly CuRecord[]; readonly broken: boolean };

export const WITHHOLDING_BROKEN = "le CU salvate (withholding.json) non si leggono: non le cambio, perché andrebbero perse. Va sistemato il file, o rimessa la copia withholding.json.bak, nella cartella dell'agente";

const EMPTY: Book = { next: 1, cus: [], calls: [] };

/** What a record did: a new CU, one that took the place of the CU of the same client and year, or the call run again (nothing written). */
export type Recorded = { readonly cu: CuRecord; readonly kind: "new" | "replaced" | "again" };

export class WithholdingStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "withholding.json"),
			empty: EMPTY,
			maxBytes: WITHHOLDING_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new WithholdingError(WITHHOLDING_BROKEN),
			full: () => new WithholdingError("le CU salvate sono troppe: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): WithholdingBook {
		const book = readBook(this.book);
		return book === undefined ? { cus: [], broken: true } : { cus: book.cus, broken: false };
	}

	/**
	 * A CU, once per `callId`: `make` gets the id it takes (the one of the CU of the same client
	 * and year, when there is one) and gives the record. Checked as the file is: a WithholdingError,
	 * nothing written, when it does not hold.
	 */
	record(callId: string, key: string, year: number, make: (id: string) => CuRecord): Recorded {
		let out: Recorded | undefined;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				const cu = book.cus.find((c) => c.callId === callId);
				if (cu === undefined) throw new WithholdingError("questa richiesta ha già scritto, ma la CU non c'è più: ridimmela");
				out = { cu, kind: "again" };
				return book;
			}
			const calls = [...book.calls, callId].slice(-WITHHOLDING_LIMITS.calls);
			const same = book.cus.find((c) => c.client.key === key && c.year === year);
			if (same !== undefined) {
				const cu = checked(make(same.id));
				out = { cu, kind: "replaced" };
				return { ...book, cus: book.cus.map((c) => (c === same ? cu : c)), calls };
			}
			if (book.cus.length >= WITHHOLDING_LIMITS.cus) throw new WithholdingError(`ci sono già ${WITHHOLDING_LIMITS.cus} CU salvate, il massimo: non ne salvo altre`);
			const cu = checked(make(cuId(book.next)));
			out = { cu, kind: "new" };
			return { next: book.next + 1, cus: [...book.cus, cu], calls };
		});
		return out as Recorded;
	}
}

function checked(cu: CuRecord): CuRecord {
	if (!validCu(cu)) throw new WithholdingError("la CU non è valida: non l'ho salvata");
	return cu;
}

const idNumber = (id: string): number => Number(CU_ID.exec(id)?.[1] ?? 0);

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, cus, calls } = raw as Book;
	if (!Number.isInteger(next) || next < 1 || next > 999_999) return undefined;
	if (!Array.isArray(cus) || cus.length > WITHHOLDING_LIMITS.cus || !cus.every(validCu)) return undefined;
	if (new Set(cus.map((c) => c.id)).size !== cus.length) return undefined;
	// One CU per client and year; every id below the counter, which only grows.
	if (new Set(cus.map((c) => `${c.client.key}#${c.year}`)).size !== cus.length) return undefined;
	if (cus.some((c) => idNumber(c.id) >= next)) return undefined;
	if (!Array.isArray(calls) || calls.length > WITHHOLDING_LIMITS.calls || !calls.every(validCall)) return undefined;
	return raw as Book;
}
