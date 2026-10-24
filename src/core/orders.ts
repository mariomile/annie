/**
 * Gli ordini ai fornitori: what the person orders from a supplier (OR-0001, never given twice),
 * line by line on the articles of the magazzino, each with its quantity in the article's unit and
 * the price expected (the last price paid to that supplier, or the one said). An order is a draft
 * until the person says it went out («sent»: Owni never sends it), then the goods that arrive
 * with the invoices received loaded into the magazzino mark it received in part or in full; it
 * can be cancelled. Kept per instance in `orders.json` (order-store.ts); what to reorder in
 * order-suggest.ts, the link to the invoices received in order-receive.ts.
 *
 * Choices, tested:
 * - Only the status said is stored (draft, sent, cancelled); «arrivato in parte» and «arrivato»
 *   come from the receipts, each an invoice line once (its key, purchase-prices.ts lineKey), or
 *   the goods the person said came with the delivery note (from "person", a «bolla:» key): the
 *   invoice that comes later bills those (`billed`) instead of loading them again.
 * - Quantities are canonical decimals in the article's unit (stock.ts isQuantity), a price per
 *   unit euros to the fourth decimal (isCost); never a float.
 * - Another agente gets counts only: never a supplier, an article, a quantity or a price.
 */
import type { Marker } from "./marker.ts";
import { realDate } from "./italian-calendar.ts";
import { isCost, isQuantity, STOCK_ID } from "./stock.ts";
import { qtyOf } from "./stock-sums.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export class OrderError extends Error {
	override readonly name = "OrderError";
}

export const ORDER_OPS = ["suggest", "create", "change", "mark_sent", "received", "cancel", "list", "status", "document", "export", "lead_time"] as const;
export type OrderOp = (typeof ORDER_OPS)[number];

export const ORDER_LIMITS = {
	orders: 5000,
	lines: 200,
	/** Invoice lines received on one order. */
	receipts: 2000,
	leads: 1000,
	alerts: 2000,
	calls: 500,
	name: 120,
	notes: 500,
	file: 300,
	/** The days of scarichi the sales pace is read from. */
	window: 90,
	/** Days of sales a suggestion covers past the minimum, unless the person says otherwise. */
	cover: 30,
	maxCover: 365,
	/** Fewer scarichi than this in the window: the pace is an estimate, and said so. */
	fewSales: 3,
	/** A supplier's lead time when the person said none, and the most it may be. */
	lead: 7,
	maxLead: 365,
	/** The cheapest supplier is among the prices of these last days; the usual one, of these. */
	recentDays: 180,
	usualDays: 365,
	/** Late orders the brief says in one day, each again after these days at the earliest. */
	briefPerDay: 3,
	briefAgain: 7,
	/** Rows shown in one answer, before «e altri N». */
	shown: 30,
	fileBytes: 8 * 1024 * 1024,
} as const;

/** Who an order goes to: the supplier's key (its partita IVA when known, else «nome:…»), its name as shown, its partita IVA. */
export type OrderSupplier = { readonly key: string; readonly name: string; readonly vat?: string };

/** One line: the article (and its name when ordered), how many in its unit, the price expected per unit and where it comes from. */
export type OrderLine = {
	readonly n: number;
	readonly item: string;
	readonly name: string;
	readonly qty: string;
	readonly unit: string;
	readonly price?: string;
	/** «purchase»: the last price paid to this supplier, of `priceDay`; «said»: the person's. */
	readonly priceFrom?: "purchase" | "said";
	readonly priceDay?: string;
};

/**
 * Goods received on an order line: from an invoice line loaded (`k` its key), or (`from`
 * «person») from the person's word with the delivery note, loaded then by hand (`k` the call's
 * own key); the order line, how many (in the article's unit), the day.
 */
/**
 * Goods of an order line arrived: an invoice line loaded (no `from`), the delivery note the person
 * said (`from` "person"), or a carico in the magazzino already (`from` "stock"): `bill` when that
 * carico was loaded by hand, not from an invoice, so that its invoice still bills it when it comes.
 */
export type Receipt = { readonly k: string; readonly n: number; readonly qty: string; readonly day: string; readonly from?: "person" | "stock"; readonly bill?: true };

/** Goods an invoice still has to bill: the delivery note's, and a carico loaded by hand. */
const billable = (r: Receipt) => r.from === "person" || (r.from === "stock" && r.bill === true);

/** An invoice line that billed goods received with the delivery note: not loaded again, not received twice. */
export type Billed = { readonly k: string; readonly n: number; readonly qty: string; readonly day: string };

