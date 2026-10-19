/**
 * Gli ordini and the invoices received: when stock receive_invoice loads an invoice of a supplier
 * with orders awaited (sent, not all arrived), each line it loads goes to the oldest of those
 * orders that still waits for its article; what is past the quantity ordered is said, and so is
 * a line on no order, an article of the order still missing after it, and a cost above the one
 * the order expected. The proposal only shows it; the order is marked inside the confirmed load,
 * each invoice line once (order-store.ts receive).
 */
import { isAwaited, type Order, type OrderLine, remainingOf } from "./orders.ts";
import type { OrderStore, ReceiptFor } from "./order-store.ts";
import { supplierKeyOf } from "./order-suggest.ts";
import { lineKey } from "./purchase-prices.ts";
import { costOf, qtyOf, qtyText } from "./stock-sums.ts";

/** One invoice line as loaded: its number, the article, how many in its unit, the cost per unit. */
export type LoadRow = { readonly line: number; readonly item: string; readonly qty: string; readonly cost: string };

/** An invoice line on an order line: how many, how many past what was still to come, the cost against the order's price. */
export type Matched = { readonly line: number; readonly order: string; readonly n: number; readonly qty: bigint; readonly over: bigint; readonly cost: bigint; readonly price?: bigint };

export type InvoiceMatch = {
	readonly matched: readonly Matched[];
	/** Invoice lines whose article no awaited order of this supplier has. */
	readonly extra: readonly LoadRow[];
	/** Order lines still missing something after this invoice. */
	readonly missing: readonly { readonly order: string; readonly line: OrderLine; readonly left: bigint }[];
	readonly receipts: readonly ReceiptFor[];
	readonly orders: readonly string[];
};

/** The supplier of an invoice, as the orders key it. */
export type InvoiceSupplier = { readonly name: string; readonly vat?: string };

/** The awaited orders of the invoice's supplier, oldest sent first. */
export function awaitedOf(orders: readonly Order[], supplier: InvoiceSupplier): Order[] {
	const key = supplierKeyOf(supplier.name, supplier.vat);
	return orders.filter((o) => o.supplier.key === key && isAwaited(o)).sort((a, b) => (a.sentDay ?? a.day).localeCompare(b.sentDay ?? b.day) || a.id.localeCompare(b.id));
}

/** The invoice's lines on the awaited orders; undefined when the supplier has none. */
export function matchInvoice(orders: readonly Order[], supplier: InvoiceSupplier, invoice: string, day: string, rows: readonly LoadRow[]): InvoiceMatch | undefined {
	const awaited = awaitedOf(orders, supplier);
	if (awaited.length === 0) return undefined;
	// An invoice line marked already (a call run again) is not counted twice.
	const done = new Set(orders.flatMap((o) => o.receipts.map((r) => r.k)));
	rows = rows.filter((r) => !done.has(lineKey(invoice, r.line)));
	if (rows.length === 0) return undefined;
	// What is still to come, line by line, taken as this invoice's lines fill it.
	const left = new Map<string, bigint>();
	for (const o of awaited) for (const l of o.lines) left.set(`${o.id}#${l.n}`, remainingOf(o, l));
	const matched: Matched[] = [];
	const extra: LoadRow[] = [];
	const receipts: ReceiptFor[] = [];
	for (const row of [...rows].sort((a, b) => a.line - b.line)) {
		const on = awaited.flatMap((o) => o.lines.filter((l) => l.item === row.item).map((l) => ({ o, l })));
		if (on.length === 0) {
			extra.push(row);
			continue;
		}
		let qty = qtyOf(row.qty);
		const k = lineKey(invoice, row.line);
		for (const [i, { o, l }] of on.entries()) {
			const key = `${o.id}#${l.n}`;
			const room = left.get(key) ?? 0n;
			const last = i === on.length - 1;
			const take = last ? qty : qty < room ? qty : room;
			if (take <= 0n) continue;
			const over = take > room ? take - room : 0n;
			left.set(key, room > take ? room - take : 0n);
			matched.push({ line: row.line, order: o.id, n: l.n, qty: take, over, cost: costOf(row.cost), ...(l.price === undefined ? {} : { price: costOf(l.price) }) });
			receipts.push({ order: o.id, k, n: l.n, qty: qtyText(take), day });
			qty -= take;
			if (qty <= 0n) break;
		}
	}
	const touched = new Set(matched.map((m) => m.order));
	const missing = awaited.filter((o) => touched.has(o.id)).flatMap((o) => o.lines.map((line) => ({ order: o.id, line, left: left.get(`${o.id}#${line.n}`) ?? 0n })).filter((x) => x.left > 0n));
	return { matched, extra, missing, receipts, orders: awaited.map((o) => o.id) };
}

/** The seam receive_invoice is given: the orders read for the proposal, and marked inside the confirmed load. */
export type OrderLink = {
	readonly orders: () => readonly Order[] | "broken";
	readonly match: (supplier: InvoiceSupplier, invoice: string, day: string, rows: readonly LoadRow[]) => InvoiceMatch | undefined | "broken";
	readonly receive: (supplier: InvoiceSupplier, invoice: string, day: string, rows: readonly LoadRow[]) => { readonly match: InvoiceMatch; readonly written: number } | undefined | "broken";
};

export function orderLink(store: OrderStore): OrderLink {
	const match = (supplier: InvoiceSupplier, invoice: string, day: string, rows: readonly LoadRow[]) => {
		const book = store.read();
		return book.broken ? ("broken" as const) : matchInvoice(book.orders, supplier, invoice, day, rows);
	};
	return {
		orders: () => {
			const book = store.read();
			return book.broken ? "broken" : book.orders;
		},
		match,
		receive: (supplier, invoice, day, rows) => {
			const m = match(supplier, invoice, day, rows);
			if (m === undefined || m === "broken") return m;
			return { match: m, written: store.receive(m.receipts).length };
		},
	};
}
