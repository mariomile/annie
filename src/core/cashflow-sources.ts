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
 *   within min(15 days, half the period)) counts once, as the invoice. A renewal without a
 *   provider whose name shares a whole word with the supplier's, at the same amount within 15
 *   days: maybe the same payment, listed, both counted. An overdue supplier invoice of an autoPay
 *   renewal, due within 5 days of one of its charges, is paid by direct debit. An occurrence of a
 *   voce that is a renewal's payment (5%, a word of the name, within 5 days) counts once, as the
 *   renewal; each renewal payment pairs once, the closest first. All are listed.
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
 * - Taxes: the F24 the tax profile's calendar estimates (tax-sums.ts), on their working day, when a
 *   profile exists; a June F24 gone by stays to its alternative day, at its amount. A tax name says
 *   F24, IRPEF, sostitutiva, INPS or Agenzia (delle) Entrate, whatever else; or saldo/acconto with
 *   imposta, contributi, tassa or tasse, but not with bollo, associazione, automobilistica,
 *   rifiuti, TARI or fornitore. A voce out with a tax name within TAX_TWIN_DAYS of an estimate is the person's own
 *   record of it: the voci stay (several summed) and are listed; the estimate goes, or, when they
 *   sum under TAX_VOCI_PERCENT of it, its rest stays. An expense with a tax name within
 *   TAX_TWIN_DAYS of one says it is paid from TAX_PAID_PERCENT of it (of its INPS part for an INPS
 *   name): the estimate goes, listed too; below, the estimate stays and the expense is listed as a
 *   maybe. One that covers TAX_VOCI_PERCENT of the sum of several estimates on the same day stands
 *   for all of them. Each voce or expense goes to the closest estimate (from its first day too, for a June
 *   F24 gone by), an INPS name to one with contributions, the closer amount on the same distance.
 *   With the taxes on, expenses with a tax name are not in the average spending either.
 *   The F24 of the IVA (la liquidazione IVA of the ordinario, never with the forfettario's) are
 *   estimates the same way: a tax name says IVA with a codice tributo of the IVA next to F24, IVA,
 *   codice or tributo, or «iva» with F24, liquidazione, acconto, saldo, versamento, mensile or
 *   trimestrale, or with only a month, a quarter or a year («IVA ottobre»); never a price («IVA
 *   inclusa», «compresa», «esposta», «+ IVA», «IVA 10%»). It pairs only with the IVA's estimates,
 *   a name of other taxes (IRPEF, INPS, imposta…) never with them, a bare «F24» with either. For
 *   the ordinario only the IVA's payments leave the average spending; for the forfettario only the
 *   names of week 56.
 * - A balance is brought to now by instant, from min(when it was said, the end of its day in the
 *   instance's time zone) — a balance said today for 10 October counts what was marked from the
 *   11th: plus the instalments to collect marked paid after it,
 *   less the expenses recorded after it (dated from its day), less the supplier invoices marked
 *   paid after it that no expense stands for, less the autoPay charges after its day not recorded;
 *   never the voci. Not when the balance is older than CASHFLOW_LIMITS.maxDays. What a bank
 *   statement dated (an instalment confirmed from it, with its day; an expense recorded from
 *   it) counts by that day instead: only when after the balance's day, which holds it already.
 */
import { AVERAGE_DAYS, AVERAGE_MIN_DAYS, type Balance, CASHFLOW_LIMITS, type CashItem, itemAmountAt, itemRecurrence, type Kind, STALE_OVERDUE_DAYS } from "./cashflow.ts";
import { NEAR_DAYS, providerMatches, renewalSeries, sameAmount, similarName } from "./cashflow-items.ts";
import { unitsToCents } from "./cash-book.ts";
import { words } from "./name-keys.ts";
import type { Expense } from "./expenses.ts";
import { cents as expenseCents } from "./expense-sums.ts";
import { payDay } from "./invoice-sums.ts";
import { type Instalment, type Invoice, matchesParty, openAmount, paidDay, partyKey, vatOf } from "./invoices.ts";
import { addDays, daysBetween, MONTH_NAMES } from "./italian-calendar.ts";
import { latest, type Quote, quoteTotalsOf } from "./quotes.ts";
import { eurosToCents, halfUp, scaled } from "./quote-sums.ts";
import { nearOccurrence, type Recurrence, recurringDates } from "./recurrence.ts";
import { amountAt, effectiveDue, occurrences } from "./renewal-dates.ts";
import type { Renewal } from "./renewals.ts";
import { summarize } from "./timesheet-sums.ts";
import type { RateRule, WorkEntry } from "./timesheet.ts";

export type Source = "invoice" | "quote" | "renewal" | "item" | "whatif" | "average" | "tax";

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
	/** An F24 estimated from the tax profile (taxes.ts) or, `iva`, from la liquidazione IVA (vat.ts): what it pays for; `was` the first day of a June F24 gone by. */
	readonly tax?: { readonly what: string; readonly contributi?: bigint; readonly was?: string; readonly iva?: true; readonly late?: true; readonly key?: string };
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
export function dedupe(invoices: InvoiceFlows, renewals: RenewalFlows | undefined, all: readonly Renewal[], today: string): { readonly invoices: InvoiceFlows; readonly renewals: RenewalFlows | undefined; readonly duplicates: readonly Duplicate[]; readonly maybe: readonly Duplicate[]; readonly autoPaid: readonly Movement[] } {
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
	// A renewal without a provider and a supplier sharing a whole word of its name: said, nothing dropped.
	const paired = new Set(duplicates.map((d) => d.other));
	const asked = new Set<Movement>();
	const maybe: Duplicate[] = [];
	for (const m of invoices.movements) {
		const name = m.invoice?.supplier.name;
		if (m.kind !== "out" || m.late === true || paired.has(m) || name === undefined) continue;
		let best: Movement | undefined;
		let bestDays = Number.POSITIVE_INFINITY;
		for (const r of kept) {
			if (asked.has(r) || r.renewal === undefined || r.renewal.provider !== undefined || !similarName(name, r.renewal.name) || !sameAmount(m.cents, r.cents)) continue;
			const days = Math.abs(daysBetween(m.date, r.date));
			if (days <= 15 && days < bestDays) {
				best = r;
				bestDays = days;
			}
		}
		if (best === undefined) continue;
		asked.add(best);
		maybe.push({ other: m, renewal: best });
	}
	const fixed: InvoiceFlows = gone.size === 0 ? invoices : { ...invoices, movements: invoices.movements.filter((m) => !gone.has(m)), latePay: invoices.latePay.filter((m) => !gone.has(m)), stale: invoices.stale.filter((m) => !gone.has(m)) };
	return { invoices: fixed, renewals: renewals === undefined ? undefined : { ...renewals, movements: kept }, duplicates, maybe, autoPaid };
}

/** The occurrences of voci that are a renewal's payment (see the choices above): those occurrences go, the renewal's stay; each renewal payment pairs once, the closest. */
export function voceDuplicates(items: readonly Movement[], renewals: readonly Movement[]): { readonly items: Movement[]; readonly duplicates: Duplicate[] } {
	const gone = new Set<Movement>();
	const used = new Set<Movement>();
	const duplicates: Duplicate[] = [];
	for (const m of items) {
		const voce = m.item;
		if (voce === undefined || voce.kind !== "out") continue;
		let best: Movement | undefined;
		let bestDays = Number.POSITIVE_INFINITY;
		for (const r of renewals) {
			if (used.has(r) || r.renewal === undefined || !sameAmount(m.cents, r.cents)) continue;
			if (!similarName(voce.name, r.renewal.name) && !(r.renewal.provider !== undefined && similarName(voce.name, r.renewal.provider))) continue;
			const days = Math.abs(daysBetween(m.date, r.date));
			if (days <= NEAR_DAYS && days < bestDays) {
				best = r;
				bestDays = days;
			}
		}
		if (best === undefined) continue;
		used.add(best);
		gone.add(m);
		duplicates.push({ other: m, renewal: best });
	}
	return { items: items.filter((m) => !gone.has(m)), duplicates };
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
	/** Expenses left out: a renewal's own payments; payments that look like a renewal's or a voce's; supplier invoices in the scadenzario; with the estimated F24 on, the tax payments. */
	readonly renewalPayments: number;
	readonly lookalikes: number;
	readonly invoices: number;
	readonly taxes?: number;
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

/**
 * The average spending per day (see the choices above); `skipTaxes`: the estimated F24 are in the
 * forecast, so their payments are not in the average: true, the forfettario's (isProfileTaxName, as
 * week 56); "iva", the ordinario's IVA only (IRPEF, INPS stay in the average).
 */
export function averageSpend(expenses: readonly Expense[], renewals: readonly Renewal[], items: readonly CashItem[], invoices: readonly Invoice[], today: string, skipTaxes: boolean | "iva" = false): AverageSpend {
	const isSkipped = (name: string) => (skipTaxes === "iva" ? isTaxName(name) && taxKindOf(name) === "iva" : skipTaxes && isProfileTaxName(name));
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
	let taxes = 0;
	for (const e of expenses) {
		if (e.date < window || e.date > to) continue;
		if (first === undefined || e.date < first) first = e.date;
		if (ofRenewals.has(e.id)) renewalPayments++;
		else if (isSkipped(expenseName(e))) taxes++;
		else if (e.docType === "fattura" && invoiceOf(e, invoices, 10, (i) => i.doc.date) !== undefined) inScadenzario++;
		else if (looksLikePlanned(e, renewals, items, today)) lookalikes++;
		else {
			total += expenseCents(e.amount);
			count++;
		}
	}
	const from = first ?? window;
	const days = Math.min(AVERAGE_DAYS, Math.max(AVERAGE_MIN_DAYS, daysBetween(from, today)));
	return { from, to, days, total, count, perDay: halfUp(total, BigInt(days)), renewalPayments, lookalikes, invoices: inScadenzario, ...(skipTaxes !== false ? { taxes } : {}) };
}

/** A movement of the bank's statement: its day, its signed amount, what holds it («inv:KEY», «other», nothing), a proposal on it. */
export type StatementMovement = { readonly date: string; readonly amount: string; readonly target?: string; readonly proposed?: true };

/** Whether an invoice other than `key` has an instalment still open of `cents` (signed), dated by `day`. */
function otherOpen(invoices: readonly Invoice[], key: string, cents: bigint, day: string): boolean {
	return invoices.some((inv) => inv.key !== key && !inv.credit && inv.side !== undefined && inv.doc.date !== undefined && inv.doc.date <= day && inv.instalments.some((i) => i.paid === undefined && i.amount !== undefined && unitsToCents(i.amount) * (inv.side === "active" ? 1n : -1n) === cents));
}

/**
 * Whether a statement whose balance is of `balanceDate` shows the payment of `invoice`: a movement
 * of the same signed amount dated from the invoice's day to the balance's, unexplained or explained
 * by that invoice (confirmed, or matched by itself). A movement with only a proposal counts as
 * unexplained unless another open invoice of `invoices` has its amount, dated on or before it: then
 * it may be that one's, and is left aside. Never for an invoice dated after the balance, nor one
 * without a date.
 */
export function inStatement(invoice: Invoice, cents: bigint, balanceDate: string, statement: readonly StatementMovement[], invoices: readonly Invoice[] = []): boolean {
	return statementAt(invoice, cents, balanceDate, statement, invoices) >= 0;
}

/** The index of the movement of inStatement, -1 when none. */
export function statementAt(invoice: Invoice, cents: bigint, balanceDate: string, statement: readonly StatementMovement[], invoices: readonly Invoice[] = []): number {
	const date = invoice.doc.date;
	if (date === undefined || date > balanceDate) return -1;
	return statement.findIndex((m) => m.date >= date && m.date <= balanceDate && eurosToCents(m.amount) === cents && (m.target === `inv:${invoice.key}` || (m.target === undefined && (m.proposed !== true || !otherOpen(invoices, invoice.key, cents, m.date)))));
}

/** An expense this close to the day a supplier invoice was paid may be that payment. */
export const PAID_TWIN_DAYS = 5;

/**
 * Whether an expense stands for `cents` of a supplier invoice paid on `day`: its partita IVA and
 * number, or partita IVA and amount within 1%; or just the amount within 1%; within
 * PAID_TWIN_DAYS. Then the money is counted once, as the expense («mai due volte gli stessi
 * soldi»): the balance brought forward and the business report (business-report-sums.ts) share it.
 */
export function expenseStandsFor(expenses: readonly Expense[], invoice: Invoice, cents: bigint, day: string): boolean {
	return expenses.some((e) => invoiceOf(e, [invoice], PAID_TWIN_DAYS, () => day) !== undefined || (sameCents(expenseCents(e.amount), cents) && Math.abs(daysBetween(e.date, day)) <= PAID_TWIN_DAYS));
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
 * is older than CASHFLOW_LIMITS.maxDays (it is said to be old instead). `statement`: the bank's
 * movements (bank.ts statementOf), read only for a balance from a statement.
 */
export function rollForward(balance: Balance, now: string, today: string, invoices: readonly Invoice[], expenses: readonly Expense[], renewals: readonly Renewal[], dayOf: (at: string) => string, statement: readonly StatementMovement[] = []): Rolled | undefined {
	if (daysBetween(balance.date, today) > CASHFLOW_LIMITS.maxDays) return undefined;
	// From min(when it was said, the end of its day): an instant counts when it is after the saying, or on a later local day; never after now. Instants that do not parse are skipped.
	const said = Date.parse(balance.at);
	const until = Date.parse(now);
	const after = (at: string) => {
		const t = Date.parse(at);
		if (Number.isNaN(t) || Number.isNaN(until) || t > until) return false;
		return (!Number.isNaN(said) && t > said) || dayOf(at) > balance.date;
	};
	// What a bank statement dated (a paid mark's `on`, an expense from the statement) is in any balance of that day or later: it counts only when dated after the balance's day, and never when said after now.
	const bankAfter = (day: string, at: string) => {
		const t = Date.parse(at);
		return day > balance.date && day <= today && !Number.isNaN(t) && !Number.isNaN(until) && t <= until;
	};
	// An invoice marked paid by hand: from the end of the balance's day, as week 55 says; for a statement's balance, not when the statement shows its payment (inStatement).
	const handAfter = (at: string, invoice: Invoice, cents: bigint) => after(at) && !(balance.source === "bank" && inStatement(invoice, cents, balance.date, statement, invoices));
	const incassi: RolledInvoice[] = [];
	const paidPassive: RolledInvoice[] = [];
	const recorded = expenses.filter((e) => (e.source === "bank" ? bankAfter(e.date, e.at) : after(e.at) && e.date >= balance.date));
	for (const invoice of invoices) {
		if (invoice.credit || invoice.doc.integration || invoice.side === undefined || invoice.doc.currency !== "EUR") continue;
		for (const i of invoice.instalments) {
			if (i.paid === undefined || i.extra === true || i.amount === undefined || i.amount <= 0n) continue;
			if (i.paid.on === undefined ? !handAfter(i.paid.at, invoice, unitsToCents(i.amount) * (invoice.side === "active" ? 1n : -1n)) : !bankAfter(i.paid.on, i.paid.at)) continue;
			const row: RolledInvoice = { invoice, instalment: { n: i.n, count: invoice.instalments.length }, cents: unitsToCents(i.amount), date: paidDay(i.paid, dayOf) };
			if (invoice.side === "active") incassi.push(row);
			// A supplier invoice paid: taken off unless an expense stands for it (counted there, or in the balance already).
			else if (!expenseStandsFor(expenses, invoice, row.cents, row.date)) paidPassive.push(row);
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

/** An estimated F24 and a voce or an expense of the person's this close (days) are one payment, whatever their amounts. */
export const TAX_TWIN_DAYS = 10;

/** Folded words that alone make a name a tax payment. */
const TAX_CLEAR = new Set(["f24", "irpef", "sostitutiva", "inps"]);
/** Folded phrases that alone make a name a tax payment. */
const TAX_PHRASES = [["agenzia", "delle", "entrate"], ["agenzia", "entrate"]] as const;
/** Generic words: a tax payment only with «saldo» or «acconto» (or with a clear word, which is enough by itself). */
const TAX_GENERIC = new Set(["imposta", "imposte", "contributi", "contributo", "tassa", "tasse"]);
const TAX_STEPS = new Set(["saldo", "acconto", "acconti"]);
/** Words that make a generic name not a tax payment: «imposta di bollo», «tassa automobilistica», «contributo associazione», «acconto fornitore». A clear word wins over them («F24 acconti e bollo fatture»). */
const NOT_TAX = new Set(["bollo", "associazione", "automobilistica", "rifiuti", "tari", "fornitore"]);
/** Words of a name that say it is INPS contributions: it pairs with the F24 that has contributions in it. */
const INPS_WORDS = new Set(["inps", "contributi", "contributo"]);

const hasPhrase = (w: readonly string[], phrase: readonly string[]) => w.some((_, i) => phrase.every((p, k) => w[i + k] === p));

/** The codici tributo of the IVA (vat-rules.ts): with «f24», «iva», «codice» or «tributo» a name is an F24 of the IVA; a bare number never («Ordine 6010»). */
const VAT_CODE = /^60(?:0\d|1[0-3]|3[1-5]|99)$/;
const VAT_CODE_WORDS = new Set(["f24", "iva", "codice", "tributo"]);
/** With «iva», words strong enough to make it an F24 of the IVA even next to a rate: «liquidazione IVA», «IVA trimestrale», a month, a quarter. */
const VAT_STRONG = new Set(["f24", "liquidazione", "versamento", "trimestrale", "mensile", "trimestre", "annuale", "periodica"]);
/** Steps that make «iva» an F24 only right before it («saldo IVA», «acconto IVA») or with a year or a period: never by themselves next to a rate. */
const VAT_WEAK = new Set(["saldo", "acconto"]);
/** Months and quarters: a period, a strong step. */
const VAT_PERIODS = new Set([...MONTH_NAMES, "t1", "t2", "t3", "t4"]);
/** Words that may stand with «iva» alone and keep it an F24 of the IVA: «IVA ottobre», «IVA T3 2026». */
const VAT_FILLERS = new Set([...VAT_PERIODS, "di", "del", "della", "dell", "primo", "secondo", "terzo", "quarto"]);
/** Words that make «iva» the price of something, not an F24: «IVA inclusa», «IVA compresa», «IVA esposta». */
const VAT_PRICE = new Set(["inclusa", "incluso", "inclusi", "incluse", "compresa", "compreso", "compresi", "comprese", "esposta", "esposto", "esclusa", "escluso"]);

const hasVatCode = (w: readonly string[]) => w.some((x) => VAT_CODE.test(x)) && w.some((x) => VAT_CODE_WORDS.has(x));

/** «10/2026»: a month and its year, the period an F24 pays. */
const MONTH_YEAR = /\b(?:0?[1-9]|1[0-2])\/\d{4}\b/;

/** A strong step of an F24 of the IVA: f24, liquidazione, versamento, a month, a quarter, a «10/2026». */
const isStrong = (text: string, w: readonly string[]) => MONTH_YEAR.test(text) || w.some((x) => VAT_STRONG.has(x) || VAT_PERIODS.has(x));

/** A rate of the IVA next to «iva», with or without %: «IVA 22», «IVA al 10%», «10% IVA»; not «IVA 10/2026», «IVA 4º trimestre». */
const RATE_BY_IVA = /\biva\s+(?:al\s+)?(?:4|5|10|22)\b(?!\s*(?:º|°|\/))|\b(?:4|5|10|22)\s*%?\s*(?:di\s+)?iva\b/i;

/** A percentage that is not «interessi 1%» nor the acconto's «88%»: the share of a price. */
function priceShare(text: string, w: readonly string[]): boolean {
	return [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].some((m) => {
		const before = text.slice(0, m.index).trimEnd().toLowerCase();
		if (/\binteressi(?:\s+(?:dell?'|del|al))?$/.test(before)) return false;
		return !(m[1] === "88" && w.includes("acconto"));
	});
}

/**
 * «IVA inclusa», «Saldo lavori + IVA», «Acconto cucina (IVA 10%)», «Saldo lavori IVA 22», «Acconto
 * 30% lavori IVA»: a price with its IVA. A price word, «+ IVA», any percentage but «interessi 1%»
 * and the acconto's «88%», or a rate next to «iva» without a strong step (saldo and acconto are not).
 */
function isVatPrice(text: string, w: readonly string[]): boolean {
	if (w.some((x) => VAT_PRICE.has(x)) || /\+\s*iva\b/i.test(text) || priceShare(text, w)) return true;
	return RATE_BY_IVA.test(text) && !isStrong(text, w);
}

/**
 * Whether a name says an F24 of the IVA: a codice tributo of the IVA with its word; «iva» with a
 * strong step; «saldo IVA», «acconto IVA» (right before it) or saldo/acconto with a year or a
 * period; «iva» with only months, quarters and years around it. Never a price «IVA inclusa».
 */
function isVatName(text: string): boolean {
	const w = words(text);
	if (hasVatCode(w)) return true;
	if (!w.includes("iva") || isVatPrice(text, w)) return false;
	if (isStrong(text, w)) return true;
	if (w.some((x, k) => VAT_WEAK.has(x) && (w[k + 1] === "iva" || w.some((y) => /^\d{4}$/.test(y))))) return true;
	return w.every((x) => x === "iva" || VAT_FILLERS.has(x) || /^\d{4}$/.test(x));
}

/** A tax name as week 56 reads it (the forfettario's F24): F24, IRPEF, sostitutiva, INPS, Agenzia delle Entrate, or saldo/acconto with imposta, contributi, tassa. */
export function isProfileTaxName(text: string): boolean {
	const w = words(text);
	if (w.some((x) => TAX_CLEAR.has(x)) || TAX_PHRASES.some((p) => hasPhrase(w, p))) return true;
	if (w.some((x) => NOT_TAX.has(x))) return false;
	return w.some((x) => TAX_STEPS.has(x)) && w.some((x) => TAX_GENERIC.has(x));
}

/** A tax payment's name: the profile's (isProfileTaxName) or the IVA's (isVatName, not with bollo, fornitore…). */
export function isTaxName(text: string): boolean {
	if (isProfileTaxName(text) || hasVatCode(words(text))) return true;
	if (words(text).some((x) => NOT_TAX.has(x))) return false;
	return isVatName(text);
}

/** Words that tie a tax name to the F24 of the tax profile, never to the IVA's. */
const NOT_VAT = new Set(["irpef", "sostitutiva", "inps", "contributi", "contributo", "imposta", "imposte", "tassa", "tasse"]);

/** Which estimates a tax name may stand for: «iva» only those of the IVA, «other» only those of the tax profile, «any» (a bare F24, Agenzia delle Entrate) all. */
export function taxKindOf(text: string): "iva" | "other" | "any" {
	if (isVatName(text)) return "iva";
	return words(text).some((x) => NOT_VAT.has(x)) ? "other" : "any";
}

/** A tax name that says INPS contributions (and not F24, imposta or Agenzia delle Entrate). */
function isInpsName(text: string): boolean {
	const w = words(text);
	return w.some((x) => INPS_WORDS.has(x)) && !w.some((x) => x === "f24" || x === "irpef" || x === "sostitutiva" || x === "imposta" || x === "imposte") && !TAX_PHRASES.some((p) => hasPhrase(w, p));
}

/** The estimated F24 from `today` to `end`, as movements out; `contributi` the INPS part of each. */
export function taxFlows(payments: readonly { readonly date: string; readonly cents: bigint; readonly what: string; readonly contributi?: bigint; readonly was?: string; readonly iva?: true; readonly late?: true; readonly key?: string }[], today: string, end: string): Movement[] {
	return payments
		.filter((p) => p.date >= today && p.date <= end && p.cents > 0n)
		.map((p) => ({ date: p.date, kind: "out" as const, cents: p.cents, source: "tax" as const, tax: { what: p.what, ...(p.contributi === undefined || p.contributi === 0n ? {} : { contributi: p.contributi }), ...(p.was === undefined ? {} : { was: p.was }), ...(p.iva === true ? { iva: true as const } : {}), ...(p.late === true ? { late: true as const } : {}), ...(p.key === undefined ? {} : { key: p.key }) } }));
}

/** An expense says an estimated F24 is paid from this share of it (or of its INPS part, for an INPS expense), in percent. */
export const TAX_PAID_PERCENT = 30n;
/** The voci for an F24 stand for all of it from this share of the estimate, in percent; below, the rest of the estimate stays. */
export const TAX_VOCI_PERCENT = 70n;

/**
 * An estimated F24 and what stands for it: the voci that count instead (summed), the expenses that
 * say it is paid; `rest` the part of the estimate still counted when the voci are well below it.
 */
export type TaxTwin = { readonly tax: Movement; readonly voci: readonly Movement[]; readonly expenses: readonly Expense[]; readonly rest?: bigint };
/** An expense with a tax name well below the F24 it is near: maybe the same payment, the estimate stays. */
export type TaxMaybe = { readonly tax: Movement; readonly expense: Expense };

/** What an amount is set against: the INPS part for an INPS name, when the F24 has one; the whole F24 otherwise. */
const measureOf = (t: Movement, inps: boolean) => (inps && t.tax?.contributi !== undefined ? t.tax.contributi : t.cents);

/**
 * How far `date` is from an estimate, in days: from its day, or from the first day of a June F24
 * gone by. An overdue F24 counted today (`late`) is measured from its own day only.
 */
function distance(t: Movement, date: string): number {
	const was = t.tax?.was;
	const fromWas = was === undefined ? Number.POSITIVE_INFINITY : Math.abs(daysBetween(date, was));
	return t.tax?.late === true ? fromWas : Math.min(Math.abs(daysBetween(date, t.date)), fromWas);
}

/** A late F24 is paid late: a day from its own day to today (its counted day) plus TAX_TWIN_DAYS. */
const inLateWindow = (t: Movement, date: string) => t.tax?.late === true && t.tax.was !== undefined && date >= t.tax.was && date <= addDays(t.date, TAX_TWIN_DAYS);

const QUARTER_WORDS: Readonly<Record<string, number>> = { primo: 1, secondo: 2, terzo: 3, quarto: 4 };

/** The period a name says: «ottobre», «10/2026», «T3», «3º trimestre», «terzo trimestre»; the year when said. */
function namedPeriod(text: string): { readonly month?: number; readonly quarter?: number; readonly year?: number } | undefined {
	const w = words(text);
	const my = /\b(0?[1-9]|1[0-2])\/(\d{4})\b/.exec(text);
	const year = w.find((x) => /^20\d{2}$/.test(x));
	const y = year === undefined ? {} : { year: Number(year) };
	if (my !== null) return { month: Number(my[1]), year: Number(my[2]) };
	const m = w.findIndex((x) => (MONTH_NAMES as readonly string[]).includes(x));
	if (m >= 0) return { month: (MONTH_NAMES as readonly string[]).indexOf(w[m] as string) + 1, ...y };
	const t = w.find((x) => /^t[1-4]$/.test(x));
	if (t !== undefined) return { quarter: Number(t.slice(1)), ...y };
	const q = w.findIndex((x) => x === "trimestre");
	if (q > 0) {
		const before = w[q - 1] as string;
		const n = /^[1-4]$/.test(before) ? Number(before) : QUARTER_WORDS[before];
		if (n !== undefined) return { quarter: n, ...y };
	}
	return undefined;
}

/** Whether an estimate of the IVA pays the period a name says (its key, vat.ts: «2026-10», «2026-T3», the fourth quarter «2026-annuale»). */
function paysPeriod(t: Movement, p: NonNullable<ReturnType<typeof namedPeriod>>): boolean {
	const key = t.tax?.key;
	if (key === undefined) return false;
	const [year, what = ""] = key.split("-");
	if (p.year !== undefined && Number(year) !== p.year) return false;
	if (p.month !== undefined) return /^\d{2}$/.test(what) && Number(what) === p.month;
	if (p.quarter !== undefined) return p.quarter === 4 ? what === "annuale" : what === `T${p.quarter}`;
	return false;
}

/**
 * The estimate a payment named `name` on `date` stands for (see the choices above). A name with a
 * period («F24 IVA ottobre», «IVA 10/2026») looks first at the estimates of that period near it.
 * Otherwise the closest within TAX_TWIN_DAYS, a late one measured from its own day; a late F24 is
 * taken in its window (its day to today plus TAX_TWIN_DAYS) only when no other estimate of the
 * kind is within TAX_TWIN_DAYS: paying the next F24 early never settles the overdue one. An INPS
 * name looks only at the F24 with contributions, when any is near. On the same distance (the late
 * June F24 and the fixed INPS instalment both on 20 August), the closer amount. A name about the
 * IVA looks only at the IVA's estimates, one about other taxes never at them.
 */
function closestTax(taxes: readonly Movement[], date: string, cents: bigint, inps: boolean, kind: "iva" | "other" | "any" = "any", name = ""): Movement | undefined {
	const ofKind = taxes.filter((t) => kind === "any" || (kind === "iva") === (t.tax?.iva === true));
	const near = ofKind.map((t) => ({ t, days: distance(t, date) })).filter((x) => x.days <= TAX_TWIN_DAYS);
	const late = ofKind.filter((t) => inLateWindow(t, date)).map((t) => ({ t, days: Math.min(distance(t, date), TAX_TWIN_DAYS) }));
	const period = namedPeriod(name);
	const named = period === undefined ? [] : [...near, ...late].filter((x) => paysPeriod(x.t, period));
	const reachable = named.length > 0 ? named : near.length > 0 ? near : late;
	const withInps = inps ? reachable.filter((x) => x.t.tax?.contributi !== undefined) : [];
	const pool = withInps.length > 0 ? withInps : reachable;
	const gap = (t: Movement) => {
		const d = measureOf(t, inps) - cents;
		return d < 0n ? -d : d;
	};
	pool.sort((a, b) => a.days - b.days || (gap(a.t) < gap(b.t) ? -1 : gap(a.t) > gap(b.t) ? 1 : 0));
	return pool[0]?.t;
}

/**
 * The estimated F24 a voce of the person's or a recorded expense already stands for (see the
 * choices above): those go, the voci stay. An expense under TAX_PAID_PERCENT of the F24 leaves it
 * counted and is listed as maybe; voci under TAX_VOCI_PERCENT leave the rest of the estimate.
 */
export function taxDuplicates(taxes: readonly Movement[], items: readonly Movement[], expenses: readonly Expense[] = []): { readonly taxes: Movement[]; readonly twins: TaxTwin[]; readonly maybe: TaxMaybe[] } {
	const voci = new Map<Movement, Movement[]>();
	const paid = new Map<Movement, Expense[]>();
	const maybe: TaxMaybe[] = [];
	// Several estimates on the same day (the late June F24 and a fixed instalment on 20 August): one payment that covers about their sum stands for all of them, as one.
	const merged = new Map<string, Movement>();
	const mergedOf = new Map<Movement, Movement>();
	const targetOf = (t: Movement, cents: bigint): Movement => {
		const group = taxes.filter((x) => x.date === t.date);
		const sum = group.reduce((n, x) => n + x.cents, 0n);
		if (group.length < 2 || cents * 100n < sum * TAX_VOCI_PERCENT) return t;
		let m = merged.get(t.date);
		if (m === undefined) {
			const contributi = group.reduce((n, x) => n + (x.tax?.contributi ?? 0n), 0n);
			const first = group[0] as Movement;
			m = { ...first, cents: sum, tax: { what: group.map((x) => x.tax?.what ?? "").join(" e "), ...(contributi === 0n ? {} : { contributi }), ...(first.tax?.was === undefined ? {} : { was: first.tax.was }) } };
			merged.set(t.date, m);
			for (const x of group) mergedOf.set(x, m);
		}
		return m;
	};
	for (const m of items) {
		if (m.kind !== "out" || m.item === undefined || !isTaxName(m.item.name)) continue;
		const t = closestTax(taxes, m.date, m.cents, isInpsName(m.item.name), taxKindOf(m.item.name), m.item.name);
		if (t === undefined) continue;
		const target = targetOf(t, m.cents);
		voci.set(target, [...(voci.get(target) ?? []), m]);
	}
	for (const e of expenses) {
		const name = expenseName(e);
		if (!isTaxName(name)) continue;
		const inps = isInpsName(name);
		const amount = expenseCents(e.amount);
		const t = closestTax(taxes, e.date, amount, inps, taxKindOf(name), name);
		if (t === undefined) continue;
		const target = targetOf(t, amount);
		if (target !== t || amount * 100n >= measureOf(t, inps) * TAX_PAID_PERCENT) paid.set(target, [...(paid.get(target) ?? []), e]);
		else maybe.push({ tax: t, expense: e });
	}
	const kept: Movement[] = [];
	const twins: TaxTwin[] = [];
	const done = new Set<Movement>();
	for (const one of taxes) {
		const t = mergedOf.get(one) ?? one;
		if (done.has(t)) continue;
		done.add(t);
		// A merged estimate takes what its members got one by one too.
		const members = t === one ? [one] : taxes.filter((x) => mergedOf.get(x) === t);
		const v = [t, ...members.filter((x) => x !== t)].flatMap((x) => voci.get(x) ?? []);
		const e = [t, ...members.filter((x) => x !== t)].flatMap((x) => paid.get(x) ?? []);
		if (v.length === 0 && e.length === 0) {
			kept.push(...members);
			continue;
		}
		const sum = v.reduce((n, m) => n + m.cents, 0n);
		// Voci well below the estimate and no expense that says it is paid: the rest of the estimate stays.
		const rest = e.length === 0 && sum * 100n < t.cents * TAX_VOCI_PERCENT ? t.cents - sum : undefined;
		if (rest !== undefined) kept.push({ ...t, cents: rest });
		twins.push({ tax: t, voci: v, expenses: e, ...(rest === undefined ? {} : { rest }) });
	}
	const gone = (t: Movement) => paid.has(t) || paid.has(mergedOf.get(t) ?? t);
	return { taxes: kept, twins, maybe: maybe.filter((x) => !gone(x.tax)) };
}
