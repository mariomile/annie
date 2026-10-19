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
import { type FatturaDocument, type FatturaLine, fromUnits, toUnits } from "./fattura-pa.ts";
import { type Invoice, partyKey, partyName, vatOf } from "./invoices.ts";
import { realDate } from "./italian-calendar.ts";
import { italianDate, withDate, withPercent } from "./italian-format.ts";
import { sameStems, spelledOut, wordsWithin } from "./name-keys.ts";
import { halfUp, halfUpSigned } from "./quote-sums.ts";
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
	/** The brief says at most this many increases of one supplier a day. */
	perSupplier: 1,
	/** An earlier price under this (hundred-millionths: 0,01 €) is no base for a rise, anywhere. */
	floor: 1_000_000,
	/** An invoice number shown, at most. */
	number: 20,
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
	/** The invoice's own party key (invoices.ts partyKey), as the magazzino learns a supplier's codes and units by it. */
	readonly party: string;
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
	/** The discount on the whole invoice spread over its lines (negative: a surcharge), in hundred-millionths: already in `total` and `price`. */
	readonly spread?: bigint;
	/** Its share of that discount is more than half its total: to be checked. */
	readonly heavy?: true;
	/** Why a discount of its invoice was not counted or not spread (spreadOf notes). */
	readonly spreadNotes?: readonly string[];
};

/** A spesa accessoria of an invoice (transport, packing): the invoice's cost, never a product. */
export type ExpenseRow = Pick<PurchaseRow, "supplierKey" | "supplier" | "invoice" | "number" | "day" | "line" | "description" | "total">;

/**
 * The rows, and what was left out: lines that do not read (`unread`) and past the 2000 kept
 * (`cut`), documents in another currency, without lines, or with a date that is no real day or
 * before 2000; the spese accessorie apart.
 */
export type PurchaseRows = {
	readonly rows: readonly PurchaseRow[];
	readonly expenses: readonly ExpenseRow[];
	readonly unread: number;
	readonly cut: number;
	readonly otherCurrency: number;
	readonly noLines: number;
	readonly badDates: number;
};

/** Lines that are a discount on the others (sconto, abbuono): spread over the goods. */
const DISCOUNT_LINES = new Set(["SC", "AB"]);

/** One goods line with its total after the invoice's discounts, in hundred-millionths. */
export type SpreadLine = { readonly line: FatturaLine; readonly total: bigint };

/** What spreadOf gives: the goods with their totals after the discounts, the spese apart, what was spread, the SC/AB lines spread, the lines whose share is very large, and what was left out, said. */
export type Spread = {
	readonly goods: readonly SpreadLine[];
	readonly expenses: readonly FatturaLine[];
	readonly spread: bigint;
	readonly discounts: ReadonlySet<number>;
	/** Lines whose share of the discount is more than half their total: to be checked. */
	readonly heavy: ReadonlySet<number>;
	/** Why a discount was not counted or not spread, in words (no data of the file). */
	readonly notes: readonly string[];
};

/** A share of the discount above this part of a line's total is flagged. */
const HEAVY_SHARE = 2n;

const rateKey = (vat: string, natura: string | undefined) => `${toUnits(vat) ?? vat}|${natura ?? ""}`;

/**
 * An invoice's goods lines with the discounts of the whole invoice spread over them in proportion
 * to their totals, as the riepilogo IVA (DatiRiepilogo) says them: the goods' imponibile, for the
 * goods' rates, less the spese and premi at those rates, is what the goods cost; the difference
 * from the goods lines is spread when it is explained by the SC and AB lines (a discount whatever
 * their sign), or by those and the document's ScontoMaggiorazione (percentages compounded, on the
 * goods after those lines; an amount without VAT, or with it when only that reconciles, at one
 * rate). A header discount the riepilogo does not have is not counted; a difference nothing
 * explains is not spread; a discount of the whole goods or more, or a surcharge more than
 * doubling them, is left out: each said in `notes`. Without a riepilogo only the SC and AB lines
 * are spread. The spese accessorie (AC) are apart, never products nor spread over; a premio (PR)
 * is neither.
 */
