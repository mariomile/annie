/**
 * I prezzi d'acquisto: what the owner pays for each product, read from the lines of the invoices
 * received (fattura-pa.ts lines, kept by the scadenzario for passive invoices only). A price is
 * per unit and net of VAT, its line's total (discounts already in it) divided by its quantity;
 * a line without a quantity is a price per line, and said so. Two prices are compared only in
 * the same unit, and only per unit. A product is the same name in either number (name-keys.ts
 * sameStems), or, from one supplier, the same supplier code. The supplier is the suppliers' one
 * (supplier-find.ts, the partita IVA first). Amounts in hundred-millionths of a euro (FatturaPA's
 * own precision), never floating point. Only reads; the brief's claims are purchase-store.ts.
 */
import { createHash } from "node:crypto";
import { fromUnits, toUnits } from "./fattura-pa.ts";
import { type Invoice, partyKey, partyName, vatOf } from "./invoices.ts";
import { realDate } from "./italian-calendar.ts";
import { sameStems, spellingKey, stemsWithin } from "./name-keys.ts";
import { halfUp } from "./quote-sums.ts";
import { stockUnit } from "./stock.ts";
import type { Supplier } from "./supplier-sums.ts";

export const PURCHASE_OPS = ["item", "supplier", "compare", "increases", "export"] as const;
export type PurchaseOp = (typeof PURCHASE_OPS)[number];

export const PURCHASE_LIMITS = {
	/** What the person says of a product or a supplier. */
	query: 120,
	/** The rise that is an «aumento», in percent, when the person says none. */
	threshold: 5,
	/** Increases said by the brief in one day: the rest is a count, said on the next days. */
	perDay: 3,
	/** The brief says increases of invoices dated at most this many days ago. */
	recentDays: 30,
	/** Products shown in one answer, and suppliers per product: the rest is counted. */
	products: 15,
	suppliers: 8,
	/** Increases said, at most: claims kept, calls remembered. */
	alerts: 5000,
	calls: 500,
	fileBytes: 2 * 1024 * 1024,
} as const;

/** One unit of FatturaPA's amounts: a euro is 10^8. */
export const EURO = 100_000_000n;

export class PurchaseError extends Error {
	override readonly name = "PurchaseError";
}

/** One line of an invoice received, as a price paid. */
export type PurchaseRow = {
	/** The supplier, the suppliers' way: its key (card id, «vat:…»…) and the name shown. */
	readonly supplierKey: string;
	readonly supplier: string;
	readonly vat?: string;
	/** The register's key of the invoice, its number and date (a real day). */
	readonly invoice: string;
	readonly number?: string;
	readonly day: string;
	readonly line: number;
	readonly description: string;
	readonly code?: string;
	/** The unit kept (stock.ts stockUnit: «PZ» is «pezzo»); undefined when the line writes none. */
	readonly unit?: string;
	/** Quantity and line total, in hundred-millionths. */
	readonly quantity?: bigint;
	readonly total: bigint;
	/** Per unit, or per line (`perLine`) when the line has no quantity: hundred-millionths of a euro, net of VAT. */
	readonly price: bigint;
	readonly perLine: boolean;
};

/** The rows, and what was left out: lines that do not read, documents in another currency. */
export type PurchaseRows = { readonly rows: readonly PurchaseRow[]; readonly skippedLines: number; readonly otherCurrency: number; readonly noLines: number };

/** Lines that are no product: a discount, a premium, an allowance. */
const NOT_GOODS = new Set(["SC", "PR", "AB"]);

/** A unit as written on an invoice («PZ», «Nr.», «KG») to the one kept. */
export function purchaseUnit(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const t = raw.replace(/\./g, " ").replace(/\s+/g, " ").trim();
	return t === "" ? undefined : stockUnit(t);
}

/**
 * The prices paid, from the register's invoices received (side passive), with their suppliers:
 * only documents in euro that are not credit notes nor reverse charge integrations, with a real
 * date; only lines for goods or services with a total above zero and, when written, a quantity
 * above zero.
 */
