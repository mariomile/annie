/**
 * The rinnovi of an instance, in `renewals.json` (outside the workspace): the next progressive
 * and every renewal, active and cancelled. Changed under the shared file lock through json-book.ts;
 * `renewals.json.bak` keeps a copy of the last state written. An id is never given twice: the
 * counter only grows, so a renewal removed leaves its id used. Read never throws: a file that does
 * not read (or is past the size cap) is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { idNumber, RENEWAL_LIMITS, type Renewal, RenewalError, renewalId, validRenewal } from "./renewals.ts";

type Book = { readonly next: number; readonly renewals: readonly Renewal[] };

export type RenewalBook = { readonly renewals: readonly Renewal[]; readonly broken: boolean };

export const RENEWALS_BROKEN = "l'elenco dei rinnovi (renewals.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: 1, renewals: [] };

/** What a remove found: removed now, removed before (its id is used and it is not there), or never recorded. */
export type Removed = "removed" | "gone" | "unknown";

export class RenewalStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "renewals.json"),
			empty: EMPTY,
			maxBytes: RENEWAL_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new RenewalError(RENEWALS_BROKEN),
			full: () => new RenewalError("l'elenco dei rinnovi è pieno: non ne salvo altri"),
		};
	}

	/** Never throws. */
	read(): RenewalBook {
		const book = readBook(this.book);
		return book === undefined ? { renewals: [], broken: true } : { renewals: book.renewals, broken: false };
	}

	/**
	 * A new renewal with the next id: `make` gets the id and gives the renewal. The one recorded by
	 * `callId` already, when there is one (a call run again). RenewalError when the list is full.
	 */
	add(callId: string, make: (id: string) => Renewal): Renewal {
		let made: Renewal | undefined;
		updateBook(this.book, (book) => {
			made = book.renewals.find((r) => r.callId === callId);
			if (made !== undefined) return book;
			if (book.renewals.length >= RENEWAL_LIMITS.items) throw new RenewalError(`ci sono già ${RENEWAL_LIMITS.items} rinnovi, il massimo: togline qualcuno che non serve più prima di aggiungerne altri`);
			const renewal = checked(make(renewalId(book.next)));
			made = renewal;
			return { next: book.next + 1, renewals: [...book.renewals, renewal] };
		});
		return made as Renewal;
	}

	/**
	 * Change the renewal `id`: `change` gets it as saved now, under the lock, and gives it back
	 * changed (the same object back writes nothing). RenewalError when it is not there.
	 */
	edit(id: string, change: (renewal: Renewal) => Renewal): Renewal {
		let edited: Renewal | undefined;
		updateBook(this.book, (book) => {
			const renewal = book.renewals.find((r) => r.id === id);
			if (renewal === undefined) throw new RenewalError(`il rinnovo ${id} non c'è più`);
			const next = change(renewal);
			edited = next;
			if (next === renewal) return book;
			return { ...book, renewals: book.renewals.map((r) => (r === renewal ? checked(next) : r)) };
		});
		return edited as Renewal;
	}

	/** Remove the renewal `id`; its id stays used. Asked again, it says the renewal is gone. */
	remove(id: string): Removed {
		let result: Removed = "unknown";
		updateBook(this.book, (book) => {
			const renewal = book.renewals.find((r) => r.id === id);
			if (renewal === undefined) {
				const n = idNumber(id);
				result = n >= 1 && n < book.next ? "gone" : "unknown";
				return book;
			}
			result = "removed";
			return { ...book, renewals: book.renewals.filter((r) => r !== renewal) };
		});
		return result;
	}
}

/** What is written always reads back. */
function checked(renewal: Renewal): Renewal {
	if (!validRenewal(renewal)) throw new RenewalError("il rinnovo non è valido: non l'ho salvato");
	return renewal;
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, renewals } = raw as Book;
	if (!Number.isInteger(next) || next < 1 || next > 1_000_000) return undefined;
	if (!Array.isArray(renewals) || renewals.length > RENEWAL_LIMITS.items || !renewals.every(validRenewal)) return undefined;
	if (new Set(renewals.map((r) => r.id)).size !== renewals.length) return undefined;
	// Every id below the counter: a counter behind a renewal would give that id again.
	if (renewals.some((r) => idNumber(r.id) >= next)) return undefined;
	return raw as Book;
}
