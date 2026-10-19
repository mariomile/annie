/**
 * Il magazzino's own state, in `stock.json` of an instance (outside the workspace): the articles,
 * the movements (append-only: a change never edits or drops one), the next numbers to give (never
 * given twice), the ids of the calls that wrote (a call run again writes nothing twice) and the
 * brief's sottoscorta alerts already said. Changed under the shared file lock through
 * json-book.ts, with the copy `stock.json.bak`. Read never throws: a file that does not read is
 * `broken`, and nothing is written over it. What is on hand is never stored: it is worked out
 * from the movements every time (stock-sums.ts).
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import type { Marker } from "./marker.ts";
import { type LowClaim, MOVE_ID, moveId, type Movement, STOCK_ID, STOCK_LIMITS, StockError, type StockItem, stockUnit, validItem, validLowClaim, validMove, validStockCall } from "./stock.ts";
import { qtyOf, qtyText, stateOf } from "./stock-sums.ts";

/** What a change works on: the articles, the movements and the next numbers. */
export type StockState = { readonly nextItem: number; readonly nextMove: number; readonly items: readonly StockItem[]; readonly moves: readonly Movement[] };

type Book = StockState & { readonly alerts: readonly LowClaim[]; readonly calls: readonly string[] };

export type StockBook = Book & { readonly broken: boolean };

export const STOCK_BROKEN = "il magazzino (stock.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { nextItem: 1, nextMove: 1, items: [], moves: [], alerts: [], calls: [] };

/** One line of an invoice issued (or a credit note) that names a voce of the listino. */
export type SaleLine = { readonly line: number; readonly listino: string; readonly quantity: string; readonly unit?: string; readonly description: string };

/** An invoice issued, or a credit note (with `of`, the invoice it corrects), as the magazzino takes it. */
export type Sale = { readonly invoice: string; readonly number: string; readonly day: string; readonly of?: string; readonly lines: readonly SaleLine[] };

/** What a sale moved: every movement of it (this run's or an earlier one's), and the lines left out, with why. */
export type SaleOutcome =
	| { readonly broken: true }
	| {
			readonly broken: false;
			readonly moved: readonly { readonly item: StockItem; readonly move: Movement; readonly negative: boolean }[];
			readonly skipped: readonly { readonly description: string; readonly why: "unit" | "quantity" | "nothing" }[];
	  };

/** The seam sales_invoices is given: the magazzino moved by an invoice issued, once per invoice and line. */
export type StockLink = { readonly sale: (sale: Sale, marker: Marker) => SaleOutcome };

