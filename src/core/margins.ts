/**
 * I margini: what each product and each client really earns, worked out only from data that is
 * already there, never stored. Revenue is the issued invoices' lines (sales-invoice-sums.ts
 * salesTotals: net of VAT, the line's discount already in; our invoices have no discount on the
 * whole document), less the credit notes'; the spese anticipate and the bollo are not revenue.
 * The cost of goods sold is the magazzino's average cost at each sale (stock-store.ts records it
 * on the scarico since week 71); a sale without one is estimated from the latest purchase price
 * (the invoices received, purchase-prices.ts, or a carico), and said so. Quantities are in the
 * article's units, converted only through its pack (stock-sums.ts saleQuantity); a line in
 * another unit is left out, and said. Hours billed are revenue with no cost. Forfettario or not,
 * the margins are the same: VAT is never in them.
 *
 * Trust and choices: a sale's `cost` is written only by stock-store.ts planSale from the
 * magazzino's own movements, so it is our own figure; it is a snapshot, and a later correction of
 * a carico's cost does not change past sales (said in the answer). A closed year keeps it on the
 * sale's key; a folded sale without one takes the apertura's average, as an estimate. A purchase
 * matched only by name (the same words both ways, never one inside the other, one product only)
 * is an estimate: never said as a loss.
 *
 * Amounts in bigint: cents for money, ten-thousandths of a euro for a unit cost or price,
 * thousandths for a quantity. A margin percent is in tenths, rounded down (floor), so 100% is
 * only a margin with no cost at all, and a loss is never rounded up to nothing.
 */
import { realDate } from "./italian-calendar.ts";
import { sameStems, spellingKey, spelledOut } from "./name-keys.ts";
import type { PriceItem } from "./price-list.ts";
import { productsOf, type PurchaseRow } from "./purchase-prices.ts";
import { eurosToCents, halfUp, halfUpSigned, netOf, scaled } from "./quote-sums.ts";
import { CREDIT_NOTE_TYPE } from "./sales-invoice-rules.ts";
import { salesTotals } from "./sales-invoice-sums.ts";
import { type IssuedInvoice, isIssued, type SalesInvoice } from "./sales-invoices.ts";
import { type CodeMap, type Movement, type SaleKey, STOCK_LIMITS, type StockItem, stockUnit, type UnitMap } from "./stock.ts";
import { costOf, qtyOf, saleQuantity } from "./stock-sums.ts";

export const MARGIN_OPS = ["product", "ranking", "client", "price_check", "what_if", "export"] as const;
export type MarginOp = (typeof MARGIN_OPS)[number];

export const MARGIN_LIMITS = {
	/** What the person says of a product or a client. */
	query: 120,
	/** The margin under which a voce is flagged, in percent, when the person says none. */
	threshold: 20,
	/** Products in each list of a ranking. */
	top: 5,
	/** Rows shown in one answer, before «e altri N». */
	shown: 15,
	/** Voci the brief says in one week, all briefs together: the rest is a count. */
	perWeek: 3,
	/** Voci said by the brief, remembered (the oldest go first). */
	alerts: 2000,
	fileBytes: 1024 * 1024,
} as const;

export class MarginError extends Error {
	override readonly name = "MarginError";
}

/** Where a sale's cost comes from: recorded at the sale (or, for a credit note, at the sale it corrects), estimated, or unknown. */
export type CostSource = "sale" | "purchase" | "none";

/** What a line is: goods (an article of the magazzino, or a voce whose purchases are known by name), a service voce (no cost), hours billed, anything else. */
export type LineKind = "goods" | "service" | "hours" | "other";

/** One line of an issued invoice or credit note, as the margins count it (a credit note's amounts negative). */
export type MarginLine = {
	readonly invoice: string;
	readonly number: string;
	readonly day: string;
	readonly credit: boolean;
	/** 1-based, as the magazzino keys a sale. */
	readonly line: number;
	readonly client: string;
	readonly clientName: string;
	readonly description: string;
	readonly kind: LineKind;
	readonly voce?: string;
	readonly article?: StockItem;
	/** The unit the quantity is in: the article's, or the voce's when no article. */
	readonly unit?: string;
	/** Thousandths of `unit`, signed: a credit note's is what its storno put back (0 when none). Undefined when the line's unit does not convert. */
	readonly qty?: bigint;
	/** Why a goods line is left out of its product's margin: its unit, its packs, its quantity; and the unit the line was in. */
	readonly unitWhy?: "quantity" | "unit" | "pack";
	readonly lineUnit?: string;
	/** Cents, net of VAT and of the line's discount; negative for a credit note. */
	readonly revenue: bigint;
	/** Cents, signed as the revenue; goods only, undefined when not known. */
	readonly cost?: bigint;
	readonly source?: CostSource;
	/** The unit cost it went out at (ten-thousandths), and, estimated, the purchase it comes from. */
	readonly unitCost?: bigint;
	readonly estimate?: Purchase;
	/** A credit note that put nothing back in the magazzino: revenue taken off, no cost given back. */
	readonly noReturn?: true;
	/** The recorded cost is from before a later correction of a carico's cost (a snapshot, kept). */
	readonly stale?: true;
	/** No estimate: several products bought have this name, and none is picked. */
	readonly ambiguous?: true;
	/** Hours: minutes billed (an invoice of the timesheet's entries puts them all on its first line), signed. */
	readonly minutes?: bigint;
};

