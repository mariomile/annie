/**
 * What the previsione di cassa gathers from each register, as movements of money on a day, read
 * only: the open instalments of the scadenzario (to collect: in, to pay: out), the accepted quotes
 * not invoiced yet, the payments of the active renewals, the voci added by hand (and the
 * hypothetical ones of a what_if), the average spending from the expenses and the unbilled hours
 * (said, never counted). Pure functions on what the stores read; «today» and the horizon's last
 * day are passed in.
 *
 * Choices, tested:
 * - Invoices: only those whose side is known (the company is set), in euros, with an amount and a
 *   due date; each instalment on its due date (the client pays on the day). An instalment overdue
 *   (its payable day, a weekend moved on, gone) is put on today: to collect, flagged «in ritardo»
 *   and left out with includeOverdue false; to pay, always, listed apart with its total. Overdue
 *   more than STALE_OVERDUE_DAYS, either side: out of the projection, listed with a question (paid
 *   already?). Open credit notes come off their own party's open instalments, soonest due first,
 *   never below zero; what is left of them is said. Instalments without a due date, in another
 *   currency or without an amount are counted apart and said.
 * - Renewals: active only; every payment from its effective due date to the horizon at the price
 *   of that payment, autoPay or by hand alike. One waiting for the person's word is said, not put
 *   on a day. A supplier invoice that is the same payment as a renewal (the provider's name or
 *   partita IVA, the amount within SAME_AMOUNT_PERCENT, the dates within one period) counts once,
 *   as the invoice, and is listed as a probable duplicate; an overdue supplier invoice of an
 *   autoPay renewal is paid by direct debit, never an overdue payable.
 * - Quotes: the latest revision of each accepted quote, what the customer pays less the invoices
 *   to that customer dated from the quote on (each invoice once, oldest quote first), expected
 *   QUOTE_PAY_DAYS after its acceptance and never before QUOTE_MIN_DAYS from today.
 * - Average spending: the expenses of the AVERAGE_DAYS days before today (today left out), less
 *   the supplier invoices (docType fattura: the scadenzario counts them), the payments the renewals
 *   recorded, and the categories an active renewal or a voce covers already; divided by the days
 *   since the first expense of the window, between AVERAGE_MIN_DAYS and AVERAGE_DAYS, half up to the cent.
 * - Voci: once on their date, or every so many months keeping their day, or every so many days,
 *   up to `until`, at the amount of that day; only what falls from today to the horizon's end.
 * - A balance said before today is brought to today: plus the invoices to collect marked paid
 *   after its day, less the expenses recorded after it, the autoPay renewals charged after it
 *   (not recorded as expenses) and the voci of those days.
 */
import { AVERAGE_DAYS, AVERAGE_MIN_DAYS, type CashItem, itemAmountAt, itemRecurrence, type Kind, SAME_AMOUNT_PERCENT, STALE_OVERDUE_DAYS } from "./cashflow.ts";
import { cashBook, unitsToCents } from "./cash-book.ts";
import { type Category as ExpenseCategory, type Expense, matchCategory } from "./expenses.ts";
import { cents as expenseCents } from "./expense-sums.ts";
import { payDay } from "./invoice-sums.ts";
import { type Instalment, type Invoice, matchesParty, openAmount, partyKey } from "./invoices.ts";
import { addDays, daysBetween } from "./italian-calendar.ts";
import { latest, type Quote, quoteTotalsOf } from "./quotes.ts";
import { halfUp, scaled } from "./quote-sums.ts";
import { type Recurrence, recurringDates } from "./recurrence.ts";
import { amountAt, effectiveDue, occurrences } from "./renewal-dates.ts";
import { EXPENSE_CATEGORY, type Renewal } from "./renewals.ts";
import { fold } from "./text-match.ts";
import { summarize } from "./timesheet-sums.ts";
import type { RateRule, WorkEntry } from "./timesheet.ts";

export type Source = "invoice" | "quote" | "renewal" | "item" | "whatif" | "average";

