/**
 * The arithmetic of the rinnovi, exact: amounts are canonical decimal strings read into bigint
 * cents, never floats. The yearly cost of a renewal is its amount × the periods in a year
 * (12 / months): exact for mensile (×12), bimestrale (×6), trimestrale (×4), quadrimestrale (×3),
 * semestrale (×2), annuale (×1); for any other period (biennale, ogni 18 mesi…) amount × 12 /
 * months in cents, rounded half up per renewal, at the amount of the next payment as of today
 * (a price change counts from its date). Totals add those yearly costs; the monthly
 * equivalent of a total (and of a category's) is its yearly total / 12, rounded half up once.
 */
import { eurosToCents, halfUp } from "./quote-sums.ts";
import { currentAmount } from "./renewal-dates.ts";
import { CATEGORIES, type Category, type Renewal } from "./renewals.ts";

/** A canonical decimal string («480», «12.5») in cents (quote-sums.ts). */
export const cents = eurosToCents;

/** The yearly cost of `amount` cents every `months` months, half up to the cent. */
export function yearlyCents(amount: bigint, months: number): bigint {
	return halfUp(amount * 12n, BigInt(months));
}

/** The yearly cost of a renewal at the amount of its next payment as of today; undefined without an amount. */
export function yearlyOf(r: Renewal, today: string): bigint | undefined {
	const amount = currentAmount(r, today);
	return amount === undefined ? undefined : yearlyCents(cents(amount), r.months);
}

/** The monthly equivalent of a yearly total, half up. */
export function monthlyOf(yearly: bigint): bigint {
	return halfUp(yearly, 12n);
}

export type CategoryCost = { readonly category: Category; readonly yearly: bigint; readonly monthly: bigint; readonly count: number };

export type Costs = {
	/** The renewals counted, with an amount. */
	readonly count: number;
	readonly yearly: bigint;
	readonly monthly: bigint;
	/** Largest first; a tie by the list's order. */
	readonly categories: readonly CategoryCost[];
	/** Largest yearly cost first, at most `top`. */
	readonly biggest: readonly { readonly renewal: Renewal; readonly yearly: bigint }[];
	/** The renewals without an amount: not in the totals. */
	readonly withoutAmount: readonly Renewal[];
};

/** The costs of the renewals given (the caller picks the active ones). */
export function costsOf(renewals: readonly Renewal[], today: string, top = 5): Costs {
	const byCategory = new Map<Category, { yearly: bigint; count: number }>();
	const priced: { renewal: Renewal; yearly: bigint }[] = [];
	const withoutAmount: Renewal[] = [];
	let yearly = 0n;
	for (const r of renewals) {
		const y = yearlyOf(r, today);
		if (y === undefined) {
			withoutAmount.push(r);
			continue;
		}
		yearly += y;
		priced.push({ renewal: r, yearly: y });
		const seen = byCategory.get(r.category) ?? { yearly: 0n, count: 0 };
		byCategory.set(r.category, { yearly: seen.yearly + y, count: seen.count + 1 });
	}
	const categories = [...byCategory]
		.map(([category, s]) => ({ category, ...s, monthly: monthlyOf(s.yearly) }))
		.sort((a, b) => (a.yearly === b.yearly ? CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) : a.yearly > b.yearly ? -1 : 1));
	const biggest = priced.sort((a, b) => (a.yearly === b.yearly ? a.renewal.id.localeCompare(b.renewal.id) : a.yearly > b.yearly ? -1 : 1)).slice(0, top);
	return { count: priced.length, yearly, monthly: monthlyOf(yearly), categories, biggest, withoutAmount };
}
