/**
 * I fornitori's own state, in `suppliers.json` of an instance (outside the workspace): the cards,
 * the next card number, and the ids of the calls that wrote (a call run again writes nothing
 * twice). Changed under the shared file lock through json-book.ts, with the copy
 * `suppliers.json.bak`. Read never throws: a file that does not read is `broken`, and nothing is
 * written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { spellingKey } from "./name-keys.ts";
import { SUPPLIER_ID, SUPPLIER_LIMITS, type SupplierCard, SupplierError, validSupplierCall, validSupplierCard } from "./suppliers.ts";

/** What a change works on: the cards and the next number to give. */
export type SupplierState = { readonly nextCard: number; readonly cards: readonly SupplierCard[] };

type Book = SupplierState & { readonly calls: readonly string[] };

export type SupplierBook = Book & { readonly broken: boolean };

export const SUPPLIERS_BROKEN = "le schede dei fornitori (suppliers.json) non si leggono: non le cambio, perché andrebbero perse. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { nextCard: 1, cards: [], calls: [] };

export class SupplierStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "suppliers.json"),
			empty: EMPTY,
			maxBytes: SUPPLIER_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new SupplierError(SUPPLIERS_BROKEN),
			full: () => new SupplierError("le schede dei fornitori sono piene: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): SupplierBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). Returns false when the call wrote already (run again),
	 * and then nothing changes. SupplierError from `change` stops it with nothing written.
	 */
	update(callId: string, change: (state: SupplierState) => SupplierState): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) return book;
			const state: SupplierState = { nextCard: book.nextCard, cards: book.cards };
			const next = change(state);
			if (next === state) return book;
			fresh = true;
			const made: Book = { nextCard: next.nextCard, cards: next.cards, calls: [...book.calls, callId].slice(-SUPPLIER_LIMITS.calls) };
			if (validBook(made) === undefined) throw new SupplierError("la scheda non è valida: non l'ho salvata");
			return made;
		});
		return fresh;
	}
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999_999;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextCard)) return undefined;
	if (!Array.isArray(b.cards) || b.cards.length > SUPPLIER_LIMITS.cards || !b.cards.every(validSupplierCard)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > SUPPLIER_LIMITS.calls || !b.calls.every(validSupplierCall)) return undefined;
	// Numbers never given again: every id below its counter, each once.
	const ids = new Set<string>();
	for (const c of b.cards) {
		const n = Number(SUPPLIER_ID.exec(c.id)?.[1]);
		if (n >= b.nextCard || ids.has(c.id)) return undefined;
		ids.add(c.id);
	}
	// Two cards never answer to the same name, partita IVA or codice fiscale.
	const names = new Set<string>();
	const vats = new Set<string>();
	const cfs = new Set<string>();
	for (const c of b.cards) {
		for (const k of new Set([c.name, ...c.aliases].map(spellingKey))) {
			if (names.has(k)) return undefined;
			names.add(k);
		}
		if (c.vat !== undefined) {
			if (vats.has(c.vat)) return undefined;
			vats.add(c.vat);
		}
		if (c.cf !== undefined) {
			if (cfs.has(c.cf)) return undefined;
			cfs.add(c.cf);
		}
	}
	return b;
}