/** An accepted quote is expected this many days after its acceptance, and never before QUOTE_MIN_DAYS from today. */
export const QUOTE_PAY_DAYS = 60;
export const QUOTE_MIN_DAYS = 30;

/** A hypothetical voce of a what_if: never stored. */
export type Hypothetical = { readonly kind: Kind; readonly cents: bigint; readonly date: string; readonly months?: number; readonly day?: number; readonly everyDays?: number; readonly name?: string };

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
	readonly quote?: Quote;
	readonly item?: CashItem;
	readonly hypothetical?: Hypothetical;
	/** Moved by a what_if delay: the days. */
	readonly delayed?: number;
};

export type InvoiceFlows = {
	/** Inside the horizon: the overdue to pay on today, the overdue to collect on today when included. */
	readonly movements: readonly Movement[];
	/** To collect, overdue (up to STALE_OVERDUE_DAYS): listed apart, on today. */
	readonly late: readonly Movement[];
	/** To pay, overdue (up to STALE_OVERDUE_DAYS): counted on today, listed apart. */
	readonly latePay: readonly Movement[];
	/** Overdue more than STALE_OVERDUE_DAYS, either side: out of the projection, asked about. */
	readonly stale: readonly Movement[];
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
	const latePay: Movement[] = [];
	const stale: Movement[] = [];
	for (const o of open) {
		if (o.units <= 0n) continue;
		const kind: Kind = o.invoice.side === "active" ? "in" : "out";
		const base = { kind, cents: unitsToCents(o.units), source: "invoice" as const, invoice: o.invoice, instalment: { n: o.instalment.n, count: o.invoice.instalments.length } };
		const payable = payDay(o.due);
		if (payable < today) {
			const m: Movement = { ...base, date: today, late: true, due: o.due };
			if (daysBetween(payable, today) > STALE_OVERDUE_DAYS) stale.push(m);
			else if (kind === "in") {
				late.push(m);
				if (includeOverdue) movements.push(m);
			} else {
				latePay.push(m);
				movements.push(m);
			}
			continue;
		}
		const date = o.due < today ? today : o.due;
		if (date <= end) movements.push({ ...base, date });
	}
	return { movements, late, latePay, stale, undated, otherCurrency: foreign.size, unreadable: unreadable.size, noSide: noSide.size, creditLeft };
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

/** Within SAME_AMOUNT_PERCENT of each other. */
export function sameAmount(a: bigint, b: bigint): boolean {
	const big = a > b ? a : b;
	const diff = a > b ? a - b : b - a;
	return diff * 100n <= big * SAME_AMOUNT_PERCENT;
}

/** The supplier invoice is from the renewal's provider (its name or partita IVA), or names the renewal. */
function fromProvider(invoice: Invoice, r: Renewal): boolean {
	return (r.provider !== undefined && matchesParty(invoice.supplier, r.provider)) || matchesParty(invoice.supplier, r.name);
}

/** A renewal's period in days, at least a week: how far an invoice's date may be from the payment. */
function periodDays(r: Renewal): number {
	return Math.max(7, Math.min(r.months * 31, 366));
}

export type Duplicate = { readonly invoice: Movement; readonly renewal: Movement };

/**
 * The supplier invoices that are a renewal's payment: the renewal's movement goes, the invoice
 * stays, the pair is listed. And the overdue supplier invoices of an autoPay renewal: paid by
 * direct debit, out of the overdue (and of the movements).
 */
export function dedupe(invoices: InvoiceFlows, renewals: RenewalFlows | undefined, all: readonly Renewal[]): { readonly invoices: InvoiceFlows; readonly renewals: RenewalFlows | undefined; readonly duplicates: readonly Duplicate[]; readonly autoPaid: readonly Movement[] } {
	const autoPay = all.filter((r) => r.status === "active" && r.autoPay === true && r.amount !== undefined);
	const debited = (m: Movement) => m.invoice !== undefined && autoPay.some((r) => fromProvider(m.invoice as Invoice, r) && sameAmount(m.cents, scaled(amountAt(r, m.due ?? m.date) ?? r.amount ?? "0", 2)));
	const autoPaid = [...invoices.latePay, ...invoices.stale.filter((m) => m.kind === "out")].filter(debited);
	const gone = new Set<Movement>(autoPaid);
	const kept = renewals === undefined ? [] : [...renewals.movements];
	const duplicates: Duplicate[] = [];
	for (const m of invoices.movements) {
		if (m.kind !== "out" || m.invoice === undefined || gone.has(m)) continue;
		const day = m.due ?? m.date;
		const at = kept.findIndex((r) => r.renewal !== undefined && fromProvider(m.invoice as Invoice, r.renewal) && sameAmount(m.cents, r.cents) && Math.abs(daysBetween(day, r.date)) <= periodDays(r.renewal));
		if (at < 0) continue;
		duplicates.push({ invoice: m, renewal: kept[at] as Movement });
		kept.splice(at, 1);
	}
	const fixed: InvoiceFlows = gone.size === 0 ? invoices : { ...invoices, movements: invoices.movements.filter((m) => !gone.has(m)), latePay: invoices.latePay.filter((m) => !gone.has(m)), stale: invoices.stale.filter((m) => !gone.has(m)) };
	return { invoices: fixed, renewals: renewals === undefined ? undefined : { ...renewals, movements: kept }, duplicates, autoPaid };
}

export type QuoteFlows = {
	readonly movements: readonly Movement[];
	/** Accepted quotes with something left to invoice, inside the horizon or not. */
	readonly count: number;
	/** Accepted quotes expected after the horizon's end: not counted. */
	readonly beyond: number;
	/** Accepted quotes all invoiced already. */
	readonly invoiced: number;
};

/** What an invoice is worth, every instalment, in cents. */
function invoiceCents(i: Invoice): bigint {
	return i.instalments.reduce((n, x) => n + (x.amount === undefined || x.extra === true ? 0n : unitsToCents(x.amount)), 0n);
}

/** The accepted quotes not invoiced yet, as money expected (see the choices above). */
export function quoteFlows(quotes: readonly Quote[], invoices: readonly Invoice[], today: string, end: string, dayOf: (at: string) => string): QuoteFlows {
	const accepted = latest(quotes)
		.filter((q) => q.status === "accepted")
		.sort((a, b) => a.date.localeCompare(b.date));
	const used = new Set<Invoice>();
	const active = invoices.filter((i) => i.side === "active" && !i.credit && !i.doc.integration && i.doc.currency === "EUR").sort((a, b) => (a.doc.date ?? "").localeCompare(b.doc.date ?? ""));
	const movements: Movement[] = [];
	let count = 0;
	let beyond = 0;
	let invoiced = 0;
	for (const q of accepted) {
		let left = quoteTotalsOf(q).net;
		const customer = q.customer.vat ?? q.customer.name;
		for (const i of active) {
			if (left <= 0n) break;
			if (used.has(i) || (i.doc.date ?? "") < q.date || !matchesParty(i.customer, customer)) continue;
			used.add(i);
			left -= invoiceCents(i);
		}
		if (left <= 0n) {
			invoiced++;
			continue;
		}
		count++;
		const acceptedOn = q.statusMark === undefined ? q.date : dayOf(q.statusMark.at);
		const expected = addDays(acceptedOn, QUOTE_PAY_DAYS);
		const soonest = addDays(today, QUOTE_MIN_DAYS);
		const date = expected < soonest ? soonest : expected;
		if (date > end) {
			beyond++;
			continue;
		}
		movements.push({ date, kind: "in", cents: left, source: "quote", quote: q });
	}
	return { movements, count, beyond, invoiced };
}

/** The days of a voce (or a hypothetical one) from `from` to `to`: once, or by its recurrence up to `until`. */
export function datesOf(v: { readonly date: string; readonly months?: number; readonly day?: number; readonly everyDays?: number; readonly until?: string }, from: string, to: string): string[] {
	const r: Recurrence | undefined = itemRecurrence(v);
	if (r === undefined) return v.date >= from && v.date <= to ? [v.date] : [];
	const last = v.until !== undefined && v.until < to ? v.until : to;
	return recurringDates(v.date, r, from, last);
}

/** The voci added by hand, from `from` to `end`, each at its amount of that day. */
export function itemFlows(items: readonly CashItem[], from: string, end: string): Movement[] {
	return items.flatMap((item) => datesOf(item, from, end).map((date): Movement => ({ date, kind: item.kind, cents: scaled(itemAmountAt(item, date), 2), source: "item", item })));
}

/** The hypothetical voci of a what_if, from today to `end`. */
export function hypotheticalFlows(items: readonly Hypothetical[], today: string, end: string): Movement[] {
	return items.flatMap((h) => datesOf(h, today, end).map((date): Movement => ({ date, kind: h.kind, cents: h.cents, source: "whatif", hypothetical: h })));
}

export type AverageSpend = {
	/** The days the average is taken from, both included: from the first expense of the window to yesterday. */
	readonly from: string;
	readonly to: string;
	/** The divisor: the days since the first expense of the window, between AVERAGE_MIN_DAYS and AVERAGE_DAYS. */
	readonly days: number;
	readonly total: bigint;
	readonly count: number;
	/** total / days, half up to the cent. */
	readonly perDay: bigint;
	/** Expenses left out: payments of renewals; supplier invoices (the scadenzario counts them); of a category a renewal or a voce covers. */
	readonly renewalPayments: number;
	readonly invoices: number;
	readonly covered: number;
	/** The categories left out, in the expenses' words. */
	readonly categories: readonly ExpenseCategory[];
};

/** The expense categories an active renewal or a voce still running covers: their expenses are counted there. «altro» never. */
function coveredCategories(renewals: readonly Renewal[], items: readonly CashItem[], today: string): Set<ExpenseCategory> {
	const out = new Set<ExpenseCategory>();
	for (const r of renewals) if (r.status === "active") out.add(EXPENSE_CATEGORY[r.category]);
	for (const i of items) {
		if (i.kind !== "out") continue;
		const running = itemRecurrence(i) === undefined ? i.date >= today : i.until === undefined || i.until >= today;
		const category = running ? matchCategory(i.name) : undefined;
		if (category !== undefined) out.add(category);
	}
	out.delete("altro");
	return out;
}

/** The average spending per day (see the choices above). */
export function averageSpend(expenses: readonly Expense[], renewals: readonly Renewal[], items: readonly CashItem[], today: string): AverageSpend {
	const window = addDays(today, -AVERAGE_DAYS);
	const to = addDays(today, -1);
	const ofRenewals = new Set<string>();
	for (const r of renewals) {
		for (const roll of r.rolls ?? []) if (roll.expense !== undefined) ofRenewals.add(roll.expense);
		for (const c of r.charges ?? []) ofRenewals.add(c.expense);
	}
	const covered = coveredCategories(renewals, items, today);
	const left = new Set<ExpenseCategory>();
	let first: string | undefined;
	let total = 0n;
	let count = 0;
	let renewalPayments = 0;
	let invoices = 0;
	let coveredCount = 0;
	for (const e of expenses) {
		if (e.date < window || e.date > to) continue;
		if (first === undefined || e.date < first) first = e.date;
		if (ofRenewals.has(e.id)) renewalPayments++;
		else if (e.docType === "fattura") invoices++;
		else if (covered.has(e.category)) {
			coveredCount++;
			left.add(e.category);
		} else {
			total += expenseCents(e.amount);
			count++;
		}
	}
	const from = first ?? window;
	const days = Math.min(AVERAGE_DAYS, Math.max(AVERAGE_MIN_DAYS, daysBetween(from, today)));
	return { from, to, days, total, count, perDay: halfUp(total, BigInt(days)), renewalPayments, invoices, covered: coveredCount, categories: [...left].sort() };
}

export type Rolled = {
	/** The balance's day and the days brought forward (the day after it to yesterday). */
	readonly from: string;
	readonly days: number;
	readonly incassi: bigint;
	readonly expenses: bigint;
	readonly renewals: bigint;
	/** The voci of those days, in less out. */
	readonly items: bigint;
	/** In less out: what is added to the balance. */
	readonly net: bigint;
	/** Supplier invoices marked paid in those days: not in the expenses unless recorded there. */
	readonly paidPassive: number;
};

/** A balance said before yesterday brought to today (see the choices above); undefined when there is nothing between. */
export function rollForward(balanceDate: string, today: string, invoices: readonly Invoice[], expenses: readonly Expense[], renewals: readonly Renewal[], items: readonly CashItem[], dayOf: (at: string) => string): Rolled | undefined {
	const from = addDays(balanceDate, 1);
	const to = addDays(today, -1);
	if (from > to) return undefined;
	const book = cashBook(invoices, expenses, { from, to }, dayOf);
	let charged = 0n;
	for (const r of renewals) {
		if (r.status !== "active" || r.autoPay !== true) continue;
		const recorded = new Set([...(r.charges ?? []).map((c) => c.date), ...(r.rolls ?? []).filter((x) => x.expense !== undefined).map((x) => x.from)]);
		for (const date of occurrences(r, effectiveDue(r, from), from, to)) {
			const amount = amountAt(r, date);
			if (amount !== undefined && !recorded.has(date)) charged += scaled(amount, 2);
		}
	}
	const voci = itemFlows(items, from, to).reduce((n, m) => n + (m.kind === "in" ? m.cents : -m.cents), 0n);
	return { from: balanceDate, days: daysBetween(from, today), incassi: book.totalIn, expenses: book.totalOut, renewals: charged, items: voci, net: book.totalIn - book.totalOut - charged + voci, paidPassive: book.paidPassive };
}

/** A what_if change: an invoice (or a party's invoices, an accepted quote's customer) paid `days` later, or not at all. */
export type Change = { readonly who: string; readonly days?: number };

/** Whether the movement is the invoice or the party's: the number as written, or the party's name or partita IVA. */
function concerns(m: Movement, who: string): boolean {
	if (m.invoice !== undefined) {
		const number = m.invoice.doc.number;
		if (number !== undefined && fold(number).replace(/\s+/g, "") === fold(who).replace(/\s+/g, "").replace(/^(?:fatt(?:ura)?\.?|n\.?)/, "")) return true;
		return matchesParty(m.invoice.side === "active" ? m.invoice.customer : m.invoice.supplier, who);
	}
	if (m.quote !== undefined) return matchesParty({ name: m.quote.customer.name, ...(m.quote.customer.vat === undefined ? {} : { vat: { country: "IT", code: m.quote.customer.vat.replace(/^IT/, "") } }) }, who);
	return false;
}

/** The movements with the delays and drops of a what_if; and how many each change touched (none: the caller says so). */
export function applyChanges(movements: readonly Movement[], changes: readonly Change[], today: string): { readonly movements: Movement[]; readonly touched: readonly number[] } {
	const touched = changes.map(() => 0);
	const out: Movement[] = [];
	for (const m of movements) {
		const at = m.source === "invoice" || m.source === "quote" ? changes.findIndex((c) => concerns(m, c.who)) : -1;
		if (at < 0) {
			out.push(m);
			continue;
		}
		touched[at] = (touched[at] ?? 0) + 1;
		const days = changes[at]?.days;
		if (days === undefined) continue;
		const from = m.date < today ? today : m.date;
		out.push({ ...m, date: addDays(from, days), delayed: days });
	}
	return { movements: out, touched };
}

/** The billable hours not billed at all, with their amount where a rate is known: a potential, never counted. */
export function unbilledPotential(entries: readonly WorkEntry[], rates: readonly RateRule[]): { readonly minutes: number; readonly cents: bigint; readonly unpriced: number } {
	const { unbilled } = summarize(entries, rates).totals;
	return { minutes: unbilled.minutes, cents: unbilled.amount, unpriced: unbilled.unpriced };
}