export function purchaseRows(invoices: readonly Invoice[], suppliers: readonly Supplier[]): PurchaseRows {
	const whose = new Map<string, Supplier>();
	for (const s of suppliers) for (const inv of s.invoices) whose.set(inv.key, s);
	const rows: PurchaseRow[] = [];
	let skippedLines = 0;
	let otherCurrency = 0;
	let noLines = 0;
	for (const inv of invoices) {
		if (inv.side !== "passive" || inv.credit || inv.doc.integration) continue;
		const { doc } = inv;
		skippedLines += (doc.linesSkipped ?? 0) + (doc.linesCut ?? 0);
		if (doc.lines === undefined) {
			noLines++;
			continue;
		}
		if (doc.currency !== "EUR") {
			otherCurrency++;
			continue;
		}
		if (doc.date === undefined || !realDate(doc.date)) continue;
		const s = whose.get(inv.key);
		const supplierKey = s?.key ?? partyKey(inv.supplier);
		const supplier = s?.name ?? partyName(inv.supplier);
		const vat = s?.vat ?? vatOf(inv.supplier);
		for (const l of doc.lines) {
			if (l.kind !== undefined && NOT_GOODS.has(l.kind)) continue;
			const total = toUnits(l.total);
			const quantity = l.quantity === undefined ? undefined : toUnits(l.quantity);
			if (total === undefined || total <= 0n || (quantity !== undefined && quantity <= 0n)) continue;
			const unit = purchaseUnit(l.unit);
			rows.push({
				supplierKey,
				supplier,
				...(vat === undefined ? {} : { vat }),
				invoice: inv.key,
				...(doc.number === undefined ? {} : { number: doc.number }),
				day: doc.date,
				line: l.n,
				description: l.description,
				...(l.code === undefined ? {} : { code: l.code.value }),
				...(unit === undefined ? {} : { unit }),
				...(quantity === undefined ? {} : { quantity }),
				total,
				price: quantity === undefined ? total : halfUp(total * EURO, quantity),
				perLine: quantity === undefined,
			});
		}
	}
	rows.sort(byTime);
	return { rows, skippedLines, otherCurrency, noLines };
}

/** Oldest first: by day, then invoice, then line. */
export function byTime(a: PurchaseRow, b: PurchaseRow): number {
	return a.day.localeCompare(b.day) || a.invoice.localeCompare(b.invoice) || a.line - b.line;
}

/** Whether a row is the product said: its supplier code, or every word said in its description in either number («carta a4» in «Carta A4 80g risma»). */
export function rowMatches(row: PurchaseRow, said: string): boolean {
	const t = said.trim();
	if (t === "") return false;
	if (row.code !== undefined && row.code.toLowerCase() === t.toLowerCase()) return true;
	return stemsWithin(t, row.description);
}

/** A product: rows with the same name in either number and the same unit (per unit or per line apart). */
export type Product = { readonly name: string; readonly unit?: string; readonly perLine: boolean; readonly rows: readonly PurchaseRow[] };

const unitKey = (r: Pick<PurchaseRow, "unit" | "perLine">) => `${r.perLine ? "riga" : "unità"}|${r.unit ?? ""}`;

/**
 * The rows grouped into products by name (sameStems) and unit: never two units in one product.
 * Within one supplier, rows with the same code join the group of the first one, whatever the
 * description says.
 */
export function productsOf(rows: readonly PurchaseRow[]): Product[] {
	const groups: { name: string; unit?: string; perLine: boolean; key: string; rows: PurchaseRow[] }[] = [];
	const byCode = new Map<string, (typeof groups)[number]>();
	for (const r of rows) {
		const key = unitKey(r);
		const coded = r.code === undefined ? undefined : `${r.supplierKey}|${r.code.toLowerCase()}|${key}`;
		const found = (coded === undefined ? undefined : byCode.get(coded)) ?? groups.find((g) => g.key === key && (spellingKey(g.name) === spellingKey(r.description) || sameStems(g.name, r.description)));
		const group = found ?? { name: r.description, ...(r.unit === undefined ? {} : { unit: r.unit }), perLine: r.perLine, key, rows: [] };
		if (found === undefined) groups.push(group);
		group.rows.push(r);
		if (coded !== undefined && !byCode.has(coded)) byCode.set(coded, group);
	}
	return groups.map(({ key: _key, ...g }) => g);
}

/** One supplier's purchases of a product: the latest price and the one before it (from another invoice), the lowest, how many. */
export type SupplierPrice = { readonly supplierKey: string; readonly supplier: string; readonly latest: PurchaseRow; readonly previous?: PurchaseRow; readonly lowest: bigint; readonly count: number };

/** A product's suppliers, the cheapest latest price first. */
export function bySupplier(product: Product): SupplierPrice[] {
	const map = new Map<string, PurchaseRow[]>();
	for (const r of product.rows) map.set(r.supplierKey, [...(map.get(r.supplierKey) ?? []), r]);
	const out: SupplierPrice[] = [];
	for (const [key, list] of map) {
		const sorted = [...list].sort(byTime);
		const latest = sorted.at(-1) as PurchaseRow;
		const previous = [...sorted].reverse().find((r) => r.invoice !== latest.invoice);
		out.push({ supplierKey: key, supplier: latest.supplier, latest, ...(previous === undefined ? {} : { previous }), lowest: sorted.reduce((m, r) => (r.price < m ? r.price : m), latest.price), count: sorted.length });
	}
	return out.sort((a, b) => (a.latest.price < b.latest.price ? -1 : a.latest.price > b.latest.price ? 1 : a.supplier.localeCompare(b.supplier, "it")));
}

/** The rise from `before` to `after` in tenths of a percent, half up away from zero: 4,50 → 4,86 is 80 (8,0%). */
export function riseTenths(before: bigint, after: bigint): bigint {
	const d = after - before;
	return d < 0n ? -halfUp(-d * 1000n, before) : halfUp(d * 1000n, before);
}

