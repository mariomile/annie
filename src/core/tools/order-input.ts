/**
 * What the person says for an order, read and checked: the order (its number, or the supplier's
 * one), the supplier (found the suppliers' way, supplier-find.ts), the lines (an article of the
 * magazzino and how many, in its unit or its pack, maybe with the price), the days. What does
 * not read comes back as the answer to give, with the words said inside the fence.
 */
import { DateError, parseDate } from "../dates.ts";
import { italianDate } from "../italian-format.ts";
import { type Order, ORDER_ID, ORDER_LIMITS, orderId, isAwaited, isOpen, orderState } from "../orders.ts";
import { supplierKeyOf } from "../order-suggest.ts";
import { findStockItem, isCost, STOCK_LIMITS, type StockItem } from "../stock.ts";
import { costOf, qtyOf, qtyText, saleQuantity } from "../stock-sums.ts";
import { findSupplier, meantSupplier, supplierNotFound } from "../supplier-find.ts";
import type { Supplier } from "../supplier-sums.ts";
import { cleanText, isProblem, readAmount } from "../text-input.ts";
import { agree, fencedOrders } from "./order-render.ts";
import { qtyNumber, unitPlural } from "./stock-render.ts";

/** A line said: the article, the quantity in its unit (thousandths), the price per unit said (ten-thousandths). */
export type LineSaid = { readonly item: StockItem; readonly qty: bigint; readonly price?: bigint };

/** A supplier as the orders keep it. */
export type SupplierSaid = { readonly key: string; readonly name: string; readonly vat?: string; /** Taken from words close to only one supplier, not its very name. */ readonly close?: true };

export const asOrderSupplier = (s: Pick<Supplier, "name" | "vat">): SupplierSaid => ({ key: supplierKeyOf(s.name, s.vat), name: s.name.slice(0, ORDER_LIMITS.name), ...(s.vat === undefined ? {} : { vat: s.vat }) });

/** The supplier said, among `suppliers` (and those of the orders), or the answer to give; undefined when none was said. */
export function supplierSaid(raw: unknown, suppliers: readonly Supplier[], orders: readonly Order[]): SupplierSaid | string | undefined {
	const said = cleanText(raw, ORDER_LIMITS.name, "il fornitore");
	if (said === undefined) return undefined;
	if (isProblem(said)) return `Errore: ${said.problem}.`;
	// The suppliers of the registers, and those only on an order.
	const known = new Set(suppliers.map((s) => supplierKeyOf(s.name, s.vat)));
	const only = orders.filter((o) => !known.has(o.supplier.key)).map((o): Supplier => ({ key: o.supplier.key, name: o.supplier.name, nameFrom: "person", ...(o.supplier.vat === undefined ? {} : { vat: o.supplier.vat }), names: [o.supplier.name], invoices: [], expenses: [], renewals: [] }));
	const f = findSupplier([...suppliers, ...only], said);
	if (f.kind === "exact") return asOrderSupplier(f.supplier);
	if (f.kind === "close" && f.candidates.length === 1) return { ...asOrderSupplier(f.candidates[0] as Supplier), close: true };
	if (f.kind === "close") return meantSupplier(f.candidates, fencedOrders);
	return supplierNotFound(said, fencedOrders);
}

/** The order said by its number («OR-0003», «ordine 3»), or the one of the supplier said that `pick` takes; or the answer to give. */
export function orderSaid(args: Record<string, unknown>, orders: readonly Order[], supplier: SupplierSaid | undefined, pick: (o: Order) => boolean, what: string): Order | string {
	const raw = cleanText(args.order, 20, "l'ordine");
	if (isProblem(raw)) return `Errore: ${raw.problem}.`;
	if (raw !== undefined) {
		const m = /^(?:or|ordine)?\s*-?\s*0*(\d{1,6})$/i.exec(raw.trim());
		const id = m === null ? undefined : orderId(Number(m[1]));
		const o = id === undefined || !ORDER_ID.test(id) ? undefined : orders.find((x) => x.id === id);
		return o ?? ["Non trovo questo ordine: dimmi il suo numero (OR-0001) o il fornitore.", fencedOrders(raw)].join("\n");
	}
	if (supplier === undefined) return `Errore: dimmi quale ordine: il numero (OR-0001) o il fornitore.`;
	const mine = orders.filter((o) => o.supplier.key === supplier.key && pick(o)).sort((a, b) => b.id.localeCompare(a.id));
	if (mine.length === 1) return mine[0] as Order;
	if (mine.length === 0) return [`Per questo fornitore non c'è un ordine ${what}.`, fencedOrders(supplier.name)].join("\n");
	return [`Per questo fornitore ci sono ${mine.length} ordini ${what}: dimmi quale, con il numero.`, fencedOrders(mine.slice(0, ORDER_LIMITS.shown).map((o) => `• ${o.id} del ${italianDate(o.day)}`).join("\n"))].join("\n");
}

/**
 * The orders of a supplier «è arrivato l'ordine di Beta?» means: those awaited (sent, not all
 * arrived), oldest first; else the latest arrived; else the latest draft.
 */
