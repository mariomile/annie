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
 *   due date; each instalment on its due date. An instalment overdue (its payable day, a weekend
 *   moved on, gone) is put on today: to collect, flagged «in ritardo» and left out with
 *   includeOverdue false; to pay, always, listed apart with its total. Overdue more than
 *   STALE_OVERDUE_DAYS, either side: out of the projection, asked about. Open credit notes come off
 *   their own party's open instalments, soonest due first; what is left of them is said.
 * - Renewals: active only; every payment from its effective due date to the horizon at the price
 *   of that payment. One waiting for the person's word is said, not put on a day.
 * - Duplicates: a supplier invoice not overdue that is a renewal's payment (the provider's
 *   partita IVA, or its whole name, in the supplier's; the amount within 5%; the closest payment
 *   within min(15 days, half the period)) counts once, as the invoice. An overdue supplier invoice
 *   of an autoPay renewal, due within 5 days of one of its charges, is paid by direct debit. A voce
 *   that is a renewal's payment (5%, a word of the name, within 5 days) counts once, as the renewal.
 *   All are listed.
 * - Quotes: the latest revision of each accepted quote, what the customer pays less the invoices to
 *   that customer dated from the first revision's date on (each invoice once), expected
 *   QUOTE_PAY_DAYS after acceptance and never before QUOTE_MIN_DAYS from today; accepted more than
 *   QUOTE_STALE_DAYS ago: not counted, asked about.
 * - Average spending: the expenses of the AVERAGE_DAYS days before today, less those that are a
 *   renewal's own payments, those that look like a renewal's or a voce's payment (a word of the name,
 *   the amount within 5%, within 5 days of one of its dates), and the supplier invoices that are in
 *   the scadenzario (partita IVA and number, or partita IVA and amount within 1% within 10 days);
 *   divided by the days since the first expense of the window, between AVERAGE_MIN_DAYS and
 *   AVERAGE_DAYS, half up to the cent.
 * - Voci: once on their date, or every so many months keeping their day, or every so many days,
 *   up to `until`, at the amount of that day.
 * - A balance is brought to now by instant: plus the instalments to collect marked paid after it,
 *   less the expenses recorded after it (dated from its day), less the supplier invoices marked
 *   paid after it that no expense stands for, less the autoPay charges after its day not recorded;
 *   never the voci. Not when the balance is older than CASHFLOW_LIMITS.maxDays.
 */
import { AVERAGE_DAYS, AVERAGE_MIN_DAYS, type Balance, CASHFLOW_LIMITS, type CashItem, itemAmountAt, itemRecurrence, type Kind, STALE_OVERDUE_DAYS } from "./cashflow.ts";
import { NEAR_DAYS, providerMatches, renewalSeries, sameAmount, similarName } from "./cashflow-items.ts";
import { unitsToCents } from "./cash-book.ts";
import type { Expense } from "./expenses.ts";
import { cents as expenseCents } from "./expense-sums.ts";
import { payDay } from "./invoice-sums.ts";
import { type Instalment, type Invoice, matchesParty, openAmount, partyKey, vatOf } from "./invoices.ts";
import { addDays, daysBetween } from "./italian-calendar.ts";
import { latest, type Quote, quoteTotalsOf } from "./quotes.ts";
import { halfUp, scaled } from "./quote-sums.ts";
import { nearOccurrence, type Recurrence, recurringDates } from "./recurrence.ts";
import { amountAt, effectiveDue, occurrences } from "./renewal-dates.ts";
import type { Renewal } from "./renewals.ts";
import { summarize } from "./timesheet-sums.ts";
import type { RateRule, WorkEntry } from "./timesheet.ts";

export type Source = "invoice" | "quote" | "renewal" | "item" | "whatif" | "average";

