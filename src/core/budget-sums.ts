/**
 * How a budget is going in its current period, pure, in bigint cents, from what the registers read
 * (the tool reads them). Every figure is a register's own, reused:
 *
 * - everything spent: the business report's spese (business-report-sums.ts figuresIn): the
 *   expenses dated in the span and the supplier invoices paid in it that no expense stands for,
 *   each payment once; a payment an expense with another name may be is counted and said.
 * - one category: the expenses of that category dated in the span (expense-sums.ts totalsOf). A
 *   supplier invoice paid without an expense has no category: it counts only in everything spent
 *   and in its supplier's budget, and that is said.
 * - one supplier: what was spent with it, the suppliers tool's way (supplier-find.ts
 *   loadSuppliers, supplier-sums.ts spentIn): its invoices paid, with the payments the bank
 *   statement confirmed, and its expenses, each payment once. So a supplier's budget says what
 *   the suppliers tool says, while everything spent says what the business report says (which
 *   counts no bank confirmation): the two can differ by the payments only the bank confirmed.
 * - incassato and fatturato: the business report's (figuresIn): the money in by the day it was
 *   paid, IVA included, credit notes used less; the imponibile of the invoices issued by their
 *   date, credit notes less.
 *
 * The estimate at the end of the period is linear: what was done so far over the days gone, times
 * the days of the period. Too early in the period (ESTIMATE_MIN_TENTHS) there is none.
 */
import { BEHIND_PERCENT, type Budget, type BudgetSubject, ALERT_PERCENTS, type AlertLevel, ESTIMATE_MIN_TENTHS, type Every, isIncome } from "./budgets.ts";
import { figuresIn, type Sources } from "./business-report-sums.ts";
import { cents as expenseCents, totalsOf } from "./expense-sums.ts";
import { daysBetween } from "./italian-calendar.ts";
import { currentMonth, type Period, readPeriod } from "./periods.ts";
import { halfUp } from "./quote-sums.ts";
import { type Ledger, spentIn, type Supplier } from "./supplier-sums.ts";

/** What the figures are read from: the business report's sources, the suppliers' ledger (with the bank's confirmations), and how a budget's supplier is found again. */
export type BudgetFacts = {
	readonly sources: Sources;
	readonly ledger: Ledger;
	readonly supplierOf: (s: Extract<BudgetSubject, { kind: "supplier" }>) => Supplier | undefined;
};

/** The period of `day` a budget of this kind is counted in. */
export function periodFor(every: Every, day: string): Period {
	if (every === "month") return currentMonth(day);
	return readPeriod(every === "quarter" ? "trimestre" : "anno", day);
}

export type Progress = {
	readonly budget: Budget;
	readonly period: Period;
	/** The days counted: the period, from the budget's start when it is later. */
	readonly from: string;
	readonly to: string;
	/** The budget starts after this period. */
	readonly notYet?: true;
	/** Spent or earned so far; undefined when its register does not read, or the supplier is not found. */
	readonly actual?: bigint;
	readonly target: bigint;
	/** Actual over target, a whole percent rounded down; at least 101 above the target (100 only when exactly reached). */
	readonly percent?: number;
	/** Target less actual: negative when past it. */
	readonly left?: bigint;
	readonly elapsed: number;
	readonly days: number;
	/** The estimate at the end of the period, linear; undefined too early. On the last day, the actual. */
	readonly estimate?: bigint;
	readonly ended: boolean;
	/** Payments of supplier invoices an expense with another name may be: both counted, to be said. */
	readonly maybeTwins: number;
	/** Supplier invoices paid in the span with no expense, so with no category: out of a category's budget. */
	readonly uncategorized: number;
	/** A yearly income target: what is needed each month left (this one included) to reach it. */
	readonly monthly?: { readonly cents: bigint; readonly months: number };
	/** The supplier of the budget is not found in the registers any more. */
	readonly lost?: true;
};

