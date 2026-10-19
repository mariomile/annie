/**
 * Il personale's own state, in `staff.json` of an instance (outside the workspace): the people,
 * their absences, the shifts said apart from the usual week, the extra hours, the settings, the
 * next ids (never given twice), the calls that wrote (a call run again writes nothing twice) and
 * what the brief said. Changed under the shared file lock through json-book.ts, with the copy
 * `staff.json.bak`. Read never throws: a file that does not read is `broken`, and nothing is
 * written over it. An absence is never deleted on its own: cancelled, it stays as such; a person
 * deleted (on the person's word, with a check) takes their absences, shifts and extra hours along.
 */
import { join } from "node:path";
import { type Absence, ABSENCE_ID, type ExtraHours, type Person, PERSON_ID, STAFF_LIMITS, type StaffClaim, StaffError, type StaffSettings, type ShiftChange, validAbsence, validExtra, validPerson, validShiftChange, validStaffClaim, validStaffSettings } from "./staff.ts";
import type { Block } from "./appointment-slots.ts";
import { resourceBlocks } from "./staff-shifts.ts";
import { type BookFile, readBook, updateBook } from "./json-book.ts";

export type StaffState = {
	readonly nextPerson: number;
	readonly nextAbsence: number;
	readonly people: readonly Person[];
	readonly absences: readonly Absence[];
	readonly shifts: readonly ShiftChange[];
	readonly extras: readonly ExtraHours[];
	readonly settings?: StaffSettings;
};

type Book = StaffState & { readonly alerts: readonly StaffClaim[]; readonly calls: readonly string[] };

export type StaffBook = Book & { readonly broken: boolean };

export const STAFF_BROKEN = "il personale (staff.json) non si legge: non lo cambio, perché i dati andrebbero persi. Non va cancellato: con l'istanza ferma, va rimessa al suo posto la copia staff.json.bak";

const EMPTY: Book = { nextPerson: 1, nextAbsence: 1, people: [], absences: [], shifts: [], extras: [], alerts: [], calls: [] };

/** The seam the appointments are given: what absences block of their resources on a day. */
export type StaffLink = Pick<StaffStore, "blocksOn">;

export class StaffStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "staff.json"),
			empty: EMPTY,
			maxBytes: STAFF_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new StaffError(STAFF_BROKEN),
			full: () => new StaffError("i dati del personale sono troppi per salvarne altri"),
		};
	}

	/** Never throws. */
	read(): StaffBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/** The appointments' resources the staff blocks on `day`: absences and time off the shift (none when the file does not read: `broken` says it). */
	blocksOn(day: string): Block[] {
		const b = this.read();
		return b.broken ? [] : resourceBlocks(b.people, b.absences, b.shifts, day);
	}

	/** Whether staff.json does not read (the appointments say so once when booking). */
	broken(): boolean {
		return this.read().broken;
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). "rerun" when the call wrote already. StaffError from
	 * `change` stops it with nothing written; so does a state that would not read back.
	 */
	update(callId: string, change: (state: StaffState) => StaffState): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const { alerts: _a, calls: _c, ...state } = book;
			const next = change(state);
			if (next === state) return book;
			const out = checked({ ...book, ...next, calls: [...book.calls, callId].slice(-STAFF_LIMITS.calls) });
			outcome = "written";
			return out;
		});
		return outcome;
	}

	/** What the brief may say today: of `wanted`, those not said today (a key «once:…» not said ever), marked said by `callId`. A call run again gets back what it claimed. */
	claim(callId: string, day: string, wanted: readonly string[]): string[] {
		let mine: string[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before.map((a) => a.k);
				return book;
			}
			const said = new Set(book.alerts.filter((a) => a.day === day || a.k.startsWith("once:")).map((a) => a.k));
			const fresh = [...new Set(wanted)].filter((k) => !said.has(k)).map((k) => ({ k, day, call: callId }));
			mine = fresh.map((a) => a.k);
			if (fresh.length === 0) return book;
			return { ...book, alerts: [...book.alerts, ...fresh].slice(-STAFF_LIMITS.alerts) };
		});
		return mine;
	}
}

function checked(book: Book): Book {
	if (validBook(book) === undefined) throw new StaffError("i dati del personale non sono validi così: non li ho salvati");
	return book;
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	const counter = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 999_999;
	if (!counter(b.nextPerson) || !counter(b.nextAbsence)) return undefined;
	if (b.settings !== undefined && !validStaffSettings(b.settings)) return undefined;
	if (!Array.isArray(b.people) || b.people.length > STAFF_LIMITS.people || !b.people.every(validPerson)) return undefined;
	if (!Array.isArray(b.absences) || b.absences.length > STAFF_LIMITS.absences || !b.absences.every(validAbsence)) return undefined;
	if (!Array.isArray(b.shifts) || b.shifts.length > STAFF_LIMITS.shifts || !b.shifts.every(validShiftChange)) return undefined;
	if (!Array.isArray(b.extras) || b.extras.length > STAFF_LIMITS.extras || !b.extras.every(validExtra)) return undefined;
	if (!Array.isArray(b.alerts) || b.alerts.length > STAFF_LIMITS.alerts || !b.alerts.every(validStaffClaim)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > STAFF_LIMITS.calls || !b.calls.every((c) => typeof c === "string" && c.length > 0 && c.length <= 300)) return undefined;
	const ids = new Set<string>();
	for (const p of b.people) {
		if (Number(PERSON_ID.exec(p.id)?.[1]) >= b.nextPerson || ids.has(p.id)) return undefined;
		ids.add(p.id);
	}
	const resources = b.people.map((p) => p.resource?.toLowerCase()).filter((r) => r !== undefined);
	if (new Set(resources).size !== resources.length) return undefined;
	const seen = new Set<string>();
	for (const a of b.absences) {
		if (Number(ABSENCE_ID.exec(a.id)?.[1]) >= b.nextAbsence || seen.has(a.id) || !ids.has(a.person)) return undefined;
		seen.add(a.id);
	}
	if (!b.shifts.every((s) => ids.has(s.person)) || !b.extras.every((e) => ids.has(e.person))) return undefined;
	return b;
}