/** An accepted quote is expected this many days after its acceptance, and never before QUOTE_MIN_DAYS from today; past QUOTE_STALE_DAYS it is asked about. */
export const QUOTE_PAY_DAYS = 60;
export const QUOTE_MIN_DAYS = 30;
export const QUOTE_STALE_DAYS = 150;

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

/** Two movements that are one payment: `renewal` is the renewal's; `other` the invoice (counted instead) or the voce (left out). */
export type Duplicate = { readonly other: Movement; readonly renewal: Movement };

/** How far an invoice's due date may be from the renewal's payment: half the period, at most 15 days. */
function pairDays(r: Renewal): number {
	return Math.min(15, Math.floor((r.months * 30) / 2));
}

/**
 * The supplier invoices not overdue that are a renewal's payment: the renewal's movement goes,
 * the invoice stays. The overdue supplier invoices of an autoPay renewal near one of its charges:
 * paid by direct debit, out of the overdue and of the movements. See the choices above.
 */
export function dedupe(invoices: InvoiceFlows, renewals: RenewalFlows | undefined, all: readonly Renewal[], today: string): { readonly invoices: InvoiceFlows; readonly renewals: RenewalFlows | undefined; readonly duplicates: readonly Duplicate[]; readonly autoPaid: readonly Movement[] } {
	const autoPay = all.filter((r) => r.status === "active" && r.autoPay === true && r.provider !== undefined);
	const debited = (m: Movement) => {
		const invoice = m.invoice;
		const due = m.due ?? m.date;
		return (
			invoice !== undefined &&
			autoPay.some((r) => {
				if (!providerMatches(invoice.supplier, r.provider as string)) return false;
				const s = renewalSeries(r, today);
				const charge = nearOccurrence(s.first, s.recurrence, due, NEAR_DAYS, true);
				const amount = charge === undefined ? undefined : amountAt(r, charge);
				return amount !== undefined && sameAmount(m.cents, scaled(amount, 2));
			})
		);
	};
	const autoPaid = [...invoices.latePay, ...invoices.stale.filter((m) => m.kind === "out")].filter(debited);
	const gone = new Set<Movement>(autoPaid);
	const kept = renewals === undefined ? [] : [...renewals.movements];
	const duplicates: Duplicate[] = [];
	for (const m of invoices.movements) {
		const invoice = m.invoice;
		if (m.kind !== "out" || m.late === true || invoice === undefined) continue;
		let best = -1;
		let bestDays = Number.POSITIVE_INFINITY;
		kept.forEach((r, i) => {
			const renewal = r.renewal;
			if (renewal?.provider === undefined || !providerMatches(invoice.supplier, renewal.provider) || !sameAmount(m.cents, r.cents)) return;
			const days = Math.abs(daysBetween(m.date, r.date));
			if (days <= pairDays(renewal) && days < bestDays) {
				best = i;
				bestDays = days;
			}
		});
		if (best < 0) continue;
		duplicates.push({ other: m, renewal: kept[best] as Movement });
		kept.splice(best, 1);
	}
	const fixed: InvoiceFlows = gone.size === 0 ? invoices : { ...invoices, movements: invoices.movements.filter((m) => !gone.has(m)), latePay: invoices.latePay.filter((m) => !gone.has(m)), stale: invoices.stale.filter((m) => !gone.has(m)) };
	return { invoices: fixed, renewals: renewals === undefined ? undefined : { ...renewals, movements: kept }, duplicates, autoPaid };
}

/** The voci that are a renewal's payment (see the choices above): their movements go, the renewal's stay; each pair once. */
export function voceDuplicates(items: readonly Movement[], renewals: readonly Movement[]): { readonly items: Movement[]; readonly duplicates: Duplicate[] } {
	const gone = new Set<string>();
	const duplicates: Duplicate[] = [];
	for (const m of items) {
		const voce = m.item;
		if (voce === undefined || voce.kind !== "out" || gone.has(voce.id)) continue;
		const twin = renewals.find((r) => r.renewal !== undefined && sameAmount(m.cents, r.cents) && (similarName(voce.name, r.renewal.name) || (r.renewal.provider !== undefined && similarName(voce.name, r.renewal.provider))) && Math.abs(daysBetween(m.date, r.date)) <= NEAR_DAYS);
		if (twin === undefined) continue;
		gone.add(voce.id);
		duplicates.push({ other: m, renewal: twin });
	}
	return { items: items.filter((m) => m.item === undefined || !gone.has(m.item.id)), duplicates };
}