export function asked(orders: readonly Order[], key: string): Order[] {
	const mine = orders.filter((o) => o.supplier.key === key && o.status !== "cancelled").sort((a, b) => b.id.localeCompare(a.id));
	const awaited = mine.filter(isAwaited);
	if (awaited.length > 0) return awaited.reverse();
	const arrived = mine.find((o) => orderState(o) === "received");
	if (arrived !== undefined) return [arrived];
	const draft = mine.find(isOpen);
	return draft === undefined ? [] : [draft];
}

/** The lines said: [{item, quantity, unit?, price?}], each an article of the magazzino; a quantity of 0 only where `zero` allows (a change that takes a line off). */
export function linesSaid(raw: unknown, items: readonly StockItem[], zero = false, packs = true): LineSaid[] | string {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > ORDER_LIMITS.lines) return `Errore: le righe sono un elenco (al massimo ${ORDER_LIMITS.lines}), ognuna con l'articolo e quanti.`;
	const out: LineSaid[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) return "Errore: ogni riga ha l'articolo e quanti.";
		const { item, quantity, unit, price } = entry as { item?: unknown; quantity?: unknown; unit?: unknown; price?: unknown };
		const said = cleanText(item, STOCK_LIMITS.name, "l'articolo");
		if (said === undefined || isProblem(said)) return `Errore: ${said === undefined ? "ogni riga dice l'articolo" : said.problem}.`;
		const f = findStockItem(items.filter((i) => i.removed === undefined), said);
		if (f === "none") return ["Questo articolo non è ancora in magazzino: vuoi che lo aggiunga? Dimmi come lo conti (a pezzi, a scatole).", fencedOrders(said)].join("\n");
		if ("close" in f) return ["Ci sono più articoli con questo nome: dimmi quale.", fencedOrders(f.close.slice(0, 10).map((i) => `• ${i.id} ${i.name}`).join("\n"))].join("\n");
		const q = readAmount(quantity, 3, "la quantità", fencedOrders);
		if (q === undefined || isProblem(q)) return `Errore: ${q === undefined ? "ogni riga dice quanti" : q.problem}.`;
		const u = cleanText(unit, STOCK_LIMITS.unit, "l'unità");
		if (isProblem(u)) return `Errore: ${u.problem}.`;
		let qty = 0n;
		if (Number(q) !== 0 || !zero) {
			const read = saleQuantity(f.item, q, u);
			if ("why" in read) return [read.why === "unit" ? `L'articolo si conta a ${unitPlural(f.item.unit)}${f.item.pack === undefined ? "" : ` o a ${unitPlural(f.item.pack.unit)}`}: dimmi la quantità così.` : read.why === "pack" ? "Le confezioni per quanto ne contiene ognuna non danno un numero preciso di unità." : "La quantità è un numero maggiore di zero, al più 3 decimali.", fencedOrders(f.item.name)].join("\n");
			qty = read.qty;
			// Sold by the pack: a count that is no whole number of packs is asked again.
			const pack = f.item.pack;
			if (packs && pack !== undefined && qty % qtyOf(pack.size) !== 0n) return [`Questo articolo va a ${unitPlural(pack.unit)} da ${qtyNumber(qtyOf(pack.size))}: ${qtyNumber(qty)} non è un numero intero di ${unitPlural(pack.unit)}. Dimmi ${agree(f.item.unit, "quanti", "quante")} ${unitPlural(f.item.unit)} o ${agree(pack.unit, "quanti", "quante")} ${unitPlural(pack.unit)}.`, fencedOrders(f.item.name)].join("\n");
		}
		const p = readAmount(price, 4, "il prezzo", fencedOrders);
		if (isProblem(p)) return `Errore: ${p.problem}.`;
		if (p !== undefined && (Number(p) <= 0 || !isCost(p))) return "Errore: il prezzo per unità è un importo in euro maggiore di zero, senza IVA, al più 4 decimali.";
		if (out.some((l) => l.item.id === f.item.id)) return ["Lo stesso articolo è su due righe: dimmelo una volta sola, con la quantità totale.", fencedOrders(f.item.name)].join("\n");
		if (qtyText(qty) !== "0" && !/^\d{1,10}(?:\.\d{1,3})?$/.test(qtyText(qty))) return "Errore: la quantità è troppo grande.";
		out.push({ item: f.item, qty, ...(p === undefined ? {} : { price: costOf(p) }) });
	}
	return out;
}

/** Whole days from 1 to `max`, or the answer to give; undefined when not said. */
export function daysSaid(raw: unknown, what: string, max: number): number | string | undefined {
	if (raw === undefined) return undefined;
	const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d{1,4}\s*$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isInteger(n) || n < 1 || n > max) return `Errore: ${what} è un numero intero di giorni, da 1 a ${max}.`;
	return n;
}

/** The day something happened, as said («ieri», «venerdì», «16/10»): never after today; undefined when not said. */
export function daySaid(raw: unknown, today: string, what: string): string | { readonly problem: string } | undefined {
	const said = cleanText(raw, 40, what);
	if (said === undefined || isProblem(said)) return said;
	try {
		const day = parseDate(said, today, { rule: "past" });
		return day > today ? { problem: `${what} non può essere dopo oggi` } : day;
	} catch (error) {
		if (error instanceof DateError) return { problem: `${what}: dimmelo come 16/10, «ieri» o «venerdì»` };
		throw error;
	}
}
