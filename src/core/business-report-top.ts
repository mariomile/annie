/**
 * The ranking of the business report, pure: the clients by what they paid in a span (the clients'
 * own grouping and ranking, client-sums.ts) with how concentrated the money is (the first
 * client's share and the first three's), and the expense categories by what was spent (the
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
	/** The first client is past the clients' concentration threshold. */
	readonly concentrated: boolean;
};

export function topClients(registers: ClientRegisters, span: Span, dayOf: (at: string) => string): TopClients {
	const { rows, total } = ranked(clientsOf(registers), span.from, span.to, "collected", dayOf);
	const share = (list: readonly Ranked[]) => (total === 0n ? 0n : halfUp(list.reduce((n, r) => n + r.cents, 0n) * 100n, total));
	const top = rows[0];
	return {
		rows: rows.slice(0, REPORT_LIMITS.topClients),
		total,
		clients: rows.length,
		first: share(rows.slice(0, 1)),
		firstThree: share(rows.slice(0, 3)),
		concentrated: top !== undefined && rows.length > 1 && concentrated(top.cents, total),
	};
}

/** The categories spent most on in the span, at most REPORT_LIMITS.topCategories, and the expenses' total. */
export function topCategories(expenses: readonly Expense[], span: Span): { readonly rows: readonly CategoryTotal[]; readonly total: bigint } {
	const t = totalsOf(expenses, span);
	return { rows: t.categories.slice(0, REPORT_LIMITS.topCategories), total: t.total };
}
