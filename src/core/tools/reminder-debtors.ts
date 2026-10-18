/**
 * Who owes a payment reminder, and in how many letters. A customer owes the instalments late
 * today (or those of the one invoice a person named, even when not yet late); instalments not yet
 * due are only a note for the person, never in a letter nor put in mora. Each invoice has its own
 * level, one past the highest recorded for it: a customer's invoices at different points get one
 * letter per point, so every letter has one level, says only what is true of all its invoices,
 * and records exactly that. The customer's credit notes are taken off only in a letter that
 * covers everything the customer has late; otherwise they are said apart.
 */
import type { FatturaParty } from "../fattura-pa.ts";
import { addTo, findInvoices, type Instalment, type Invoice, matchesParty, openAmount, partyKey, type Sums } from "../invoices.ts";
import { daysLate, eur, netted } from "../invoice-sums.ts";
import { nextLevel, type ReminderLevel, type ReminderMark } from "../reminder-book.ts";

/** One open instalment, and how many days late it is today (0 or less when not yet). */
export type OverdueRow = { readonly invoice: Invoice; readonly instalment: Instalment; readonly days: number };

type Credit = { readonly invoice: Invoice; readonly units: bigint };

/** A letter to a customer: its instalments, the most late first; those not yet due (a note); the credit notes taken off, and those not. */
export type Debtor = {
	readonly key: string;
	readonly customer: FatturaParty;
	readonly rows: readonly OverdueRow[];
	readonly upcoming: readonly OverdueRow[];
	readonly credits: readonly Credit[];
	readonly aside: readonly Credit[];
	/** The letter covers everything the customer has late. */
	readonly complete: boolean;
};

/** An invoice to collect (the company is its supplier), not a credit note nor a reverse-charge integration. */
export function collectable(invoice: Invoice): boolean {
	return invoice.side === "active" && !invoice.credit && !invoice.doc.integration;
}

function openRows(invoice: Invoice, today: string): OverdueRow[] {
	const rows: OverdueRow[] = [];
	for (const instalment of invoice.instalments) {
		if (instalment.paid !== undefined || instalment.extra === true || instalment.amount === undefined) continue;
		rows.push({ invoice, instalment, days: instalment.due === undefined ? 0 : daysLate(instalment.due, today) });
	}
	return rows;
}

const byLateness = (a: OverdueRow, b: OverdueRow) => b.days - a.days || (a.invoice.doc.number ?? "").localeCompare(b.invoice.doc.number ?? "");

/**
 * The customers who owe, the most owed first: those late today, those `party` names, or the one
 * of `only` (an invoice the person named). One entry per customer: letters() splits it.
 */
export function debtors(invoices: readonly Invoice[], today: string, filter: { readonly party?: string; readonly only?: Invoice } = {}): Debtor[] {
	const byKey = new Map<string, { customer: FatturaParty; rows: OverdueRow[]; lateElsewhere: boolean }>();
	for (const invoice of invoices) {
		if (!collectable(invoice)) continue;
		if (filter.party !== undefined && !matchesParty(invoice.customer, filter.party)) continue;
		const key = partyKey(invoice.customer);
		if (filter.only !== undefined && key !== partyKey(filter.only.customer)) continue;
		const rows = openRows(invoice, today);
		if (rows.length === 0) continue;
		const entry = byKey.get(key) ?? { customer: invoice.customer, rows: [], lateElsewhere: false };
		byKey.set(key, entry);
		if (filter.only !== undefined && invoice !== filter.only) entry.lateElsewhere ||= rows.some((r) => r.days > 0);
		else entry.rows.push(...rows);
	}
	const credits = new Map<string, Credit[]>();
	for (const invoice of invoices) {
		if (invoice.side !== "active" || !invoice.credit || invoice.paid || invoice.doc.integration) continue;
		const key = partyKey(invoice.customer);
		credits.set(key, [...(credits.get(key) ?? []), { invoice, units: openAmount(invoice) }]);
	}
	const list: Debtor[] = [];
	for (const [key, d] of byKey) {
		const late = d.rows.filter((r) => r.days > 0).sort(byLateness);
		const upcoming = d.rows.filter((r) => r.days <= 0).sort(byLateness);
		// A customer counts when something is late; the one invoice named counts anyway, as a reminder of its due date.
		if (late.length === 0 && filter.only === undefined) continue;
		if (late.length === 0 && upcoming.length === 0) continue;
		const own = credits.get(key) ?? [];
		const complete = !d.lateElsewhere;
		list.push({ key, customer: d.customer, rows: late.length > 0 ? late : upcoming, upcoming: late.length > 0 ? upcoming : [], credits: complete ? own : [], aside: complete ? [] : own, complete });
	}
	return list.sort((a, b) => Number(eur(owedDetail(b).net) - eur(owedDetail(a).net)) || (a.customer.name ?? "").localeCompare(b.customer.name ?? "", "it"));
}

