/**
 * Cosa riordinare: the articles of the magazzino under their minimum, or that will be before a
 * new order can arrive, from how fast they go out. The pace is the scarichi (sales and internal
 * use, less the credit notes' returns) of the last ORDER_LIMITS.window days; with fewer than
 * ORDER_LIMITS.fewSales of them it is an estimate, and said so. The quantity brings the article
 * back to its minimum plus `cover` days at that pace, rounded up to whole units and, with a pack,
 * to whole packs. Who sells it: the prices paid (purchase-prices.ts rows, an article's own by the
 * codes and descriptions the magazzino learned, else the same name when only one article has
 * it), else the carichi with a supplier: the cheapest of the recent ones and the usual one.
 */
import { vatKey } from "./clients.ts";
import { addDays, daysBetween } from "./italian-calendar.ts";
import { sameStems, spelledOut, spellingKey } from "./name-keys.ts";
import { isOpen, type Order, ORDER_LIMITS, remainingOf } from "./orders.ts";
import type { PurchaseRow } from "./purchase-prices.ts";
import { halfUp } from "./quote-sums.ts";
import { type CodeMap, type Movement, STOCK_LIMITS, type StockItem, type UnitMap } from "./stock.ts";
import { costOf, type ItemState, isLow, qtyOf, stateOf } from "./stock-sums.ts";

export type SuggestData = {
	readonly items: readonly StockItem[];
	readonly moves: readonly Movement[];
	readonly purchases: readonly PurchaseRow[];
	readonly codes: readonly CodeMap[];
	readonly units: readonly UnitMap[];
	/** The conto visione DDTs (their ids) the client kept and that were billed: only then their goods count as sold. */
	readonly visioneSold?: ReadonlySet<string>;
};

/** A price paid for an article: per its unit (ten-thousandths of a euro), the day, the supplier (its key, partita IVA first), and where it was read. */
export type Offer = { readonly key: string; readonly supplier: string; readonly vat?: string; readonly cost: bigint; readonly day: string; readonly from: "invoice" | "carico" };

/** Who sells an article: the cheapest of the recent prices (each supplier's latest), and the supplier bought from most often, with its latest price. */
export type Sellers = { readonly cheapest?: Offer; readonly usual?: Offer & { readonly count: number } };

/** A supplier's key the orders keep: its partita IVA, else its name spelled plainly. */
export function supplierKeyOf(name: string, vat: string | undefined): string {
	return vatKey(vat) ?? `nome:${spellingKey(name)}`;
}

const collapsed = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The prices paid for `item`: the invoice lines that are its own (learned) or have its very name (and no other article's), else its carichi with a supplier. */
export function offersFor(item: StockItem, data: SuggestData): Offer[] {
	const names = data.items.filter((i) => i.removed === undefined).map((i) => i.name);
	const out: Offer[] = [];
	for (const r of data.purchases) {
		if (r.perLine) continue;
		const code = r.code?.toLowerCase();
		const d = collapsed(spelledOut(r.description), STOCK_LIMITS.supplierText);
		const learned = data.codes.find((c) => c.s === r.party && ((code !== undefined && c.c?.toLowerCase() === code) || (c.d !== undefined && c.d === d)))?.i;
		if (learned !== undefined ? learned !== item.id : !sameStems(item.name, r.description) || names.filter((n) => sameStems(n, r.description)).length > 1) continue;
		const cost = perUnit(item, r, data.units);
		if (cost === undefined || cost <= 0n) continue;
		const vat = r.vat ?? vatKey(r.party);
		out.push({ key: supplierKeyOf(r.supplier, vat), supplier: r.supplier, ...(vat === undefined ? {} : { vat }), cost, day: r.day, from: "invoice" });
	}
	if (out.length > 0) return out;
	for (const m of data.moves) {
		if (m.item !== item.id || m.kind !== "carico" || m.supplier === undefined || m.cost === undefined) continue;
		out.push({ key: supplierKeyOf(m.supplier.name, m.supplier.vat), supplier: m.supplier.name, ...(m.supplier.vat === undefined ? {} : { vat: m.supplier.vat }), cost: costOf(m.cost), day: m.day, from: "carico" });
	}
	return out;
}

/** A price row per the article's unit: as written, per its pack, or through a unit the supplier's lines were taught. */
function perUnit(item: StockItem, r: PurchaseRow, units: readonly UnitMap[]): bigint | undefined {
	if (r.unit === undefined || r.unit === item.unit) return halfUp(r.price, 10_000n);
	if (item.pack !== undefined && r.unit === item.pack.unit) return halfUp(r.price * 1000n, qtyOf(item.pack.size) * 10_000n);
	const map = units.find((u) => u.s === r.party && u.u === r.unit && u.i === item.id);
	return map === undefined ? undefined : halfUp(r.price * 1000n, qtyOf(map.q) * 10_000n);
}

/** Each supplier's latest price (the latest day; on the same day, the lower). */
export function latestBySupplier(offers: readonly Offer[]): Offer[] {
	const by = new Map<string, Offer>();
	for (const o of offers) {
		const was = by.get(o.key);
		if (was === undefined || o.day > was.day || (o.day === was.day && o.cost < was.cost)) by.set(o.key, o);
	}
	return [...by.values()];
}

export function sellersOf(offers: readonly Offer[], today: string): Sellers {
	const recent = latestBySupplier(offers.filter((o) => o.day >= addDays(today, -ORDER_LIMITS.recentDays)));
	const cheapest = [...recent].sort((a, b) => (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : b.day.localeCompare(a.day)))[0];
	const year = offers.filter((o) => o.day >= addDays(today, -ORDER_LIMITS.usualDays));
	const counts = new Map<string, number>();
	for (const o of year) counts.set(o.key, (counts.get(o.key) ?? 0) + 1);
	const latest = latestBySupplier(year);
	const usual = [...latest].sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0) || b.day.localeCompare(a.day))[0];
	return { ...(cheapest === undefined ? {} : { cheapest }), ...(usual === undefined ? {} : { usual: { ...usual, count: counts.get(usual.key) ?? 0 } }) };
}

