/**
 * The ore di lavoro of an instance, in `timesheet.json` (outside the workspace): the next
 * progressive of each year, every entry, the running timers (one per person) and the default
 * rates. Changed under the shared file lock; `timesheet.json.bak` keeps a copy of the last state
 * written, as `expenses.json.bak` does. An id is never given twice: the counter only grows, so
 * an entry removed leaves its id used. Read never throws: a file that does not read (or is past
 * the size cap) is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { type Billed, entryId, idOrder, type RateRule, sameClient, TIMESHEET_LIMITS, type Timer, TimesheetError, validEntry, validRule, validTimer, type WorkEntry } from "./timesheet.ts";

type Book = {
	readonly next: Readonly<Record<string, number>>;
	readonly entries: readonly WorkEntry[];
	readonly timers: readonly Timer[];
	readonly rates: readonly RateRule[];
};

export type TimesheetBook = { readonly entries: readonly WorkEntry[]; readonly timers: readonly Timer[]; readonly rates: readonly RateRule[]; readonly broken: boolean };

export const TIMESHEET_BROKEN = "il registro delle ore (timesheet.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { next: {}, entries: [], timers: [], rates: [] };
const YEAR = /^\d{4}$/;

/** What a remove found: removed now, removed before (its id is used and it is not there), or never recorded. */
export type Removed = "removed" | "gone" | "unknown";

/** What a start found: the timer started (now, or by this same call before), or another one running. */
export type Started = { readonly started: Timer } | { readonly running: Timer };

export class TimesheetStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "timesheet.json"),
			empty: EMPTY,
			maxBytes: TIMESHEET_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new TimesheetError(TIMESHEET_BROKEN),
			full: () => new TimesheetError("il registro delle ore è pieno: non ne salvo altre"),
		};
	}

	/** Never throws. */
	read(): TimesheetBook {
		const book = readBook(this.book);
		return book === undefined ? { entries: [], timers: [], rates: [], broken: true } : { entries: book.entries, timers: book.timers, rates: book.rates, broken: false };
	}

	/**
	 * A new entry with the next id of `year` (the year of its day): `make` gets the id and gives the
	 * entry. The one recorded by `callId` already, when there is one (a call run again).
	 */
	add(year: number, callId: string, make: (id: string) => WorkEntry): WorkEntry {
		let made: WorkEntry | undefined;
		this.update((book) => {
			made = book.entries.find((e) => e.callId === callId);
			if (made !== undefined) return book;
			const added = withEntry(book, year, make);
			made = added.entry;
			return added.book;
		});
		return made as WorkEntry;
	}

	/** Change the entry `id` as saved now, under the lock. TimesheetError when it is not there. */
	edit(id: string, change: (entry: WorkEntry) => WorkEntry): WorkEntry {
		let edited: WorkEntry | undefined;
		this.update((book) => {
			const entry = book.entries.find((e) => e.id === id);
			if (entry === undefined) throw new TimesheetError(`la voce ${id} non c'è più`);
			const next = checked(change(entry));
			edited = next;
			return { ...book, entries: book.entries.map((e) => (e === entry ? next : e)) };
		});
		return edited as WorkEntry;
	}

	/** Remove the entry `id`; its id stays used. Asked again, it says the entry is gone. */
	remove(id: string): Removed {
		let result: Removed = "unknown";
		this.update((book) => {
			const entry = book.entries.find((e) => e.id === id);
			if (entry === undefined) {
				const [year, seq] = idOrder(id);
				result = seq >= 1 && seq < (book.next[String(year)] ?? 1) ? "gone" : "unknown";
				return book;
			}
			result = "removed";
			return { ...book, entries: book.entries.filter((e) => e !== entry) };
		});
		return result;
	}

	/**
	 * Mark the entries `ids` billed (`billed` given) or not billed (undefined), as saved now. Only
	 * those that change are written: what is already so is left, so a call run again changes
	 * nothing. `billedOf` gives each entry's mark (its rate and rounding of now). The ids changed.
	 */
	setBilled(ids: readonly string[], billedOf: ((entry: WorkEntry) => Billed) | undefined): string[] {
		const changed: string[] = [];
		this.update((book) => {
			const wanted = new Set(ids);
			let any = false;
			const entries = book.entries.map((e) => {
				if (!wanted.has(e.id)) return e;
				if (billedOf === undefined) {
					if (e.billed === undefined) return e;
					const { billed: _, ...rest } = e;
					any = true;
					changed.push(e.id);
					return checked(rest);
				}
				const mark = billedOf(e);
				if (e.billed !== undefined && e.billed.ref === mark.ref && e.billed.quote === mark.quote) return e;
				any = true;
				changed.push(e.id);
				return checked({ ...e, billed: mark });
			});
			return any ? { ...book, entries } : book;
		});
		return changed;
	}

	/**
	 * Start the timer of `person`: `make` gives it. When one runs already it is given back, nothing
	 * changed: two starts at once leave one timer. The timer of `callId` is this call's own.
	 */
	start(person: string, callId: string, make: () => Timer): Started {
		let result: Started | undefined;
		this.update((book) => {
			const running = book.timers.find((t) => t.person === person);
			if (running !== undefined) {
				result = running.callId === callId ? { started: running } : { running };
				return book;
			}
			if (book.timers.length >= TIMESHEET_LIMITS.timers) throw new TimesheetError("ci sono troppi timer avviati: fermane qualcuno");
			const timer = make();
			if (!validTimer(timer)) throw new TimesheetError("il timer non è valido: non l'ho avviato");
			result = { started: timer };
			return { ...book, timers: [...book.timers, timer] };
		});
		return result as Started;
	}

	/**
	 * Stop the timer of `person` and record what it ran as an entry (`make` gets the timer and gives
	 * the entry without its id, which is the next of its day's year; it may throw to keep the timer
	 * running; undefined drops the timer without recording, as asked). The entry of `callId` when this
	 * call stopped it already. Undefined when no timer runs and this call recorded nothing.
	 */
	stop(person: string, callId: string, make: ((timer: Timer) => Omit<WorkEntry, "id">) | undefined): { entry?: WorkEntry; timer?: Timer } | undefined {
		let result: { entry?: WorkEntry; timer?: Timer } | undefined;
		this.update((book) => {
			const done = book.entries.find((e) => e.callId === callId);
			if (done !== undefined) {
				result = { entry: done };
				return book;
			}
			const timer = book.timers.find((t) => t.person === person);
			if (timer === undefined) return book;
			const timers = book.timers.filter((t) => t !== timer);
			if (make === undefined) {
				result = { timer };
				return { ...book, timers };
			}
			const draft = make(timer);
			const added = withEntry({ ...book, timers }, Number(draft.date.slice(0, 4)), (id) => ({ id, ...draft }) as WorkEntry);
			result = { entry: added.entry, timer };
			return added.book;
		});
		return result;
	}

	/** Set the default rate and rounding of `client` (undefined: everyone's); a field undefined keeps what there is, null removes it. */
	setRate(client: string | undefined, change: { readonly rate?: string | null; readonly rounding?: number | null }, mark: { by: string; at: string }): RateRule | undefined {
		let rule: RateRule | undefined;
		this.update((book) => {
			const old = book.rates.find((r) => (client === undefined ? r.client === undefined : r.client !== undefined && sameClient(r.client, client)));
			const rate = change.rate === null ? undefined : (change.rate ?? old?.rate);
			const rounding = change.rounding === null ? undefined : (change.rounding ?? old?.rounding);
			if (old !== undefined && old.rate === rate && old.rounding === rounding) {
				rule = old;
				return book;
			}
			const others = book.rates.filter((r) => r !== old);
			if (rate === undefined && rounding === undefined) {
				rule = undefined;
				return old === undefined ? book : { ...book, rates: others };
			}
			const next = { ...(client === undefined ? {} : { client: old?.client ?? client }), ...(rate === undefined ? {} : { rate }), ...(rounding === undefined ? {} : { rounding }), ...mark } as RateRule;
			if (!validRule(next)) throw new TimesheetError("la tariffa non è valida: non l'ho salvata");
			if (old === undefined && others.filter((r) => r.client !== undefined).length >= TIMESHEET_LIMITS.rates) throw new TimesheetError(`ci sono già ${TIMESHEET_LIMITS.rates} clienti con una tariffa: non ne salvo altre`);
			rule = next;
			return { ...book, rates: [...others, next] };
		});
		return rule;
	}

	/** The change under the lock; then a copy of what was written in timesheet.json.bak. */
	private update(change: (book: Book) => Book): void {
		updateBook(this.book, change);
	}
}

