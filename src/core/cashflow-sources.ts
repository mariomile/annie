/**
 * What the previsione di cassa gathers from each register, as movements of money on a day, read
 * only: the open instalments of the scadenzario (to collect: in, to pay: out), the payments of the
 * active renewals, the voci added by hand (and the hypothetical ones of a what_if), the average
 * spending from the expenses and the unbilled hours (said, never counted). Pure functions on what
 * the stores read; «today» and the horizon's last day are passed in.
 *
 * Choices, tested:
 * - Invoices: only those whose side is known (the company is set), in euros, with an amount and a
 *   due date; each instalment on its due date (the client pays on the day). An instalment overdue
 *   (its payable day, a weekend moved on, gone) is put on today: to collect, flagged «in ritardo»
 *   and left out with includeOverdue false; to pay, always (the money is owed). Open credit notes
 *   come off their own party's open instalments, soonest due first, never below zero; what is left
 *   of them is said. Instalments without a due date, in another currency or without an amount
 *   are counted apart and said.
 * - Renewals: active only (a cancelled one never pays again); every payment from its effective
 *   due date (renewal-dates.ts) to the horizon at the price of that payment (amountAt), autoPay or
 *   by hand alike. One waiting for the person's word (a manual due date gone, or a renewal by
 *   itself not confirmed paid) is not put on a day: it is said, with its amount.
 * - Average spending: the expenses of the AVERAGE_DAYS days before today (today left out), less
 *   the payments the renewals recorded as expenses (counted as renewals already), divided by
 *   AVERAGE_DAYS and rounded half up to the cent once: the same amount every day of the horizon.
 * - Voci: once on their date, or every `months` months keeping their day, up to `until`; only
 *   what falls from today to the horizon's end.
 */
import { AVERAGE_DAYS, type CashItem, type Kind } from "./cashflow.ts";
import { unitsToCents } from "./cash-book.ts";
import type { Expense } from "./expenses.ts";
import { cents as expenseCents } from "./expense-sums.ts";
import { payDay } from "./invoice-sums.ts";
import { type Instalment, type Invoice, openAmount, partyKey } from "./invoices.ts";
import { addDays } from "./italian-calendar.ts";
import { halfUp, scaled } from "./quote-sums.ts";
import { datesBetween, rollDate } from "./recurrence.ts";
import { amountAt, effectiveDue, occurrences } from "./renewal-dates.ts";
import type { Renewal } from "./renewals.ts";
import { summarize } from "./timesheet-sums.ts";
import type { RateRule, WorkEntry } from "./timesheet.ts";

export type Source = "invoice" | "renewal" | "item" | "whatif" | "average";

/** A hypothetical voce of a what_if: never stored. */
export type Hypothetical = { readonly kind: Kind; readonly cents: bigint; readonly date: string; readonly months?: number; readonly day?: number; readonly name?: string };

export type Movement = {
	readonly date: string;
	readonly kind: Kind;
	/** More than zero: the kind says the sign. */
	readonly cents: bigint;
	readonly source: Source;
	/** Overdue, put on today: `due` is the day it was due. */
	readonly late?: true;
	readonly due?: string;
	readonly invoice?: Invoice;
	readonly instalment?: { readonly n: number; readonly count: number };
	readonly renewal?: Renewal;
	readonly item?: CashItem;
	readonly hypothetical?: Hypothetical;
};

export type InvoiceFlows = {
	/** Inside the horizon: the overdue to pay on today, the overdue to collect on today when included. */
	readonly movements: readonly Movement[];
	/** To collect, overdue: listed apart, on today. */
	readonly late: readonly Movement[];
	/** Open instalments without a due date, by direction: not counted. */
	readonly undated: { readonly count: number; readonly in: bigint; readonly out: bigint };
	/** Invoices left out: in another currency; with an instalment whose amount does not read; whose side is not known. */
	readonly otherCurrency: number;
	readonly unreadable: number;
	readonly noSide: number;
	/** What is left of the open credit notes once taken off their party's instalments, by direction. */
	readonly creditLeft: { readonly in: bigint; readonly out: bigint };
};

/** The party on the other side: the customer of an invoice to collect, the supplier of one to pay. */
function counterparty(i: Invoice): string {
	return partyKey(i.side === "active" ? i.customer : i.supplier);
}

