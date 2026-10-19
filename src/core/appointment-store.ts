/**
 * Gli appuntamenti's own state, in `appointments.json` of an instance (outside the workspace):
 * the appointments, the next id (never given twice), the settings (hours, closures, resources,
 * services with their duration), the calls that wrote (a call run again writes nothing twice) and
 * what the brief said. Changed under the shared file lock through json-book.ts, with the copy
 * `appointments.json.bak`. Read never throws: a file that does not read is `broken`, and nothing
 * is written over it. An appointment is never deleted: disdetto, it stays as such.
 */
import { join } from "node:path";
import { type Appointment, APPOINTMENT_ID, APPOINTMENT_LIMITS, type AppointmentBilled, type AppointmentClaim, AppointmentError, type AppointmentSettings, validAppointment, validClaim, validSettings } from "./appointments.ts";
import { type BookFile, readBook, updateBook } from "./json-book.ts";

export type AppointmentState = { readonly nextAppointment: number; readonly appointments: readonly Appointment[]; readonly settings?: AppointmentSettings };

type Book = AppointmentState & { readonly alerts: readonly AppointmentClaim[]; readonly calls: readonly string[] };

export type AppointmentBook = Book & { readonly broken: boolean };

export const APPOINTMENTS_BROKEN = "gli appuntamenti (appointments.json) non si leggono: non li cambio, perché andrebbero persi. Non va cancellato: con l'istanza ferma, va rimessa al suo posto la copia appointments.json.bak";

const EMPTY: Book = { nextAppointment: 1, appointments: [], alerts: [], calls: [] };

/** The seam the fatture in uscita are given: the appointments read, marked billed by an invoice issued, given back to bill by a credit note for the wrong customer. */
export type AppointmentLink = Pick<AppointmentStore, "read" | "markBilled" | "release">;

export class AppointmentStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "appointments.json"),
			empty: EMPTY,
			maxBytes: APPOINTMENT_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new AppointmentError(APPOINTMENTS_BROKEN),
			full: () => new AppointmentError("gli appuntamenti sono troppi per salvarne altri"),
		};
	}

	/** Never throws. */
	read(): AppointmentBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). "rerun" when the call wrote already. AppointmentError
	 * from `change` stops it with nothing written; so does a state that would not read back.
	 */
	update(callId: string, change: (state: AppointmentState) => AppointmentState): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const state: AppointmentState = { nextAppointment: book.nextAppointment, appointments: book.appointments, ...(book.settings === undefined ? {} : { settings: book.settings }) };
			const next = change(state);
			if (next === state) return book;
			const out = checked({ ...book, ...next, calls: [...book.calls, callId].slice(-APPOINTMENT_LIMITS.calls) });
			outcome = "written";
			return out;
		});
		return outcome;
	}

	/** The appointments `ids` marked billed by the invoice issued, each once: one billed by another invoice, not fatto or gone is refused. */
	markBilled(ids: readonly string[], billed: AppointmentBilled): { readonly marked: readonly string[]; readonly refused: readonly string[] } {
		const marked: string[] = [];
		const refused: string[] = [];
		updateBook(this.book, (book) => {
			let changed = false;
			const appointments = book.appointments.map((a) => {
				if (!ids.includes(a.id)) return a;
				if (a.billed?.invoice === billed.invoice) {
					marked.push(a.id);
					return a;
				}
				if (a.status !== "done" || a.billed !== undefined) {
					refused.push(a.id);
					return a;
				}
				changed = true;
				marked.push(a.id);
				return { ...a, billed };
			});
			refused.push(...ids.filter((id) => !book.appointments.some((a) => a.id === id)));
			return changed ? checked({ ...book, appointments }) : book;
		});
		return { marked, refused };
	}

	/** The appointments the invoice `invoice` billed, to bill again (a credit note for the wrong customer issued): how many. */
	release(invoice: string): number {
		let n = 0;
		updateBook(this.book, (book) => {
			const appointments = book.appointments.map((a) => {
				if (a.billed?.invoice !== invoice) return a;
				n++;
				const { billed: _, ...rest } = a;
				return rest;
			});
			return n === 0 ? book : checked({ ...book, appointments });
		});
		return n;
	}

	/** What the brief may say today: of `wanted`, those not said today, marked said by `callId`. A call run again gets back what it claimed. */
	claim(callId: string, day: string, wanted: readonly string[]): string[] {
		let mine: string[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before.map((a) => a.k);
				return book;
			}
			const said = new Set(book.alerts.filter((a) => a.day === day).map((a) => a.k));
			const fresh = [...new Set(wanted)].filter((k) => !said.has(k)).map((k) => ({ k, day, call: callId }));
			mine = fresh.map((a) => a.k);
			if (fresh.length === 0) return book;
			return { ...book, alerts: [...book.alerts, ...fresh].slice(-APPOINTMENT_LIMITS.alerts) };
		});
		return mine;
	}
}

function checked(book: Book): Book {
	if (validBook(book) === undefined) throw new AppointmentError("gli appuntamenti non sono validi così: non li ho salvati");
	return book;
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (typeof b.nextAppointment !== "number" || !Number.isInteger(b.nextAppointment) || b.nextAppointment < 1 || b.nextAppointment > 999_999) return undefined;
	if (b.settings !== undefined && !validSettings(b.settings)) return undefined;
	if (!Array.isArray(b.appointments) || b.appointments.length > APPOINTMENT_LIMITS.appointments || !b.appointments.every(validAppointment)) return undefined;
	if (!Array.isArray(b.alerts) || b.alerts.length > APPOINTMENT_LIMITS.alerts || !b.alerts.every(validClaim)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > APPOINTMENT_LIMITS.calls || !b.calls.every((c) => typeof c === "string" && c.length > 0 && c.length <= 300)) return undefined;
	const ids = new Set<string>();
	for (const a of b.appointments) {
		if (Number(APPOINTMENT_ID.exec(a.id)?.[1]) >= b.nextAppointment || ids.has(a.id)) return undefined;
		ids.add(a.id);
	}
	return b;
}
