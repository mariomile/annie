/**
 * The ore di lavoro of an instance, in `timesheet.json` (outside the workspace): the next
 * progressive of each year, every entry, the running timers (one per person), the default rates
 * and the reservations of the to_quote calls under way. Changed under the shared file lock;
 * `timesheet.json.bak` keeps a copy of the last state written, as `expenses.json.bak` does. An id
 * is never given twice: the counter only grows, so an entry removed leaves its id used. Read
 * never throws: a file that does not read (or is past the size cap) is `broken`, and nothing is
 * written over it. What decides on billing (billed, reserved) is checked again here, under the
 * lock, on the entries as saved: a change made meanwhile is never overwritten.
 *
 * A reservation never lapses while its quote may exist. Before every change, under the lock,
 * the reservations of the other calls are settled: one whose call made its quote (the quotes
 * store says so) is billed with that quote at its frozen terms and dropped, as its own call
 * would have done; one past RESERVATION_MS with no quote is dropped, its entries free again; the
 * rest hold their entries.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import {
	activeReservation,
	type Billed,
	idOrder,
	entryId,
	type RateRule,
	type Reservation,
	type ReservedEntry,
	sameClient,
	TIMESHEET_LIMITS,
	type Timer,
	TimesheetError,
	validEntry,
	validReservation,
	validRule,
	validTimer,
	type WorkEntry,
} from "./timesheet.ts";
import { termsOf } from "./timesheet-sums.ts";

type Book = {
	readonly next: Readonly<Record<string, number>>;
	readonly entries: readonly WorkEntry[];
	readonly timers: readonly Timer[];
	readonly rates: readonly RateRule[];
	readonly reservations?: readonly Reservation[];
};

export type TimesheetBook = {
	readonly entries: readonly WorkEntry[];
	readonly timers: readonly Timer[];
	readonly rates: readonly RateRule[];
	readonly reservations: readonly Reservation[];
	readonly broken: boolean;
};

export const TIMESHEET_BROKEN = "il registro delle ore (timesheet.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

/** An entry another to_quote call is putting in its preventivo: not changed meanwhile. */
export const RESERVED = "è in un preventivo che si sta preparando: riprova tra poco";

const EMPTY: Book = { next: {}, entries: [], timers: [], rates: [], reservations: [] };
const YEAR = /^\d{4}$/;

/** What a remove found: removed now, removed before (its id is used and it is not there), never recorded, or kept (billed, reserved). */
export type Removed = "removed" | "gone" | "unknown" | "billed" | "reserved";

/** What a start found: the timer started (now, or by this same call before), or another one running. */
export type Started = { readonly started: Timer } | { readonly running: Timer };

/** What a bill did: the entries marked now, those not marked because they changed since the pick, and whether the reservation was there. */
export type Billing = { readonly changed: readonly string[]; readonly skipped: readonly string[]; readonly reserved: boolean };

export type TimesheetStoreOptions = {
	readonly now?: () => Date;
	/** The number of the quote a call made, once its document is written (QuoteStore.finished); none: no reservation is ever settled as billed. */
	readonly finishedQuote?: (callId: string) => string | undefined;
};

export class TimesheetStore {
	private readonly book: BookFile<Book>;
	private readonly now: () => Date;
	private readonly finishedQuote: (callId: string) => string | undefined;
	constructor(instanceDir: string, options: TimesheetStoreOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.finishedQuote = options.finishedQuote ?? (() => undefined);
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
		if (book === undefined) return { entries: [], timers: [], rates: [], reservations: [], broken: true };
		return { entries: book.entries, timers: book.timers, rates: book.rates, reservations: book.reservations ?? [], broken: false };
	}

	/** The ids held by another call's reservation (settled already: each of these holds its entries). */
	private heldByOthers(book: Book, callId?: string): Set<string> {
		return new Set((book.reservations ?? []).filter((r) => r.callId !== callId).flatMap((r) => r.entries.map((e) => e.id)));
	}