export class StockStore implements StockLink {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "stock.json"),
			empty: EMPTY,
			maxBytes: STOCK_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new StockError(STOCK_BROKEN),
			full: () => new StockError("il magazzino è pieno: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): StockBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write, "unchanged"). "rerun" when the call wrote already. The
	 * movements only grow: one changed or dropped is refused. StockError from `change` stops it with
	 * nothing written.
	 */
	update(callId: string, change: (state: StockState) => StockState): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const state: StockState = { nextItem: book.nextItem, nextMove: book.nextMove, items: book.items, moves: book.moves };
			const next = change(state);
			if (next === state) return book;
			outcome = "written";
			return made(book, next, [...book.calls, callId].slice(-STOCK_LIMITS.calls));
		});
		return outcome;
	}

	/**
	 * The sottoscorta crossings of `wanted` not said yet, marked said by `callId`: each crossing
	 * once. A call run again gets back what it claimed.
	 */
	claim(callId: string, wanted: readonly Omit<LowClaim, "call">[]): LowClaim[] {
		let mine: LowClaim[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before;
				return book;
			}
			const said = (w: Omit<LowClaim, "call">) => book.alerts.some((a) => a.item === w.item && a.crossing === w.crossing);
			const fresh = wanted.filter((w) => !said(w) && book.items.some((i) => i.id === w.item)).map((w) => ({ ...w, call: callId }));
			mine = fresh;
			if (fresh.length === 0) return book;
			return { ...book, alerts: [...book.alerts, ...fresh].slice(-STOCK_LIMITS.alerts) };
		});
		return mine;
	}

	/**
	 * An invoice issued unloads (vendita), a credit note reloads (storno), each line naming a voce
	 * that is an article here, once per invoice and line: run again, nothing moves twice. A line
	 * in another unit, or whose quantity does not read, is left out and said. A storno never puts
	 * back more than the invoice it corrects took out of that article, less the storni before it.
	 * A vendita past what there is is recorded all the same (the sale happened), and said: the
	 * article is «in negativo» until a count. `{ broken: true }` when the file does not read.
	 */
	sale(sale: Sale, marker: Marker): SaleOutcome {
		if (this.read().broken) return { broken: true };
		const skipped: { description: string; why: "unit" | "quantity" | "nothing" }[] = [];
		const same = (m: Movement, line: number) => m.sale?.invoice === sale.invoice && m.sale.line === line;
		updateBook(this.book, (book) => {
			skipped.length = 0;
			let nextMove = book.nextMove;
			const added: Movement[] = [];
			const all = () => [...book.moves, ...added];
			for (const l of sale.lines) {
				const item = book.items.find((i) => i.removed === undefined && i.listino === l.listino);
				if (item === undefined) continue;
				if (all().some((m) => same(m, l.line))) continue;
				if (!/^\d{1,10}(?:\.\d{1,3})?$/.test(l.quantity) || Number(l.quantity) <= 0) {
					skipped.push({ description: l.description, why: "quantity" });
					continue;
				}
				// A line without a unit is in the article's own; one in another unit is not counted.
				if (l.unit !== undefined && stockUnit(l.unit) !== item.unit) {
					skipped.push({ description: l.description, why: "unit" });
					continue;
				}
				let qty = qtyOf(l.quantity);
				if (sale.of !== undefined) {
					const of = sale.of;
					const out = all().filter((m) => m.item === item.id && m.kind === "scarico" && m.sale?.invoice === of).reduce((n, m) => n + qtyOf(m.qty), 0n);
					const back = all().filter((m) => m.item === item.id && m.kind === "storno" && m.sale?.of === of).reduce((n, m) => n + qtyOf(m.qty), 0n);
					if (out - back < qty) qty = out - back;
					if (qty <= 0n) {
						skipped.push({ description: l.description, why: "nothing" });
						continue;
					}
				}
				const ref = { invoice: sale.invoice, line: l.line, number: sale.number, ...(sale.of === undefined ? {} : { of: sale.of }) };
				added.push(
					sale.of === undefined
						? { id: moveId(nextMove), item: item.id, kind: "scarico", qty: qtyText(qty), day: sale.day, reason: "vendita", sale: ref, ...marker }
						: { id: moveId(nextMove), item: item.id, kind: "storno", qty: qtyText(qty), day: sale.day, sale: ref, ...marker },
				);
				nextMove += 1;
			}
			if (added.length === 0) return book;
			return made(book, { nextItem: book.nextItem, nextMove, items: book.items, moves: [...book.moves, ...added] }, book.calls);
		});
		const now = this.read();
		const moved = now.moves
			.filter((m) => m.sale?.invoice === sale.invoice)
			.map((move) => {
				const item = now.items.find((i) => i.id === move.item) as StockItem;
				return { item, move, negative: stateOf(item, now.moves).negative };
			});
		return { broken: false, moved, skipped };
	}
}

/** The book after a change, checked: the movements before it all there, unchanged, in their place. */
function made(book: Book, next: StockState, calls: readonly string[]): Book {
	if (next.moves.length < book.moves.length || book.moves.some((m, n) => next.moves[n] !== m)) throw new StockError("i movimenti del magazzino non si cambiano: non ho salvato");
	const out: Book = { nextItem: next.nextItem, nextMove: next.nextMove, items: next.items, moves: next.moves, alerts: book.alerts.filter((a) => next.items.some((i) => i.id === a.item)), calls };
	if (validBook(out) === undefined) throw new StockError("il magazzino non è valido: non l'ho salvato");
	return out;
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9_999_999;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextItem) || !counter(b.nextMove)) return undefined;
	if (!Array.isArray(b.items) || b.items.length > STOCK_LIMITS.items || !b.items.every(validItem)) return undefined;
	if (!Array.isArray(b.moves) || b.moves.length > STOCK_LIMITS.moves || !b.moves.every(validMove)) return undefined;
	if (!Array.isArray(b.alerts) || b.alerts.length > STOCK_LIMITS.alerts || !b.alerts.every(validLowClaim)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > STOCK_LIMITS.calls || !b.calls.every(validStockCall)) return undefined;
	// Numbers never given again: every id below its counter, each once; one article on the list per name, code and voce.
	const ids = new Set<string>();
	const taken = new Set<string>();
	for (const x of b.items) {
		if (Number(STOCK_ID.exec(x.id)?.[1]) >= b.nextItem || ids.has(x.id)) return undefined;
		ids.add(x.id);
		if (x.removed !== undefined) continue;
		for (const key of [`n:${x.name.toLowerCase()}`, ...(x.code === undefined ? [] : [`c:${x.code.toLowerCase()}`]), ...(x.listino === undefined ? [] : [`l:${x.listino}`])]) {
			if (taken.has(key)) return undefined;
			taken.add(key);
		}
	}
	// Movements in their order, each of an article here; a sale's line moved once.
	let last = 0;
	const sales = new Set<string>();
	for (const m of b.moves) {
		const n = Number(MOVE_ID.exec(m.id)?.[1]);
		if (n <= last || n >= b.nextMove || !ids.has(m.item)) return undefined;
		last = n;
		if (m.sale !== undefined) {
			const key = `${m.sale.invoice}#${m.sale.line}`;
			if (sales.has(key)) return undefined;
			sales.add(key);
		}
	}
	return b;
}
