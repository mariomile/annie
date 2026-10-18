/**
 * The spese of an instance, in `expenses.json` (outside the workspace): the next progressive of
 * each year and every expense. Changed under the shared file lock; `expenses.json.bak` keeps a copy
 * of the last state written, as `quotes.json.bak` does. An id is never given twice: the counter
 * only grows, so an expense removed leaves its id used, and a remove asked again says it is gone.
 * Read never throws: a file that does not read (or is past the size cap) is `broken`, and nothing
 * is written over it. A year past its cap still reads; only new expenses of that year are refused.
 */
import { join } from "node:path";
import { EXPENSE_LIMITS, type Expense, ExpenseError, expenseId, idOrder, validExpense } from "./expenses.ts";
import { type BookFile, readBook, updateBook } from "./json-book.ts";

type Book = { readonly next: Readonly<Record<string, number>>; readonly expenses: readonly Expense[] };

export type ExpenseBook = { readonly expenses: readonly Expense[]; readonly broken: boolean };

export const EXPENSES_BROKEN = "il registro delle spese (expenses.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: {}, expenses: [] };
const YEAR = /^\d{4}$/;

/** What a remove found: removed now, removed before (its id is used and it is not there), or never recorded. */
export type Removed = "removed" | "gone" | "unknown";

export class ExpenseStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "expenses.json"),
			empty: EMPTY,
			maxBytes: EXPENSE_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new ExpenseError(EXPENSES_BROKEN),
			full: () => new ExpenseError("il registro delle spese è pieno: non ne salvo altre"),
		};
	}

	/** Never throws. */
	read(): ExpenseBook {
		const book = readBook(this.book);
		return book === undefined ? { expenses: [], broken: true } : { expenses: book.expenses, broken: false };
	}

	/**
	 * A new expense with the next id of `year` (the year of its date): `make` gets the id and gives
	 * the expense. The one recorded by `callId` already, when there is one (a call run again).
	 * ExpenseError when the year is full.
	 */
	add(year: number, callId: string, make: (id: string) => Expense): Expense {
		let made: Expense | undefined;
		this.update((book) => {
			made = book.expenses.find((e) => e.callId === callId);
			if (made !== undefined) return book;
			const count = book.expenses.filter((e) => idOrder(e.id)[0] === year).length;
			if (count >= EXPENSE_LIMITS.perYear) throw new ExpenseError(`ci sono già ${EXPENSE_LIMITS.perYear} spese del ${year}, il massimo per un anno: non ne registro altre`);
			const key = String(year);
			const n = Math.max(book.next[key] ?? 1, 1);
			const expense = checked(make(expenseId(year, n)));
			made = expense;
			return { next: { ...book.next, [key]: n + 1 }, expenses: [...book.expenses, expense] };
		});
		return made as Expense;
	}

	/**
	 * Change the expense `id`: `change` gets it as saved now, under the lock (a change made
	 * meanwhile is kept), and gives it back changed. ExpenseError when it is not there.
	 */
	edit(id: string, change: (expense: Expense) => Expense): Expense {
		let edited: Expense | undefined;
		this.update((book) => {
			const expense = book.expenses.find((e) => e.id === id);
			if (expense === undefined) throw new ExpenseError(`la spesa ${id} non c'è più`);
			const next = checked(change(expense));
			edited = next;
			return { ...book, expenses: book.expenses.map((e) => (e === expense ? next : e)) };
		});
		return edited as Expense;
	}

	/** Remove the expense `id`; its id stays used. Asked again, it says the expense is gone. */
	remove(id: string): Removed {
		let result: Removed = "unknown";
		this.update((book) => {
			const expense = book.expenses.find((e) => e.id === id);
			if (expense === undefined) {
				const [year, seq] = idOrder(id);
				result = seq >= 1 && seq < (book.next[String(year)] ?? 1) ? "gone" : "unknown";
				return book;
			}
			result = "removed";
			return { ...book, expenses: book.expenses.filter((e) => e !== expense) };
		});
		return result;
	}

	/** The change under the lock; then a copy of what was written in expenses.json.bak. */
	private update(change: (book: Book) => Book): void {
		updateBook(this.book, change);
	}
}

/** What is written always reads back. */
function checked(expense: Expense): Expense {
	if (!validExpense(expense)) throw new ExpenseError("la spesa non è valida: non l'ho salvata");
	return expense;
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, expenses } = raw as Book;
	if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined;
	if (!Object.entries(next).every(([y, n]) => YEAR.test(y) && Number.isInteger(n) && n >= 1 && n <= 1_000_000)) return undefined;
	if (!Array.isArray(expenses) || !expenses.every(validExpense)) return undefined;
	if (new Set(expenses.map((e) => e.id)).size !== expenses.length) return undefined;
	// Every id below its year's counter: a counter behind an expense would give that id again.
	for (const e of expenses) {
		const [year, seq] = idOrder(e.id);
		if (seq >= (next[String(year)] ?? 1)) return undefined;
	}
	return raw as Book;
}
