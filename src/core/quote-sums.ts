/**
 * The arithmetic of a preventivo, exact: amounts are digit strings read into bigint cents, never
 * floats. Rounding is half up to the cent:
 * - a line: quantity × unit price less its discount, once;
 * - prices without VAT: per rate, the cassa on the sum of its lines, then the IVA on that
 *   imponibile, as an invoice's riepilogo does;
 * - prices with VAT included: per rate, the gross the person said is kept exactly: imponibile =
 *   gross × 100 / (100 + rate), IVA = gross − imponibile (said in a note when it is a cent off the
 *   rate times the imponibile); the lines are shown with VAT, as the person said them;
 * - ritenuta, acconto: once, on their base.
 * Nothing here decides a tax rule: rates, cassa, ritenuta and bollo apply only as the caller says.
 */
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

/**
 * A professional's social security charge on the fees, only when the person says so:
 * - `rivalsa_inps` (gestione separata INPS, usually 4%): part of the fee, so it takes VAT and is in
 *   the ritenuta's base;
 * - `contributo_integrativo` (casse professionali, usually 4% or 2%): takes VAT, but is not in the
 *   ritenuta's base (art. 25 DPR 600/1973 taxes the fee, not the contribution owed to the cassa).
 * Either way it is computed on the lines' imponibile, per VAT rate, before VAT.
 */
export const CASSA_KINDS = ["rivalsa_inps", "contributo_integrativo"] as const;
export type CassaKind = (typeof CASSA_KINDS)[number];
export type Cassa = { readonly kind: CassaKind; readonly rate: string; readonly label: string };

/** A line as stored: canonical decimal strings with a dot («500.00», «1.5», «12.5»). */
export type SumLine = { readonly quantity: string; readonly price: string; readonly discount?: string; readonly vat: VatRate };

export type SumOptions = { readonly ritenuta?: boolean; readonly bollo?: boolean; readonly includeVat?: boolean; readonly cassa?: Cassa; readonly deposit?: string };

export type RateTotal = { readonly rate: VatRate; readonly lines: bigint; readonly cassa: bigint; readonly taxable: bigint; readonly vat: bigint };

export type QuoteTotals = {
	/** Each line's amount as shown, after its discount: with VAT when the prices include it. */
	readonly lines: readonly bigint[];
	
	readonly rates: readonly RateTotal[];
	readonly cassa: bigint;
	readonly taxable: bigint;
	readonly vat: bigint;
	readonly bollo: bigint;
	/** Imponibile + IVA + bollo. */
	readonly total: bigint;
	readonly ritenuta: bigint;
	/** Total less the ritenuta: what the customer pays. */
	readonly net: bigint;
	readonly deposit: bigint;
	readonly balance: bigint;
	/** Rates whose IVA, taken out of prices with VAT, is a cent off the rate times the imponibile. */
	readonly byDifference: readonly VatRate[];
};

/** Returned by readDecimal for «1.250» or «1,500»: thousands or decimals, nobody can tell. */
export const AMBIGUOUS = "ambiguous" as const;

const DECIMAL = /^(\d{1,12})(?:\.(\d{1,8}))?$/;
const ITALIAN_GROUPED = /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/;
const ENGLISH_GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const THOUSANDS_DOTS = /^\d{1,3}(?:\.\d{3}){2,}$/;
const THOUSANDS_COMMAS = /^\d{1,3}(?:,\d{3}){2,}$/;
const ONE_SEPARATOR = /^(\d+)[.,](\d+)$/;
const NOISE = /[€%]|^\s*eur(?:o)?|eur(?:o)?\s*$/gi;
/** Spaces only between groups of three digits: «1 234,56»; «19 99» is no number. */
const SPACED = /^\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?$/;

/**
 * A number as a person writes it, to a canonical dot string. Clear forms: «1.234,56», «1,234.56»,
 * «1.234.567», «12,30», «1,5», «1.5», «€ 500», «22%». A single separator followed by exactly three
 * digits («1.250», «1,500») is AMBIGUOUS, unless the integer part is 0. A JSON number is read as
 * it is. Spaces only as thousands groups («1 234»). At most `decimals` decimals; undefined when it
 * is no number (also «1.5,3», «1,2.5», «19 99»).
 */