export function spreadOf(doc: Pick<FatturaDocument, "lines" | "adjustments" | "vatRows">): Spread {
	const goods: SpreadLine[] = [];
	const expenses: FatturaLine[] = [];
	const discountLines: FatturaLine[] = [];
	const others: FatturaLine[] = [];
	for (const l of doc.lines ?? []) {
		const total = toUnits(l.total);
		if (total === undefined) continue;
		if (l.kind !== undefined && DISCOUNT_LINES.has(l.kind)) discountLines.push(l);
		else if (l.kind === "AC") {
			others.push(l);
			if (total > 0n) expenses.push(l);
		} else if (l.kind !== "PR" && total > 0n) goods.push({ line: l, total });
		else others.push(l);
	}
	const none = (notes: string[] = [], discounts = new Set<number>()): Spread => ({ goods, expenses, spread: 0n, discounts, heavy: new Set(), notes });
	const sum = goods.reduce((t, g) => t + g.total, 0n);
	const header = doc.adjustments ?? [];
	if (sum === 0n || (discountLines.length === 0 && header.length === 0)) return none();
	const rates = new Set(goods.map((g) => rateKey(g.line.vat, g.line.natura)));
	const atRates = (l: FatturaLine) => rates.has(rateKey(l.vat, l.natura));
	const abs = (n: bigint) => (n < 0n ? -n : n);
	const fromLines = discountLines.filter(atRates).reduce((t, l) => t + abs(toUnits(l.total) as bigint), 0n);
	// The header on the goods after the lines' discounts, percentages compounded; an amount as written.
	let base = sum > fromLines ? sum - fromLines : 0n;
	let net = 0n;
	let amounts = 0n;
	for (const a of header) {
		const sign = a.kind === "SC" ? 1n : -1n;
		if (a.percent !== undefined) {
			const part = halfUp(base * (toUnits(a.percent) ?? 0n), 100n * EURO);
			net += sign * part;
			base -= sign * part;
		} else {
			const amount = toUnits(a.amount ?? "0") ?? 0n;
			net += sign * amount;
			amounts += sign * amount;
		}
	}
	let spread: bigint;
	const notes: string[] = [];
	const rows = (doc.vatRows ?? []).filter((r) => rates.has(rateKey(r.rate, r.natura)));
	if (doc.vatRows === undefined || rows.length === 0) {
		// Nothing to check against: the lines' discounts only.
		spread = fromLines;
		if (header.length > 0) notes.push("Lo sconto scritto in testa alla fattura non si controlla con il riepilogo IVA, che manca: non l'ho contato.");
	} else {
		const taxable = rows.reduce((t, r) => t + (toUnits(r.taxable) ?? 0n), 0n);
		const rest = others.filter(atRates).reduce((t, l) => t + (toUnits(l.total) as bigint), 0n);
		const owed = sum - (taxable - rest);
		const near = (a: bigint, b: bigint) => abs(a - b) <= 1_000_000n * BigInt(rows.length);
		// An amount with VAT, at the goods' one rate: its imponibile.
		const only = rates.size === 1 ? toUnits(goods[0]?.line.vat ?? "0") : undefined;
		const gross = only === undefined || only === 0n || amounts === 0n ? undefined : net - amounts + halfUpSigned(amounts * 100n * EURO, 100n * EURO + only);
		if (near(owed, fromLines)) {
			spread = owed;
			if (header.length > 0 && net !== 0n) notes.push("Lo sconto scritto in testa alla fattura non è nel riepilogo IVA: non l'ho contato.");
		} else if (header.length > 0 && near(owed, fromLines + net)) spread = owed;
		else if (gross !== undefined && near(owed, fromLines + gross)) spread = owed;
		else {
			notes.push("Gli sconti della fattura non tornano con il riepilogo IVA: non li ho divisi sulle righe.");
			return none(notes);
		}
	}
	if (spread === 0n) return none(notes);
	if (spread >= sum) return none([...notes, "Lo sconto su tutta la fattura è pari o oltre il totale della merce: l'ho lasciato fuori, non l'ho diviso sulle righe."]);
	if (-spread > sum) return none([...notes, "La maggiorazione su tutta la fattura più che raddoppierebbe le righe: l'ho lasciata fuori, non l'ho divisa."]);
	const heavy = new Set<number>();
	const spreadGoods = goods.map((g) => {
		const share = halfUpSigned(spread * g.total, sum);
		if (share * HEAVY_SHARE > g.total) heavy.add(g.line.n);
		return { line: g.line, total: g.total - share };
	});
	return { goods: spreadGoods, expenses, spread, discounts: new Set(discountLines.map((l) => l.n)), heavy, notes };
}