type Open = { readonly invoice: Invoice; readonly instalment: Instalment; readonly due: string; units: bigint };

/** The open instalments of the scadenzario as movements (see the choices above). */
export function invoiceFlows(invoices: readonly Invoice[], today: string, end: string, includeOverdue: boolean): InvoiceFlows {
	const open: Open[] = [];
	const foreign = new Set<string>();
	const unreadable = new Set<string>();
	const noSide = new Set<string>();
	const undated = { count: 0, in: 0n, out: 0n };
	for (const invoice of invoices) {
		if (invoice.credit || invoice.doc.integration) continue;
		for (const instalment of invoice.instalments) {
			if (instalment.paid !== undefined || instalment.extra === true) continue;
			if (invoice.side === undefined) {
				noSide.add(invoice.key);
				continue;
			}
			if (invoice.doc.currency !== "EUR") {
				foreign.add(invoice.key);
				continue;
			}
			if (instalment.amount === undefined) {
				unreadable.add(invoice.key);
				continue;
			}
			if (instalment.amount <= 0n) continue;
			if (instalment.due === undefined) {
				undated.count++;
				undated[invoice.side === "active" ? "in" : "out"] += unitsToCents(instalment.amount);
				continue;
			}
			open.push({ invoice, instalment, due: instalment.due, units: instalment.amount });
		}
	}
	// Open credit notes off their own party's open instalments, soonest due first.
	const credits = new Map<string, bigint>();
	for (const invoice of invoices) {
		if (!invoice.credit || invoice.paid || invoice.doc.integration || invoice.side === undefined || invoice.doc.currency !== "EUR") continue;
		const key = `${invoice.side}|${counterparty(invoice)}`;
		credits.set(key, (credits.get(key) ?? 0n) + openAmount(invoice));
	}
	open.sort((a, b) => a.due.localeCompare(b.due) || (a.invoice.doc.date ?? "").localeCompare(b.invoice.doc.date ?? "") || a.instalment.n - b.instalment.n);
	for (const o of open) {
		const key = `${o.invoice.side}|${counterparty(o.invoice)}`;
		const credit = credits.get(key) ?? 0n;
		if (credit <= 0n) continue;
		const taken = credit < o.units ? credit : o.units;
		o.units -= taken;
		credits.set(key, credit - taken);
	}
	const creditLeft = { in: 0n, out: 0n };
	for (const [key, units] of credits) creditLeft[key.startsWith("active|") ? "in" : "out"] += unitsToCents(units);
	const movements: Movement[] = [];
	const late: Movement[] = [];
	for (const o of open) {
		if (o.units <= 0n) continue;
		const kind: Kind = o.invoice.side === "active" ? "in" : "out";
		const base = { kind, cents: unitsToCents(o.units), source: "invoice" as const, invoice: o.invoice, instalment: { n: o.instalment.n, count: o.invoice.instalments.length } };
		if (payDay(o.due) < today) {
			const m: Movement = { ...base, date: today, late: true, due: o.due };
			if (kind === "in") {
				late.push(m);
				if (includeOverdue) movements.push(m);
			} else movements.push(m);
			continue;
		}
		const date = o.due < today ? today : o.due;
		if (date <= end) movements.push({ ...base, date });
	}
	return { movements, late, undated, otherCurrency: foreign.size, unreadable: unreadable.size, noSide: noSide.size, creditLeft };
}

export type RenewalFlows = {
	readonly movements: readonly Movement[];
	/** Active renewals with a payment in the horizon but no amount: not counted. */
	readonly withoutAmount: number;
	/** Waiting for the person's word (a manual due gone, or renewed by itself and not confirmed paid): not counted, said. */
	readonly waiting: { readonly count: number; readonly cents: bigint; readonly unpriced: number };
};