export const ORDER_STATUSES = ["draft", "sent", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type Order = Marker & {
	/** «OR-0001», never given again. */
	readonly id: string;
	readonly supplier: OrderSupplier;
	readonly status: OrderStatus;
	/** The day it was made, and the day the person said it went out. */
	readonly day: string;
	readonly sentDay?: string;
	readonly lines: readonly OrderLine[];
	readonly notes?: string;
	/** The document without prices, as the person asked. */
	readonly noPrices?: true;
	/** The document in the workspace, the last made. */
	readonly file?: string;
	readonly receipts: readonly Receipt[];
	/** The invoice lines that billed what came with the delivery note (absent before week 72's hand receipts). */
	readonly billed?: readonly Billed[];
	readonly callId?: string;
	readonly edited?: Marker;
	readonly sent?: Marker;
	readonly cancelled?: Marker;
};

/** A supplier's lead time, as the person said it: the supplier's key, the days. */
export type LeadTime = { readonly s: string; readonly days: number };

/** What the brief said: a late order (its id) or the line on what to reorder («reorder»), the day and the call. */
export type OrderClaim = { readonly k: string; readonly day: string; readonly call: string };

/** The state shown: the status said, or what the receipts make of a sent order. */
export type OrderState = "draft" | "sent" | "partial" | "received" | "cancelled";

export const STATE_WORDS: Readonly<Record<OrderState, string>> = { draft: "bozza, non ancora inviato", sent: "inviato, non ancora arrivato", partial: "arrivato in parte", received: "arrivato", cancelled: "annullato" };

export const orderId = (n: number) => `OR-${String(n).padStart(4, "0")}`;
export const ORDER_ID = /^OR-(\d{4,6})$/;
const LINE_KEY = /^[0-9a-f]{24}#\d{1,4}$/;
/** The key of goods received by the person's word: «bolla:» and a digest of the call. */
const HAND_KEY = /^bolla:[0-9a-f]{16}$/;
/** A receipt of goods found in the magazzino already (a carico by hand, an invoice that matched no order): keyed by that carico. */
const STOCK_KEY = /^carico:MV-\d{6,7}$/;

/** How many of order line `n` came with the delivery note and no invoice billed yet (thousandths). */
export function unbilledOf(order: Pick<Order, "receipts" | "billed">, n: number): bigint {
	const hand = order.receipts.filter((r) => r.n === n && billable(r)).reduce((s, r) => s + qtyOf(r.qty), 0n);
	const billed = (order.billed ?? []).filter((b) => b.n === n).reduce((s, b) => s + qtyOf(b.qty), 0n);
	return hand > billed ? hand - billed : 0n;
}

/** The day the delivery note brought the goods of line `n` (the latest), when it did. */
export const handDayOf = (order: Pick<Order, "receipts">, n: number): string | undefined =>
	order.receipts
		.filter((r) => r.n === n && billable(r))
		.map((r) => r.day)
		.sort()
		.at(-1);

/** How many of order line `n` were received (thousandths). */
export function receivedOf(order: Pick<Order, "receipts">, n: number): bigint {
	return order.receipts.filter((r) => r.n === n).reduce((s, r) => s + qtyOf(r.qty), 0n);
}

/** How many of a line are still to come (thousandths, never below zero). */
export function remainingOf(order: Pick<Order, "receipts">, line: Pick<OrderLine, "n" | "qty">): bigint {
	const left = qtyOf(line.qty) - receivedOf(order, line.n);
	return left > 0n ? left : 0n;
}

export function orderState(order: Pick<Order, "status" | "lines" | "receipts">): OrderState {
	if (order.status !== "sent") return order.status;
	if (order.lines.every((l) => remainingOf(order, l) === 0n)) return "received";
	return order.receipts.length > 0 ? "partial" : "sent";
}

/** Still open: a draft, or sent and not all arrived. */
export const isOpen = (o: Order): boolean => ["draft", "sent", "partial"].includes(orderState(o));

/** Waiting for goods: sent, not all arrived. */
export const isAwaited = (o: Order): boolean => ["sent", "partial"].includes(orderState(o));

/** The ops that only read, and the brief's list (compact), which only marks what it said: they run in a brief's thread. */
const READ_OPS: readonly OrderOp[] = ["suggest", "list", "status"];

export function orderCallReads(args: Record<string, unknown>): boolean {
	return READ_OPS.some((o) => o === args.op);
}

const plain = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);

function validSupplier(v: unknown): v is OrderSupplier {
	if (typeof v !== "object" || v === null) return false;
	const s = v as OrderSupplier;
	return Object.keys(s).every((k) => ["key", "name", "vat"].includes(k)) && plain(s.key, 140) && plain(s.name, ORDER_LIMITS.name) && (s.vat === undefined || plain(s.vat, 40));
}

