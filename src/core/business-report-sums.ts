/**
 * The figures of the business report, pure, in bigint cents, from what the registers read (the
 * tool reads them; nothing here does I/O). Every rule is a register's own, reused:
 *
 * - fatturato: the documents la liquidazione IVA counts (vat-docs.ts): the fatture in uscita and
 *   the XML in the workspace where the company is the supplier, the same invoice once, a credit
 *   note with the minus; their imponibile, by the invoice's date (competenza). An invoice in
 *   instalments counts once, on its date. Issued invoices left out there (another currency, no
 *   date, no summary rows) are counted, to be said.
 * - incassato: the clients' collected (client-sums.ts collectedIn): the prima nota's incassi
 *   (cash-book.ts), each instalment by the day it was paid, IVA included, less the credit notes
 *   to customers used in the span.
 * - spese: the expenses dated in the span (expense-sums.ts totalsOf), and the instalments of
 *   supplier invoices paid in the span (by the day paid) that no expense stands for, by the rule
 *   the cashflow brings a balance forward with (cashflow-sources.ts pairPaidWithExpenses): the same money is never counted twice.
 *   A payment an expense with another supplier's name and the same amount may be is counted
 *   and said (cashflow-sources.ts maybeTwins). A renewal counts through the expense its payment recorded,
 *   never on its own.
 * - ritenute (the ordinario only): the ritenute d'acconto the clients withheld on the invoices paid
 *   in the span, by the day paid (withholding-docs.ts, each invoice once); the incassato stays what
 *   came in, the net (the scadenzario counts what the client pays, invoices.ts).
 * - margine: incassato less spese; in tasca: margine less the taxes estimated
 *   (business-report-taxes.ts).
 * - ore: the minutes recorded on days in the span; per hour: the fatturato over them, a rough
 *   ratio, only with REPORT_LIMITS.perHourMinutes or more.
 * - preventivi: the quotes whose first version is dated in the span, by the status of their latest.
 * - da incassare: the open instalments of the invoices issued, each customer's open credit notes
 *   off them, as the cashflow gathers them (cashflow-sources.ts invoiceFlows); past due: an
 *   instalment whose payable day (a weekend or holiday moved on) is gone.
 */
import { type Figures, type Receivables, REPORT_LIMITS, type Span } from "./business-report.ts";
import { type TaxSetting, taxesIn } from "./business-report-taxes.ts";
import { invoiceFlows, type MaybeTwin, type PaidInstalment, paidSupplierInstalments, type SupplierPairing, supplierPairing } from "./cashflow-sources.ts";
import { collectedIn } from "./client-sums.ts";
import type { Expense } from "./expenses.ts";
import { totalsOf } from "./expense-sums.ts";
import type { Invoice } from "./invoices.ts";
import { latest, type Quote } from "./quotes.ts";
import { halfUp } from "./quote-sums.ts";
import { isIssued, type SalesInvoice } from "./sales-invoices.ts";
import type { WorkEntry } from "./timesheet.ts";
import type { DeductMark } from "./vat.ts";
import { type VatDoc, vatDocs } from "./vat-docs.ts";
import { type WithheldDoc, withheldDocs } from "./withholding-docs.ts";

/** What the registers read; a register that does not read is undefined. */
export type ReportRegisters = {
	readonly invoices?: readonly Invoice[];
	readonly sales?: readonly SalesInvoice[];
	readonly expenses?: readonly Expense[];
	readonly quotes?: readonly Quote[];
	readonly entries?: readonly WorkEntry[];
	/** La liquidazione IVA's deductibility marks (none when its store does not read). */
	readonly marks: readonly DeductMark[];
	readonly tax: TaxSetting;
};

/** The registers, with the documents gathered once, today and the local day of an instant. */
export type Sources = ReportRegisters & {
	readonly docs?: readonly VatDoc[];
	/** Issued invoices of the scadenzario left out of the fatturato. */
	readonly uncounted: number;
	readonly today: string;
	readonly dayOf: (at: string) => string;
	/** Every paid supplier instalment and how the expenses pair with it, once for the whole register. */
	readonly pairing: Pairing;
	/** The ordinario: the invoices issued with a ritenuta d'acconto, each once. */
	readonly withheld?: readonly WithheldDoc[];
};

type Pairing = SupplierPairing & { readonly paid: readonly PaidInstalment[] };

/** Which registers hold anything at all: an empty one is said, never shown as zeros. */
export type Presence = { readonly invoices: boolean; readonly expenses: boolean; readonly entries: boolean; readonly quotes: boolean };

const within = (day: string, span: Span) => day >= span.from && day <= span.to;

export function sourcesOf(r: ReportRegisters, today: string, dayOf: (at: string) => string): Sources {
	const docs = r.invoices === undefined && r.sales === undefined ? undefined : vatDocs(r.sales ?? [], r.invoices ?? [], r.marks, dayOf).docs;
	const keys = new Set((docs ?? []).map((d) => d.key));
	const uncounted = (r.invoices ?? []).filter((i) => i.side === "active" && !i.doc.integration && !keys.has(i.key)).length;
	const paid = paidSupplierInstalments(r.invoices ?? [], dayOf);
	const pairing = { paid, ...supplierPairing(paid, r.expenses ?? []) };
	const ordinario = r.tax.kind === "ordinario" || (r.tax.kind === "none" && r.tax.why === "unreadable_vat");
	const withheld = ordinario && docs !== undefined ? withheldDocs(r.sales ?? [], r.invoices ?? [], dayOf).docs : undefined;
	return { ...r, ...(docs === undefined ? {} : { docs }), uncounted, today, dayOf, pairing, ...(withheld === undefined ? {} : { withheld }) };
}