export function readDecimal(input: string | number, decimals: number): string | typeof AMBIGUOUS | undefined {
	let text: string;
	if (typeof input === "number") {
		if (!Number.isFinite(input) || input < 0) return undefined;
		text = String(input);
		if (/e/i.test(text)) return undefined;
	} else {
		text = input.replace(NOISE, "").trim();
		if (text === "" || text.length > 30) return undefined;
		if (/[\s\u00a0]/.test(text)) {
			if (!SPACED.test(text)) return undefined;
			text = text.replace(/[ \u00a0]/g, "");
		}
		if (text.includes(",") && text.includes(".")) {
			if (ITALIAN_GROUPED.test(text)) text = text.replace(/\./g, "").replace(",", ".");
			else if (ENGLISH_GROUPED.test(text)) text = text.replace(/,/g, "");
			else return undefined;
		} else if (THOUSANDS_DOTS.test(text)) text = text.replace(/\./g, "");
		else if (THOUSANDS_COMMAS.test(text)) text = text.replace(/,/g, "");
		else {
			const one = ONE_SEPARATOR.exec(text);
			if (one !== null) {
				if ((one[2] as string).length === 3 && !/^0+$/.test(one[1] as string)) return AMBIGUOUS;
				text = `${one[1]}.${one[2]}`;
			}
		}
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

/** Cents as a canonical decimal string, the inverse of scaled(…, 2): 4550n → «45.5», 4500n → «45». */
export function centsDecimal(value: bigint): string {
	const digits = (value < 0n ? -value : value).toString().padStart(3, "0");
	const fraction = digits.slice(-2).replace(/0+$/, "");
	const integer = digits.slice(0, -2);
	return `${value < 0n ? "-" : ""}${fraction === "" ? integer : `${integer}.${fraction}`}`;
}

/** numerator / denominator rounded half up, both positive. */
export function halfUp(numerator: bigint, denominator: bigint): bigint {
	return (numerator * 2n + denominator) / (denominator * 2n);
}

/** `cents` × `percent` (a decimal string, 2 decimals at most) / 100, half up. */
function percentOf(cents: bigint, percent: string): bigint {
	return halfUp(cents * scaled(percent, 2), 10_000n);
}

/** Quantity to 3 decimals, price to 4, discount to 2: one line's amount in cents, rounded half up. */
export function lineCents(line: SumLine): bigint {
	const quantity = scaled(line.quantity, 3);
	const price = scaled(line.price, 4);
	const discount = line.discount === undefined ? 0n : scaled(line.discount, 2);
	return halfUp(price * 100n * quantity * (10_000n - discount), 10_000n * 1_000n * 10_000n);
}

/** The imponibile in a gross amount at `rate`. */
export function netOf(gross: bigint, rate: VatRate): bigint {
	return halfUp(gross * 100n, BigInt(100 + rate));
}

/** The quote's totals: lines, then per rate, then ritenuta, bollo and acconto when asked. */
export function quoteTotals(lines: readonly SumLine[], options: SumOptions = {}): QuoteTotals {
	if (options.includeVat === true && options.cassa !== undefined) throw new QuoteSumError("cassa with VAT-inclusive prices");
	const amounts = lines.map(lineCents);
	const groups = new Map<VatRate, number[]>();
	lines.forEach((line, i) => groups.set(line.vat, [...(groups.get(line.vat) ?? []), i]));
	const rates: RateTotal[] = [];
	const byDifference: VatRate[] = [];
	for (const [rate, members] of [...groups].sort((a, b) => b[0] - a[0])) {
		const sum = members.reduce((s, i) => s + (amounts[i] as bigint), 0n);
		if (options.includeVat === true) {
			const taxable = netOf(sum, rate);
			const vat = sum - taxable;
			if (vat !== halfUp(taxable * BigInt(rate), 100n)) byDifference.push(rate);
			rates.push({ rate, lines: taxable, cassa: 0n, taxable, vat });
		} else {
			const cassa = options.cassa === undefined ? 0n : percentOf(sum, options.cassa.rate);
			const taxable = sum + cassa;
			rates.push({ rate, lines: sum, cassa, taxable, vat: halfUp(taxable * BigInt(rate), 100n) });
		}
	}
	const cassa = rates.reduce((s, r) => s + r.cassa, 0n);
	const taxable = rates.reduce((s, r) => s + r.taxable, 0n);
	const vat = rates.reduce((s, r) => s + r.vat, 0n);
	const bollo = options.bollo === true ? BOLLO_CENTS : 0n;
	const total = taxable + vat + bollo;
	// The fees, and the rivalsa INPS that is part of them; never the contributo integrativo nor the bollo.
	const ritenutaBase = rates.reduce((s, r) => s + r.lines, 0n) + (options.cassa?.kind === "rivalsa_inps" ? cassa : 0n);
	const ritenuta = options.ritenuta === true ? halfUp(ritenutaBase * BigInt(RITENUTA_RATE), 100n) : 0n;
	const net = total - ritenuta;
	const deposit = options.deposit === undefined ? 0n : percentOf(net, options.deposit);
	return { lines: amounts, rates, cassa, taxable, vat, bollo, total, ritenuta, net, deposit, balance: net - deposit, byDifference };
}

/** The imponibile without VAT, in cents: what the bollo threshold is measured on. */
export function zeroRateCents(totals: QuoteTotals): bigint {
	return totals.rates.find((r) => r.rate === 0)?.taxable ?? 0n;
}

/** Whether the bollo applies by the threshold: amounts without VAT over 77,47 €. */
export function bolloDue(totals: QuoteTotals): boolean {
	return zeroRateCents(totals) > BOLLO_THRESHOLD_CENTS;
}

/** A canonical decimal the Italian way, without forcing decimals: 1,5 or 1.000. */
export function decimalText(value: string): string {
	const [integer = "0", fraction] = value.split(".");
	const grouped = integer.replace(/\B(?=(\d{3})+$)/g, ".");
	return fraction === undefined ? grouped : `${grouped},${fraction}`;
}