/** The highest level recorded for an invoice, 0 when none. */
function topLevel(invoice: Invoice): number {
	return (invoice.reminders ?? []).reduce((n, m) => Math.max(n, m.level), 0);
}

/**
 * A customer's letters. Not late: one, a reminder of the due date. A level asked: one letter at
 * that level, without the invoices already reminded at a higher one (`higher`: never sent down).
 * Otherwise one letter per highest level recorded, most reminded first: a resend of the formal
 * one apart from a first formal one. The credit notes stay only when one letter covers it all.
 */
export function letters(debtor: Debtor, asked: ReminderLevel | undefined): { letters: Debtor[]; higher: Invoice[] } {
	if (!isLate(debtor)) return { letters: [debtor], higher: [] };
	const groups = new Map<number, OverdueRow[]>();
	const higher = new Set<Invoice>();
	for (const row of debtor.rows) {
		const top = topLevel(row.invoice);
		if (asked !== undefined && top > asked) {
			higher.add(row.invoice);
			continue;
		}
		const group = asked ?? top;
		groups.set(group, [...(groups.get(group) ?? []), row]);
	}
	const parts = [...groups].sort((a, b) => b[0] - a[0]).map(([, rows]) => rows);
	const whole = parts.length === 1 && higher.size === 0 && debtor.complete;
	const out = parts.map((rows, i): Debtor => ({
		...debtor,
		rows,
		upcoming: i === 0 ? debtor.upcoming : [],
		credits: whole ? debtor.credits : [],
		aside: whole ? debtor.aside : i === 0 ? [...debtor.credits, ...debtor.aside] : [],
		complete: whole,
	}));
	return { letters: out, higher: [...higher] };
}

/** The customers to collect from whose name `party` fits, by key and name: to say who else it could mean. */
export function customersNamed(invoices: readonly Invoice[], party: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const i of invoices) if (collectable(i) && matchesParty(i.customer, party)) found.set(partyKey(i.customer), i.customer.name ?? partyKey(i.customer));
	return found;
}

/** What a letter asks: the rows less its credit notes, never below zero; and what the notes took off. */
export function owedDetail(debtor: Debtor): { gross: Sums; applied: Sums; net: Sums } {
	const gross: Sums = new Map();
	for (const r of debtor.rows) addTo(gross, r.invoice.doc.currency, r.instalment.amount as bigint);
	const credit: Sums = new Map();
	for (const c of debtor.credits) addTo(credit, c.invoice.doc.currency, c.units);
	const n = netted([{ gross, credit, notes: debtor.credits.length }]);
	return { gross: n.gross, applied: n.applied, net: n.net };
}

/** The open credit notes of the customer not taken off in this letter. */
export function asideSums(debtor: Debtor): Sums {
	const sums: Sums = new Map();
	for (const c of debtor.aside) if (c.units > 0n) addTo(sums, c.invoice.doc.currency, c.units);
	return sums;
}

/** The invoices of a letter, once each, in the order of its rows. */
export function invoicesOf(debtor: Debtor): Invoice[] {
	return [...new Set(debtor.rows.map((r) => r.invoice))];
}

/** Whether any row is late today. */
export function isLate(debtor: Debtor): boolean {
	return debtor.rows.some((r) => r.days > 0);
}

/** The level of a letter: the one asked, else one past the highest recorded on its invoices. */
export function levelOf(debtor: Debtor, asked: ReminderLevel | undefined): ReminderLevel {
	if (asked !== undefined) return asked;
	return invoicesOf(debtor).reduce<ReminderLevel>((top, i) => {
		const next = nextLevel(i.reminders);
		return next > top ? next : top;
	}, 1);
}

/** The last formal reminder recorded on the letter's invoices. */
export function lastFormal(debtor: Debtor): ReminderMark | undefined {
	const formal = invoicesOf(debtor).flatMap((i) => (i.reminders ?? []).filter((m) => m.level === 3));
	return formal.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}

/** The marks of an invoice recorded on `today` (`dayOf` gives the local day of an instant). */
export function marksOn(invoice: Invoice, today: string, dayOf: (at: string) => string): ReminderMark[] {
	return (invoice.reminders ?? []).filter((m) => dayOf(m.at) === today);
}

/** The letter's invoices with a reminder recorded on `today`. */
export function remindedOn(debtor: Debtor, today: string, dayOf: (at: string) => string): Invoice[] {
	return invoicesOf(debtor).filter((i) => marksOn(i, today, dayOf).length > 0);
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