function validLine(v: unknown): v is OrderLine {
	if (typeof v !== "object" || v === null) return false;
	const l = v as OrderLine;
	if (!Object.keys(l).every((k) => ["n", "item", "name", "qty", "unit", "price", "priceFrom", "priceDay"].includes(k))) return false;
	if (!Number.isInteger(l.n) || l.n < 1 || l.n > 9999 || typeof l.item !== "string" || !STOCK_ID.test(l.item) || !plain(l.name, ORDER_LIMITS.name) || !plain(l.unit, 10)) return false;
	if (!isQuantity(l.qty) || Number(l.qty) <= 0) return false;
	if (l.price !== undefined && (!isCost(l.price) || (l.priceFrom !== "purchase" && l.priceFrom !== "said"))) return false;
	if (l.price === undefined && (l.priceFrom !== undefined || l.priceDay !== undefined)) return false;
	return l.priceDay === undefined || (typeof l.priceDay === "string" && realDate(l.priceDay));
}

function validReceipt(v: unknown): v is Receipt {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Receipt;
	if (r.bill !== undefined && (r.bill !== true || r.from !== "stock")) return false;
	if (!Object.keys(r).every((k) => ["k", "n", "qty", "day", "from", "bill"].includes(k)) || (r.from !== undefined && r.from !== "person" && r.from !== "stock")) return false;
	return typeof r.k === "string" && (r.from === "person" ? HAND_KEY : r.from === "stock" ? STOCK_KEY : LINE_KEY).test(r.k) && Number.isInteger(r.n) && r.n >= 1 && isQuantity(r.qty) && Number(r.qty) > 0 && typeof r.day === "string" && realDate(r.day);
}

function validBilled(v: unknown): v is Billed {
	if (typeof v !== "object" || v === null) return false;
	const b = v as Billed;
	return Object.keys(b).every((k) => ["k", "n", "qty", "day"].includes(k)) && typeof b.k === "string" && LINE_KEY.test(b.k) && Number.isInteger(b.n) && b.n >= 1 && isQuantity(b.qty) && Number(b.qty) > 0 && typeof b.day === "string" && realDate(b.day);
}

/** Each pair of a key and an order line once. */
const uniquePairs = (xs: readonly { readonly k: string; readonly n: number }[]) => new Set(xs.map((x) => `${x.k}|${x.n}`)).size === xs.length;

/** An order as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validOrder(v: unknown): v is Order {
	if (!isMarker(v)) return false;
	const o = v as Order;
	for (const key of Object.keys(o)) if (!["id", "supplier", "status", "day", "sentDay", "lines", "notes", "noPrices", "file", "receipts", "billed", "callId", "edited", "sent", "cancelled", "by", "at"].includes(key)) return false;
	if (typeof o.id !== "string" || !ORDER_ID.test(o.id) || !validSupplier(o.supplier) || !(ORDER_STATUSES as readonly string[]).includes(o.status)) return false;
	if (typeof o.day !== "string" || !realDate(o.day) || (o.sentDay !== undefined && (typeof o.sentDay !== "string" || !realDate(o.sentDay)))) return false;
	if ((o.status === "sent") !== (o.sentDay !== undefined) && o.status !== "cancelled") return false;
	if (!Array.isArray(o.lines) || o.lines.length === 0 || o.lines.length > ORDER_LIMITS.lines || !o.lines.every(validLine)) return false;
	if (new Set(o.lines.map((l) => l.n)).size !== o.lines.length || new Set(o.lines.map((l) => l.item)).size !== o.lines.length) return false;
	if (!Array.isArray(o.receipts) || o.receipts.length > ORDER_LIMITS.receipts || !o.receipts.every((r) => validReceipt(r) && o.lines.some((l) => l.n === r.n)) || !uniquePairs(o.receipts)) return false;
	if (o.billed !== undefined && (!Array.isArray(o.billed) || o.billed.length > ORDER_LIMITS.receipts || !o.billed.every((b) => validBilled(b) && o.lines.some((l) => l.n === b.n)) || !uniquePairs(o.billed))) return false;
	if (!optText(o.notes, ORDER_LIMITS.notes) || (o.noPrices !== undefined && o.noPrices !== true) || !optText(o.file, ORDER_LIMITS.file) || !optText(o.callId, 200)) return false;
	return [o.edited, o.sent, o.cancelled].every((m) => m === undefined || isMarker(m));
}

export function validLead(v: unknown): v is LeadTime {
	if (typeof v !== "object" || v === null) return false;
	const l = v as LeadTime;
	return Object.keys(l).every((k) => ["s", "days"].includes(k)) && plain(l.s, 140) && Number.isInteger(l.days) && l.days >= 1 && l.days <= ORDER_LIMITS.maxLead;
}

export function validOrderClaim(v: unknown): v is OrderClaim {
	if (typeof v !== "object" || v === null) return false;
	const c = v as OrderClaim;
	return Object.keys(c).every((k) => ["k", "day", "call"].includes(k)) && (c.k === "reorder" || (typeof c.k === "string" && ORDER_ID.test(c.k))) && typeof c.day === "string" && realDate(c.day) && isText(c.call, 200);
}

export const validOrderCall = (v: unknown): boolean => isText(v, 200);