/** «La fattura n. B-9 ha uno sconto di 20,00 € su tutta la fattura: l'ho diviso sulle righe in proporzione.» */
export function spreadWords(number: string | undefined, day: string | undefined, spread: bigint): string {
	const which = number !== undefined ? `La fattura n. ${number.slice(0, PURCHASE_LIMITS.number)}` : day !== undefined ? `La fattura del ${italianDate(day)}` : "La fattura";
	return spread > 0n ? `${which} ha uno sconto di ${priceWords(spread)} su tutta la fattura: l'ho diviso sulle righe in proporzione.` : `${which} ha una maggiorazione di ${priceWords(-spread)} su tutta la fattura: l'ho divisa sulle righe in proporzione.`;
}

/** Whether an invoice's date is one to keep a price by: a real day, from 2000 on. */
export const goodDate = (date: string | undefined): date is string => date !== undefined && realDate(date) && date >= "2000-01-01";

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
	const expenses: ExpenseRow[] = [];
	let unread = 0;
	let cut = 0;
	let otherCurrency = 0;
	let noLines = 0;
	let badDates = 0;
	for (const inv of invoices) {
		if (inv.side !== "passive" || inv.credit || inv.doc.integration) continue;
		const { doc } = inv;
		unread += doc.linesSkipped ?? 0;
		cut += doc.linesCut ?? 0;
		if (doc.lines === undefined) {
			noLines++;
			continue;
		}
		if (doc.currency !== "EUR") {
			otherCurrency++;
			continue;
		}
		if (!goodDate(doc.date)) {
			badDates++;
			continue;
		}
		const day = doc.date;
		const s = whose.get(inv.key);
		const supplierKey = s?.key ?? partyKey(inv.supplier);
		const supplier = s?.name ?? partyName(inv.supplier);
		const vat = s?.vat ?? vatOf(inv.supplier);
		const number = doc.number === undefined ? {} : { number: doc.number.slice(0, PURCHASE_LIMITS.number) };
		const spread = spreadOf(doc);
		for (const l of spread.expenses) expenses.push({ supplierKey, supplier, invoice: inv.key, ...number, day, line: l.n, description: l.description, total: toUnits(l.total) as bigint });
		for (const { line: l, total } of spread.goods) {
			const quantity = l.quantity === undefined ? undefined : toUnits(l.quantity);
			if (quantity !== undefined && quantity <= 0n) continue;
			const unit = purchaseUnit(l.unit);
			rows.push({
				supplierKey,
				supplier,
				...(vat === undefined ? {} : { vat }),
				party: partyKey(inv.supplier),
				invoice: inv.key,
				...number,
				day,
				line: l.n,
				description: l.description,
				...(l.code === undefined ? {} : { code: l.code.value }),
				...(unit === undefined ? {} : { unit }),
				...(quantity === undefined ? {} : { quantity }),
				total,
				price: quantity === undefined ? total : halfUp(total * EURO, quantity),
				perLine: quantity === undefined,
				...(spread.spread === 0n ? {} : { spread: spread.spread }),
				...(spread.heavy.has(l.n) ? { heavy: true as const } : {}),
				...(spread.notes.length === 0 ? {} : { spreadNotes: spread.notes }),
			});
		}
	}
	rows.sort(byTime);
	expenses.sort((a, b) => a.day.localeCompare(b.day) || a.invoice.localeCompare(b.invoice) || a.line - b.line);
	return { rows, expenses, unread, cut, otherCurrency, noLines, badDates };
}

