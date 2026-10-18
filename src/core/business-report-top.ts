/**
 * The ranking of the business report, pure: the clients by what they paid in a span (the clients'
 * own grouping and ranking, client-sums.ts) with how concentrated the money is (the first
 * client's share and the first three's, and when that is worth a warning), and the expense categories by what was spent (the
 * expenses' own totals, expense-sums.ts).
 */
import { REPORT_LIMITS, type Span } from "./business-report.ts";
import { type ClientRegisters, clientsOf, concentrated, type Ranked, ranked } from "./client-sums.ts";
import type { Expense } from "./expenses.ts";
import { type CategoryTotal, totalsOf } from "./expense-sums.ts";
import { halfUp } from "./quote-sums.ts";

export type TopClients = {
	readonly rows: readonly Ranked[];
	/** All the clients' collected in the span. */
	readonly total: bigint;
	readonly clients: number;
	/** Whole percent of the total: the first client's, and the first three's together. */
	readonly first: bigint;
	readonly firstThree: bigint;
	/** The money depends on one client (see reportConcentrated). */
	readonly concentrated: boolean;
	/** Two clients only, close to even (the first at EVEN_PERCENT or less). */
	readonly even: boolean;
};

/** Two clients are «quasi alla pari» when the first has at most this share. */
export const EVEN_PERCENT = 55n;

/**
 * Whether the report warns that the money depends on one client. With two clients: the first has
 * 60% or more and at least twice the second. With three or more: past the clients' own threshold
 * (client-sums.ts concentrated, unchanged for the clients tool), and also twice the second or over
 * half of the total. One client is said apart.
 */
export function reportConcentrated(cents: readonly bigint[], total: bigint): boolean {
	const [first, second] = cents;
	if (first === undefined || second === undefined || total <= 0n) return false;
	const twice = first >= second * 2n;
	if (cents.length === 2) return first * 100n >= total * 60n && twice;
	return concentrated(first, total) && (twice || first * 2n > total);
}

export function topClients(registers: ClientRegisters, span: Span, dayOf: (at: string) => string): TopClients {
	const { rows, total } = ranked(clientsOf(registers), span.from, span.to, "collected", dayOf);
	const share = (list: readonly Ranked[]) => (total === 0n ? 0n : halfUp(list.reduce((n, r) => n + r.cents, 0n) * 100n, total));
	const first = share(rows.slice(0, 1));
	return {
		rows: rows.slice(0, REPORT_LIMITS.topClients),
		total,
		clients: rows.length,
		first,
		firstThree: share(rows.slice(0, 3)),
		concentrated: reportConcentrated(
			rows.map((r) => r.cents),
			total,
		),
		even: rows.length === 2 && first <= EVEN_PERCENT,
	};
}

/** The categories spent most on in the span, at most REPORT_LIMITS.topCategories, and the expenses' total. */
export function topCategories(expenses: readonly Expense[], span: Span): { readonly rows: readonly CategoryTotal[]; readonly total: bigint } {
	const t = totalsOf(expenses, span);
	return { rows: t.categories.slice(0, REPORT_LIMITS.topCategories), total: t.total };
}
