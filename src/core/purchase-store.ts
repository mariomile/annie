/**
 * I prezzi d'acquisto's own state, in `purchases.json` of an instance (outside the workspace):
 * only the increases already said, each invoice line once, with the day, the call that said it and
 * where (the brief, or the answer about that invoice). The prices themselves are read from the
 * invoices every time (purchase-prices.ts). Changed under the shared file lock through
 * json-book.ts, with the copy `purchases.json.bak`. Read never throws: a file that does not read
 * is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { type PriceClaim, PURCHASE_LIMITS, PurchaseError, validPriceClaim } from "./purchase-prices.ts";

type Book = { readonly alerts: readonly PriceClaim[] };

export type PurchaseBook = Book & { readonly broken: boolean };

export const PURCHASES_BROKEN = "gli aumenti già segnalati (purchases.json) non si leggono: non li cambio, perché andrebbero persi. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { alerts: [] };

export class PurchaseStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "purchases.json"),
			empty: EMPTY,
			maxBytes: PURCHASE_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new PurchaseError(PURCHASES_BROKEN),
			full: () => new PurchaseError("gli aumenti segnalati sono troppi: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): PurchaseBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * The invoice lines of `wanted` not said yet, marked said by `callId` on `day` (`via` where):
	 * each line once, whoever says it. `perDay`, for the brief: at most so many said by the brief
	 * on that day, all calls together. A call run again gets back what it claimed.
	 */
	claim(callId: string, day: string, via: PriceClaim["via"], wanted: readonly string[], perDay?: number): string[] {
		let mine: string[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before.map((a) => a.k);
				return book;
			}
			const said = new Set(book.alerts.map((a) => a.k));
			let room = perDay === undefined ? Number.POSITIVE_INFINITY : Math.max(0, perDay - book.alerts.filter((a) => a.via === "brief" && a.day === day).length);
			const fresh: PriceClaim[] = [];
			for (const k of new Set(wanted)) {
				if (said.has(k) || room <= 0) continue;
				fresh.push({ k, day, call: callId, via });
				room--;
			}
			mine = fresh.map((a) => a.k);
			if (fresh.length === 0) return book;
			return { alerts: [...book.alerts, ...fresh].slice(-PURCHASE_LIMITS.alerts) };
		});
		return mine;
	}
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!Array.isArray(b.alerts) || b.alerts.length > PURCHASE_LIMITS.alerts || !b.alerts.every(validPriceClaim)) return undefined;
	if (new Set(b.alerts.map((a) => a.k)).size !== b.alerts.length) return undefined;
	return { alerts: b.alerts };
}
