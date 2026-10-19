/**
 * Gli ordini and the invoices received: when stock receive_invoice loads an invoice of a supplier
 * with orders awaited (sent, not all arrived), each line it loads goes to the order the invoice
 * names (its DatiOrdineAcquisto, when it is one of ours), else to the oldest that still waits for
 * its article. What is past the quantity still to come is said and never put on a line already
 * full; so is a line on no order, an article still missing after it, and a cost above the one the
 * order expected. Goods the person said came with the delivery note (loaded then by hand) are not
 * loaded again: the invoice line bills them. The proposal only shows it; the order is marked
 * inside the confirmed load, under the orders' lock, each invoice line once (order-store.ts).
 */
import { spellingKey } from "./name-keys.ts";
import { handDayOf, isAwaited, type Order, type OrderLine, remainingOf, unbilledOf } from "./orders.ts";
import type { BilledFor, OrderStore, ReceiptFor } from "./order-store.ts";
import { supplierKeyOf } from "./order-suggest.ts";
import { lineKey } from "./purchase-prices.ts";
import { costOf, qtyOf, qtyText } from "./stock-sums.ts";

/** One invoice line as loaded (or held back, billing the delivery note): its number, the article, how many in its unit, the cost per unit. */
export type LoadRow = { readonly line: number; readonly item: string; readonly qty: string; readonly cost: string };

/** An invoice line on an order line: how many it fills, how many past what was still to come (never put on the order), the cost against the order's price. */
export type Matched = { readonly line: number; readonly item: string; readonly order: string; readonly n: number; readonly qty: bigint; readonly over: bigint; readonly cost: bigint; readonly price?: bigint };

/** An invoice line billing goods of the delivery note: the order line, how many, the day they came, the cost against the order's price. */
export type BilledRow = { readonly line: number; readonly item: string; readonly order: string; readonly n: number; readonly qty: bigint; readonly day: string; readonly cost: bigint; readonly price?: bigint };

export type InvoiceMatch = {
	readonly matched: readonly Matched[];
	readonly billedRows: readonly BilledRow[];
	/** Invoice lines whose article no awaited order of this supplier has. */
	readonly extra: readonly LoadRow[];
	/** Order lines still missing something after this invoice. */
	readonly missing: readonly { readonly order: string; readonly line: OrderLine; readonly left: bigint }[];
	readonly receipts: readonly ReceiptFor[];
	readonly billed: readonly BilledFor[];
	readonly orders: readonly string[];
};

/** The supplier of an invoice, as the orders key it. */
export type InvoiceSupplier = { readonly name: string; readonly vat?: string };

/** Whether an order is to this supplier: the same key (its partita IVA), or an order kept by name only and the same name spelled plainly. */
export function sameSupplier(o: Order, supplier: InvoiceSupplier): boolean {
	if (o.supplier.key === supplierKeyOf(supplier.name, supplier.vat)) return true;
	return o.supplier.vat === undefined && o.supplier.key.startsWith("nome:") && spellingKey(o.supplier.name) === spellingKey(supplier.name);
}

/** The awaited orders of the invoice's supplier: those the invoice names first, then the oldest sent. */
export function awaitedOf(orders: readonly Order[], supplier: InvoiceSupplier, refs: readonly string[] = []): Order[] {
	const named = (o: Order) => (refs.includes(o.id) ? 0 : 1);
	return orders.filter((o) => isAwaited(o) && sameSupplier(o, supplier)).sort((a, b) => named(a) - named(b) || (a.sentDay ?? a.day).localeCompare(b.sentDay ?? b.day) || a.id.localeCompare(b.id));
}

/** What came with the delivery note and no invoice billed yet, per article: the order line, how many, the day. Or an invoice line that billed some already. */
export type Covered = { readonly items: ReadonlyMap<string, { readonly day: string; readonly qty: bigint }>; readonly keys: ReadonlySet<string> };

export function coveredOf(orders: readonly Order[], supplier: InvoiceSupplier): Covered {
	const items = new Map<string, { day: string; qty: bigint }>();
	const keys = new Set<string>();
	for (const o of orders) {
		if (o.status === "cancelled" || !sameSupplier(o, supplier)) continue;
		for (const b of o.billed ?? []) keys.add(b.k);
		for (const l of o.lines) {
			const left = unbilledOf(o, l.n);
			if (left <= 0n) continue;
			const was = items.get(l.item);
			items.set(l.item, { day: [was?.day ?? "", handDayOf(o, l.n) ?? ""].sort().at(-1) as string, qty: (was?.qty ?? 0n) + left });
		}
	}
	return { items, keys };
}

/**
 * The invoice's lines on the orders: `rows` loaded, each to the orders with room for its article
 * (what is past them is said, not put on any); `held` (goods of the delivery note) billing the
 * lines received by hand. Undefined when there is nothing to say.
 */