/**
 * A purchase price per the unit counted (ten-thousandths), the day, and where it comes from: an
 * invoice received, a carico, or (a year closed) the apertura's average. `byName`: an invoice line
 * taken only because its description has the same words as the name, never a learned code.
 */
export type Purchase = { readonly cost: bigint; readonly day: string; readonly from: "invoice" | "carico" | "apertura"; readonly byName?: true };

/** What the margins read: the invoices issued, the magazzino (with the sales a closed year folded), the listino and the prices paid. */
export type MarginData = {
	readonly invoices: readonly SalesInvoice[];
	readonly items: readonly StockItem[];
	readonly moves: readonly Movement[];
	readonly archived: readonly SaleKey[];
	readonly codes: readonly CodeMap[];
	readonly units: readonly UnitMap[];
	readonly listino: readonly PriceItem[];
	readonly purchases: readonly PurchaseRow[];
};

/** The client's key: its card, else its partita IVA, codice fiscale, or its name as spelled. */
export function clientKey(inv: Pick<SalesInvoice, "buyer">): string {
	const b = inv.buyer;
	return b.card ?? (b.vat !== undefined ? `vat:${b.vat}` : b.cf !== undefined ? `cf:${b.cf}` : `name:${spellingKey(b.name)}`);
}

const HOUR_UNITS = new Set(["ora", "ore", "h"]);

const collapsed = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** What purchases are looked for: an article (its id, for the codes it learned and its carichi), or a voce with no article (name and unit only). */
export type Target = Pick<StockItem, "name" | "unit" | "pack"> & { readonly id?: string };

/** The purchase prices of a target, and whether a name matched several products (then no name match is used). */
export type Purchases = { readonly prices: readonly Purchase[]; readonly ambiguous: boolean };

/**
 * The purchase prices of `target` per its unit. An invoice line is it when the magazzino learned
 * its code or description for this article from that supplier; else only when its description
 * and the name have the same words both ways (name-keys.ts sameStems), never one inside the
 * other, and no other of `names` (the other articles and voci) has them too. Name matches that
 * make more than one product (another unit, another description) are `ambiguous`: none is
 * picked. In the target's unit, its pack, or a supplier's unit it learned; per line prices and
 * other units are left out. And the article's carichi at their cost (corrected when a costo fixed it).
 */
export function purchasesOf(target: Target, data: Pick<MarginData, "purchases" | "codes" | "units" | "moves">, names: readonly string[]): Purchases {
	const out: Purchase[] = [];
	const learnedFor = (r: PurchaseRow): string | undefined => {
		const code = r.code?.toLowerCase();
		const d = collapsed(spelledOut(r.description), STOCK_LIMITS.supplierText);
		return data.codes.find((c) => c.s === r.party && ((code !== undefined && c.c?.toLowerCase() === code) || (c.d !== undefined && c.d === d)))?.i;
	};
	const perUnit = (r: PurchaseRow): bigint | undefined => {
		if (r.unit === undefined || r.unit === target.unit) return halfUp(r.price, 10_000n);
		if (target.pack !== undefined && r.unit === target.pack.unit) return halfUp(r.price * 1000n, qtyOf(target.pack.size) * 10_000n);
		const map = target.id === undefined ? undefined : data.units.find((u) => u.s === r.party && u.u === r.unit && u.i === target.id);
		return map === undefined ? undefined : halfUp(r.price * 1000n, qtyOf(map.q) * 10_000n);
	};
	const byName: PurchaseRow[] = [];
	let ambiguous = false;
	for (const r of data.purchases) {
		if (r.perLine) continue;
		const learned = learnedFor(r);
		if (learned !== undefined) {
			if (learned !== target.id) continue;
			const cost = perUnit(r);
			if (cost !== undefined && cost > 0n) out.push({ cost, day: r.day, from: "invoice" });
			continue;
		}
		if (!sameStems(target.name, r.description)) continue;
		if (names.filter((n) => sameStems(n, r.description)).length > 1) {
			ambiguous = true;
			continue;
		}
		byName.push(r);
	}
	if (productsOf(byName).length > 1) ambiguous = true;
	else
		for (const r of byName) {
			const cost = perUnit(r);
			if (cost !== undefined && cost > 0n) out.push({ cost, day: r.day, from: "invoice", byName: true });
		}
	if (target.id !== undefined) {
		const mine = data.moves.filter((m) => m.item === target.id);
		const fixed = new Map<string, string>();
		for (const m of mine) if (m.kind === "costo" && m.fixes !== undefined && m.cost !== undefined) fixed.set(m.fixes, m.cost);
		for (const m of mine) if (m.kind === "carico" && m.cost !== undefined) out.push({ cost: costOf(fixed.get(m.id) ?? m.cost), day: m.day, from: "carico" });
	}
	return { prices: out, ambiguous };
}