export function presenceOf(s: Sources): Presence {
	const issued = (s.invoices ?? []).some((i) => i.side !== undefined && !i.doc.integration) || (s.sales ?? []).some(isIssued);
	return { invoices: issued, expenses: (s.expenses ?? []).length > 0 || (s.invoices ?? []).some((i) => i.side === "passive" && i.instalments.some((n) => n.paid !== undefined)), entries: (s.entries ?? []).length > 0, quotes: (s.quotes ?? []).length > 0 };
}

function fatturatoIn(docs: readonly VatDoc[], span: Span): NonNullable<Figures["fatturato"]> {
	let cents = 0n;
	let count = 0;
	let credits = 0;
	for (const d of docs) {
		if (d.side !== "sale" || !within(d.date, span)) continue;
		for (const r of d.rows) cents += r.taxable;
		if (d.credit) credits++;
		else count++;
	}
	return { cents, count, credits };
}

/** The supplier invoices paid in `span` that no expense stands for; `twins`: those an expense stands for; `maybe`: those an expense may still be. Read off the pairing of the whole register (sourcesOf), so an expense's amount is spent once whatever the span. */
function supplierPaid(pairing: Pairing, span: Span): { cents: bigint; count: number; twins: number; maybe: MaybeTwin[] } {
	let cents = 0n;
	let count = 0;
	let twins = 0;
	pairing.paid.forEach((p, n) => {
		if (!within(p.day, span)) return;
		if (pairing.stands[n]) twins++;
		else {
			cents += p.cents;
			count++;
		}
	});
	return { cents, count, twins, maybe: pairing.maybe.filter((t) => within(t.paid.day, span)) };
}

function quotesIn(quotes: readonly Quote[], span: Span): NonNullable<Figures["preventivi"]> {
	const first = new Map<string, string>();
	for (const q of quotes) {
		const seen = first.get(q.base);
		if (seen === undefined || q.date < seen) first.set(q.base, q.date);
	}
	let made = 0;
	let accepted = 0;
	let declined = 0;
	for (const q of latest(quotes)) {
		const date = first.get(q.base);
		if (date === undefined || !within(date, span)) continue;
		made++;
		if (q.status === "accepted") accepted++;
		else if (q.status === "declined") declined++;
	}
	return { made, accepted, declined };
}

/** The figures of `span` (see above). */
export function figuresIn(s: Sources, span: Span): Figures {
	const fatturato = s.docs === undefined ? undefined : fatturatoIn(s.docs, span);
	const incassato = s.invoices === undefined ? undefined : collectedIn({ invoices: s.invoices }, span.from, span.to, s.dayOf).cents;
	const ritenute = s.withheld?.filter((d) => d.paidOn !== undefined && within(d.paidOn, span)).reduce((n, d) => n + d.ritenuta, 0n);
	let spese: Figures["spese"];
	if (s.expenses !== undefined) {
		const own = totalsOf(s.expenses, span);
		const suppliers = supplierPaid(s.pairing, span);
		spese = { cents: own.total + suppliers.cents, expenses: own.count, suppliers: suppliers.count, supplierCents: suppliers.cents, twins: suppliers.twins, ...(suppliers.maybe.length === 0 ? {} : { maybe: suppliers.maybe }) };
	}
	const margine = incassato === undefined || spese === undefined ? undefined : incassato - spese.cents;
	const tasse = taxesIn(s, span);
	const inTasca = margine === undefined || tasse.kind === "none" ? undefined : margine - tasse.cents;
	let ore: Figures["ore"];
	if (s.entries !== undefined) {
		const minutes = s.entries.filter((e) => within(e.date, span)).reduce((n, e) => n + e.minutes, 0);
		const perHour = minutes >= REPORT_LIMITS.perHourMinutes && fatturato !== undefined && fatturato.cents > 0n ? halfUp(fatturato.cents * 60n, BigInt(minutes)) : undefined;
		ore = { minutes, ...(perHour === undefined ? {} : { perHour }) };
	}
	return {
		span,
		...(fatturato === undefined ? {} : { fatturato }),
		...(incassato === undefined ? {} : { incassato }),
		...(ritenute === undefined ? {} : { ritenute }),
		...(spese === undefined ? {} : { spese }),
		...(margine === undefined ? {} : { margine }),
		tasse,
		...(inTasca === undefined ? {} : { inTasca }),
		...(ore === undefined ? {} : { ore }),
		...(s.quotes === undefined ? {} : { preventivi: quotesIn(s.quotes, span) }),
	};
}

/** What is still to collect today (see above); undefined when the scadenzario does not read. */
export function receivablesOf(s: Sources): Receivables | undefined {
	if (s.invoices === undefined) return undefined;
	const issued = s.invoices.filter((i) => i.side === "active");
	const flows = invoiceFlows(issued, s.today, "9999-12-31", false);
	const sum = (list: readonly { readonly cents: bigint }[]) => list.reduce((n, m) => n + m.cents, 0n);
	const staleIn = flows.stale.filter((m) => m.kind === "in");
	const ahead = flows.movements.filter((m) => m.kind === "in");
	const overdue = sum(flows.late) + sum(staleIn);
	return { open: sum(ahead) + overdue + flows.undated.in, overdue, overdueCount: flows.late.length + staleIn.length };
}
