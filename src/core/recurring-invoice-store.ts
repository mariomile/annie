/**
 * Le fatture ricorrenti of an instance, in `recurring-invoices.json` (outside the workspace): the
 * schedules, the next number to give (a number is never given twice), the periods handled (each
 * schedule and period once: claimed before the draft is made, so a crash, a restart or two sweeps
 * never make two) and the ids of the calls that wrote. Changed under the shared file lock through
 * json-book.ts, with the copy `recurring-invoices.json.bak`. Read never throws: a file that does
 * not read is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { RECURRING_LIMITS, RecurringError, type Run, SCHEDULE_ID, type Schedule, validRun, validSchedule } from "./recurring-invoices.ts";
import { isText } from "./stored-fields.ts";

export type RecurringState = { readonly nextId: number; readonly schedules: readonly Schedule[] };

type Book = RecurringState & { readonly runs: readonly Run[]; readonly calls: readonly string[] };

export type RecurringBook = Book & { readonly broken: boolean };

export const RECURRING_BROKEN = "le fatture ricorrenti (recurring-invoices.json) non si leggono: non le cambio, perché andrebbero perse. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { nextId: 1, schedules: [], runs: [], calls: [] };

/** What a claim gave: the period is this call's to prepare (new, or claimed before and never finished), or handled already. */
export type Claim = { readonly mine: true; readonly run: Run } | { readonly mine: false; readonly run: Run };

export class RecurringStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "recurring-invoices.json"),
			empty: EMPTY,
			maxBytes: RECURRING_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new RecurringError(RECURRING_BROKEN),
			full: () => new RecurringError("le fatture ricorrenti sono piene: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): RecurringBook {
		const book = readBook(this.book);
		return book === undefined ? { ...EMPTY, broken: true } : { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). "rerun" when the call wrote already. The runs of a
	 * schedule removed go with it. RecurringError from `change` stops it with nothing written.
	 */
	update(callId: string, change: (state: RecurringState) => RecurringState): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const state: RecurringState = { nextId: book.nextId, schedules: book.schedules };
			const next = change(state);
			if (next === state) return book;
			outcome = "written";
			const ids = new Set(next.schedules.map((s) => s.id));
			const made: Book = { nextId: next.nextId, schedules: next.schedules, runs: book.runs.filter((r) => ids.has(r.schedule)), calls: [...book.calls, callId].slice(-RECURRING_LIMITS.calls) };
			if (validBook(made) === undefined) throw new RecurringError("la fattura ricorrente non è valida: non l'ho salvata");
			return made;
		});
		return outcome;
	}

	/**
	 * Claim a schedule's period: a new claim when nobody handled it (or a claim never finished, by
	 * a process that stopped: its draft is found again by the draft's own call id); `retry` claims
	 * again a period that failed (the person asked). Otherwise what was done.
	 */
	claim(schedule: string, period: string, at: string, o: { readonly skipped?: number; readonly retry?: boolean } = {}): Claim {
		let out: Claim | undefined;
		updateBook(this.book, (book) => {
			if (!book.schedules.some((s) => s.id === schedule)) throw new RecurringError("la fattura ricorrente non c'è più");
			const old = book.runs.find((r) => r.schedule === schedule && r.period === period);
			if (old !== undefined && (old.state === "drafted" || (old.state === "failed" && o.retry !== true))) {
				out = { mine: false, run: old };
				return book;
			}
			if (old !== undefined && old.state === "claimed") {
				out = { mine: true, run: old };
				return book;
			}
			const run: Run = { schedule, period, state: "claimed", at, ...(o.skipped === undefined || o.skipped === 0 ? {} : { skipped: o.skipped }) };
			out = { mine: true, run };
			return { ...book, runs: [...book.runs.filter((r) => r !== old), run].slice(-RECURRING_LIMITS.runs) };
		});
		return out as Claim;
	}

	/** How a claimed period ended: drafted (with the draft's id) or failed (with why). */
	settle(schedule: string, period: string, result: { readonly draft: string } | { readonly why: string }): Run | undefined {
		let out: Run | undefined;
		updateBook(this.book, (book) => {
			const old = book.runs.find((r) => r.schedule === schedule && r.period === period);
			if (old === undefined) return book;
			const run: Run = "draft" in result ? { ...old, state: "drafted", draft: result.draft } : { ...old, state: "failed", why: result.why.slice(0, 4000) };
			out = run;
			return { ...book, runs: book.runs.map((r) => (r === old ? run : r)) };
		});
		return out;
	}

	/** The conversation was told how a period went: not told again. */
	markTold(schedule: string, period: string): void {
		updateBook(this.book, (book) => {
			const old = book.runs.find((r) => r.schedule === schedule && r.period === period);
			if (old === undefined || old.told === true) return book;
			return { ...book, runs: book.runs.map((r) => (r === old ? { ...old, told: true as const } : r)) };
		});
	}
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999_999;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextId)) return undefined;
	if (!Array.isArray(b.schedules) || b.schedules.length > RECURRING_LIMITS.schedules || !b.schedules.every(validSchedule)) return undefined;
	if (!Array.isArray(b.runs) || b.runs.length > RECURRING_LIMITS.runs || !b.runs.every(validRun)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > RECURRING_LIMITS.calls || !b.calls.every((c) => isText(c, 200))) return undefined;
	// Numbers never given again: every id below its counter, each once; a period handled once.
	const ids = new Set<string>();
	for (const s of b.schedules) {
		const n = Number(SCHEDULE_ID.exec(s.id)?.[1]);
		if (n >= b.nextId || ids.has(s.id)) return undefined;
		ids.add(s.id);
	}
	const periods = new Set<string>();
	for (const r of b.runs) {
		const key = `${r.schedule}|${r.period}`;
		if (periods.has(key)) return undefined;
		periods.add(key);
	}
	return b;
}