/** The purchase price for a sale on `day`: the latest on or before it (learned before by name, an invoice before a carico the same day), else the first after it. */
export function purchaseAt(prices: readonly Purchase[], day: string): Purchase | undefined {
	const rank = (p: Purchase) => (p.byName === true ? 0 : 2) + (p.from === "invoice" ? 1 : 0);
	const before = prices.filter((p) => p.day <= day).sort((a, b) => a.day.localeCompare(b.day) || rank(a) - rank(b));
	if (before.length > 0) return before[before.length - 1];
	return [...prices].sort((a, b) => a.day.localeCompare(b.day) || rank(b) - rank(a))[0];
}

/** The article a voce is: the one on the list, else one taken off it. */
function articleOf(items: readonly StockItem[], voce: string): StockItem | undefined {
	return items.find((i) => i.removed === undefined && i.listino === voce) ?? items.find((i) => i.listino === voce);
}

/** The names purchases may match by: the articles' and the voci's (one per voce linked to an article). */
function namesOf(data: Pick<MarginData, "items" | "listino">): string[] {
	const linked = new Set(data.items.map((i) => i.listino).filter((l) => l !== undefined));
	return [...data.items.filter((i) => i.removed === undefined).map((i) => i.name), ...data.listino.filter((v) => !linked.has(v.id)).map((v) => v.name)];
}

/** A unit cost from scarichi, weighted by their quantities; undefined when one has no cost. */
function weighted(out: readonly { qty: bigint; cost?: string }[]): bigint | undefined {
	if (out.length === 0 || out.some((o) => o.cost === undefined)) return undefined;
	const qty = out.reduce((s, o) => s + o.qty, 0n);
	return qty <= 0n ? undefined : halfUp(out.reduce((s, o) => s + o.qty * costOf(o.cost as string), 0n), qty);
}

/**
 * The lines of the invoices and credit notes issued from `from` to `to` (their date), each as the
 * margins count it. A sale's cost: recorded on its scarico (or kept by a closed year), else for a
 * folded one the apertura's average, else the latest purchase price, as an estimate. A credit
 * note gives back the cost of what its storno put back, at the cost the corrected invoice's
 * scarico went out at (the same line first, else all of that article's, weighted); without a
 * storno it gives back no cost.
 */