/** Oldest first: by day, then invoice, then line. */
export function byTime(a: PurchaseRow, b: PurchaseRow): number {
	return a.day.localeCompare(b.day) || a.invoice.localeCompare(b.invoice) || a.line - b.line;
}

/** Whether a row is the product said: its supplier code, or every word said in its description in either number, abbreviations spelled out («carta a4 80 grammi» in «CARTA A4 80GR RS500»). */
export function rowMatches(row: Pick<PurchaseRow, "code" | "description">, said: string): boolean {
	const t = said.trim();
	if (t === "") return false;
	if (row.code !== undefined && row.code.toLowerCase() === t.toLowerCase()) return true;
	return wordsWithin(t, row.description);
}

/** A product: rows with the same name in either number and the same unit (per unit or per line apart). */
export type Product = { readonly name: string; readonly unit?: string; readonly perLine: boolean; readonly rows: readonly PurchaseRow[] };

const unitKey = (r: Pick<PurchaseRow, "unit" | "perLine">) => `${r.perLine ? "riga" : "unità"}|${r.unit ?? ""}`;

/**
 * The rows grouped into products by name (the same words in either number, abbreviations spelled
 * out) and unit: never two units in one product. Within one supplier, rows with the same code join
 * the group of the first one, whatever the description says.
 */
export function productsOf(rows: readonly PurchaseRow[]): Product[] {
	const groups: { name: string; spelled: string; unit?: string; perLine: boolean; key: string; rows: PurchaseRow[] }[] = [];
	const byCode = new Map<string, (typeof groups)[number]>();
	for (const r of rows) {
		const key = unitKey(r);
		const spelled = spelledOut(r.description);
		const coded = r.code === undefined ? undefined : `${r.supplierKey}|${r.code.toLowerCase()}|${key}`;
		const found = (coded === undefined ? undefined : byCode.get(coded)) ?? groups.find((g) => g.key === key && (g.spelled === spelled || sameStems(g.spelled, spelled)));
		const group = found ?? { name: r.description, spelled, ...(r.unit === undefined ? {} : { unit: r.unit }), perLine: r.perLine, key, rows: [] };
		if (found === undefined) groups.push(group);
		group.rows.push(r);
		if (coded !== undefined && !byCode.has(coded)) byCode.set(coded, group);
	}
	return groups.map(({ key: _key, spelled: _spelled, ...g }) => g);
}

/** What was bought in one unit (per unit or per line apart), whatever the description: each supplier's product its own seller, the cheapest latest price first. */
export type Offer = { readonly unit?: string; readonly perLine: boolean; readonly sellers: readonly SupplierPrice[] };

/** The rows the person's words fit, by unit: every product of every supplier with those words, in that unit, together. */
export function offersOf(rows: readonly PurchaseRow[]): Offer[] {
	const byUnit = new Map<string, Product[]>();
	for (const p of productsOf(rows)) byUnit.set(unitKey(p), [...(byUnit.get(unitKey(p)) ?? []), p]);
	return [...byUnit.values()].map((ps) => {
		const first = ps[0] as Product;
		return { ...(first.unit === undefined ? {} : { unit: first.unit }), perLine: first.perLine, sellers: ps.flatMap(bySupplier).sort(cheaper) };
	});
}

const cheaper = (a: SupplierPrice, b: SupplierPrice) => (a.latest.price < b.latest.price ? -1 : a.latest.price > b.latest.price ? 1 : a.supplier.localeCompare(b.supplier, "it"));

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
	return out.sort(cheaper);
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
			// From a price under a cent any rise is noise: never an increase.
			if (s.previous === undefined || s.previous.price < BigInt(PURCHASE_LIMITS.floor) || s.latest.day < from || s.latest.day > to) continue;
			if (!risesBy(s.previous.price, s.latest.price, threshold)) continue;
			out.push({ product, supplier: s.supplier, supplierKey: s.supplierKey, latest: s.latest, previous: s.previous, tenths: riseTenths(s.previous.price, s.latest.price) });
		}
	}
	return out.sort((a, b) => (a.tenths > b.tenths ? -1 : a.tenths < b.tenths ? 1 : a.product.name.localeCompare(b.product.name, "it")));
}

