/**
 * The arithmetic of an outgoing invoice, exact: amounts are digit strings read into bigint cents
 * (quote-sums.ts' scaled and halfUp), never floats; rounding is half up to the cent. In the order
 * FatturaPA checks it:
 * 1. each line's PrezzoTotale: quantity × unit price less its discount, rounded once (lineCents);
 * 2. the lines grouped by VAT rate and nature, as the DatiRiepilogo rows;
 * 3. the cassa on each group's lines, which joins that group's imponibile;
 * 4. the bollo, when the amounts without VAT pass the threshold: a line of its own (N1) when the
 *    customer pays it, otherwise only declared;
 * 5. the VAT of each row on its imponibile (rounded per row, never per line);
 * 6. the ritenuta on the lines (and the cassa when it is subject to it), never on VAT or bollo;
 * 7. the total (imponibili + imposte) and what the customer pays: less the ritenuta, and less the
 *    VAT under split payment.
 */
import { halfUp, lineCents, scaled } from "./quote-sums.ts";
import { BOLLO_CENTS, BOLLO_DESCRIPTION, BOLLO_FREE_NATURE, BOLLO_NATURA, BOLLO_REFERENCE, BOLLO_THRESHOLD_CENTS, FORFETTARIO_DICITURA, FORFETTARIO_NATURA, type Natura, REGIME_FORFETTARIO, RITENUTA_RATE, type SalesVatRate } from "./sales-invoice-rules.ts";
import type { SalesInvoice, SalesLine } from "./sales-invoices.ts";

/** One DatiRiepilogo row: its rate (and nature at 0%), the lines' sum, the cassa on it, the imponibile, the VAT, the law. */
export type SummaryRow = { readonly vat: SalesVatRate; readonly natura?: Natura; readonly lines: bigint; readonly cassa: bigint; readonly taxable: bigint; readonly tax: bigint; readonly reference?: string };

/** One DatiCassaPrevidenziale block: the base it is computed on and its amount, with the rate and nature of its group. */
export type CassaRow = { readonly vat: SalesVatRate; readonly natura?: Natura; readonly base: bigint; readonly amount: bigint };

export type SalesTotals = {
	/** The lines as written, the bollo's included when the customer pays it (last). */
	readonly lines: readonly SalesLine[];
	/** Each line's PrezzoTotale, in cents, in the same order. */
	readonly amounts: readonly bigint[];
	readonly rows: readonly SummaryRow[];
	readonly cassa: readonly CassaRow[];
	readonly cassaTotal: bigint;
	/** The amounts without VAT the bollo is measured on. */
	readonly freeOfVat: bigint;
	/** The bollo: due or not, and whether it is a line the customer pays. */
	readonly bollo: { readonly due: boolean; readonly charged: boolean };
	readonly taxable: bigint;
	readonly vat: bigint;
	/** ImportoTotaleDocumento: imponibili + imposte. */
	readonly total: bigint;
	readonly ritenutaBase: bigint;
	readonly ritenuta: bigint;
	/** What the customer pays (ImportoPagamento). */
	readonly toPay: bigint;
};

/** The bollo line, when the customer pays it. */
export const BOLLO_LINE: SalesLine = { description: BOLLO_DESCRIPTION, quantity: "1", price: "2", vat: 0, natura: BOLLO_NATURA, reference: BOLLO_REFERENCE };

const groupKey = (l: Pick<SalesLine, "vat" | "natura">) => `${l.vat}|${l.natura ?? ""}`;

/** `cents` × `percent` / 100, half up. */
function percentOf(cents: bigint, percent: string): bigint {
	return halfUp(cents * scaled(percent, 2), 10_000n);
}

