/**
 * Who owes a payment reminder: the customers with instalments late today (or the one invoice a
 * person named), the most owed first, with their credit notes, and the level the next reminder
 * takes from those recorded.
 */
import type { FatturaParty } from "../fattura-pa.ts";
import { addTo, findInvoices, type Instalment, type Invoice, matchesParty, openAmount, partyKey, type Sums } from "../invoices.ts";
import { daysLate, eur, netted } from "../invoice-sums.ts";
import { nextLevel, type ReminderLevel, type ReminderMark } from "../reminder-book.ts";

/** One overdue instalment, and how many days late it is today (0 or less when not yet). */
export type OverdueRow = { readonly invoice: Invoice; readonly instalment: Instalment; readonly days: number };

/** A customer who owes: the instalments, the most late first, and its credit notes still to take off. */
export type Debtor = {
	readonly key: string;
	readonly customer: FatturaParty;
	readonly rows: readonly OverdueRow[];
	readonly credits: readonly { readonly invoice: Invoice; readonly units: bigint }[];
};

/** An invoice to collect (the company is its supplier), not a credit note nor a reverse-charge integration. */
export function collectable(invoice: Invoice): boolean {
	return invoice.side === "active" && !invoice.credit && !invoice.doc.integration;
}

/**
 * The customers who owe, the most owed first: those late today, those `party` names, or the one
 * of `only` (an invoice the person named, whose open instalments count even if not yet late).
 */
export function debtors(invoices: readonly Invoice[], today: string, filter: { readonly party?: string; readonly only?: Invoice } = {}): Debtor[] {
	const byKey = new Map<string, { customer: FatturaParty; rows: OverdueRow[]; credits: { invoice: Invoice; units: bigint }[] }>();
	for (const invoice of invoices) {
		if (!collectable(invoice)) continue;
		if (filter.only !== undefined && invoice !== filter.only) continue;
		if (filter.party !== undefined && !matchesParty(invoice.customer, filter.party)) continue;
		for (const instalment of invoice.instalments) {
			if (instalment.paid !== undefined || instalment.extra === true || instalment.amount === undefined) continue;
			const days = instalment.due === undefined ? 0 : daysLate(instalment.due, today);
			if (days <= 0 && filter.only === undefined) continue;
			const key = partyKey(invoice.customer);
			const entry = byKey.get(key) ?? { customer: invoice.customer, rows: [], credits: [] };
			byKey.set(key, entry);
			entry.rows.push({ invoice, instalment, days });
		}
	}
	for (const invoice of invoices) {
		if (invoice.side !== "active" || !invoice.credit || invoice.paid || invoice.doc.integration) continue;
		const entry = byKey.get(partyKey(invoice.customer));
		if (entry !== undefined) entry.credits.push({ invoice, units: openAmount(invoice) });
	}
	const list = [...byKey].map(([key, d]): Debtor => ({ key, customer: d.customer, rows: d.rows.sort((a, b) => b.days - a.days || (a.invoice.doc.number ?? "").localeCompare(b.invoice.doc.number ?? "")), credits: d.credits }));
	return list.sort((a, b) => Number(eur(owedDetail(b).net) - eur(owedDetail(a).net)) || (a.customer.name ?? "").localeCompare(b.customer.name ?? "", "it"));
}

/** The customers to collect from whose name `party` fits, by key and name: to say who else it could mean. */
export function customersNamed(invoices: readonly Invoice[], party: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const i of invoices) if (collectable(i) && matchesParty(i.customer, party)) found.set(partyKey(i.customer), i.customer.name ?? partyKey(i.customer));
	return found;
}

/** What a debtor owes: the rows less its credit notes, never below zero; and what the notes took off. */
export function owedDetail(debtor: Debtor): { gross: Sums; applied: Sums; net: Sums } {
	const gross: Sums = new Map();
	for (const r of debtor.rows) addTo(gross, r.invoice.doc.currency, r.instalment.amount as bigint);
	const credit: Sums = new Map();
	for (const c of debtor.credits) addTo(credit, c.invoice.doc.currency, c.units);
	const n = netted([{ gross, credit, notes: debtor.credits.length }]);
	return { gross: n.gross, applied: n.applied, net: n.net };
}

/** The invoices of a debtor, once each, in the order of its rows. */
export function invoicesOf(debtor: Debtor): Invoice[] {
	return [...new Set(debtor.rows.map((r) => r.invoice))];
}

/** Whether any row is late today. */
export function isLate(debtor: Debtor): boolean {
	return debtor.rows.some((r) => r.days > 0);
}

/** The level: the one asked, else one past the highest recorded on its invoices. */
export function levelOf(debtor: Debtor, asked: ReminderLevel | undefined): ReminderLevel {
	if (asked !== undefined) return asked;
	return invoicesOf(debtor).reduce<ReminderLevel>((top, i) => {
		const next = nextLevel(i.reminders);
		return next > top ? next : top;
	}, 1);
}

/** The last formal reminder recorded on the debtor's invoices. */
export function lastFormal(debtor: Debtor): ReminderMark | undefined {
	const formal = invoicesOf(debtor).flatMap((i) => (i.reminders ?? []).filter((m) => m.level === 3));
	return formal.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}

/** The debtor's invoices with a reminder recorded on `today` (`dayOf` gives the local day of an instant). */
export function remindedOn(debtor: Debtor, today: string, dayOf: (at: string) => string): Invoice[] {
	return invoicesOf(debtor).filter((i) => (i.reminders ?? []).some((m) => dayOf(m.at) === today));
}

/** The invoice a person named, among those to collect: one, or why not. */
export function namedInvoice(invoices: readonly Invoice[], query: { readonly number?: string; readonly party?: string; readonly path?: string }): Invoice | { problem: "none" | "many" | "not_active" | "credit" | "paid"; found: readonly Invoice[] } {
	const found = findInvoices(invoices, query);
	if (found.length === 0) return { problem: "none", found };
	if (found.length > 1) return { problem: "many", found };
	const invoice = found[0] as Invoice;
	if (invoice.credit || invoice.doc.integration) return { problem: "credit", found };
	if (invoice.side !== "active") return { problem: "not_active", found };
	if (invoice.paid) return { problem: "paid", found };
	return invoice;
}