export function matchInvoice(orders: readonly Order[], supplier: InvoiceSupplier, invoice: string, day: string, rows: readonly LoadRow[], held: readonly LoadRow[] = [], refs: readonly string[] = []): InvoiceMatch | undefined {
	// An invoice line marked already (a call run again) is not counted twice.
	const done = new Set(orders.flatMap((o) => [...o.receipts.map((r) => r.k), ...(o.billed ?? []).map((b) => b.k)]));
	const fresh = rows.filter((r) => !done.has(lineKey(invoice, r.line)));
	const holding = held.filter((r) => !done.has(lineKey(invoice, r.line)));
	const awaited = awaitedOf(orders, supplier, refs);
	if ((awaited.length === 0 || fresh.length === 0) && holding.length === 0) return undefined;
	const left = new Map<string, bigint>();
	for (const o of awaited) for (const l of o.lines) left.set(`${o.id}#${l.n}`, remainingOf(o, l));
	const matched: Matched[] = [];
	const extra: LoadRow[] = [];
	const receipts: ReceiptFor[] = [];
	for (const row of awaited.length === 0 ? [] : [...fresh].sort((a, b) => a.line - b.line)) {
		const on = awaited.flatMap((o) => o.lines.filter((l) => l.item === row.item).map((l) => ({ o, l })));
		if (on.length === 0) {
			extra.push(row);
			continue;
		}
		let qty = qtyOf(row.qty);
		const k = lineKey(invoice, row.line);
		const mine: Matched[] = [];
		for (const { o, l } of on) {
			const key = `${o.id}#${l.n}`;
			const room = left.get(key) ?? 0n;
			const take = qty < room ? qty : room;
			if (take <= 0n) continue;
			left.set(key, room - take);
			mine.push({ line: row.line, item: row.item, order: o.id, n: l.n, qty: take, over: 0n, cost: costOf(row.cost), ...(l.price === undefined ? {} : { price: costOf(l.price) }) });
			receipts.push({ order: o.id, k, n: l.n, qty: qtyText(take), day });
			qty -= take;
			if (qty <= 0n) break;
		}
		if (qty > 0n) {
			// Past every line with room: said, never put on a line already full.
			const last = mine.pop();
			const first = on[0] as { o: Order; l: OrderLine };
			mine.push(last === undefined ? { line: row.line, item: row.item, order: first.o.id, n: first.l.n, qty: 0n, over: qty, cost: costOf(row.cost), ...(first.l.price === undefined ? {} : { price: costOf(first.l.price) }) } : { ...last, over: qty });
		}
		matched.push(...mine);
	}
	// The goods of the delivery note: the invoice line bills them, line by line, never past what came.
	const billedRows: BilledRow[] = [];
	const billed: BilledFor[] = [];
	const unbilled = new Map<string, bigint>();
	for (const o of orders) if (o.status !== "cancelled" && sameSupplier(o, supplier)) for (const l of o.lines) unbilled.set(`${o.id}#${l.n}`, unbilledOf(o, l.n));
	for (const row of [...holding].sort((a, b) => a.line - b.line)) {
		let qty = qtyOf(row.qty);
		const k = lineKey(invoice, row.line);
		for (const o of orders.filter((x) => x.status !== "cancelled" && sameSupplier(x, supplier)).sort((a, b) => a.id.localeCompare(b.id))) {
			for (const l of o.lines.filter((x) => x.item === row.item)) {
				const key = `${o.id}#${l.n}`;
				const room = unbilled.get(key) ?? 0n;
				const take = qty < room ? qty : room;
				if (take <= 0n) continue;
				unbilled.set(key, room - take);
				billedRows.push({ line: row.line, item: row.item, order: o.id, n: l.n, qty: take, day: handDayOf(o, l.n) ?? day, cost: costOf(row.cost), ...(l.price === undefined ? {} : { price: costOf(l.price) }) });
				billed.push({ order: o.id, k, n: l.n, qty: qtyText(take), day });
				qty -= take;
			}
		}
	}
	const touched = new Set(matched.map((m) => m.order));
	const missing = awaited.filter((o) => touched.has(o.id)).flatMap((o) => o.lines.map((line) => ({ order: o.id, line, left: left.get(`${o.id}#${line.n}`) ?? 0n })).filter((x) => x.left > 0n));
	if (matched.length === 0 && billedRows.length === 0 && extra.length === 0) return undefined;
	return { matched, billedRows, extra, missing, receipts, billed, orders: awaited.map((o) => o.id) };
}

/** The seam receive_invoice is given: the orders read for the proposal, and marked inside the confirmed load. */
export type OrderLink = {
	readonly orders: () => readonly Order[] | "broken";
	/** What came with the delivery note from this supplier: not to load again. */
	readonly covered: (supplier: InvoiceSupplier) => Covered | "broken";
	readonly match: (supplier: InvoiceSupplier, invoice: string, day: string, rows: readonly LoadRow[], held: readonly LoadRow[], refs: readonly string[]) => InvoiceMatch | undefined | "broken";
	/** Marked under the lock; OrderError when the orders do not take it. */
	readonly receive: (supplier: InvoiceSupplier, invoice: string, day: string, rows: readonly LoadRow[], held: readonly LoadRow[], refs: readonly string[]) => { readonly match: InvoiceMatch; readonly written: number } | undefined | "broken";
};

export function orderLink(store: OrderStore): OrderLink {
	const read = () => {
		const book = store.read();
		return book.broken ? ("broken" as const) : book.orders;
	};
	return {
		orders: read,
		covered: (supplier) => {
			const orders = read();
			return orders === "broken" ? orders : coveredOf(orders, supplier);
		},
		match: (supplier, invoice, day, rows, held, refs) => {
			const orders = read();
			return orders === "broken" ? orders : matchInvoice(orders, supplier, invoice, day, rows, held, refs);
		},
		receive: (supplier, invoice, day, rows, held, refs) => {
			if (store.read().broken) return "broken";
			const got = store.receive((orders) => {
				const m = matchInvoice(orders, supplier, invoice, day, rows, held, refs);
				return { receipts: m?.receipts ?? [], billed: m?.billed ?? [], found: m };
			});
			if (got?.found === undefined) return undefined;
			return { match: got.found, written: got.receipts.length + got.billed.length };
		},
	};
}
