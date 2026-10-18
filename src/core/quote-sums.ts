/**
 * The arithmetic of a preventivo, exact: amounts are digit strings read into bigint cents, never
 * floats. Rounding is half up to the cent, once per line (quantity × price less the line's
 * discount) and once per VAT rate on the sum of its lines, as an invoice's riepilogo does; the
 * ritenuta is rounded once on the whole imponibile. Nothing here decides a tax rule: the rates,
 * the ritenuta and the bollo are applied only as the caller says.
 */
import { fromUnits, money } from "./fattura-pa.ts";

export class QuoteSumError extends Error {
	override readonly name = "QuoteSumError";
}

/** The VAT rates a quote line may carry; 0 needs the reason the person gives (natura). */
export const VAT_RATES = [22, 10, 5, 4, 0] as const;
export type VatRate = (typeof VAT_RATES)[number];

/** The ritenuta d'acconto, in percent, when the person asks for it. */
export const RITENUTA_RATE = 20;
/** The imposta di bollo and the amount without VAT past which it is due, in cents. */
export const BOLLO_CENTS = 200n;
export const BOLLO_THRESHOLD_CENTS = 7747n;

/** A line as stored: canonical decimal strings with a dot («500.00», «1.5», «12.5»). */
export type SumLine = { readonly quantity: string; readonly price: string; readonly discount?: string; readonly vat: VatRate };

export type RateTotal = { readonly rate: VatRate; readonly taxable: bigint; readonly vat: bigint };

export type QuoteTotals = {
	/** Each line's amount, after its discount, in cents. */
	readonly lines: readonly bigint[];
	/** Per rate, from the highest: imponibile and IVA in cents. */
	readonly rates: readonly RateTotal[];
	readonly taxable: bigint;
	readonly vat: bigint;
	/** 2,00 € when the bollo is charged, else 0. */
	readonly bollo: bigint;
	/** Imponibile + IVA + bollo. */
	readonly total: bigint;
	readonly ritenuta: bigint;
	/** Total less the ritenuta. */
	readonly net: bigint;
};

const DECIMAL = /^(\d{1,12})(?:\.(\d{1,4}))?$/;

/**
 * A number as a person writes it, to a canonical dot string: «1.234,56», «1234.56», «500», «€ 500»,
 * «12,5%». A dot alone is thousands only in groups of three («1.500» is 1500, «12.5» is 12.5).
 * At most `decimals` decimals; undefined when it is no number.
 */
export function readDecimal(input: string | number, decimals: number): string | undefined {
	let text = typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : input;
	text = text.replace(/[€%\s ]/g, "").replace(/^eur/i, "").replace(/eur(o)?$/i, "");
	if (text === "" || text.length > 30) return undefined;
	if (text.includes(",") && text.includes(".")) {
		// The last of the two separates decimals: 1.234,56 or 1,234.56.
		text = text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
	} else if (text.includes(",")) {
		if ((text.match(/,/g) ?? []).length > 1) return undefined;
		text = text.replace(",", ".");
	} else if (/^[1-9]\d{0,2}(?:\.\d{3})+$/.test(text)) {
		text = text.replace(/\./g, "");
	}
	const m = DECIMAL.exec(text);
	if (m === null) return undefined;
	const fraction = (m[2] ?? "").replace(/0+$/, "");
	if (fraction.length > decimals) return undefined;
	const integer = (m[1] as string).replace(/^0+(?=\d)/, "");
	return fraction === "" ? integer : `${integer}.${fraction}`;
}

/** A canonical decimal string scaled to an integer: «1.5» at scale 3 is 1500n. */
export function scaled(value: string, scale: number): bigint {
	const [integer, fraction = ""] = value.split(".");
	if (fraction.length > scale) throw new QuoteSumError(`too many decimals in ${value}`);
	return BigInt(`${integer}${fraction.padEnd(scale, "0")}`);
}

/** numerator / denominator rounded half up, both positive. */
function halfUp(numerator: bigint, denominator: bigint): bigint {
	return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Quantity to 3 decimals, price to 4, discount to 2: one line's amount in cents, rounded half up. */
export function lineCents(line: SumLine): bigint {
	const quantity = scaled(line.quantity, 3);
	const price = scaled(line.price, 4);
	const discount = line.discount === undefined ? 0n : scaled(line.discount, 2);
	// price × 100 cents / 1e4 × quantity / 1e3 × (1e4 − discount) / 1e4
	return halfUp(price * 100n * quantity * (10_000n - discount), 10_000n * 1_000n * 10_000n);
}

/** The quote's totals: lines, then per rate, then ritenuta and bollo when asked. */
export function quoteTotals(lines: readonly SumLine[], options: { readonly ritenuta?: boolean; readonly bollo?: boolean } = {}): QuoteTotals {
	const amounts = lines.map(lineCents);
	const byRate = new Map<VatRate, bigint>();
	lines.forEach((line, i) => byRate.set(line.vat, (byRate.get(line.vat) ?? 0n) + (amounts[i] as bigint)));
	const rates = [...byRate]
		.sort((a, b) => b[0] - a[0])
		.map(([rate, taxable]) => ({ rate, taxable, vat: halfUp(taxable * BigInt(rate), 100n) }));
	const taxable = rates.reduce((s, r) => s + r.taxable, 0n);
	const vat = rates.reduce((s, r) => s + r.vat, 0n);
	const bollo = options.bollo === true ? BOLLO_CENTS : 0n;
	const total = taxable + vat + bollo;
	const ritenuta = options.ritenuta === true ? halfUp(taxable * BigInt(RITENUTA_RATE), 100n) : 0n;
	return { lines: amounts, rates, taxable, vat, bollo, total, ritenuta, net: total - ritenuta };
}

/** The imponibile without VAT, in cents: what the bollo threshold is measured on. */
export function zeroRateCents(totals: QuoteTotals): bigint {
	return totals.rates.find((r) => r.rate === 0)?.taxable ?? 0n;
}

/** Whether the bollo applies by the threshold: amounts without VAT over 77,47 €. */
export function bolloDue(totals: QuoteTotals): boolean {
	return zeroRateCents(totals) > BOLLO_THRESHOLD_CENTS;
}

/** Cents written the Italian way: 1.234,56 €, a minus in front when negative. */
export function euros(cents: bigint): string {
	return money(fromUnits(cents * 1_000_000n), "EUR") as string;
}

/** A unit price as given, with at least two decimals: 0,0125 € or 500,00 €. */
export function priceText(price: string): string {
	return money(price, "EUR") as string;
}

/** A canonical decimal the Italian way, without forcing decimals: 1,5 or 1.000. */
export function decimalText(value: string): string {
	const [integer = "0", fraction] = value.split(".");
	const grouped = integer.replace(/\B(?=(\d{3})+$)/g, ".");
	return fraction === undefined ? grouped : `${grouped},${fraction}`;
}