/** Whether `after` is at least `threshold` hundredths of a percent above `before` (500 is 5%): exact, no rounding. */
export function risesBy(before: bigint, after: bigint, threshold: bigint): boolean {
	return before > 0n && (after - before) * 10_000n >= threshold * before;
}

/** One increase: a supplier's latest price of a product against its previous one, both per unit, in the same unit. */
export type Increase = { readonly product: Product; readonly supplier: string; readonly supplierKey: string; readonly latest: PurchaseRow; readonly previous: PurchaseRow; readonly tenths: bigint };

/**
 * The increases of `threshold` (hundredths of a percent) or more: for each supplier and product
 * (per unit only), the latest purchase dated from `from` to `to` against the purchase before it
 * from another invoice. The largest rise first.
 */
export function increasesOf(rows: readonly PurchaseRow[], threshold: bigint, from: string, to: string): Increase[] {
	const out: Increase[] = [];
	for (const product of productsOf(rows.filter((r) => !r.perLine))) {
		for (const s of bySupplier(product)) {
			if (s.previous === undefined || s.latest.day < from || s.latest.day > to) continue;
			if (!risesBy(s.previous.price, s.latest.price, threshold)) continue;
			out.push({ product, supplier: s.supplier, supplierKey: s.supplierKey, latest: s.latest, previous: s.previous, tenths: riseTenths(s.previous.price, s.latest.price) });
		}
	}
	return out.sort((a, b) => (a.tenths > b.tenths ? -1 : a.tenths < b.tenths ? 1 : a.product.name.localeCompare(b.product.name, "it")));
}

/** A product's cheapest supplier in a period: the lowest latest price among those that sold it then, and the others. */
export type Cheapest = { readonly product: Product; readonly suppliers: readonly SupplierPrice[] };

/** Per product bought from two suppliers or more in the period (per unit only), the suppliers by their latest price there, cheapest first. */
export function cheapestOf(rows: readonly PurchaseRow[], from: string, to: string): Cheapest[] {
	const within = rows.filter((r) => !r.perLine && r.day >= from && r.day <= to);
	return productsOf(within)
		.map((product) => ({ product, suppliers: bySupplier(product) }))
		.filter((c) => c.suppliers.length >= 2)
		.sort((a, b) => a.product.name.localeCompare(b.product.name, "it"));
}

/** The key an invoice line is claimed by (the brief, the answer about that invoice): a digest of the invoice's key, and the line. */
export function lineKey(invoice: string, line: number): string {
	return `${createHash("sha256").update(invoice).digest("hex").slice(0, 24)}#${line}`;
}

/** An increase said: the invoice line, the day, the call that said it, and where (the brief, or the answer about that invoice). */
export type PriceClaim = { readonly k: string; readonly day: string; readonly call: string; readonly via: "brief" | "invoice" };

export function validPriceClaim(v: unknown): v is PriceClaim {
	if (typeof v !== "object" || v === null) return false;
	const c = v as PriceClaim;
	return Object.keys(c).every((k) => ["k", "day", "call", "via"].includes(k)) && typeof c.k === "string" && /^[0-9a-f]{24}#\d{1,4}$/.test(c.k) && typeof c.day === "string" && realDate(c.day) && typeof c.call === "string" && c.call.length > 0 && c.call.length <= 200 && (c.via === "brief" || c.via === "invoice");
}

/** A price in hundred-millionths, said in euros to the ten-thousandth, at least two decimals: «4,86 €», «0,0125 €». */
export function priceWords(price: bigint): string {
	const t = halfUp(price, 10_000n);
	const digits = t.toString().padStart(5, "0");
	const whole = digits.slice(0, -4).replace(/\B(?=(\d{3})+$)/g, ".");
	const fraction = digits.slice(-4).replace(/0+$/, "").padEnd(2, "0");
	return `${whole},${fraction} €`;
}

/** Tenths of a percent said: «8%», «12,5%», «−3%». */
export function tenthsWords(tenths: bigint): string {
	const sign = tenths < 0n ? "−" : "";
	const t = tenths < 0n ? -tenths : tenths;
	return `${sign}${(t / 10n).toString()}${t % 10n === 0n ? "" : `,${(t % 10n).toString()}`}%`;
}

/** A quantity in hundred-millionths, the Italian way: «12», «2,5». */
export function quantityWords(q: bigint): string {
	const [integer, fraction] = fromUnits(q).replace(/\.?0+$/, "").split(".");
	return `${(integer ?? "0").replace(/\B(?=(\d{3})+$)/g, ".")}${fraction === undefined ? "" : `,${fraction}`}`;
}

/** The ops that only read, and the brief's increases (compact), which only marks its lines as said: they run in a brief's thread. */
export function purchaseCallReads(args: Record<string, unknown>): boolean {
	return args.op !== "export" && PURCHASE_OPS.some((o) => o === args.op);
}

/** What another agente may ask: how many products rose, how many purchases of a product; never a price, a supplier or a file. */
export function purchaseAgentReads(args: Record<string, unknown>): boolean {
	return (args.op === "increases" && args.compact !== true) || args.op === "item";
}