export type QuoteFlows = {
	readonly movements: readonly Movement[];
	/** Accepted quotes with something left to invoice, inside the horizon or not (the old ones aside). */
	readonly count: number;
	/** Accepted quotes expected after the horizon's end: not counted. */
	readonly beyond: number;
	/** Accepted quotes all invoiced already. */
	readonly invoiced: number;
	/** Accepted more than QUOTE_STALE_DAYS ago with something left: not counted, asked about. */
	readonly old: readonly { readonly quote: Quote; readonly cents: bigint }[];
};

/** What an invoice is worth, every instalment, in cents. */
function invoiceCents(i: Invoice): bigint {
	return i.instalments.reduce((n, x) => n + (x.amount === undefined || x.extra === true ? 0n : unitsToCents(x.amount)), 0n);
}

/** The accepted quotes not invoiced yet, as money expected (see the choices above). */
export function quoteFlows(quotes: readonly Quote[], invoices: readonly Invoice[], today: string, end: string, dayOf: (at: string) => string): QuoteFlows {
	const firstDate = (q: Quote) => quotes.find((x) => x.base === q.base && x.revision === 0)?.date ?? q.date;
	const accepted = latest(quotes)
		.filter((q) => q.status === "accepted")
		.sort((a, b) => firstDate(a).localeCompare(firstDate(b)));
	const used = new Set<Invoice>();
	const active = invoices.filter((i) => i.side === "active" && !i.credit && !i.doc.integration && i.doc.currency === "EUR").sort((a, b) => (a.doc.date ?? "").localeCompare(b.doc.date ?? ""));
	const movements: Movement[] = [];
	const old: { quote: Quote; cents: bigint }[] = [];
	let count = 0;
	let beyond = 0;
	let invoiced = 0;
	for (const q of accepted) {
		let left = quoteTotalsOf(q).net;
		const customer = q.customer.vat ?? q.customer.name;
		const since = firstDate(q);
		for (const i of active) {
			if (left <= 0n) break;
			if (used.has(i) || (i.doc.date ?? "") < since || !matchesParty(i.customer, customer)) continue;
			used.add(i);
			left -= invoiceCents(i);
		}
		if (left <= 0n) {
			invoiced++;
			continue;
		}
		const acceptedOn = q.statusMark === undefined ? q.date : dayOf(q.statusMark.at);
		if (daysBetween(acceptedOn, today) > QUOTE_STALE_DAYS) {
			old.push({ quote: q, cents: left });
			continue;
		}
		count++;
		const expected = addDays(acceptedOn, QUOTE_PAY_DAYS);
		const soonest = addDays(today, QUOTE_MIN_DAYS);
		const date = expected < soonest ? soonest : expected;
		if (date > end) {
			beyond++;
			continue;
		}
		movements.push({ date, kind: "in", cents: left, source: "quote", quote: q });
	}
	return { movements, count, beyond, invoiced, old };
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
	/** Expenses left out: a renewal's own payments; payments that look like a renewal's or a voce's; supplier invoices in the scadenzario. */
	readonly renewalPayments: number;
	readonly lookalikes: number;
	readonly invoices: number;
};

/** A partita IVA compared: digits and letters, no country prefix «IT». */
function vatKey(vat: string | undefined): string | undefined {
	if (vat === undefined) return undefined;
	const v = vat.replace(/[\s.-]+/g, "").toUpperCase();
	return v === "" ? undefined : v.replace(/^IT(?=\d{11}$)/, "");
}