/** The agente's thresholds: a percentage asked is taken down to one of these (hundredths of a percent), never under the first. */
export const AGENT_THRESHOLDS = [500n, 1000n, 2000n] as const;

export function agentThreshold(asked: bigint): bigint {
	return [...AGENT_THRESHOLDS].reverse().find((t) => t <= asked) ?? AGENT_THRESHOLDS[0];
}

/** Units said «al …» (masculine), «a …» (feminine); the short ones spelled. */
const MASCULINE = new Set(["pezzo", "kg", "mq", "km", "litro", "cartone", "pacco", "rotolo", "paio", "flacone", "bancale", "g", "m", "ml"]);
const FEMININE = new Set(["risma", "confezione", "scatola", "busta", "bottiglia"]);
const SPELLED: Readonly<Record<string, string>> = { g: "grammo", m: "metro", ml: "millilitro" };

/** «a risma», «al pezzo», «al metro»; «per unità» without a unit; «per …» for one not known. */
export function perUnitWords(unit: string | undefined): string {
	if (unit === undefined) return "per unità";
	const w = SPELLED[unit] ?? unit;
	if (MASCULINE.has(unit)) return /^[aeiou]/.test(w) ? `all'${w}` : `al ${w}`;
	if (FEMININE.has(unit)) return `a ${w}`;
	return `per ${w}`;
}

/** Tenths of a percent as withPercent takes them: 80 is «8», 125 «12.5». */
const percentOf = (tenths: bigint) => `${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}`;

/** «l'8%», «il 12,5%». */
export const percentWords = (tenths: bigint) => withPercent("il", percentOf(tenths < 0n ? -tenths : tenths));

/** «dell'8%», «del 12,5%». */
export const ofPercentWords = (tenths: bigint) => percentWords(tenths).replace(/^l'/, "dell'").replace(/^il /, "del ").replace(/^lo /, "dello ");

/** «• Beta Srl: CARTA A4 ora costa 4,86 € a risma (fattura del 18/10/2026), l'8% in più del 3 marzo 2026, quando costava 4,50 €.» */
export function increaseWords(i: Increase): string {
	return `• ${i.supplier}: ${i.latest.description} ora costa ${priceWords(i.latest.price)} ${perUnitWords(i.latest.unit)} (fattura del ${italianDate(i.latest.day)}), ${percentWords(i.tenths)} in più ${withDate("del", i.previous.day)}, quando costava ${priceWords(i.previous.price)}.`;
}

/** The brief's: «• Beta Srl ha aumentato CARTA A4 dell'8% rispetto al 3 marzo (4,86 € invece di 4,50 € a risma).»; the year only when not this one. */
export function briefIncreaseWords(i: Increase, today: string): string {
	const when = withDate("al", i.previous.day);
	return `• ${i.supplier} ha aumentato ${i.latest.description} ${ofPercentWords(i.tenths)} rispetto ${i.previous.day.slice(0, 4) === today.slice(0, 4) ? when.replace(/ \d{4}$/, "") : when} (${priceWords(i.latest.price)} invece di ${priceWords(i.previous.price)} ${perUnitWords(i.latest.unit)}).`;
}

/** The increases of one invoice received: its lines 5% or more above the supplier's purchase before (purchaseRows, increasesOf). */
export function increasesIn(invoices: readonly Invoice[], suppliers: readonly Supplier[], inv: Invoice): Increase[] {
	if (!goodDate(inv.doc.date)) return [];
	const rows = purchaseRows(invoices, suppliers).rows;
	return increasesOf(rows, BigInt(PURCHASE_LIMITS.threshold * 100), inv.doc.date, inv.doc.date).filter((i) => i.latest.invoice === inv.key);
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