export function marginLines(data: MarginData, from: string, to: string): MarginLine[] {
	const out: MarginLine[] = [];
	const names = namesOf(data);
	const cache = new Map<string, Purchases>();
	const pricesOf = (t: Target, key: string) => {
		const got = cache.get(key) ?? purchasesOf(t, data, names);
		cache.set(key, got);
		return got;
	};
	const aperturaOf = (a: StockItem): Purchase | undefined => {
		const m = data.moves.find((x) => x.item === a.id && x.kind === "apertura" && x.cost !== undefined);
		return m === undefined ? undefined : { cost: costOf(m.cost as string), day: m.day, from: "apertura" };
	};
	const issued = data.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.date >= from && i.date <= to);
	for (const inv of issued) {
		const credit = inv.type === CREDIT_NOTE_TYPE;
		const sign = credit ? -1n : 1n;
		const amounts = salesTotals(inv).amounts;
		const hoursInvoice = (inv.hours ?? []).length > 0;
		const billed = BigInt((inv.hours ?? []).reduce((n, h) => n + h.minutes, 0));
		let firstHours = true;
		inv.lines.forEach((l, n) => {
			// A spesa anticipata is the client's money back, not revenue.
			if (l.notFee === true) return;
			const base = { invoice: inv.id, number: inv.number, day: inv.date, credit, line: n + 1, client: clientKey(inv), clientName: inv.buyer.name, description: l.description, revenue: sign * (amounts[n] as bigint) };
			// A fattura differita's line: the goods went out with its DDT, whose scarico holds the cost.
			const from = l.ddt === undefined ? { invoice: inv.id, line: n + 1 } : { invoice: l.ddt.id, line: l.ddt.line };
			const key = `${from.invoice}#${from.line}`;
			const move = data.moves.find((m) => m.sale?.invoice === from.invoice && m.sale.line === from.line);
			const folded = move === undefined ? data.archived.find((a) => a.k === key) : undefined;
			const moved = move?.item ?? folded?.i;
			const article = l.item === undefined ? undefined : moved !== undefined ? data.items.find((i) => i.id === moved) : articleOf(data.items, l.item);
			if (l.item !== undefined && article !== undefined) {
				const read = saleQuantity(article, l.quantity, l.unit);
				const goods = { ...base, kind: "goods" as const, voce: l.item, article, unit: article.unit };
				if ("why" in read) {
					out.push({ ...goods, unitWhy: read.why, lineUnit: l.unit ?? article.unit });
					return;
				}
				if (credit) {
					const back = move?.kind === "storno" ? qtyOf(move.qty) : folded?.of !== undefined ? qtyOf(folded.q) : undefined;
					if (back === undefined || back === 0n) {
						out.push({ ...goods, qty: 0n, cost: 0n, source: "sale", noReturn: true });
						return;
					}
					// A credit note for goods back with a DDT di reso: the cost of the DDT they went out with.
					const of = l.ddt !== undefined && move?.kind === "storno" ? move.sale?.of : inv.related?.id;
					const outs = of === undefined ? [] : [...data.moves.filter((m) => m.kind === "scarico" && m.item === article.id && m.sale?.invoice === of).map((m) => ({ line: m.sale?.line, qty: qtyOf(m.qty), ...(m.cost === undefined ? {} : { cost: m.cost }) })), ...data.archived.filter((a) => a.i === article.id && a.of === undefined && a.k.startsWith(`${of}#`)).map((a) => ({ line: Number(a.k.split("#")[1]), qty: qtyOf(a.q), ...(a.c === undefined ? {} : { cost: a.c }) }))];
					const same = l.ddt !== undefined ? [] : outs.filter((o) => o.line === n + 1);
					const unitCost = weighted(same.length > 0 ? same : outs);
					const qty = -back;
					if (unitCost !== undefined) {
						out.push({ ...goods, qty, cost: halfUpSigned(qty * unitCost, 100_000n), source: "sale", unitCost });
						return;
					}
					const when = inv.related !== undefined && realDate(inv.related.date) ? inv.related.date : inv.date;
					const p = pricesOf(article, article.id);
					const estimate = purchaseAt(p.prices, when);
					out.push(estimate === undefined ? { ...goods, qty, source: "none", ...(p.ambiguous ? { ambiguous: true as const } : {}) } : { ...goods, qty, cost: halfUpSigned(qty * estimate.cost, 100_000n), source: "purchase", unitCost: estimate.cost, estimate });
					return;
				}
				const qty = read.qty;
				const recorded = move?.kind === "scarico" ? move.cost : folded?.c;
				if (recorded !== undefined) {
					const unitCost = costOf(recorded);
					// A correction of an earlier carico's cost made after the sale: the recorded cost is a snapshot.
					const stale = move !== undefined && data.moves.some((m) => m.kind === "costo" && m.item === article.id && m.id > move.id && m.fixes !== undefined && m.fixes < move.id);
					out.push({ ...goods, qty, cost: halfUpSigned(qty * unitCost, 100_000n), source: "sale", unitCost, ...(stale ? { stale: true as const } : {}) });
					return;
				}
				const p = pricesOf(article, article.id);
				const estimate = (folded !== undefined ? aperturaOf(article) : undefined) ?? purchaseAt(p.prices, inv.date);
				out.push(estimate === undefined ? { ...goods, qty, source: "none", ...(p.ambiguous ? { ambiguous: true as const } : {}) } : { ...goods, qty, cost: halfUpSigned(qty * estimate.cost, 100_000n), source: "purchase", unitCost: estimate.cost, estimate });
				return;
			}
			if (l.item !== undefined) {
				// A voce with no article: a cost only from purchases with its very name, as an estimate.
				const voce = data.listino.find((v) => v.id === l.item);
				const target: Target | undefined = voce === undefined ? undefined : { name: voce.name, unit: stockUnit(voce.unit ?? l.unit ?? "pezzo") };
				const read = target === undefined ? undefined : saleQuantity(target, l.quantity, l.unit);
				const p = target === undefined || read === undefined || "why" in read ? undefined : pricesOf(target, `voce:${l.item}`);
				const estimate = p === undefined ? undefined : purchaseAt(p.prices, credit && inv.related !== undefined && realDate(inv.related.date) ? inv.related.date : inv.date);
				if (target !== undefined && read !== undefined && !("why" in read) && estimate !== undefined) {
					const goods = { ...base, kind: "goods" as const, voce: l.item, unit: target.unit };
					// A credit note of a voce with no magazzino puts nothing back: no cost given back.
					if (credit) out.push({ ...goods, qty: 0n, cost: 0n, source: "sale", noReturn: true });
					else out.push({ ...goods, qty: read.qty, cost: halfUpSigned(read.qty * estimate.cost, 100_000n), source: "purchase", unitCost: estimate.cost, estimate });
					return;
				}
				out.push({ ...base, kind: "service", voce: l.item });
				return;
			}
			if (hoursInvoice) {
				out.push({ ...base, kind: "hours", minutes: firstHours ? sign * billed : 0n });
				firstHours = false;
				return;
			}
			if (l.unit !== undefined && HOUR_UNITS.has(l.unit.trim().toLowerCase()) && /^\d{1,10}(?:\.\d{1,3})?$/.test(l.quantity)) {
				out.push({ ...base, kind: "hours", minutes: sign * halfUp(scaled(l.quantity, 3) * 60n, 1000n) });
				return;
			}
			out.push({ ...base, kind: "other" });
		});
	}
	return out;
}