/** A document number compared: no case, spaces, and no «fatt.», «n.», «nr.» in front of a digit. */
export function numberKey(text: string): string {
	return text
		.trim()
		.replace(/^(?:fatt(?:ura)?\.?|n\.?|nr\.?)\s*(?=\d)/i, "")
		.replace(/\s+/g, "")
		.toUpperCase();
}

/** The supplier invoice of the scadenzario an expense stands for: partita IVA and number, or partita IVA and amount within 1% within `days` of `near`. */
function invoiceOf(e: Expense, invoices: readonly Invoice[], days: number, near: (i: Invoice) => string | undefined): Invoice | undefined {
	const vat = vatKey(e.supplierVat);
	if (vat === undefined) return undefined;
	const cents = expenseCents(e.amount);
	return invoices.find((i) => {
		if (i.side !== "passive" || i.credit) return false;
		if (vatKey(vatOf(i.supplier)) !== vat && vatKey(i.supplier.fiscal) !== vat) return false;
		if (e.docNumber !== undefined && i.doc.number !== undefined && numberKey(e.docNumber) === numberKey(i.doc.number)) return true;
		const total = invoiceCents(i);
		const diff = total > cents ? total - cents : cents - total;
		const day = near(i);
		return diff * 100n <= total && day !== undefined && Math.abs(daysBetween(day, e.date)) <= days;
	});
}

/** Within 1% of each other: the same payment, rounding aside. */
function sameCents(a: bigint, b: bigint): boolean {
	const diff = a > b ? a - b : b - a;
	return diff * 100n <= (a > b ? a : b);
}

/** The words an expense is named by: its supplier and note. */
const expenseName = (e: Expense) => `${e.supplier ?? ""} ${e.note ?? ""}`;

/** The expense looks like a payment of an active renewal or of a voce (see the choices above). */
function looksLikePlanned(e: Expense, renewals: readonly Renewal[], items: readonly CashItem[], today: string): boolean {
	const cents = expenseCents(e.amount);
	const name = expenseName(e);
	const vat = vatKey(e.supplierVat);
	for (const r of renewals) {
		if (r.status !== "active") continue;
		const named = similarName(name, r.name) || (r.provider !== undefined && (similarName(name, r.provider) || (vat !== undefined && vatKey(r.provider) === vat)));
		if (!named) continue;
		const s = renewalSeries(r, today);
		const at = nearOccurrence(s.first, s.recurrence, e.date, NEAR_DAYS, true);
		const amount = at === undefined ? undefined : amountAt(r, at);
		if (amount !== undefined && sameAmount(cents, scaled(amount, 2))) return true;
	}
	for (const i of items) {
		if (i.kind !== "out" || !similarName(name, i.name)) continue;
		const r = itemRecurrence(i);
		const at = nearOccurrence(i.date, r, e.date, NEAR_DAYS, r !== undefined);
		if (at !== undefined && sameAmount(cents, scaled(itemAmountAt(i, at), 2))) return true;
	}
	return false;
}

/** The average spending per day (see the choices above). */
export function averageSpend(expenses: readonly Expense[], renewals: readonly Renewal[], items: readonly CashItem[], invoices: readonly Invoice[], today: string): AverageSpend {
	const window = addDays(today, -AVERAGE_DAYS);
	const to = addDays(today, -1);
	const ofRenewals = new Set<string>();
	for (const r of renewals) {
		for (const roll of r.rolls ?? []) if (roll.expense !== undefined) ofRenewals.add(roll.expense);
		for (const c of r.charges ?? []) ofRenewals.add(c.expense);
	}
	let first: string | undefined;
	let total = 0n;
	let count = 0;
	let renewalPayments = 0;
	let lookalikes = 0;
	let inScadenzario = 0;
	for (const e of expenses) {
		if (e.date < window || e.date > to) continue;
		if (first === undefined || e.date < first) first = e.date;
		if (ofRenewals.has(e.id)) renewalPayments++;
		else if (e.docType === "fattura" && invoiceOf(e, invoices, 10, (i) => i.doc.date) !== undefined) inScadenzario++;
		else if (looksLikePlanned(e, renewals, items, today)) lookalikes++;
		else {
			total += expenseCents(e.amount);
			count++;
		}
	}
	const from = first ?? window;
	const days = Math.min(AVERAGE_DAYS, Math.max(AVERAGE_MIN_DAYS, daysBetween(from, today)));
	return { from, to, days, total, count, perDay: halfUp(total, BigInt(days)), renewalPayments, lookalikes, invoices: inScadenzario };
}