/** The book with a new entry of `year`, numbered next. TimesheetError when the year is full. */
function withEntry(book: Book, year: number, make: (id: string) => WorkEntry): { book: Book; entry: WorkEntry } {
	const count = book.entries.filter((e) => idOrder(e.id)[0] === year).length;
	if (count >= TIMESHEET_LIMITS.perYear) throw new TimesheetError(`ci sono già ${TIMESHEET_LIMITS.perYear} voci di ore del ${year}, il massimo per un anno: non ne registro altre`);
	const key = String(year);
	const n = Math.max(book.next[key] ?? 1, 1);
	const entry = checked(make(entryId(year, n)));
	if (idOrder(entry.id)[0] !== year) throw new TimesheetError("la voce non è valida: non l'ho salvata");
	return { entry, book: { ...book, next: { ...book.next, [key]: n + 1 }, entries: [...book.entries, entry] } };
}

/** What is written always reads back. */
function checked(entry: WorkEntry): WorkEntry {
	if (!validEntry(entry)) throw new TimesheetError("la voce non è valida: non l'ho salvata");
	return entry;
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, entries, timers, rates } = raw as Book;
	if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined;
	if (!Object.entries(next).every(([y, n]) => YEAR.test(y) && Number.isInteger(n) && n >= 1 && n <= 1_000_000)) return undefined;
	if (!Array.isArray(entries) || !entries.every(validEntry)) return undefined;
	if (!Array.isArray(timers) || !timers.every(validTimer) || new Set(timers.map((t) => t.person)).size !== timers.length) return undefined;
	if (!Array.isArray(rates) || !rates.every(validRule) || rates.filter((r) => r.client === undefined).length > 1) return undefined;
	if (new Set(entries.map((e) => e.id)).size !== entries.length) return undefined;
	// Every id below its year's counter: a counter behind an entry would give that id again.
	for (const e of entries) {
		const [year, seq] = idOrder(e.id);
		if (seq >= (next[String(year)] ?? 1)) return undefined;
	}
	return raw as Book;
}