/** A margin percent in tenths, rounded down (a loss away from zero); undefined without revenue. 1000 only when there is no cost. */
export function marginTenths(margin: bigint, revenue: bigint): bigint | undefined {
	if (revenue <= 0n) return undefined;
	const n = margin * 1000n;
	const q = n / revenue;
	return n < 0n && q * revenue !== n ? q - 1n : q;
}

/** One voce's figures over a period. */
export type ProductMargin = {
	readonly voce: string;
	/** The voce's name, or the first line's description when the voce is gone from the listino. */
	readonly name: string;
	readonly article?: StockItem;
	/** The unit the quantity is in (goods). */
	readonly unit?: string;
	/** The lines counted: goods with a unit that converts and a cost (recorded or estimated); a service voce's all. */
	readonly lines: readonly MarginLine[];
	/** Thousandths of `unit` (goods); undefined for a service voce. */
	readonly qty?: bigint;
	readonly revenue: bigint;
	/** Goods only. */
	readonly cost?: bigint;
	readonly margin?: bigint;
	readonly tenths?: bigint;
	/** Lines whose cost is estimated, and of them those by a name match only. */
	readonly estimated: number;
	readonly byName: number;
	/** Credit notes that put nothing back; sales whose recorded cost a later correction did not change. */
	readonly noReturn: number;
	readonly stale: number;
	/** Goods lines left out: their unit does not convert (with the units), or no cost is known (`ambiguous` of them: several products bought by that name); their revenue. */
	readonly badUnit: number;
	readonly badUnits: readonly string[];
	readonly noCost: number;
	readonly ambiguous: number;
	readonly leftOut: bigint;
};