/** An instalment marked paid after the balance: what it was, how much, the day. */
export type RolledInvoice = { readonly invoice: Invoice; readonly instalment: { readonly n: number; readonly count: number }; readonly cents: bigint; readonly date: string };

export type Rolled = {
	/** The balance's day. */
	readonly from: string;
	/** Instalments to collect marked paid after the balance: added. */
	readonly incassi: readonly RolledInvoice[];
	/** Expenses recorded after the balance: taken off. */
	readonly expenses: bigint;
	readonly expenseCount: number;
	/** Supplier invoices marked paid after the balance, with no expense standing for them: taken off. */
	readonly paidPassive: readonly RolledInvoice[];
	/** AutoPay charges after the balance's day, before today, not recorded: taken off. */
	readonly renewals: bigint;
	/** In less out: what is added to the balance. */
	readonly net: bigint;
};

/**
 * The balance brought to `now` (see the choices above); undefined when nothing moved, or when it
 * is older than CASHFLOW_LIMITS.maxDays (it is said to be old instead).
 */
export function rollForward(balance: Balance, now: string, today: string, invoices: readonly Invoice[], expenses: readonly Expense[], renewals: readonly Renewal[], dayOf: (at: string) => string): Rolled | undefined {
	if (daysBetween(balance.date, today) > CASHFLOW_LIMITS.maxDays) return undefined;
	const after = (at: string) => at > balance.at && at <= now;
	const incassi: RolledInvoice[] = [];
	const paidPassive: RolledInvoice[] = [];
	const recorded = expenses.filter((e) => after(e.at) && e.date >= balance.date);
	for (const invoice of invoices) {
		if (invoice.credit || invoice.doc.integration || invoice.side === undefined || invoice.doc.currency !== "EUR") continue;
		for (const i of invoice.instalments) {
			if (i.paid === undefined || i.extra === true || i.amount === undefined || i.amount <= 0n || !after(i.paid.at)) continue;
			const row: RolledInvoice = { invoice, instalment: { n: i.n, count: invoice.instalments.length }, cents: unitsToCents(i.amount), date: dayOf(i.paid.at) };
			if (invoice.side === "active") incassi.push(row);
			// A supplier invoice paid: taken off unless an expense stands for it (counted there, or in the balance already).
			else if (!expenses.some((e) => invoiceOf(e, [invoice], 5, () => row.date) !== undefined || (sameCents(expenseCents(e.amount), row.cents) && Math.abs(daysBetween(e.date, row.date)) <= 5))) paidPassive.push(row);
		}
	}
	let charged = 0n;
	const from = addDays(balance.date, 1);
	const to = addDays(today, -1);
	if (from <= to) {
		for (const r of renewals) {
			if (r.status !== "active" || r.autoPay !== true) continue;
			const known = new Set([...(r.charges ?? []).map((c) => c.date), ...(r.rolls ?? []).filter((x) => x.expense !== undefined).map((x) => x.from)]);
			for (const date of occurrences(r, effectiveDue(r, from), from, to)) {
				const amount = amountAt(r, date);
				if (amount === undefined || known.has(date)) continue;
				const cents = scaled(amount, 2);
				// An expense of about that amount near the day is the charge: in the expenses, or in the balance.
				if (expenses.some((e) => sameAmount(expenseCents(e.amount), cents) && Math.abs(daysBetween(e.date, date)) <= 3)) continue;
				charged += cents;
			}
		}
	}
	const spent = recorded.reduce((n, e) => n + expenseCents(e.amount), 0n);
	const inCents = incassi.reduce((n, r) => n + r.cents, 0n);
	const outCents = paidPassive.reduce((n, r) => n + r.cents, 0n);
	if (incassi.length === 0 && recorded.length === 0 && paidPassive.length === 0 && charged === 0n) return undefined;
	return { from: balance.date, incassi, expenses: spent, expenseCount: recorded.length, paidPassive, renewals: charged, net: inCents - spent - outCents - charged };
}

