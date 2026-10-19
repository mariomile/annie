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
 * Amounts in bigint: cents for money, ten-thousandths of a euro for a unit cost or price,
 * thousandths for a quantity. A margin percent is in tenths, rounded down (floor), so 100% is
 * only a margin with no cost at all, and a loss is never rounded up to nothing.
 */
import { realDate } from "./italian-calendar.ts";
import { spellingKey, spelledOut } from "./name-keys.ts";
import type { PriceItem } from "./price-list.ts";
import { type PurchaseRow, rowMatches } from "./purchase-prices.ts";
import { eurosToCents, halfUp, halfUpSigned, netOf, scaled } from "./quote-sums.ts";
import { CREDIT_NOTE_TYPE } from "./sales-invoice-rules.ts";
import { salesTotals } from "./sales-invoice-sums.ts";
import { type IssuedInvoice, isIssued, type SalesInvoice } from "./sales-invoices.ts";
import { type CodeMap, type Movement, STOCK_LIMITS, type StockItem, stockUnit, type UnitMap } from "./stock.ts";
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

/** Where a sale's cost comes from: recorded at the sale, estimated from the latest purchase, or unknown. */
export type CostSource = "sale" | "purchase" | "none";

/** What a line is: goods (a voce that is an article of the magazzino), a service voce (no article), hours billed, anything else. */
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
	/** Thousandths of the article's unit (goods), signed; undefined when the line's unit does not convert. */
	readonly qty?: bigint;
	/** Why a goods line is left out of its product's margin: its unit, its packs, its quantity. */
	readonly unitWhy?: "quantity" | "unit" | "pack";
	/** Cents, net of VAT and of the line's discount; negative for a credit note. */
	readonly revenue: bigint;
	/** Cents, signed as the revenue; goods only, undefined when not known. */
	readonly cost?: bigint;
	readonly source?: CostSource;
	/** The unit cost it went out at (ten-thousandths), and, estimated, the purchase it comes from. */
	readonly unitCost?: bigint;
	readonly estimate?: Purchase;
	/** Hours: minutes billed (an invoice of the timesheet's entries puts them all on its first line), signed. */
	readonly minutes?: bigint;
};

/** A purchase price for an article: per its unit (ten-thousandths), the day, and whether an invoice received or a carico says it. */
export type Purchase = { readonly cost: bigint; readonly day: string; readonly from: "invoice" | "carico" };