/** What is on its way for an article: still awaited on the orders sent, or on a draft; with each order. */
export type Incoming = { readonly qty: bigint; readonly orders: readonly { readonly id: string; readonly supplier: string; readonly day: string; readonly draft: boolean; readonly qty: bigint }[] };

/** Per article, what the open orders still bring: a draft's lines whole, a sent order's what has not arrived. */
export function incomingOf(orders: readonly Order[]): Map<string, Incoming> {
	const out = new Map<string, { qty: bigint; orders: Incoming["orders"][number][] }>();
	for (const o of orders) {
		if (!isOpen(o)) continue;
		for (const l of o.lines) {
			const left = remainingOf(o, l);
			if (left <= 0n) continue;
			const was = out.get(l.item) ?? { qty: 0n, orders: [] };
			was.qty += left;
			was.orders.push({ id: o.id, supplier: o.supplier.name, day: o.sentDay ?? o.day, draft: o.status === "draft", qty: left });
			out.set(l.item, was);
		}
	}
	return out;
}

export type Suggestion = {
	readonly item: StockItem;
	readonly state: ItemState;
	/** Thousandths sold in the window, in how many scarichi, and the window's days (fewer when the article is followed since less). */
	readonly sold: bigint;
	readonly sales: number;
	readonly days: number;
	/** Under its minimum or in negativo now (counting what is on its way), or about to be before an order arrives. */
	readonly why: "low" | "soon";
	/** soon: in how many days it goes under. */
	readonly toMin?: number;
	/** The lead time counted, in days, and whether the person said it (else it is the default, an assumption). */
	readonly lead: number;
	readonly leadKnown: boolean;
	/** On its way already: on the orders sent and the drafts. */
	readonly incoming?: Incoming;
	/** The quantity to reach (minimum plus the sales of the lead time and the cover), what is missing, and what to order (whole units, whole packs). */
	readonly target: bigint;
	readonly need: bigint;
	readonly qty: bigint;
	readonly packs?: bigint;
	/** The need had decimals: rounded up to whole units. */
	readonly rounded: boolean;
	readonly few: boolean;
	readonly sellers: Sellers;
};

const ceilDiv = (a: bigint, b: bigint) => (a <= 0n ? 0n : (a + b - 1n) / b);

/**
 * The thousandths gone out of `item` from `from` to `to`: scarichi for a sale or internal use (a
 * conto visione only once billed, `visioneSold`; an omaggio never), less the returns of credit
 * notes and resi; and how many scarichi.
 */
