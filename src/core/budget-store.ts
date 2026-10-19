/**
 * Budget e obiettivi's own state, in `budgets.json` of an instance (outside the workspace): the
 * budgets, the next number to give (a number is never given twice), the ids of the calls that
 * wrote (a call run again writes nothing twice) and the brief's alerts already said, each with
 * the call that said it. Changed under the shared file lock through json-book.ts, with the copy
 * `budgets.json.bak`. Read never throws: a file that does not read is `broken`, and nothing is
 * written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { type AlertClaim, BUDGET_ID, BUDGET_LIMITS, type Budget, BudgetError, subjectKey, validBudget, validBudgetCall, validClaim } from "./budgets.ts";

/** What a change works on: the budgets and the next number to give. */
export type BudgetState = { readonly nextId: number; readonly budgets: readonly Budget[] };

type Book = BudgetState & { readonly alerts: readonly AlertClaim[]; readonly calls: readonly string[] };

export type BudgetBook = Book & { readonly broken: boolean };

export const BUDGETS_BROKEN = "i budget (budgets.json) non si leggono: non li cambio, perché andrebbero persi. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { nextId: 1, budgets: [], alerts: [], calls: [] };

export class BudgetStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "budgets.json"),
			empty: EMPTY,
			maxBytes: BUDGET_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new BudgetError(BUDGETS_BROKEN),
			full: () => new BudgetError("i budget sono pieni: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): BudgetBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). Returns false when the call wrote already (run again),
	 * and then nothing changes. The alerts of a budget gone, or changed (a new object for its id),
	 * go with it: a budget changed is said again against what it is now. BudgetError from `change`
	 * stops it with nothing written.
	 */
	update(callId: string, change: (state: BudgetState) => BudgetState): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) return book;
			const state: BudgetState = { nextId: book.nextId, budgets: book.budgets };
			const next = change(state);
			if (next === state) return book;
			fresh = true;
			const kept = new Set(next.budgets.filter((b) => book.budgets.includes(b)).map((b) => b.id));
			const alerts = book.alerts.filter((a) => kept.has(a.budget));
			const made: Book = { nextId: next.nextId, budgets: next.budgets, alerts, calls: [...book.calls, callId].slice(-BUDGET_LIMITS.calls) };
			if (validBook(made) === undefined) throw new BudgetError("il budget non è valido: non l'ho salvato");
			return made;
		});
		return fresh;
	}

	/**
	 * The alerts of `wanted` not said yet in their period, marked said by `callId` (the claim the
	 * board's weekly summary makes: each said once). A call run again gets back what it claimed.
	 */
	claim(callId: string, wanted: readonly Omit<AlertClaim, "call">[]): AlertClaim[] {
		let mine: AlertClaim[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before;
				return book;
			}
			const said = (w: Omit<AlertClaim, "call">) => book.alerts.some((a) => a.budget === w.budget && a.period === w.period && a.level === w.level);
			const fresh = wanted.filter((w) => !said(w) && book.budgets.some((b) => b.id === w.budget)).map((w) => ({ ...w, call: callId }));
			mine = fresh;
			if (fresh.length === 0) return book;
			return { ...book, alerts: [...book.alerts, ...fresh].slice(-BUDGET_LIMITS.alerts) };
		});
		return mine;
	}
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999_999;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextId)) return undefined;
	if (!Array.isArray(b.budgets) || b.budgets.length > BUDGET_LIMITS.budgets || !b.budgets.every(validBudget)) return undefined;
	if (!Array.isArray(b.alerts) || b.alerts.length > BUDGET_LIMITS.alerts || !b.alerts.every(validClaim)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > BUDGET_LIMITS.calls || !b.calls.every(validBudgetCall)) return undefined;
	// Numbers never given again: every id below its counter, each once; one budget per target and kind of period.
	const ids = new Set<string>();
	const targets = new Set<string>();
	for (const x of b.budgets) {
		const n = Number(BUDGET_ID.exec(x.id)?.[1]);
		if (n >= b.nextId || ids.has(x.id)) return undefined;
		ids.add(x.id);
		const t = `${subjectKey(x.subject)}|${x.every}`;
		if (targets.has(t)) return undefined;
		targets.add(t);
	}
	return b;
}
