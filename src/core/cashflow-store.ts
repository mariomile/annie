/**
 * The previsione di cassa's own state, in `cashflow.json` of an instance (outside the workspace):
 * the bank balances said (the latest CASHFLOW_LIMITS.balances by date, oldest first), the alert
 * threshold of the brief, the next progressive and the voci added by hand. Changed under the shared file lock through
 * json-book.ts; `cashflow.json.bak` keeps a copy of the last state written. An id is never given
 * twice: the counter only grows. Read never throws: a file that does not read (or is past the size
 * cap) is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type Balance, CASHFLOW_LIMITS, type CashItem, CashflowError, idNumber, isSignedAmount, itemId, validBalance, validItem } from "./cashflow.ts";
import { type BookFile, readBook, updateBook } from "./json-book.ts";

type Book = { readonly next: number; readonly balances: readonly Balance[]; readonly alertBelow?: string; readonly items: readonly CashItem[] };

export type CashflowBook = {
	readonly balances: readonly Balance[];
	/** The balance below which the brief warns; zero when not set. */
	readonly alertBelow?: string;
	readonly items: readonly CashItem[];
	readonly broken: boolean;
};

export const CASHFLOW_BROKEN = "la previsione di cassa (cashflow.json) non si legge: non la cambio, perché andrebbe persa. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: 1, balances: [], items: [] };

/** What a remove found: removed now, removed before (its id is used and it is not there), or never recorded. */
export type Removed = "removed" | "gone" | "unknown";

/** The latest balance: the one of the latest day; of two of the same day, the one said last. */
export function latestBalance(balances: readonly Balance[]): Balance | undefined {
	let latest: Balance | undefined;
	for (const b of balances) if (latest === undefined || b.date >= latest.date) latest = b;
	return latest;
}

/** By date, a day's balances in the order said: the stable sort keeps it. */
function byDate(balances: readonly Balance[]): Balance[] {
	return [...balances].sort((a, b) => a.date.localeCompare(b.date));
}

export class CashflowStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "cashflow.json"),
			empty: EMPTY,
			maxBytes: CASHFLOW_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new CashflowError(CASHFLOW_BROKEN),
			full: () => new CashflowError("la previsione di cassa è piena: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): CashflowBook {
		const book = readBook(this.book);
		if (book === undefined) return { balances: [], items: [], broken: true };
		return { balances: book.balances, items: book.items, ...(book.alertBelow === undefined ? {} : { alertBelow: book.alertBelow }), broken: false };
	}

	/**
	 * A new balance (none when `balance` is undefined) and the alert threshold (`null` removes it,
	 * undefined keeps it). The balance a call set already is not added twice (a call run again).
	 * Past the cap the oldest by date go, never the latest.
	 */
	setBalance(balance: Balance | undefined, alertBelow: string | null | undefined): void {
		updateBook(this.book, (book) => {
			const again = balance?.callId !== undefined && book.balances.some((b) => b.callId === balance.callId);
			const balances = balance === undefined || again ? book.balances : byDate([...book.balances, checkedBalance(balance)]).slice(-CASHFLOW_LIMITS.balances);
			let next: Book = balances === book.balances ? book : { ...book, balances };
			if (alertBelow === null && next.alertBelow !== undefined) {
				const { alertBelow: _a, ...rest } = next;
				next = rest;
			} else if (alertBelow !== null && alertBelow !== undefined && alertBelow !== next.alertBelow) {
				if (!isSignedAmount(alertBelow)) throw new CashflowError("la soglia non è valida: non l'ho salvata");
				next = { ...next, alertBelow };
			}
			return next;
		});
	}

	/** A new voce with the next id: `make` gets the id and gives the voce. The one `callId` recorded already, when there is one. */
	add(callId: string, make: (id: string) => CashItem): CashItem {
		let made: CashItem | undefined;
		updateBook(this.book, (book) => {
			made = book.items.find((i) => i.callId === callId);
			if (made !== undefined) return book;
			if (book.items.length >= CASHFLOW_LIMITS.items) throw new CashflowError(`ci sono già ${CASHFLOW_LIMITS.items} voci, il massimo: togline qualcuna che non serve più prima di aggiungerne altre`);
			const item = checkedItem(make(itemId(book.next)));
			made = item;
			return { ...book, next: book.next + 1, items: [...book.items, item] };
		});
		return made as CashItem;
	}

	/** Change the voce `id`: `change` gets it as saved now and gives it back changed (the same object writes nothing). */
	edit(id: string, change: (item: CashItem) => CashItem): CashItem {
		let edited: CashItem | undefined;
		updateBook(this.book, (book) => {
			const item = book.items.find((i) => i.id === id);
			if (item === undefined) throw new CashflowError(`la voce ${id} non c'è più`);
			const next = change(item);
			edited = next;
			if (next === item) return book;
			return { ...book, items: book.items.map((i) => (i === item ? checkedItem(next) : i)) };
		});
		return edited as CashItem;
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
}

function checkedBalance(b: Balance): Balance {
	if (!validBalance(b)) throw new CashflowError("il saldo non è valido: non l'ho salvato");
	return b;
}

function checkedItem(i: CashItem): CashItem {
	if (!validItem(i)) throw new CashflowError("la voce non è valida: non l'ho salvata");
	return i;
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, balances, alertBelow, items } = raw as Book;
	if (!Number.isInteger(next) || next < 1 || next > 1_000_000) return undefined;
	if (!Array.isArray(balances) || balances.length > CASHFLOW_LIMITS.balances || !balances.every(validBalance)) return undefined;
	if (alertBelow !== undefined && !isSignedAmount(alertBelow)) return undefined;
	if (!Array.isArray(items) || items.length > CASHFLOW_LIMITS.items || !items.every(validItem)) return undefined;
	if (new Set(items.map((i) => i.id)).size !== items.length) return undefined;
	// Every id below the counter: a counter behind a voce would give that id again.
	if (items.some((i) => idNumber(i.id) >= next)) return undefined;
	return raw as Book;
}