export function paceOf(item: StockItem, moves: readonly Movement[], from: string, to: string, visioneSold?: ReadonlySet<string>): { sold: bigint; sales: number } {
	let sold = 0n;
	let sales = 0;
	for (const m of moves) {
		if (m.item !== item.id || m.day < from || m.day > to) continue;
		const kept = m.reason === "conto_visione" && m.sale !== undefined && visioneSold?.has(m.sale.invoice) === true;
		if (m.kind === "scarico" && (m.reason === "vendita" || m.reason === "uso_interno" || kept)) {
			sold += qtyOf(m.qty);
			sales++;
		} else if (m.kind === "storno") sold -= qtyOf(m.qty);
	}
	return { sold: sold > 0n ? sold : 0n, sales };
}

/** The days the pace is read over: ORDER_LIMITS.window, or fewer when the article's first movement is more recent. */
export function windowOf(item: StockItem, moves: readonly Movement[], today: string): number {
	let first: string | undefined;
	for (const m of moves) if (m.item === item.id && m.day <= today && (first === undefined || m.day < first)) first = m.day;
	if (first === undefined) return ORDER_LIMITS.window;
	return Math.max(1, Math.min(ORDER_LIMITS.window, daysBetween(first, today) + 1));
}

export type SuggestOptions = {
	readonly cover: number;
	/** A supplier's lead time in days, and whether the person said it. */
	readonly lead: (key: string | undefined) => { readonly days: number; readonly known: boolean };
	/** What the open orders bring, per article. */
	readonly incoming?: ReadonlyMap<string, Incoming>;
};

/**
 * The articles to reorder today, the furthest under first: under the minimum (or in negativo),
 * or that at their pace go under it (under zero without one) within the lead time of the supplier
 * they would come from; what the open orders bring counts as had. The quantity reaches the
 * minimum plus the sales of the lead time and of `cover` days.
 */
export function suggestions(data: SuggestData, today: string, o: SuggestOptions): Suggestion[] {
	const out: Suggestion[] = [];
	for (const item of data.items) {
		if (item.removed !== undefined) continue;
		const state = stateOf(item, data.moves);
		const days = windowOf(item, data.moves, today);
		const window = BigInt(days);
		const { sold, sales } = paceOf(item, data.moves, addDays(today, -(days - 1)), today, data.visioneSold);
		const min = item.min === undefined ? 0n : qtyOf(item.min);
		if (item.min === undefined && sold === 0n) continue;
		const incoming = o.incoming?.get(item.id);
		const coming = incoming?.qty ?? 0n;
		const have = state.onHand + coming;
		const sellers = sellersOf(offersFor(item, data), today);
		const lead = o.lead((sellers.usual ?? sellers.cheapest)?.key);
		const gone = ceilDiv(sold * BigInt(lead.days), window);
		const low = coming === 0n ? isLow(state) : have < 0n || (item.min !== undefined && have < min);
		const soon = !low && have - gone < min;
		if (!low && !soon) continue;
		// The minimum and the sales of the delivery and the cover, up to whole units.
		const target = ceilDiv(min + ceilDiv(sold * BigInt(lead.days + o.cover), window), 1000n) * 1000n;
		const need = target - have;
		if (need <= 0n) continue;
		let qty = ceilDiv(need, 1000n) * 1000n;
		let packs: bigint | undefined;
		if (item.pack !== undefined) {
			const size = qtyOf(item.pack.size);
			packs = ceilDiv(qty, size);
			qty = packs * size;
		}
		// soon: the days until it is under the minimum at this pace (at least one).
		const toMin = soon && sold > 0n ? Math.max(1, Number(ceilDiv((have - min) * window, sold))) : undefined;
		out.push({ item, state, sold, sales, days, why: low ? "low" : "soon", ...(toMin === undefined ? {} : { toMin }), lead: lead.days, leadKnown: lead.known, ...(incoming === undefined ? {} : { incoming }), target, need, qty, ...(packs === undefined ? {} : { packs }), rounded: need % 1000n !== 0n, few: sales < ORDER_LIMITS.fewSales, sellers });
	}
	const gap = (s: Suggestion) => s.need;
	return out.sort((a, b) => Number(b.why === "low") - Number(a.why === "low") || (gap(b) > gap(a) ? 1 : gap(b) < gap(a) ? -1 : 0) || a.item.name.localeCompare(b.item.name, "it"));
}
