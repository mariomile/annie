/**
 * Gli ordini's own state, in `orders.json` of an instance (outside the workspace): the orders, the
 * lead times the person said per supplier, the next number to give (never given twice), the calls
 * that wrote (a call run again writes nothing twice) and what the brief said. Changed under the
 * shared file lock through json-book.ts, with the copy `orders.json.bak`. Read never throws: a
 * file that does not read is `broken`, and nothing is written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { addDays } from "./italian-calendar.ts";
import { type LeadTime, type Order, ORDER_ID, ORDER_LIMITS, type OrderClaim, OrderError, type Receipt, validLead, validOrder, validOrderCall, validOrderClaim } from "./orders.ts";

/** What a change works on: the orders, the lead times and the next number. */
export type OrderState = { readonly nextOrder: number; readonly orders: readonly Order[]; readonly leads: readonly LeadTime[] };

type Book = OrderState & { readonly alerts: readonly OrderClaim[]; readonly calls: readonly string[] };

export type OrderBook = Book & { readonly broken: boolean };

export const ORDERS_BROKEN = "gli ordini ai fornitori (orders.json) non si leggono: non li cambio, perché andrebbero persi. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { nextOrder: 1, orders: [], leads: [], alerts: [], calls: [] };

/** Goods of an invoice line to mark on an order line. */
export type ReceiptFor = Receipt & { readonly order: string };

export class OrderStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "orders.json"),
			empty: EMPTY,
			maxBytes: ORDER_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new OrderError(ORDERS_BROKEN),
			full: () => new OrderError("gli ordini sono troppi per salvarne altri: annulla o esporta quelli vecchi"),
		};
	}

	/** Never throws. */
	read(): OrderBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). "rerun" when the call wrote already. OrderError from
	 * `change` stops it with nothing written.
	 */
	update(callId: string, change: (state: OrderState) => OrderState): "written" | "rerun" | "unchanged" {
		let outcome: "written" | "rerun" | "unchanged" = "unchanged";
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) {
				outcome = "rerun";
				return book;
			}
			const state: OrderState = { nextOrder: book.nextOrder, orders: book.orders, leads: book.leads };
			const next = change(state);
			if (next === state) return book;
			const out: Book = { ...book, nextOrder: next.nextOrder, orders: next.orders, leads: next.leads, calls: [...book.calls, callId].slice(-ORDER_LIMITS.calls) };
			if (validBook(out) === undefined) throw new OrderError("gli ordini non sono validi così: non li ho salvati");
			outcome = "written";
			return out;
		});
		return outcome;
	}

	/**
	 * The goods of invoice lines marked on their orders: an invoice line already marked anywhere is
	 * skipped (each once), and so is an order cancelled meanwhile. The receipts written.
	 */
	receive(receipts: readonly ReceiptFor[]): ReceiptFor[] {
		let written: ReceiptFor[] = [];
		updateBook(this.book, (book) => {
			const done = new Set(book.orders.flatMap((o) => o.receipts.map((r) => r.k)));
			const fresh = receipts.filter((r) => !done.has(r.k) && book.orders.some((o) => o.id === r.order && o.status === "sent" && o.lines.some((l) => l.n === r.n)));
			written = fresh;
			if (fresh.length === 0) return book;
			const orders = book.orders.map((o) => {
				const mine = fresh.filter((r) => r.order === o.id).map(({ order: _, ...r }) => r);
				return mine.length === 0 ? o : { ...o, receipts: [...o.receipts, ...mine] };
			});
			const out: Book = { ...book, orders };
			if (validBook(out) === undefined) throw new OrderError("la merce arrivata non si segna così sull'ordine: non l'ho segnata");
			return out;
		});
		return written;
	}

	/**
	 * What the brief may say today: of `wanted`, those not said within `again` days (a late order
	 * once a week, the line on what to reorder once a day), at most `perDay` of them today, all
	 * calls together; marked said by `callId`. A call run again gets back what it claimed.
	 */
	claim(callId: string, day: string, wanted: readonly string[], perDay: number, again: number): string[] {
		let mine: string[] = [];
		updateBook(this.book, (book) => {
			const before = book.alerts.filter((a) => a.call === callId);
			if (before.length > 0) {
				mine = before.map((a) => a.k);
				return book;
			}
			const since = addDays(day, -(again - 1));
			const said = new Set(book.alerts.filter((a) => a.day >= since && a.day <= day).map((a) => a.k));
			// The day's cap counts the claims of the same kind: late orders, or the line on what to reorder.
			const kind = (k: string) => k === "reorder";
			const wantsReorder = wanted.some(kind);
			let room = Math.max(0, perDay - book.alerts.filter((a) => a.day === day && kind(a.k) === wantsReorder).length);
			const fresh: OrderClaim[] = [];
			for (const k of new Set(wanted)) {
				if (said.has(k) || room <= 0) continue;
				fresh.push({ k, day, call: callId });
				room--;
			}
			mine = fresh.map((a) => a.k);
			if (fresh.length === 0) return book;
			return { ...book, alerts: [...book.alerts, ...fresh].slice(-ORDER_LIMITS.alerts) };
		});
		return mine;
	}
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999_999;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextOrder)) return undefined;
	if (!Array.isArray(b.orders) || b.orders.length > ORDER_LIMITS.orders || !b.orders.every(validOrder)) return undefined;
	if (!Array.isArray(b.leads) || b.leads.length > ORDER_LIMITS.leads || !b.leads.every(validLead) || new Set(b.leads.map((l) => l.s)).size !== b.leads.length) return undefined;
	if (!Array.isArray(b.alerts) || b.alerts.length > ORDER_LIMITS.alerts || !b.alerts.every(validOrderClaim)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > ORDER_LIMITS.calls || !b.calls.every(validOrderCall)) return undefined;
	// Numbers never given again; an invoice line received once.
	const ids = new Set<string>();
	for (const o of b.orders) {
		if (Number(ORDER_ID.exec(o.id)?.[1]) >= b.nextOrder || ids.has(o.id)) return undefined;
		ids.add(o.id);
	}
	return b;
}