/** What the margins read: the invoices issued, the magazzino, the listino and the prices paid. */
export type MarginData = {
	readonly invoices: readonly SalesInvoice[];
	readonly items: readonly StockItem[];
	readonly moves: readonly Movement[];
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

/**
 * The purchase prices of `article` per its unit: the lines of invoices received that are it (a
 * code or description the magazzino learned for it from that supplier, its own code, or its name
 * in the description and not learned for another article), in its unit, in its pack, or in a
 * supplier's unit it learned; and its carichi at their cost (corrected when a costo fixed it).
 * Per line prices and other units are left out.
 */
export function purchasesOf(article: StockItem, data: Pick<MarginData, "purchases" | "codes" | "units" | "moves">): Purchase[] {
	const out: Purchase[] = [];
	const learnedFor = (r: PurchaseRow): string | undefined => {
		const code = r.code?.toLowerCase();
		const d = collapsed(spelledOut(r.description), STOCK_LIMITS.supplierText);
		return data.codes.find((c) => c.s === r.party && ((code !== undefined && c.c?.toLowerCase() === code) || (c.d !== undefined && c.d === d)))?.i;
	};
	for (const r of data.purchases) {
		if (r.perLine) continue;
		const learned = learnedFor(r);
		const own = article.code !== undefined && r.code !== undefined && r.code.toLowerCase() === article.code.toLowerCase();
		if (learned !== article.id && !(learned === undefined && (own || rowMatches(r, article.name)))) continue;
		let cost: bigint | undefined;
		if (r.unit === undefined || r.unit === article.unit) cost = halfUp(r.price, 10_000n);
		else if (article.pack !== undefined && r.unit === article.pack.unit) cost = halfUp(r.price * 1000n, qtyOf(article.pack.size) * 10_000n);
		else {
			const map = data.units.find((u) => u.s === r.party && u.u === r.unit && u.i === article.id);
			if (map !== undefined) cost = halfUp(r.price * 1000n, qtyOf(map.q) * 10_000n);
		}
		if (cost !== undefined && cost > 0n) out.push({ cost, day: r.day, from: "invoice" });
	}
	const mine = data.moves.filter((m) => m.item === article.id);
	const fixed = new Map<string, string>();
	for (const m of mine) if (m.kind === "costo" && m.fixes !== undefined && m.cost !== undefined) fixed.set(m.fixes, m.cost);
	for (const m of mine) if (m.kind === "carico" && m.cost !== undefined) out.push({ cost: costOf(fixed.get(m.id) ?? m.cost), day: m.day, from: "carico" });
	return out;
}

/** The purchase price for a sale on `day`: the latest on or before it (an invoice before a carico the same day), else the first after it. */
export function purchaseAt(prices: readonly Purchase[], day: string): Purchase | undefined {
	const rank = (p: Purchase) => (p.from === "invoice" ? 1 : 0);
	const before = prices.filter((p) => p.day <= day).sort((a, b) => a.day.localeCompare(b.day) || rank(a) - rank(b));
	if (before.length > 0) return before[before.length - 1];
	return [...prices].sort((a, b) => a.day.localeCompare(b.day) || rank(b) - rank(a))[0];
}

/** The article a voce is: the one on the list, else one taken off it. */
function articleOf(items: readonly StockItem[], voce: string): StockItem | undefined {
	return items.find((i) => i.removed === undefined && i.listino === voce) ?? items.find((i) => i.listino === voce);
}

/** The lines of the invoices and credit notes issued from `from` to `to` (their date), each as the margins count it. */
export function marginLines(data: MarginData, from: string, to: string): MarginLine[] {
	const out: MarginLine[] = [];
	const prices = new Map<string, Purchase[]>();
	const pricesOf = (a: StockItem) => {
		const got = prices.get(a.id) ?? purchasesOf(a, data);
		prices.set(a.id, got);
		return got;
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
			const move = data.moves.find((m) => m.sale?.invoice === inv.id && m.sale.line === n + 1);
			const article = l.item === undefined ? undefined : move !== undefined ? data.items.find((i) => i.id === move.item) : articleOf(data.items, l.item);
			if (l.item !== undefined && article !== undefined) {
				const read = saleQuantity(article, l.quantity, l.unit);
				if ("why" in read) {
					out.push({ ...base, kind: "goods", voce: l.item, article, unitWhy: read.why });
					return;
				}
				const qty = sign * read.qty;
				// The cost it went out at: recorded on the scarico; for a credit note, the one the corrected invoice's went out at.
				const recorded = credit
					? data.moves.find((m) => m.kind === "scarico" && m.item === article.id && m.cost !== undefined && m.sale !== undefined && m.sale.invoice === inv.related?.id)?.cost
					: move?.kind === "scarico" ? move.cost : undefined;
				if (recorded !== undefined) {
					const unitCost = costOf(recorded);
					out.push({ ...base, kind: "goods", voce: l.item, article, qty, cost: halfUpSigned(qty * unitCost, 100_000n), source: "sale", unitCost });
					return;
				}
				const when = credit && inv.related !== undefined && realDate(inv.related.date) ? inv.related.date : inv.date;
				const estimate = purchaseAt(pricesOf(article), when);
				if (estimate === undefined) {
					out.push({ ...base, kind: "goods", voce: l.item, article, qty, source: "none" });
					return;
				}
				out.push({ ...base, kind: "goods", voce: l.item, article, qty, cost: halfUpSigned(qty * estimate.cost, 100_000n), source: "purchase", unitCost: estimate.cost, estimate });
				return;
			}
			if (l.item !== undefined) {
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
	/** The lines counted: goods with a unit that converts and a cost (recorded or estimated); a service voce's all. */
	readonly lines: readonly MarginLine[];
	/** Thousandths of the article's unit (goods); undefined for a service voce. */
	readonly qty?: bigint;
	readonly revenue: bigint;
	/** Goods only. */
	readonly cost?: bigint;
	readonly margin?: bigint;
	readonly tenths?: bigint;
	/** Lines whose cost is estimated from a purchase price. */
	readonly estimated: number;
	/** Goods lines left out: their unit does not convert, or no cost is known; their revenue. */
	readonly badUnit: number;
	readonly noCost: number;
	readonly leftOut: bigint;
};

/** The voci sold, each with its margin (goods) or only its revenue (a service voce). */
export function productMargins(lines: readonly MarginLine[], listino: readonly PriceItem[]): ProductMargin[] {
	const by = new Map<string, MarginLine[]>();
	for (const l of lines) if (l.voce !== undefined && (l.kind === "goods" || l.kind === "service")) by.set(l.voce, [...(by.get(l.voce) ?? []), l]);
	const out: ProductMargin[] = [];
	for (const [voce, all] of by) {
		const name = listino.find((i) => i.id === voce)?.name ?? (all[0] as MarginLine).description;
		const article = all.find((l) => l.article !== undefined)?.article;
		if (article === undefined) {
			out.push({ voce, name, lines: all, revenue: all.reduce((s, l) => s + l.revenue, 0n), estimated: 0, badUnit: 0, noCost: 0, leftOut: 0n });
			continue;
		}
		const counted = all.filter((l) => l.qty !== undefined && l.cost !== undefined);
		const out1 = all.filter((l) => !counted.includes(l));
		const revenue = counted.reduce((s, l) => s + l.revenue, 0n);
		const cost = counted.reduce((s, l) => s + (l.cost as bigint), 0n);
		const margin = revenue - cost;
		const tenths = marginTenths(margin, revenue);
		out.push({
			voce,
			name,
			article,
			lines: counted,
			qty: counted.reduce((s, l) => s + (l.qty as bigint), 0n),
			revenue,
			cost,
			margin,
			...(tenths === undefined ? {} : { tenths }),
			estimated: counted.filter((l) => l.source === "purchase").length,
			badUnit: out1.filter((l) => l.unitWhy !== undefined).length,
			noCost: out1.filter((l) => l.unitWhy === undefined).length,
			leftOut: out1.reduce((s, l) => s + l.revenue, 0n),
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name, "it"));
}

/** Goods with a margin: counted lines and revenue. */
export type RankedProduct = ProductMargin & { readonly article: StockItem; readonly margin: bigint; readonly cost: bigint; readonly qty: bigint };

export const ranked = (p: ProductMargin): p is RankedProduct => p.article !== undefined && p.margin !== undefined && p.lines.length > 0;

const byBig = (a: bigint, b: bigint) => (a > b ? 1 : a < b ? -1 : 0);

/** The ranking: by margin in euros and in percent, top and bottom, and those sold at a loss (the biggest loss first). */
export function rankingOf(products: readonly ProductMargin[], top: number = MARGIN_LIMITS.top) {
	const goods = products.filter(ranked);
	const withPercent = goods.filter((p) => p.tenths !== undefined);
	const byEuro = [...goods].sort((a, b) => byBig(b.margin, a.margin) || a.name.localeCompare(b.name, "it"));
	const byPercent = [...withPercent].sort((a, b) => byBig(b.tenths as bigint, a.tenths as bigint) || byBig(b.margin, a.margin) || a.name.localeCompare(b.name, "it"));
	return {
		goods,
		bestEuro: byEuro.slice(0, top),
		worstEuro: [...byEuro].reverse().slice(0, top),
		bestPercent: byPercent.slice(0, top),
		worstPercent: [...byPercent].reverse().slice(0, top),
		losses: byEuro.filter((p) => p.margin < 0n).reverse(),
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
	readonly flag?: "loss" | "low";
};

/**
 * Each voce that is an article on the list: its price per the article's unit, the average cost
 * now and the latest purchase price; flagged when its margin at the cost now (the average, else
 * the latest purchase) is negative («loss») or under `threshold` tenths of a percent («low»).
 * Flagged first (the worst first), then by name.
 */
export function priceChecks(data: Pick<MarginData, "listino" | "items" | "moves" | "purchases" | "codes" | "units">, averages: ReadonlyMap<string, bigint>, today: string, threshold: bigint): PriceCheck[] {
	const out: PriceCheck[] = [];
	for (const voce of data.listino) {
		const article = data.items.find((i) => i.removed === undefined && i.listino === voce.id);
		if (article === undefined) continue;
		const price = listPricePerUnit(voce, article);
		const average = averages.get(article.id);
		const latest = purchaseAt(purchasesOf(article, data), today);
		const cost = average ?? latest?.cost;
		const basis = average !== undefined ? "average" : latest !== undefined ? "latest" : undefined;
		const tenths = price === undefined || cost === undefined ? undefined : marginTenths(price - cost, price);
		const flag = tenths === undefined ? undefined : tenths < 0n ? "loss" : tenths < threshold ? "low" : undefined;
		out.push({ voce, article, ...(price === undefined ? {} : { price }), ...(average === undefined ? {} : { average }), ...(latest === undefined ? {} : { latest }), ...(basis === undefined ? {} : { basis }), ...(tenths === undefined ? {} : { tenths }), ...(flag === undefined ? {} : { flag }) });
	}
	const rank = (c: PriceCheck) => (c.flag === "loss" ? 0 : c.flag === "low" ? 1 : 2);
	return out.sort((a, b) => rank(a) - rank(b) || (a.flag !== undefined ? byBig(a.tenths as bigint, b.tenths as bigint) : 0) || a.voce.name.localeCompare(b.voce.name, "it"));
}

/** A change of a simulation: by hundredths of a percent (signed), or to an amount per the article's unit (ten-thousandths). */
export type Change = { readonly percent: bigint } | { readonly to: bigint };

/** What a simulation gives: the margin as it was and as it would be, on the same quantities. */
export type WhatIf = { readonly qty: bigint; readonly revenue: bigint; readonly cost: bigint; readonly margin: bigint; readonly tenths?: bigint; readonly newRevenue: bigint; readonly newCost: bigint; readonly newMargin: bigint; readonly newTenths?: bigint };

const changed = (amount: bigint, qty: bigint, c: Change) => ("percent" in c ? amount + halfUpSigned(amount * c.percent, 10_000n) : halfUpSigned(qty * c.to, 100_000n));

/** The product's margin again with its price or its cost changed, on the quantities it sold: nothing changes anywhere. */
export function whatIf(p: RankedProduct, change: { readonly price?: Change; readonly cost?: Change }): WhatIf {
	const newRevenue = change.price === undefined ? p.revenue : changed(p.revenue, p.qty, change.price);
	const newCost = change.cost === undefined ? p.cost : changed(p.cost, p.qty, change.cost);
	const newMargin = newRevenue - newCost;
	const tenths = marginTenths(p.margin, p.revenue);
	const newTenths = marginTenths(newMargin, newRevenue);
	return { qty: p.qty, revenue: p.revenue, cost: p.cost, margin: p.margin, ...(tenths === undefined ? {} : { tenths }), newRevenue, newCost, newMargin, ...(newTenths === undefined ? {} : { newTenths }) };
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
