/**
 * I margini's own state, in `margins.json` of an instance (outside the workspace): only the voci
 * the brief said sold below cost or below the threshold, each once a week, with the week's Monday
 * and the call that said it. The margins themselves are worked out every time (margins.ts).
 * Changed under the shared file lock through json-book.ts, with the copy `margins.json.bak`. Read
 * never throws: a file that does not read is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { MARGIN_LIMITS, MarginError, type MarginClaim, validMarginClaim } from "./margins.ts";

type Book = { readonly alerts: readonly MarginClaim[] };

export type MarginBook = Book & { readonly broken: boolean };

export const MARGINS_BROKEN = "i margini già segnalati (margins.json) non si leggono: non li cambio, perché andrebbero persi. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { alerts: [] };

export class MarginStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "margins.json"),
			empty: EMPTY,
			maxBytes: MARGIN_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new MarginError(MARGINS_BROKEN),
			full: () => new MarginError("i margini segnalati sono troppi: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): MarginBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * The voci of `wanted` not said in the week of `week` (its Monday), marked said by `callId`:
	 * each voce once a week, and at most `perWeek` in a week, all calls together. A call run again
	 * gets back what it claimed.
	 */
	claim(callId: string, week: string, wanted: readonly string[], perWeek: number = MARGIN_LIMITS.perWeek): string[] {
		let mine: string[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before.map((a) => a.v);
				return book;
			}
			const thisWeek = book.alerts.filter((a) => a.week === week);
			const said = new Set(thisWeek.map((a) => a.v));
			let room = Math.max(0, perWeek - thisWeek.length);
			const fresh: MarginClaim[] = [];
			for (const v of new Set(wanted)) {
				if (said.has(v) || room <= 0) continue;
				fresh.push({ v, week, call: callId });
				room--;
			}
			mine = fresh.map((a) => a.v);
			if (fresh.length === 0) return book;
			return { alerts: [...book.alerts, ...fresh].slice(-MARGIN_LIMITS.alerts) };
		});
		return mine;
	}
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!Array.isArray(b.alerts) || b.alerts.length > MARGIN_LIMITS.alerts || !b.alerts.every(validMarginClaim)) return undefined;
	if (new Set(b.alerts.map((a) => `${a.v}@${a.week}`)).size !== b.alerts.length) return undefined;
	return { alerts: b.alerts };
}