/** Actual over target, a whole percent, rounded down; above the target at least 101, so 100% is only exactly reached. */
const pct = (a: bigint, t: bigint) => {
	const down = Number((a * 100n) / t);
	return a === t ? 100 : a < t ? down : Math.max(101, down);
};

/** How `budget` is going on `today`. */
export function progressOf(budget: Budget, facts: BudgetFacts, today: string): Progress {
	const period = periodFor(budget.every, today);
	const target = expenseCents(budget.amount);
	const from = budget.start !== undefined && budget.start > period.from ? budget.start : period.from;
	const days = daysBetween(from, period.to) + 1;
	const base = { budget, period, from, to: period.to, target, maybeTwins: 0, uncategorized: 0 };
	if (from > period.to || from > today) return { ...base, notYet: true, elapsed: 0, days: Math.max(days, 0), ended: false };
	const upTo = today < period.to ? today : period.to;
	const elapsed = daysBetween(from, upTo) + 1;
	const ended = upTo === period.to;
	const span = { from, to: upTo };
	let actual: bigint | undefined;
	let maybeTwins = 0;
	let uncategorized = 0;
	let lost = false;
	const s = budget.subject;
	const f = figuresIn(facts.sources, span);
	if (s.kind === "income") actual = s.measure === "fatturato" ? f.fatturato?.cents : f.incassato;
	else if (s.kind === "all") {
		actual = f.spese?.cents;
		maybeTwins = f.spese?.maybe?.length ?? 0;
	} else if (s.kind === "category") {
		const expenses = facts.sources.expenses;
		if (expenses !== undefined) actual = totalsOf(expenses, span).categories.find((c) => c.category === s.category)?.total ?? 0n;
		uncategorized = f.spese?.suppliers ?? 0;
	} else {
		const supplier = facts.supplierOf(s);
		if (supplier === undefined) lost = true;
		else if (facts.sources.expenses !== undefined) {
			const spent = spentIn(supplier, facts.ledger, from, upTo);
			actual = spent.cents;
			maybeTwins = spent.twins;
		}
	}
	const common = { ...base, elapsed, days, ended, maybeTwins, uncategorized, ...(lost ? { lost: true as const } : {}) };
	if (actual === undefined) return common;
	const estimate = ended ? actual : elapsed * 10 < days * ESTIMATE_MIN_TENTHS ? undefined : halfUp(actual * BigInt(days), BigInt(elapsed));
	let monthly: Progress["monthly"];
	if (isIncome(s) && budget.every === "year") {
		const months = 12 - Number(upTo.slice(5, 7)) + 1;
		const missing = target - actual;
		if (missing > 0n && !ended) monthly = { cents: halfUp(missing, BigInt(months)), months };
	}
	return { ...common, actual, percent: pct(actual, target), left: target - actual, ...(estimate === undefined ? {} : { estimate }), ...(monthly === undefined ? {} : { monthly }) };
}

/** An income target is clearly behind: in the last third of its period, its estimate under BEHIND_PERCENT of it. */
export function behind(p: Progress): boolean {
	if (!isIncome(p.budget.subject) || p.actual === undefined || p.estimate === undefined || p.ended || p.actual >= p.target) return false;
	return p.elapsed * 3 >= p.days * 2 && p.estimate * 100n < p.target * BigInt(BEHIND_PERCENT);
}

/** The alerts a budget's progress calls for now: a spending budget past 80% and 100%, an income target behind. */
export function alertsOf(p: Progress): AlertLevel[] {
	if (p.notYet === true || p.actual === undefined) return [];
	if (isIncome(p.budget.subject)) return behind(p) ? ["behind"] : [];
	// Past 80% at 80% and over; superato only past the amount: exactly the amount is reached, not exceeded.
	return ALERT_PERCENTS.filter((n) => p.actual !== undefined && (n === 100 ? p.actual > p.target : p.actual * 100n >= p.target * BigInt(n))).map((n) => String(n) as AlertLevel);
}
