/**
 * I DDT's own state, in `ddt.json` of an instance (outside the workspace): the DDTs, the next draft
 * id and the next number of each year (never given twice), the person's numbering, the calls that
 * wrote (a call run again writes nothing twice) and what the brief said. Changed under the shared
 * file lock through json-book.ts, with the copy `ddt.json.bak`. A number is given only when a DDT
 * is issued, under the lock; the counters only grow. Read never throws: a file that does not read
 * is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { BILLED, type Ddt, DDT_ID, DDT_LIMITS, type DdtBilled, type DdtClaim, DdtError, ddtNumber, type DdtSettings, type IssuedDdt, isIssuedDdt, validDdt, validDdtCall, validDdtClaim, validDdtSettings } from "./ddt.ts";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import type { Marker } from "./marker.ts";

/** What a change works on. */
export type DdtState = { readonly nextDdt: number; readonly next: Readonly<Record<string, number>>; readonly ddts: readonly Ddt[]; readonly settings?: DdtSettings };

type Book = DdtState & { readonly alerts: readonly DdtClaim[]; readonly calls: readonly string[] };

export type DdtBook = Book & { readonly broken: boolean };

export const DDT_BROKEN = "i DDT (ddt.json) non si leggono: non li cambio, perché andrebbero persi. Non va cancellato: con l'istanza ferma, va rimessa al suo posto la copia ddt.json.bak";

const EMPTY: Book = { nextDdt: 1, next: {}, ddts: [], alerts: [], calls: [] };

/** The seam the fatture in uscita are given: the DDTs read, marked billed by an invoice issued, and to bill again after a credit note for the wrong customer. */
export type DdtLink = Pick<DdtStore, "read" | "markBilled" | "release">;

/** The number the next DDT of `year` takes: after the counter and the last number said before Annie. */
export function nextDdtSeq(state: Pick<DdtState, "next" | "settings">, year: number): number {
	return Math.max(state.next[String(year)] ?? 1, (state.settings?.lastBefore?.[String(year)] ?? 0) + 1);
}

