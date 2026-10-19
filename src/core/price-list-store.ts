/**
 * Il listino prezzi of an instance, in `price-list.json` (outside the workspace): the next
 * progressive, every voce, and the call ids of the changes to many voci (a price change, an
 * import), so a call run again changes nothing twice. Changed under the shared file lock through
 * json-book.ts; `price-list.json.bak` keeps a copy of the last state written. An id is never given
 * twice: the counter only grows. Read never throws: a file that does not read (or is past the size
 * cap) is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { spellingKey } from "./name-keys.ts";
import { idNumber, itemId, PRICE_LIST_LIMITS, type PriceItem, PriceListError, validItem } from "./price-list.ts";
import { isText } from "./stored-fields.ts";

type Book = { readonly next: number; readonly items: readonly PriceItem[]; readonly calls?: readonly string[] };

export type PriceListBook = { readonly items: readonly PriceItem[]; readonly broken: boolean };

export const PRICE_LIST_BROKEN = "il listino prezzi (price-list.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: 1, items: [] };

/** What a remove found: removed now, removed before (its id is used and it is not there), or never recorded. */
export type Removed = "removed" | "gone" | "unknown";

/** A new price for one voce, as planned: applied only while the voce still has `from`. */
export type Repricing = { readonly id: string; readonly from: string; readonly to: string };

export class PriceListStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "price-list.json"),
			empty: EMPTY,
			maxBytes: PRICE_LIST_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new PriceListError(PRICE_LIST_BROKEN),
			full: () => new PriceListError("il listino è pieno: non salvo altre voci"),
		};
	}

	/** Never throws. */
	read(): PriceListBook {
		const book = readBook(this.book);
		return book === undefined ? { items: [], broken: true } : { items: book.items, broken: false };
	}

	/**
	 * New voci with the next ids: `make` gets each id and gives the voce. Those recorded by
	 * `callId` already, when there are (a call run again). PriceListError when the list would be
	 * full or a name or code is taken.
	 */
	addMany(callId: string, count: number, make: (id: string, n: number) => PriceItem): PriceItem[] {
		let made: PriceItem[] = [];
		updateBook(this.book, (book) => {
			const mine = book.items.filter((i) => i.callId === callId);
			if (mine.length > 0) {
				made = mine;
				return book;
			}
			if (book.items.length + count > PRICE_LIST_LIMITS.items) throw new PriceListError(`il listino terrebbe più di ${PRICE_LIST_LIMITS.items} voci, il massimo: togline qualcuna che non vendi più prima di aggiungerne altre`);
			const fresh = Array.from({ length: count }, (_, n) => checked({ ...make(itemId(book.next + n), n), callId }));
			const all = [...book.items, ...fresh];
			clash(all);
			made = fresh;
			return { ...book, next: book.next + count, items: all };
		});
		return made;
	}

	/** Change the voce `id`: `change` gets it as saved now and gives it back (the same object writes nothing). */
	edit(id: string, change: (item: PriceItem) => PriceItem): PriceItem {
		let edited: PriceItem | undefined;
		updateBook(this.book, (book) => {
			const item = book.items.find((i) => i.id === id);
			if (item === undefined) throw new PriceListError(`la voce ${id} non c'è più`);
			const next = change(item);
			edited = next;
			if (next === item) return book;
			const items = book.items.map((i) => (i === item ? checked(next) : i));
			clash(items);
			return { ...book, items };
		});
		return edited as PriceItem;
	}

	/** Remove the voce `id`; its id stays used. Asked again, it says the voce is gone. */
	remove(id: string): Removed {
		let result: Removed = "unknown";
		updateBook(this.book, (book) => {
			const item = book.items.find((i) => i.id === id);
			if (item === undefined) {
				const n = idNumber(id);
				result = n >= 1 && n < book.next ? "gone" : "unknown";
				return book;
			}
			result = "removed";
			return { ...book, items: book.items.filter((i) => i !== item) };
		});
		return result;
	}

	/**
	 * New prices for some voci, once per `callId`: each only while the voce still has the price it
	 * was planned from. Gives back the ids changed, and false when this call had changed them already.
	 */
	reprice(callId: string, plan: readonly Repricing[], mark: { by: string; at: string }): { changed: string[]; again: boolean } {
		let result: { changed: string[]; again: boolean } = { changed: [], again: false };
		updateBook(this.book, (book) => {
			if ((book.calls ?? []).includes(callId)) {
				result = { changed: [], again: true };
				return book;
			}
			const changed: string[] = [];
			const items = book.items.map((i) => {
				const p = plan.find((x) => x.id === i.id);
				if (p === undefined || i.price !== p.from) return i;
				changed.push(i.id);
				return checked({ ...i, price: p.to, edited: mark });
			});
			result = { changed, again: false };
			return { ...book, items, calls: [...(book.calls ?? []), callId].slice(-PRICE_LIST_LIMITS.calls) };
		});
		return result;
	}
}

/** What is written always reads back. */
function checked(item: PriceItem): PriceItem {
	if (!validItem(item)) throw new PriceListError("la voce non è valida: non l'ho salvata");
	return item;
}

/** Two voci with one name or one code: refused, so a phrase names one voce. */
function clash(items: readonly PriceItem[]): void {
	const names = new Map<string, string>();
	const codes = new Map<string, string>();
	for (const i of items) {
		const k = spellingKey(i.name);
		const other = names.get(k);
		if (other !== undefined) throw new PriceListError(`nel listino c'è già una voce con questo nome (${other}): cambia quella con op update, oppure scegli un altro nome`);
		names.set(k, i.id);
		if (i.code !== undefined) {
			const c = i.code.toUpperCase();
			const was = codes.get(c);
			if (was !== undefined) throw new PriceListError(`il codice è già della voce ${was}: scegline un altro`);
			codes.set(c, i.id);
		}
	}
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, items, calls } = raw as Book;
	if (!Number.isInteger(next) || next < 1 || next > 10_000_000) return undefined;
	if (!Array.isArray(items) || items.length > PRICE_LIST_LIMITS.items || !items.every(validItem)) return undefined;
	if (calls !== undefined && (!Array.isArray(calls) || calls.length > PRICE_LIST_LIMITS.calls || !calls.every((c) => isText(c, 200)))) return undefined;
	if (new Set(items.map((i) => i.id)).size !== items.length) return undefined;
	// Every id below the counter: a counter behind a voce would give that id again.
	if (items.some((i) => idNumber(i.id) >= next)) return undefined;
	return raw as Book;
}
