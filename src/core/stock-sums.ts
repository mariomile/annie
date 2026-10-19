/**
 * Il magazzino's figures, all from the movements in their order (stock.ts): what is on hand, the
 * weighted average cost, the value, whether an article is «in negativo» (a scarico past what
 * there was, until a count) and since when it is sottoscorta (the crossing the brief says once).
 * Quantities in bigint thousandths, a unit cost in ten-thousandths of a euro, a value in cents.
 * A carico whose cost was corrected (a costo movement) counts at the right cost, as if it had
 * always had it; an apertura (a closed year) starts the article where it was.
 */
import { halfUp, scaled, scaledDecimal } from "./quote-sums.ts";
import { type Movement, type StockItem, stockUnit } from "./stock.ts";

/** Thousandths of a unit. */
export const qtyOf = (q: string): bigint => (q.startsWith("-") ? -scaled(q.slice(1), 3) : scaled(q, 3));

/** Thousandths back to a canonical decimal, the sign kept. */
export const qtyText = (n: bigint): string => (n < 0n ? `-${scaledDecimal(-n, 3)}` : scaledDecimal(n, 3));

/** A unit cost in ten-thousandths of a euro. */
export const costOf = (c: string): bigint => scaled(c, 4);

/** Ten-thousandths back to a canonical decimal of euros. */
export const costText = (c: bigint): string => scaledDecimal(c, 4);

export type ItemState = {
	readonly item: StockItem;
	/** Thousandths on hand. */
	readonly onHand: bigint;
	/** The weighted average cost, ten-thousandths of a euro per unit; undefined before the first carico. */
	readonly average?: bigint;
	/** onHand × average in cents (0 when there is nothing or the article is in negativo); undefined without a cost. */
	readonly value?: bigint;
	/** A scarico took it under zero and no count came after: since this movement. */
	readonly negative: boolean;
	readonly negativeSince?: string;
	/** The crossing it is sottoscorta since (the movement that took it under the minimum, with the minimum); undefined when it is not. */
	readonly lowSince?: string;
	/** Where the crossing starts (a movement, or the article's id when it was under from the start). */
	readonly lowBase?: string;
	/** The last carico, with the cost it counts at now. */
	readonly lastCarico?: { readonly move: Movement; readonly cost: string };
	readonly moves: readonly Movement[];
};

const delta = (m: Movement): bigint => {
	switch (m.kind) {
		case "carico":
		case "storno":
		case "rettifica":
			return qtyOf(m.qty);
		case "scarico":
			return -qtyOf(m.qty);
		case "costo":
		case "apertura":
			return 0n;
	}
};

/** The average after a carico of `qty` at `cost` on `onHand` at `average`: what there was at its average, the new at its cost; from nothing (or less), the new cost. */
export function averageAfter(onHand: bigint, average: bigint | undefined, qty: bigint, cost: bigint): bigint {
	if (onHand <= 0n || average === undefined) return cost;
	return halfUp(onHand * average + qty * cost, onHand + qty);
}

/** One article's state from its movements (any order given: they are taken by number). */
export function stateOf(item: StockItem, all: readonly Movement[]): ItemState {
	const moves = all.filter((m) => m.item === item.id).sort((a, b) => a.id.localeCompare(b.id));
	// The cost each carico counts at: its own, or the last correction of it.
	const fixed = new Map<string, string>();
	for (const m of moves) if (m.kind === "costo" && m.fixes !== undefined && m.cost !== undefined) fixed.set(m.fixes, m.cost);
	const min = item.min === undefined ? undefined : qtyOf(item.min);
	let onHand = 0n;
	let average: bigint | undefined;
	let negativeSince: string | undefined;
	// Under the minimum from the start (an article added with nothing), until a movement takes it back up.
	let lowBase: string | undefined = min !== undefined && 0n < min ? item.id : undefined;
	let lastCarico: { move: Movement; cost: string } | undefined;
	for (const m of moves) {
		if (m.kind === "apertura") {
			onHand = qtyOf(m.qty);
			average = m.cost === undefined ? undefined : costOf(m.cost);
			negativeSince = m.negative;
			lowBase = min !== undefined && onHand < min ? (m.low ?? m.id) : undefined;
			continue;
		}
		const d = delta(m);
		if (m.kind === "carico") {
			const cost = fixed.get(m.id) ?? (m.cost as string);
			average = averageAfter(onHand, average, d, costOf(cost));
			lastCarico = { move: m, cost };
		}
		onHand += d;
		if (m.kind === "rettifica") negativeSince = undefined;
		if (onHand < 0n && negativeSince === undefined) negativeSince = m.id;
		if (min !== undefined) {
			if (onHand >= min) lowBase = undefined;
			else if (lowBase === undefined) lowBase = m.id;
		}
	}
	const value = average === undefined ? undefined : onHand <= 0n ? 0n : halfUp(onHand * average, 100_000n);
	return {
		item,
		onHand,
		...(average === undefined ? {} : { average }),
		...(value === undefined ? {} : { value }),
		negative: negativeSince !== undefined,
		...(negativeSince === undefined ? {} : { negativeSince }),
		...(lowBase === undefined ? {} : { lowBase, lowSince: `${lowBase}@${item.min}` }),
		...(lastCarico === undefined ? {} : { lastCarico }),
		moves,
	};
}

/** Sottoscorta: under its minimum (or in negativo). */
export const isLow = (s: ItemState): boolean => s.lowSince !== undefined || s.negative;

/** The list's order: in negativo first, then sottoscorta, by how far under; then the rest by name. */
export function lowFirst(states: readonly ItemState[]): ItemState[] {
	const gap = (s: ItemState) => (s.item.min === undefined ? 0n : qtyOf(s.item.min) - s.onHand);
	return [...states].sort((a, b) => Number(b.negative) - Number(a.negative) || Number(isLow(b)) - Number(isLow(a)) || (gap(b) > gap(a) ? 1 : gap(b) < gap(a) ? -1 : 0) || a.item.name.localeCompare(b.item.name, "it"));
}

/** `qty` packs of `size` units in units (thousandths), when it has at most 3 decimals; undefined otherwise. */
export function packUnits(qty: string, size: string): bigint | undefined {
	const n = scaled(qty, 3) * scaled(size, 3);
	return n % 1000n === 0n ? n / 1000n : undefined;
}

/**
 * A sale line's quantity in the article's units (thousandths): a line without a unit is in the
 * article's own; in its pack, so many each; in another unit it is not counted («unit»), nor in
 * packs that do not make a quantity to the thousandth («pack»), nor a quantity that does not
 * read («quantity»). The one rule the magazzino unloads by (stock-store.ts planSale) and the
 * margins count by.
 */
export function saleQuantity(item: Pick<StockItem, "unit" | "pack">, quantity: string, unit: string | undefined): { readonly qty: bigint } | { readonly why: "quantity" | "unit" | "pack" } {
	if (!/^\d{1,10}(?:\.\d{1,3})?$/.test(quantity) || Number(quantity) <= 0) return { why: "quantity" };
	const said = unit === undefined ? item.unit : stockUnit(unit);
	if (said === item.unit) return { qty: qtyOf(quantity) };
	if (item.pack === undefined || said !== item.pack.unit) return { why: "unit" };
	const qty = packUnits(quantity, item.pack.size);
	return qty === undefined ? { why: "pack" } : { qty };
}
