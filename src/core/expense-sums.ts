/**
 * The arithmetic of the spese, exact: amounts are canonical decimal strings read into bigint
 * cents (quote-sums.ts' scaled), never floats; the VAT taken out of a total with a rate is the
 * total less its imponibile rounded half up, as a preventivo with prices VAT included does. The
 * periods asked about, and the one before to compare against, are in periods.ts.
 */
import { CATEGORIES, type Category, type Expense, ExpenseError } from "./expenses.ts";
import { inPeriod, type Span } from "./periods.ts";
import { centsDecimal, netOf, scaled, type VatRate } from "./quote-sums.ts";

/** A canonical decimal string («42.5») in cents. */
export function cents(value: string): bigint {
	return scaled(value, 2);
}

/** Cents back to a canonical decimal string: 4250n → «42.5». Never negative: a stored amount is not. */
export function centsValue(value: bigint): string {
	if (value < 0n) throw new ExpenseError("un importo negativo non si salva");
	return centsDecimal(value);
}

/** The VAT in a total that includes it at `rate`: the total less its imponibile. */
export function vatInGross(gross: bigint, rate: VatRate): bigint {
	return gross - netOf(gross, rate);
}

export type CategoryTotal = { readonly category: Category; readonly total: bigint; readonly count: number };

export type Totals = {
	readonly count: number;
	/** The totals paid, VAT included. */
	readonly total: bigint;
	/** The VAT recorded; `withoutVat` expenses have none recorded. */
	readonly vat: bigint;
	readonly withoutVat: number;
	/** Largest first; a tie by the list's order. */
	readonly categories: readonly CategoryTotal[];
};

/** The totals of the expenses dated in `span`. */
export function totalsOf(expenses: readonly Expense[], span: Span): Totals {
	const within = expenses.filter((e) => inPeriod(e.date, span));
	const byCategory = new Map<Category, { total: bigint; count: number }>();
	let total = 0n;
	let vat = 0n;
	let withoutVat = 0;
	for (const e of within) {
		const amount = cents(e.amount);
		total += amount;
		if (e.vat === undefined) withoutVat++;
		else vat += cents(e.vat);
		const seen = byCategory.get(e.category) ?? { total: 0n, count: 0 };
		byCategory.set(e.category, { total: seen.total + amount, count: seen.count + 1 });
	}
	const categories = [...byCategory]
		.map(([category, s]) => ({ category, ...s }))
		.sort((x, y) => (x.total === y.total ? CATEGORIES.indexOf(x.category) - CATEGORIES.indexOf(y.category) : x.total > y.total ? -1 : 1));
	return { count: within.length, total, vat, withoutVat, categories };
}