/** The rows of some lines: per rate and nature, highest rate first, the cassa added to each. */
function rowsOf(lines: readonly SalesLine[], amounts: readonly bigint[], cassaRate: string | undefined, regime: SalesInvoice["regime"]): { rows: SummaryRow[]; cassa: CassaRow[] } {
	const groups = new Map<string, { vat: SalesVatRate; natura?: Natura; lines: bigint; fees: bigint; reference?: string }>();
	lines.forEach((line, i) => {
		const key = groupKey(line);
		const seen = groups.get(key) ?? { vat: line.vat, ...(line.natura === undefined ? {} : { natura: line.natura }), lines: 0n, fees: 0n };
		const cents = amounts[i] as bigint;
		// The cassa is on the fees, never on the bollo the customer pays back.
		const fees = line === BOLLO_LINE ? 0n : cents;
		groups.set(key, { ...seen, lines: seen.lines + cents, fees: seen.fees + fees, ...(seen.reference === undefined && line.reference !== undefined ? { reference: line.reference } : {}) });
	});
	const rows: SummaryRow[] = [];
	const cassa: CassaRow[] = [];
	for (const g of [...groups.values()].sort((a, b) => b.vat - a.vat || (a.natura ?? "").localeCompare(b.natura ?? ""))) {
		const amount = cassaRate === undefined || g.fees <= 0n ? 0n : percentOf(g.fees, cassaRate);
		if (amount > 0n) cassa.push({ vat: g.vat, ...(g.natura === undefined ? {} : { natura: g.natura }), base: g.fees, amount });
		const taxable = g.lines + amount;
		const reference = regime === REGIME_FORFETTARIO && g.natura === FORFETTARIO_NATURA ? FORFETTARIO_DICITURA : g.reference;
		rows.push({ vat: g.vat, ...(g.natura === undefined ? {} : { natura: g.natura }), lines: g.lines, cassa: amount, taxable, tax: halfUp(taxable * BigInt(g.vat), 100n), ...(reference === undefined ? {} : { reference }) });
	}
	return { rows, cassa };
}

/** The amounts without VAT the bollo threshold is measured on: 0% rows of natures that bear the bollo. */
function freeOfVatOf(rows: readonly SummaryRow[]): bigint {
	return rows.filter((r) => r.vat === 0 && r.natura !== undefined && !BOLLO_FREE_NATURE.includes(r.natura)).reduce((s, r) => s + r.taxable, 0n);
}

/**
 * The totals of a draft or an invoice. The bollo's choice (`bolloToClient`) matters only when it
 * is due; a credit note declares it but never charges it.
 */
export function salesTotals(invoice: Pick<SalesInvoice, "type" | "regime" | "lines" | "cassa" | "ritenuta" | "bolloToClient" | "splitPayment">): SalesTotals {
	const own = invoice.lines;
	const ownAmounts = own.map(lineCents);
	const first = rowsOf(own, ownAmounts, invoice.cassa?.rate, invoice.regime);
	const freeOfVat = freeOfVatOf(first.rows);
	const due = freeOfVat > BOLLO_THRESHOLD_CENTS;
	const charged = due && invoice.bolloToClient === true && invoice.type === "TD01";
	const lines = charged ? [...own, BOLLO_LINE] : own;
	const amounts = charged ? [...ownAmounts, BOLLO_CENTS] : ownAmounts;
	const { rows, cassa } = charged ? rowsOf(lines, amounts, invoice.cassa?.rate, invoice.regime) : first;
	const taxable = rows.reduce((s, r) => s + r.taxable, 0n);
	const vat = rows.reduce((s, r) => s + r.tax, 0n);
	const cassaTotal = cassa.reduce((s, c) => s + c.amount, 0n);
	const total = taxable + vat;
	const ritenutaBase = ownAmounts.reduce((s, a) => s + a, 0n) + (invoice.cassa?.subject === true ? cassaTotal : 0n);
	const ritenuta = invoice.ritenuta === undefined ? 0n : halfUp(ritenutaBase * BigInt(RITENUTA_RATE), 100n);
	const toPay = total - ritenuta - (invoice.splitPayment === true ? vat : 0n);
	return { lines, amounts, rows, cassa, cassaTotal, freeOfVat, bollo: { due, charged }, taxable, vat, total, ritenutaBase: invoice.ritenuta === undefined ? 0n : ritenutaBase, ritenuta, toPay };
}

/** Cents as FatturaPA writes an amount: a dot and two decimals («1234.50», «-2.00»). */
export function amount2(cents: bigint): string {
	const digits = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
	return `${cents < 0n ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** A canonical decimal with at least `min` decimals (FatturaPA's quantities and unit prices: 2 to 8). */
export function decimalAtLeast(value: string, min: number): string {
	const [integer = "0", fraction = ""] = value.split(".");
	return `${integer}.${fraction.padEnd(min, "0")}`;
}