/** A what_if change: an invoice by number (with its party, when said) or a party's invoices and accepted quotes, paid `days` later, or not at all. */
export type Change = { readonly invoice?: string; readonly party?: string; readonly days?: number };

function ofParty(m: Movement, party: string): boolean {
	if (m.invoice !== undefined) return matchesParty(m.invoice.side === "active" ? m.invoice.customer : m.invoice.supplier, party);
	if (m.quote !== undefined) {
		const c = m.quote.customer;
		return matchesParty({ name: c.name, ...(c.vat === undefined ? {} : { vat: { country: "IT", code: c.vat.replace(/^IT/i, "") } }) }, party);
	}
	return false;
}

/** Whether the movement is what the change names (see Change). */
function concerns(m: Movement, c: Change): boolean {
	if (m.source !== "invoice" && m.source !== "quote") return false;
	if (c.invoice !== undefined) {
		const number = m.invoice?.doc.number;
		if (number === undefined || numberKey(number) !== numberKey(c.invoice)) return false;
	}
	return c.party === undefined || ofParty(m, c.party);
}

export type Changed = {
	readonly movements: Movement[];
	/** For each change, the movements it touched: before, and after (none when dropped). */
	readonly touched: readonly { readonly before: Movement; readonly after?: Movement }[][];
	/** A change by number alone that more than one invoice has: its index and those movements. */
	readonly ambiguous?: { readonly index: number; readonly movements: readonly Movement[] };
};

/** The movements with the delays and drops of a what_if (see Change). */
export function applyChanges(movements: readonly Movement[], changes: readonly Change[], today: string): Changed {
	for (const [index, c] of changes.entries()) {
		if (c.invoice === undefined || c.party !== undefined) continue;
		const hit = movements.filter((m) => concerns(m, c));
		if (new Set(hit.map((m) => m.invoice?.key)).size > 1) return { movements: [...movements], touched: changes.map(() => []), ambiguous: { index, movements: hit } };
	}
	const touched: { before: Movement; after?: Movement }[][] = changes.map(() => []);
	const out: Movement[] = [];
	for (const m of movements) {
		const at = changes.findIndex((c) => concerns(m, c));
		if (at < 0) {
			out.push(m);
			continue;
		}
		const days = changes[at]?.days;
		if (days === undefined) {
			touched[at]?.push({ before: m });
			continue;
		}
		const from = m.date < today ? today : m.date;
		const after: Movement = { ...m, date: addDays(from, days), delayed: days };
		touched[at]?.push({ before: m, after });
		out.push(after);
	}
	return { movements: out, touched };
}

/** The billable hours not billed at all, with their amount where a rate is known: a potential, never counted. */
export function unbilledPotential(entries: readonly WorkEntry[], rates: readonly RateRule[]): { readonly minutes: number; readonly cents: bigint; readonly unpriced: number } {
	const { unbilled } = summarize(entries, rates).totals;
	return { minutes: unbilled.minutes, cents: unbilled.amount, unpriced: unbilled.unpriced };
}
