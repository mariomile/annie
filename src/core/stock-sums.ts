/**
 * Il magazzino's figures, all from the movements in their order (stock.ts): what is on hand, the
 * weighted average cost, the value, whether an article is «in negativo» (a scarico past what
 * there was, until a count) and since when it is sottoscorta (the crossing the brief says once).
 * Quantities in bigint thousandths, a unit cost in ten-thousandths of a euro, a value in cents.
 */
import { halfUp, scaled, scaledDecimal } from "./quote-sums.ts";
import type { Movement, StockItem } from "./stock.ts";

/** Thousandths of a unit. */
export const qtyOf = (q: string): bigint => (q.startsWith("-") ? -scaled(q.slice(1), 3) : scaled(q, 3));

/** Thousandths back to a canonical decimal, the sign kept. */
export const qtyText = (n: bigint): string => (n < 0n ? `-${scaledDecimal(-n, 3)}` : scaledDecimal(n, 3));

/** A unit cost in ten-thousandths of a euro. */
export const costOf = (c: string): bigint => scaled(c, 4);

export type ItemState = {
	readonly item: StockItem;
	/** Thousandths on hand. */
	readonly onHand: bigint;
	/** The weighted average cost, ten-thousandths of a euro per unit; undefined before the first carico. */
	readonly average?: bigint;
	/** onHand × average in cents (0 when there is nothing or the article is in negativo); undefined without a cost. */
	readonly value?: bigint;
	/** A scarico took it under zero and no count came after. */
	readonly negative: boolean;
	/** The crossing it is sottoscorta since (the movement that took it under the minimum, with the minimum); undefined when it is not. */
	readonly lowSince?: string;
	readonly moves: readonly Movement[];
};

const delta = (m: Movement): bigint => {
	switch (m.kind) {
		case "carico":
		case "storno":
			return qtyOf(m.qty);
		case "scarico":
			return -qtyOf(m.qty);
		case "rettifica":
			return qtyOf(m.qty);
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
	const min = item.min === undefined ? undefined : qtyOf(item.min);
	let onHand = 0n;
	let average: bigint | undefined;
	let negative = false;
	// Under the minimum from the start (an article added with nothing), until a movement takes it back up.
	let lowSince: string | undefined = min !== undefined && 0n < min ? `${item.id}@${item.min}` : undefined;
	for (const m of moves) {
		const d = delta(m);
		if (m.kind === "carico") average = averageAfter(onHand, average, d, costOf(m.cost as string));
		onHand += d;
		if (m.kind === "rettifica") negative = false;
		if (onHand < 0n) negative = true;
		if (min !== undefined) {
			if (onHand >= min) lowSince = undefined;
			else if (lowSince === undefined) lowSince = `${m.id}@${item.min}`;
		}
	}
	const value = average === undefined ? undefined : onHand <= 0n ? 0n : halfUp(onHand * average, 100_000n);
	return { item, onHand, ...(average === undefined ? {} : { average }), ...(value === undefined ? {} : { value }), negative, ...(lowSince === undefined ? {} : { lowSince }), moves };
}

/** Sottoscorta: under its minimum (or in negativo). */
export const isLow = (s: ItemState): boolean => s.lowSince !== undefined || s.negative;

/** The list's order: in negativo first, then sottoscorta, by how far under; then the rest by name. */
export function lowFirst(states: readonly ItemState[]): ItemState[] {
	const gap = (s: ItemState) => (s.item.min === undefined ? 0n : qtyOf(s.item.min) - s.onHand);
	return [...states].sort((a, b) => Number(b.negative) - Number(a.negative) || Number(isLow(b)) - Number(isLow(a)) || (gap(b) > gap(a) ? 1 : gap(b) < gap(a) ? -1 : 0) || a.item.name.localeCompare(b.item.name, "it"));
}