	/**
	 * The reservations settled, but `keep`'s (the calling call's own): one whose quote is made is
	 * billed with it and dropped; one past its time without a quote is dropped; the others stay.
	 * The same book when nothing changes.
	 */
	private settle(book: Book, keep?: string): Book {
		const reservations = book.reservations ?? [];
		if (reservations.length === 0) return book;
		const now = this.now();
		let entries = book.entries;
		const kept: Reservation[] = [];
		for (const r of reservations) {
			if (r.callId === keep) {
				kept.push(r);
				continue;
			}
			const quote = this.finishedQuote(r.callId);
			if (quote !== undefined) entries = billReserved(entries, r, { by: r.by, at: now.toISOString(), quote }).entries;
			else if (activeReservation(r, now)) kept.push(r);
		}
		return kept.length === reservations.length ? book : { ...book, entries, reservations: kept };
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

	/** Change the entry `id` as saved now, under the lock. TimesheetError when it is not there or is reserved. */
	edit(id: string, change: (entry: WorkEntry) => WorkEntry): WorkEntry {
		let edited: WorkEntry | undefined;
		this.update((book) => {
			const entry = book.entries.find((e) => e.id === id);
			if (entry === undefined) throw new TimesheetError(`la voce ${id} non c'è più`);
			if (this.heldByOthers(book).has(id)) throw new TimesheetError(`la voce ${id} ${RESERVED}`);
			const next = checked(change(entry));
			edited = next;
			return { ...book, entries: book.entries.map((e) => (e === entry ? next : e)) };
		});
		return edited as WorkEntry;
	}

	/** Remove the entry `id`, unless it is billed or reserved (checked here, under the lock); its id stays used. */
	remove(id: string): Removed {
		let result: Removed = "unknown";
		this.update((book) => {
			const entry = book.entries.find((e) => e.id === id);
			if (entry === undefined) {
				const [year, seq] = idOrder(id);
				result = seq >= 1 && seq < (book.next[String(year)] ?? 1) ? "gone" : "unknown";
				return book;
			}
			if (entry.billed !== undefined) {
				result = "billed";
				return book;
			}
			if (this.heldByOthers(book).has(id)) {
				result = "reserved";
				return book;
			}
			result = "removed";
			return { ...book, entries: book.entries.filter((e) => e !== entry) };
		});
		return result;
	}

	/**
	 * Change the billing of the entries `ids`, as saved now: `billedOf` gives each (with the rates
 * as saved) its new mark,
	 * null to clear it, or undefined to leave it. Entries reserved by a to_quote call are left.
	 * Only what changes is written, so a call run again changes nothing. The ids changed, and those
	 * left because reserved.
	 */
	setBilled(ids: readonly string[], billedOf: (entry: WorkEntry, rates: readonly RateRule[]) => Billed | null | undefined): { changed: string[]; reserved: string[] } {
		const changed: string[] = [];
		const reserved: string[] = [];
		this.update((book) => {
			const wanted = new Set(ids);
			const held = this.heldByOthers(book);
			const entries = book.entries.map((e) => {
				if (!wanted.has(e.id)) return e;
				if (held.has(e.id)) {
					reserved.push(e.id);
					return e;
				}
				const mark = billedOf(e, book.rates);
				if (mark === undefined || (mark === null && e.billed === undefined)) return e;
				if (mark !== null && e.billed !== undefined && e.billed.ref === mark.ref && e.billed.quote === mark.quote) return e;
				changed.push(e.id);
				if (mark === null) {
					const { billed: _, ...rest } = e;
					return checked(rest);
				}
				return checked({ ...e, billed: mark });
			});
			return changed.length > 0 ? { ...book, entries } : book;
		});
		return { changed, reserved };
	}

	/**
	 * Reserve to `callId` the entries `pick` chooses among those no other active reservation holds:
	 * each with its minutes, rate and rounding of now. The reservation `callId` already has, when
	 * there is one (a call run again). An empty pick reserves nothing.
	 */
	reserve(callId: string, by: string, pick: (free: readonly WorkEntry[], rates: readonly RateRule[]) => readonly WorkEntry[], fallbackRate?: (entry: WorkEntry) => { readonly rate: string; readonly listed: { readonly id: string; readonly name: string } } | undefined): Reservation | undefined {
		let result: Reservation | undefined;
		this.update((book) => {
			const own = (book.reservations ?? []).find((r) => r.callId === callId);
			if (own !== undefined) {
				result = own;
				return book;
			}
			const held = this.heldByOthers(book, callId);
			const chosen = pick(
				book.entries.filter((e) => !held.has(e.id)),
				book.rates,
			);
			if (chosen.length === 0) return book;
			const entries = chosen.map((e): ReservedEntry => {
				const terms = termsOf(e, book.rates);
				// No rate of the timesheet's own: the caller's (the listino's hourly voce), recorded as the rate it is billed at, with the voce it came from.
				const fallback = terms.rate === undefined && e.billable ? fallbackRate?.(e) : undefined;
				const rate = terms.rate ?? fallback?.rate;
				return { id: e.id, client: e.client, date: e.date, minutes: e.minutes, ...(rate === undefined ? {} : { rate }), rounding: terms.rounding, ...(fallback === undefined ? {} : { listed: fallback.listed }) };
			});
			const reservation: Reservation = { callId, entries, by, at: this.now().toISOString() };
			result = reservation;
			return { ...book, reservations: [...(book.reservations ?? []), reservation] };
		}, callId);
		return result;
	}

	/**
	 * Whether the reservation of `callId` is still there, its time started again: called just
	 * before its quote is made, so it holds its entries while the quote is made. False when it is
	 * gone (released, or dropped past its time): no quote is to be made with it.
	 */
	renew(callId: string): boolean {
		let found = false;
		this.update((book) => {
			const reservations = book.reservations ?? [];
			const own = reservations.find((r) => r.callId === callId);
			if (own === undefined) return book;
			found = true;
			return { ...book, reservations: reservations.map((r) => (r === own ? { ...r, at: this.now().toISOString() } : r)) };
		}, callId);
		return found;
	}

	/**
	 * Mark billed the entries reserved to `callId` that are as they were picked (billable, not
	 * billed, the same client, day, minutes and own rate), with `mark` and the rate and rounding
	 * picked; then drop the reservation. Without a reservation (billed already, settled by another
	 * call's change, or released) nothing changes.
	 */
	bill(callId: string, mark: Omit<Billed, "rate" | "rounding">): Billing {
		let result: Billing = { changed: [], skipped: [], reserved: false };
		this.update((book) => {
			const reservation = (book.reservations ?? []).find((r) => r.callId === callId);
			if (reservation === undefined) return book;
			const billed = billReserved(book.entries, reservation, mark);
			result = { changed: billed.changed, skipped: reservation.entries.map((r) => r.id).filter((id) => !billed.changed.includes(id)), reserved: true };
			return { ...book, entries: billed.entries, reservations: (book.reservations ?? []).filter((r) => r !== reservation) };
		}, callId);
		return result;
	}

	/** Drop the reservation of `callId` (its quote was not made): its entries are free again. */
	release(callId: string): void {
		this.update((book) => {
			const reservations = book.reservations ?? [];
			return reservations.some((r) => r.callId === callId) ? { ...book, reservations: reservations.filter((r) => r.callId !== callId) } : book;
		}, callId);
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
	 * running; undefined drops the timer without recording, as asked). The entry of `callId` when
	 * this call stopped it already. Undefined when no timer runs and this call recorded nothing.
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

	/** The change under the lock, the other calls' reservations settled first (`keep`'s left to it); then a copy of what was written in timesheet.json.bak. */
	private update(change: (book: Book) => Book, keep?: string): void {
		updateBook(this.book, (book) => change(this.settle(book, keep)));
	}
}

/**
 * The entries reserved by `r` billed with `mark`, at the rate and rounding picked, when they are
 * as picked: billable, not billed, the same client, day, minutes and own rate. The others stay.
 */
function billReserved(entries: readonly WorkEntry[], r: Reservation, mark: Omit<Billed, "rate" | "rounding">): { entries: readonly WorkEntry[]; changed: string[] } {
	const picked = new Map(r.entries.map((x) => [x.id, x]));
	const changed: string[] = [];
	const next = entries.map((e) => {
		const x = picked.get(e.id);
		if (x === undefined) return e;
		const same = e.billable && e.billed === undefined && e.minutes === x.minutes && (x.client === undefined || x.client === e.client) && (x.date === undefined || x.date === e.date) && (e.rate === undefined || e.rate === x.rate);
		if (!same) return e;
		changed.push(e.id);
		return checked({ ...e, billed: { ...mark, ...(x.rate === undefined ? {} : { rate: x.rate }), rounding: x.rounding } });
	});
	return { entries: changed.length === 0 ? entries : next, changed };
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
	const { next, entries, timers, rates, reservations } = raw as Book;
	if (typeof next !== "object" || next === null || Array.isArray(next)) return undefined;
	if (!Object.entries(next).every(([y, n]) => YEAR.test(y) && Number.isInteger(n) && n >= 1 && n <= 1_000_000)) return undefined;
	if (!Array.isArray(entries) || !entries.every(validEntry)) return undefined;
	if (!Array.isArray(timers) || !timers.every(validTimer) || new Set(timers.map((t) => t.person)).size !== timers.length) return undefined;
	if (!Array.isArray(rates) || !rates.every(validRule) || rates.filter((r) => r.client === undefined).length > 1) return undefined;
	if (reservations !== undefined && (!Array.isArray(reservations) || !reservations.every(validReservation) || new Set(reservations.map((r) => r.callId)).size !== reservations.length)) return undefined;
	if (new Set(entries.map((e) => e.id)).size !== entries.length) return undefined;
	// Every id below its year's counter: a counter behind an entry would give that id again.
	for (const e of entries) {
		const [year, seq] = idOrder(e.id);
		if (seq >= (next[String(year)] ?? 1)) return undefined;
	}
	return raw as Book;
}
