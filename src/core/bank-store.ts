/**
 * L'estratto conto's own state, in `bank.json` of an instance (outside the workspace): the
 * movements loaded (each once), the imports, the matches with their state, the settings, the next
 * progressives and the ids of the calls that wrote (a call run again writes nothing twice).
 * Changed under the shared file lock through json-book.ts, with the copy `bank.json.bak`. Past
 * BANK_LIMITS.movements the oldest movements by date go, with their matches. Read never throws: a
 * file that does not read is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { BANK_LIMITS, type BankImport, type BankMatch, type BankMovement, BankError, type BankSettings, validCall, validImport, validMatch, validMovement, validSettings } from "./bank.ts";
import { type BookFile, readBook, updateBook } from "./json-book.ts";

/** What a change works on. */
export type BankState = {
	readonly next: { readonly movement: number; readonly import: number };
	readonly movements: readonly BankMovement[];
	readonly imports: readonly BankImport[];
	readonly matches: readonly BankMatch[];
	readonly settings?: BankSettings;
};

type Book = BankState & { readonly calls: readonly string[] };

export type BankBook = Book & { readonly broken: boolean };

export const BANK_BROKEN = "i dati dell'estratto conto (bank.json) non si leggono: non li cambio, perché andrebbero persi. Va sistemato il file, o rimessa la copia bank.json.bak, nella cartella dell'agente";

const EMPTY: Book = { next: { movement: 1, import: 1 }, movements: [], imports: [], matches: [], calls: [] };

export class BankStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "bank.json"),
			empty: EMPTY,
			maxBytes: BANK_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new BankError(BANK_BROKEN),
			full: () => new BankError("i dati dell'estratto conto sono pieni: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): BankBook {
		const book = readBook(this.book);
		return book === undefined ? { ...EMPTY, broken: true } : { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one.
	 * False when the call wrote already (run again), and then nothing changes. The caps are applied
	 * here; what `change` gives is checked as the file is: a BankError, nothing written, when it does not hold.
	 */
	update(callId: string, change: (state: BankState) => BankState): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) return book;
			fresh = true;
			const { calls, ...state } = book;
			const made = capped(change(state));
			const next: Book = { ...made, calls: [...calls, callId].slice(-BANK_LIMITS.calls) };
			if (validBook(next) === undefined) throw new BankError("i dati non sono validi: non li ho salvati");
			return next;
		});
		return fresh;
	}
}

/** Past the caps: the oldest movements by date go with their matches; the oldest imports and matches go. */
function capped(state: BankState): BankState {
	let { movements, matches } = state;
	if (movements.length > BANK_LIMITS.movements) {
		const kept = new Set([...movements].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, BANK_LIMITS.movements).map((m) => m.id));
		movements = movements.filter((m) => kept.has(m.id));
		matches = matches.filter((m) => kept.has(m.movement));
	}
	return { ...state, movements, matches: matches.slice(-BANK_LIMITS.matches), imports: state.imports.slice(-BANK_LIMITS.imports) };
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { next, movements, imports, matches, settings, calls } = raw as Book;
	if (typeof next !== "object" || next === null || !Number.isInteger(next.movement) || next.movement < 1 || next.movement > 9_999_999 || !Number.isInteger(next.import) || next.import < 1 || next.import > 999_999) return undefined;
	if (!Array.isArray(movements) || movements.length > BANK_LIMITS.movements || !movements.every(validMovement)) return undefined;
	const ids = new Set(movements.map((m) => m.id));
	if (ids.size !== movements.length || movements.some((m) => Number(m.id.slice(2)) >= next.movement)) return undefined;
	if (new Set(movements.map((m) => `${m.hash}#${m.seq}`)).size !== movements.length) return undefined;
	if (!Array.isArray(imports) || imports.length > BANK_LIMITS.imports || !imports.every(validImport)) return undefined;
	if (!Array.isArray(matches) || matches.length > BANK_LIMITS.matches || !matches.every(validMatch)) return undefined;
	// A movement is explained at most once: one live match (refused ones and hints aside).
	const live = matches.filter((m) => m.state !== "refused" && m.state !== "hint").map((m) => m.movement);
	if (new Set(live).size !== live.length) return undefined;
	if (settings !== undefined && !validSettings(settings)) return undefined;
	if (!Array.isArray(calls) || calls.length > BANK_LIMITS.calls || !calls.every(validCall)) return undefined;
	return raw as Book;
}