/** The voci sold, each with its margin (goods) or only its revenue (a service voce). */
export function productMargins(lines: readonly MarginLine[], listino: readonly PriceItem[]): ProductMargin[] {
	const by = new Map<string, MarginLine[]>();
	for (const l of lines) if (l.voce !== undefined && (l.kind === "goods" || l.kind === "service")) by.set(l.voce, [...(by.get(l.voce) ?? []), l]);
	const out: ProductMargin[] = [];
	const none = { estimated: 0, byName: 0, noReturn: 0, stale: 0, badUnit: 0, badUnits: [], noCost: 0, ambiguous: 0, leftOut: 0n };
	for (const [voce, all] of by) {
		const name = listino.find((i) => i.id === voce)?.name ?? (all[0] as MarginLine).description;
		const goodsLines = all.filter((l) => l.kind === "goods");
		if (goodsLines.length === 0) {
			out.push({ voce, name, lines: all, revenue: all.reduce((s, l) => s + l.revenue, 0n), ...none });
			continue;
		}
		const article = goodsLines.find((l) => l.article !== undefined)?.article;
		const unit = goodsLines.find((l) => l.unit !== undefined)?.unit;
		// A service line of a voce otherwise estimated has no cost: it is left out like one with none.
		const counted = goodsLines.filter((l) => l.qty !== undefined && l.cost !== undefined);
		const left = all.filter((l) => !counted.includes(l));
		const revenue = counted.reduce((s, l) => s + l.revenue, 0n);
		const cost = counted.reduce((s, l) => s + (l.cost as bigint), 0n);
		const margin = revenue - cost;
		const tenths = marginTenths(margin, revenue);
		out.push({
			voce,
			name,
			...(article === undefined ? {} : { article }),
			...(unit === undefined ? {} : { unit }),
			lines: counted,
			qty: counted.reduce((s, l) => s + (l.qty as bigint), 0n),
			revenue,
			cost,
			margin,
			...(tenths === undefined ? {} : { tenths }),
			estimated: counted.filter((l) => l.source === "purchase").length,
			byName: counted.filter((l) => l.estimate?.byName === true).length,
			noReturn: counted.filter((l) => l.noReturn === true).length,
			stale: counted.filter((l) => l.stale === true).length,
			badUnit: left.filter((l) => l.unitWhy !== undefined).length,
			badUnits: [...new Set(left.flatMap((l) => (l.unitWhy === "unit" && l.lineUnit !== undefined ? [l.lineUnit] : [])))],
			noCost: left.filter((l) => l.unitWhy === undefined).length,
			ambiguous: left.filter((l) => l.ambiguous === true).length,
			leftOut: left.reduce((s, l) => s + l.revenue, 0n),
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name, "it"));
}

/** Goods with a margin: counted lines and revenue. */
export type RankedProduct = ProductMargin & { readonly unit: string; readonly margin: bigint; readonly cost: bigint; readonly qty: bigint };

export const ranked = (p: ProductMargin): p is RankedProduct => p.unit !== undefined && p.margin !== undefined && p.lines.length > 0;

/** A loss that rests on a cost guessed from a name only: said as an estimate, never as a loss. */
export const guessed = (p: ProductMargin): boolean => p.byName > 0;

const byBig = (a: bigint, b: bigint) => (a > b ? 1 : a < b ? -1 : 0);

/** The ranking: by margin in euros and in percent, top and bottom, those sold at a loss (the biggest first) and those that may be, on a cost from a name only. */
export function rankingOf(products: readonly ProductMargin[], top: number = MARGIN_LIMITS.top) {
	const goods = products.filter(ranked);
	const withPercent = goods.filter((p) => p.tenths !== undefined);
	const byEuro = [...goods].sort((a, b) => byBig(b.margin, a.margin) || a.name.localeCompare(b.name, "it"));
	const byPercent = [...withPercent].sort((a, b) => byBig(b.tenths as bigint, a.tenths as bigint) || byBig(b.margin, a.margin) || a.name.localeCompare(b.name, "it"));
	const under = byEuro.filter((p) => p.margin < 0n).reverse();
	return {
		goods,
		bestEuro: byEuro.slice(0, top),
		worstEuro: [...byEuro].reverse().slice(0, top),
		bestPercent: byPercent.slice(0, top),
		worstPercent: [...byPercent].reverse().slice(0, top),
		losses: under.filter((p) => !guessed(p)),
		maybeLosses: under.filter(guessed),
	};
}

/** One client's figures over a period. */
export type ClientMargin = {
	readonly key: string;
	readonly name: string;
	readonly revenue: bigint;
	/** Goods sold with a known cost: their revenue and cost. */
	readonly goodsRevenue: bigint;
	readonly goodsCost: bigint;
	/** Goods without a known cost (or in a unit that does not convert): counted as revenue, at no cost. */
	readonly goodsUnknown: number;
	readonly goodsUnknownRevenue: bigint;
	readonly hoursRevenue: bigint;
	readonly minutes: bigint;
	/** The hours at the cost the person said for this answer, in cents. */
	readonly hoursCost: bigint;
	readonly otherRevenue: bigint;
	readonly cost: bigint;
	readonly margin: bigint;
	readonly tenths?: bigint;
	readonly estimated: number;
	/** The client's names as the invoices write them, the latest first; tax ids and the card for finding it. */
	readonly names: readonly string[];
	readonly vat?: string;
	readonly cf?: string;
	readonly card?: string;
};

/** Per client: revenue, the cost of the goods, the hours (at `hourCost` cents an hour, when said) and the margin; the biggest margin first. */
export function clientMargins(lines: readonly MarginLine[], invoices: readonly SalesInvoice[], hourCost?: bigint): ClientMargin[] {
	const by = new Map<string, MarginLine[]>();
	for (const l of lines) by.set(l.client, [...(by.get(l.client) ?? []), l]);
	const out: ClientMargin[] = [];
	for (const [key, all] of by) {
		const goods = all.filter((l) => l.kind === "goods");
		const known = goods.filter((l) => l.cost !== undefined && l.qty !== undefined);
		const unknown = goods.filter((l) => !known.includes(l));
		const hours = all.filter((l) => l.kind === "hours");
		const minutes = hours.reduce((s, l) => s + (l.minutes ?? 0n), 0n);
		const hoursCost = hourCost === undefined ? 0n : halfUpSigned(minutes * hourCost, 60n);
		const revenue = all.reduce((s, l) => s + l.revenue, 0n);
		const goodsCost = known.reduce((s, l) => s + (l.cost as bigint), 0n);
		const cost = goodsCost + hoursCost;
		const margin = revenue - cost;
		const tenths = marginTenths(margin, revenue);
		const mine = invoices.filter((i) => isIssued(i) && clientKey(i) === key).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
		const latest = mine[0]?.buyer;
		out.push({
			key,
			name: latest?.name ?? (all[0] as MarginLine).clientName,
			revenue,
			goodsRevenue: known.reduce((s, l) => s + l.revenue, 0n),
			goodsCost,
			goodsUnknown: unknown.length,
			goodsUnknownRevenue: unknown.reduce((s, l) => s + l.revenue, 0n),
			hoursRevenue: hours.reduce((s, l) => s + l.revenue, 0n),
			minutes,
			hoursCost,
			otherRevenue: all.filter((l) => l.kind === "other" || l.kind === "service").reduce((s, l) => s + l.revenue, 0n),
			cost,
			margin,
			...(tenths === undefined ? {} : { tenths }),
			estimated: known.filter((l) => l.source === "purchase").length,
			names: [...new Set(mine.map((i) => i.buyer.name))],
			...(latest?.vat === undefined ? {} : { vat: latest.vat }),
			...(latest?.cf === undefined ? {} : { cf: latest.cf }),
			...(latest?.card === undefined ? {} : { card: latest.card }),
		});
	}
	return out.sort((a, b) => byBig(b.margin, a.margin) || a.name.localeCompare(b.name, "it"));
}

/** A voce's price per the article's unit (ten-thousandths), net of VAT: in its unit or its pack; undefined in another unit. */
export function listPricePerUnit(voce: PriceItem, article: StockItem): bigint | undefined {
	const cents = voce.includesVat === true ? netOf(eurosToCents(voce.price), voce.vat) : eurosToCents(voce.price);
	const unit = voce.unit === undefined ? article.unit : stockUnit(voce.unit);
	if (unit === article.unit) return cents * 100n;
	if (article.pack !== undefined && unit === article.pack.unit) return halfUp(cents * 100n * 1000n, qtyOf(article.pack.size));
	return undefined;
}

/** A listino voce linked to an article, against what it costs now. */
export type PriceCheck = {
	readonly voce: PriceItem;
	readonly article: StockItem;
	/** Per the article's unit, ten-thousandths; undefined when the voce's unit is not the article's nor its pack. */
	readonly price?: bigint;
	readonly average?: bigint;
	readonly latest?: Purchase;
	/** The cost the margin is at: the average, else the latest purchase price. */
	readonly basis?: "average" | "latest";
	readonly tenths?: bigint;
	/** At a loss, under the threshold, or either on a cost from a name only («estimate»: never said as a loss). */
	readonly flag?: "loss" | "low" | "estimate";
	/** The listino's price (in its own unit, with VAT when it is said with VAT, cents) that brings the margin back to the threshold. */
	readonly restore?: bigint;
	/** Flagged, with a cost, yet no price restores the threshold (its search gave up): said, never left out. */
	readonly restoreFailed?: true;
};

/**
 * The lowest listino price, in cents of the voce's own unit (with VAT when the voce is said with
 * it), whose margin at `cost` is the threshold or more: rounded up, never down.
 */
export function restorePrice(voce: PriceItem, article: StockItem, cost: bigint, threshold: bigint): bigint | undefined {
	if (threshold >= 1000n) return undefined;
	const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
	const perUnit = ceil(cost * 1000n, 1000n - threshold);
	const unit = voce.unit === undefined ? article.unit : stockUnit(voce.unit);
	const inUnit = unit === article.unit ? perUnit : article.pack !== undefined && unit === article.pack.unit ? ceil(perUnit * qtyOf(article.pack.size), 1000n) : undefined;
	if (inUnit === undefined) return undefined;
	const net = ceil(inUnit, 100n);
	let cents = voce.includesVat === true ? ceil(net * BigInt(100 + voce.vat), 100n) : net;
	// The listino's own rounding (VAT out, the pack's size) may take a cent off: up until it holds.
	for (let n = 0; n < 1000; n++) {
		const price = listPricePerUnit({ ...voce, price: centsText(cents) }, article);
		const t = price === undefined ? undefined : marginTenths(price - cost, price);
		if (t !== undefined && t >= threshold) return cents;
		cents += 1n;
	}
	return undefined;
}

/** Cents as the listino keeps a price: «5.63», «6». */
const centsText = (c: bigint) => `${c / 100n}${c % 100n === 0n ? "" : `.${String(c % 100n).padStart(2, "0")}`.replace(/0$/, "")}`;

/**
 * Each voce that is an article on the list: its price per the article's unit, the average cost
 * now and the latest purchase price; flagged when its margin at the cost now (the average, else
 * the latest purchase) is negative («loss») or under `threshold` tenths of a percent («low»), with
 * the price that restores the threshold. On a purchase matched by its name only, it is an
 * «estimate», never a loss. Flagged first (the worst first), then by name.
 */
export function priceChecks(data: Pick<MarginData, "listino" | "items" | "moves" | "purchases" | "codes" | "units">, averages: ReadonlyMap<string, bigint>, today: string, threshold: bigint): PriceCheck[] {
	const out: PriceCheck[] = [];
	const names = namesOf(data);
	for (const voce of data.listino) {
		const article = data.items.find((i) => i.removed === undefined && i.listino === voce.id);
		if (article === undefined) continue;
		const price = listPricePerUnit(voce, article);
		const average = averages.get(article.id);
		const latest = purchaseAt(purchasesOf(article, data, names).prices, today);
		const cost = average ?? latest?.cost;
		const basis = average !== undefined ? "average" : latest !== undefined ? "latest" : undefined;
		const tenths = price === undefined || cost === undefined ? undefined : marginTenths(price - cost, price);
		const under = tenths !== undefined && tenths < threshold;
		const flag = !under ? undefined : basis === "latest" && latest?.byName === true ? "estimate" : (tenths as bigint) < 0n ? "loss" : "low";
		const tries = under && cost !== undefined && flag !== "estimate";
		const restore = tries ? restorePrice(voce, article, cost, threshold) : undefined;
		const restoreFailed = tries && restore === undefined;
		out.push({ voce, article, ...(price === undefined ? {} : { price }), ...(average === undefined ? {} : { average }), ...(latest === undefined ? {} : { latest }), ...(basis === undefined ? {} : { basis }), ...(tenths === undefined ? {} : { tenths }), ...(flag === undefined ? {} : { flag }), ...(restore === undefined ? {} : { restore }), ...(restoreFailed ? { restoreFailed: true as const } : {}) });
	}
	const rank = (c: PriceCheck) => (c.flag === "loss" ? 0 : c.flag === "low" ? 1 : c.flag === "estimate" ? 2 : 3);
	return out.sort((a, b) => rank(a) - rank(b) || (a.flag !== undefined ? byBig(a.tenths as bigint, b.tenths as bigint) : 0) || a.voce.name.localeCompare(b.voce.name, "it"));
}

/** A change of a simulation: by hundredths of a percent (signed), or to an amount per the article's unit (ten-thousandths). */
export type Change = { readonly percent: bigint } | { readonly to: bigint };

/** What a simulation gives: the margin as it was and as it would be, on the same quantities. */
export type WhatIf = {
	readonly qty: bigint;
	readonly revenue: bigint;
	readonly cost: bigint;
	readonly margin: bigint;
	readonly tenths?: bigint;
	readonly newRevenue: bigint;
	readonly newCost: bigint;
	readonly newMargin: bigint;
	readonly newTenths?: bigint;
	/** Per unit (ten-thousandths), the average of the quantities sold: the price and the cost before and after; undefined with no quantity. */
	readonly unitPrice?: bigint;
	readonly newUnitPrice?: bigint;
	readonly unitCost?: bigint;
	readonly newUnitCost?: bigint;
};

const changed = (amount: bigint, qty: bigint, c: Change) => ("percent" in c ? amount + halfUpSigned(amount * c.percent, 10_000n) : halfUpSigned(qty * c.to, 100_000n));

/** The product's margin again with its price or its cost changed, on the quantities it sold: nothing changes anywhere. */
export function whatIf(p: RankedProduct, change: { readonly price?: Change; readonly cost?: Change }): WhatIf {
	const newRevenue = change.price === undefined ? p.revenue : changed(p.revenue, p.qty, change.price);
	const newCost = change.cost === undefined ? p.cost : changed(p.cost, p.qty, change.cost);
	const newMargin = newRevenue - newCost;
	const tenths = marginTenths(p.margin, p.revenue);
	const newTenths = marginTenths(newMargin, newRevenue);
	const per = (cents: bigint) => (p.qty <= 0n ? undefined : halfUpSigned(cents * 100_000n, p.qty));
	const units = { unitPrice: per(p.revenue), newUnitPrice: per(newRevenue), unitCost: per(p.cost), newUnitCost: per(newCost) };
	const defined = Object.fromEntries(Object.entries(units).filter(([, v]) => v !== undefined)) as Partial<Record<keyof typeof units, bigint>>;
	return { qty: p.qty, revenue: p.revenue, cost: p.cost, margin: p.margin, ...(tenths === undefined ? {} : { tenths }), newRevenue, newCost, newMargin, ...(newTenths === undefined ? {} : { newTenths }), ...defined };
}

/** A voce said by the brief in a week: the voce, the week's Monday, the call that said it. */
export type MarginClaim = { readonly v: string; readonly week: string; readonly call: string };

export function validMarginClaim(v: unknown): v is MarginClaim {
	if (typeof v !== "object" || v === null) return false;
	const c = v as MarginClaim;
	return Object.keys(c).every((k) => ["v", "week", "call"].includes(k)) && typeof c.v === "string" && /^LS-\d{4,7}$/.test(c.v) && typeof c.week === "string" && realDate(c.week) && typeof c.call === "string" && c.call.length > 0 && c.call.length <= 200;
}

/** Everything reads but the export (a file) and the brief's line (compact), which only marks its voci as said: they run in a brief's thread. */
export function marginCallReads(args: Record<string, unknown>): boolean {
	return args.op !== "export" && MARGIN_OPS.some((o) => o === args.op);
}