export class DdtStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "ddt.json"),
			empty: EMPTY,
			maxBytes: DDT_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new DdtError(DDT_BROKEN),
			full: () => new DdtError("i DDT sono troppi per salvarne altri: esporta e annulla le bozze vecchie"),
		};
	}

	/** Never throws. */
	read(): DdtBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). "rerun" when the call wrote already. DdtError from
	 * `change` stops it with nothing written; so does a state that would not read back.
	 */
	update(callId: string, change: (state: DdtState) => DdtState): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const state: DdtState = { nextDdt: book.nextDdt, next: book.next, ddts: book.ddts, ...(book.settings === undefined ? {} : { settings: book.settings }) };
			const next = change(state);
			if (next === state) return book;
			const out = checked({ ...book, ...next, calls: [...book.calls, callId].slice(-DDT_LIMITS.calls) });
			outcome = "written";
			return out;
		});
		return outcome;
	}

	/**
	 * The draft `id` issued on `day`: its number under the lock, after the counter and the last
	 * number said before Annie, never before the date of a DDT of the year issued already. The DDT
	 * `callId` issued already, when there is one (a call run again).
	 */
	issue(id: string, callId: string, day: string, marker: Marker): IssuedDdt {
		let made: IssuedDdt | undefined;
		updateBook(this.book, (book) => {
			made = book.ddts.find((d): d is IssuedDdt => isIssuedDdt(d) && d.issueCall === callId);
			if (made !== undefined) return book;
			const draft = book.ddts.find((d) => d.id === id);
			if (draft === undefined) throw new DdtError("la bozza del DDT non c'è più");
			if (draft.status === "cancelled") throw new DdtError("il DDT è annullato");
			if (isIssuedDdt(draft)) throw new DdtError(`il DDT è già emesso con il numero ${draft.number}`);
			if (draft.status !== "draft") throw new DdtError("il reso è già registrato");
			const year = Number(day.slice(0, 4));
			const seq = nextDdtSeq(book, year);
			if (seq > DDT_LIMITS.perYear) throw new DdtError(`i DDT del ${year} sono arrivati al massimo di ${DDT_LIMITS.perYear}`);
			const later = book.ddts.find((d) => isIssuedDdt(d) && d.status === "issued" && d.year === year && d.day > day);
			if (later !== undefined) throw new DdtError(`c'è già il DDT n. ${later.number} con una data successiva: la numerazione deve seguire le date`);
			const issued: IssuedDdt = { ...draft, status: "issued", day, number: ddtNumber(year, seq, book.settings?.numbering), year, seq, issued: marker, issueCall: callId };
			made = issued;
			return checked({ ...book, next: { ...book.next, [String(year)]: seq + 1 }, ddts: book.ddts.map((d) => (d === draft ? issued : d)) });
		});
		return made as IssuedDdt;
	}

	/**
	 * A reso that came with the client's own DDT (`theirs`), recorded under the lock: no number of
	 * ours, the day of their DDT. The one `callId` recorded already, when there is one.
	 */
	record(id: string, callId: string, marker: Marker): Ddt {
		let made: Ddt | undefined;
		updateBook(this.book, (book) => {
			made = book.ddts.find((d) => d.issueCall === callId);
			if (made !== undefined) return book;
			const draft = book.ddts.find((d) => d.id === id);
			if (draft === undefined || draft.theirs === undefined) throw new DdtError("la bozza del reso non c'è più");
			if (draft.status !== "draft") throw new DdtError(draft.status === "cancelled" ? "il reso è annullato" : "il reso è già registrato");
			const recorded: Ddt = { ...draft, status: "issued", day: draft.theirs.date, issued: marker, issueCall: callId };
			made = recorded;
			return checked({ ...book, ddts: book.ddts.map((d) => (d === draft ? recorded : d)) });
		});
		return made as Ddt;
	}

	/** The DDTs the invoice `invoice` billed, to bill again (a credit note for the wrong customer issued): how many. */
	release(invoice: string): number {
		let n = 0;
		updateBook(this.book, (book) => {
			const ddts = book.ddts.map((d) => {
				if (d.billed?.invoice !== invoice) return d;
				n++;
				const { billed: _, ...rest } = d;
				return rest;
			});
			return n === 0 ? book : checked({ ...book, ddts });
		});
		return n;
	}

	/** The issue of `id` complete: the magazzino moved, or nothing to move. */
	setStocked(id: string): void {
		updateBook(this.book, (book) => {
			const d = book.ddts.find((x) => x.id === id);
			if (d === undefined || d.status === "draft" || d.issued === undefined || d.stocked === true) return book;
			return checked({ ...book, ddts: book.ddts.map((x) => (x === d ? { ...d, stocked: true as const } : x)) });
		});
	}

	/**
	 * The DDTs `ids` marked billed by the invoice issued (`billed`), each once: one billed by
	 * another invoice, annulled or not a vendita is left as it is and comes back in `refused`.
	 */
	markBilled(ids: readonly string[], billed: DdtBilled): { readonly marked: readonly string[]; readonly refused: readonly string[] } {
		const marked: string[] = [];
		const refused: string[] = [];
		updateBook(this.book, (book) => {
			let changed = false;
			const ddts = book.ddts.map((d) => {
				if (!ids.includes(d.id)) return d;
				if (d.billed?.invoice === billed.invoice) {
					marked.push(d.id);
					return d;
				}
				if (d.status !== "issued" || !BILLED.includes(d.causale) || d.billed !== undefined) {
					refused.push(d.id);
					return d;
				}
				changed = true;
				marked.push(d.id);
				return { ...d, billed };
			});
			refused.push(...ids.filter((id) => !book.ddts.some((d) => d.id === id)));
			return changed ? checked({ ...book, ddts }) : book;
		});
		return { marked, refused };
	}

	/**
	 * What the brief may say today: of `wanted`, those not said today, marked said by `callId`. A
	 * call run again gets back what it claimed.
	 */
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
			return { ...book, alerts: [...book.alerts, ...fresh].slice(-DDT_LIMITS.alerts) };
		});
		return mine;
	}
}

function checked(book: Book): Book {
	if (validBook(book) === undefined) throw new DdtError("i DDT non sono validi così: non li ho salvati");
	return book;
}

const counter = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextDdt, 999_999)) return undefined;
	if (typeof b.next !== "object" || b.next === null || Array.isArray(b.next) || !Object.entries(b.next).every(([y, n]) => /^\d{4}$/.test(y) && counter(n, DDT_LIMITS.perYear + 1))) return undefined;
	if (b.settings !== undefined && !validDdtSettings(b.settings)) return undefined;
	if (!Array.isArray(b.ddts) || b.ddts.length > DDT_LIMITS.ddts || !b.ddts.every(validDdt)) return undefined;
	if (!Array.isArray(b.alerts) || b.alerts.length > DDT_LIMITS.alerts || !b.alerts.every(validDdtClaim)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > DDT_LIMITS.calls || !b.calls.every(validDdtCall)) return undefined;
	// Ids and numbers never given twice.
	const ids = new Set<string>();
	const numbers = new Set<string>();
	for (const d of b.ddts) {
		if (Number(DDT_ID.exec(d.id)?.[1]) >= b.nextDdt || ids.has(d.id)) return undefined;
		ids.add(d.id);
		if (isIssuedDdt(d)) {
			const key = `${d.year}:${d.seq}`;
			if (numbers.has(key) || d.seq >= (b.next[String(d.year)] ?? 1)) return undefined;
			numbers.add(key);
		}
	}
	return b;
}