/** The payments of the active renewals from today to `end`, each at its own price (see the choices above). */
export function renewalFlows(renewals: readonly Renewal[], today: string, end: string): RenewalFlows {
	const movements: Movement[] = [];
	const unpriced = new Set<string>();
	const waiting = { count: 0, cents: 0n, unpriced: 0 };
	for (const r of renewals) {
		if (r.status !== "active") continue;
		if (r.autoPay !== true && r.due < today) {
			waiting.count++;
			// A renewal by itself waits for every period gone since its due date; a manual one for that date only.
			const gone = r.autoRenew ? occurrences(r, r.due, r.due, addDays(today, -1)) : [r.due];
			for (const d of gone) {
				const amount = amountAt(r, d);
				if (amount === undefined) waiting.unpriced++;
				else waiting.cents += scaled(amount, 2);
			}
			// A manual one never moves by itself: nothing more until the person says.
			if (!r.autoRenew) continue;
		}
		for (const date of occurrences(r, effectiveDue(r, today), today, end)) {
			const amount = amountAt(r, date);
			if (amount === undefined) {
				unpriced.add(r.id);
				continue;
			}
			movements.push({ date, kind: "out", cents: scaled(amount, 2), source: "renewal", renewal: r });
		}
	}
	return { movements, withoutAmount: unpriced.size, waiting };
}

/** The first date on or after `from` - one period, stepping from `first`: a long-running voce does not walk its whole past. */
function caughtUp(first: string, months: number, day: number, from: string): string {
	if (first >= from) return first;
	const gone = (Number(from.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(first.slice(5, 7));
	const steps = Math.floor(gone / months) - 1;
	return steps > 0 ? rollDate(first, steps * months, day) : first;
}

/** The days of a voce from `from` to `to`: once, or every `months` months keeping `day`, up to `until`. */
export function datesOf(v: { readonly date: string; readonly months?: number; readonly day?: number; readonly until?: string }, from: string, to: string): string[] {
	if (v.months === undefined || v.day === undefined) return v.date >= from && v.date <= to ? [v.date] : [];
	const last = v.until !== undefined && v.until < to ? v.until : to;
	return datesBetween(caughtUp(v.date, v.months, v.day, from), v.months, v.day, from, last);
}

/** The voci added by hand, from today to `end`. */
export function itemFlows(items: readonly CashItem[], today: string, end: string): Movement[] {
	return items.flatMap((item) => datesOf(item, today, end).map((date): Movement => ({ date, kind: item.kind, cents: scaled(item.amount, 2), source: "item", item })));
}

/** The hypothetical voci of a what_if, from today to `end`. */
export function hypotheticalFlows(items: readonly Hypothetical[], today: string, end: string): Movement[] {
	return items.flatMap((h) => datesOf(h, today, end).map((date): Movement => ({ date, kind: h.kind, cents: h.cents, source: "whatif", hypothetical: h })));
}

export type AverageSpend = {
	/** The days the average is taken from, both included: the AVERAGE_DAYS before today. */
	readonly from: string;
	readonly to: string;
	readonly total: bigint;
	readonly count: number;
	/** total / AVERAGE_DAYS, half up to the cent. */
	readonly perDay: bigint;
	/** Expenses left out: payments of renewals (counted as renewals). */
	readonly renewalPayments: number;
};

/** The average spending per day (see the choices above). */
export function averageSpend(expenses: readonly Expense[], renewals: readonly Renewal[], today: string): AverageSpend {
	const from = addDays(today, -AVERAGE_DAYS);
	const to = addDays(today, -1);
	const ofRenewals = new Set<string>();
	for (const r of renewals) {
		for (const roll of r.rolls ?? []) if (roll.expense !== undefined) ofRenewals.add(roll.expense);
		for (const c of r.charges ?? []) ofRenewals.add(c.expense);
	}
	let total = 0n;
	let count = 0;
	let renewalPayments = 0;
	for (const e of expenses) {
		if (e.date < from || e.date > to) continue;
		if (ofRenewals.has(e.id)) {
			renewalPayments++;
			continue;
		}
		total += expenseCents(e.amount);
		count++;
	}
	return { from, to, total, count, perDay: halfUp(total, BigInt(AVERAGE_DAYS)), renewalPayments };
}

/** The billable hours not billed at all, with their amount where a rate is known: a potential, never counted. */
export function unbilledPotential(entries: readonly WorkEntry[], rates: readonly RateRule[]): { readonly minutes: number; readonly cents: bigint; readonly unpriced: number } {
	const { unbilled } = summarize(entries, rates).totals;
	return { minutes: unbilled.minutes, cents: unbilled.amount, unpriced: unbilled.unpriced };
}
