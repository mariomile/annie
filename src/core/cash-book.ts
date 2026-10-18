/**
 * The prima nota (cash book) of a period: INCASSI, the invoices to collect marked paid in it, and
 * USCITE, the expenses dated in it, in one chronological table with a running balance. Read
 * only. The scadenzario keeps when the owner marked the invoice (or the instalment) paid, and
 * that day, where the instance is, is the incasso's date; when a bank statement confirmed the
 * payment (bank.ts), its day is (paidDay). Only euro amounts are counted; other currencies, amounts that do not read and credit
 * notes marked used are counted apart, to be said.
 */
import type { Expense } from "./expenses.ts";
import { cents } from "./expense-sums.ts";
import { inPeriod, type Span } from "./periods.ts";
import { type Invoice, paidDay, partyKey } from "./invoices.ts";
import { unitsToCents } from "./quote-sums.ts";

type CashKind = "in" | "out";

export type CashRow = {
	readonly date: string;
	readonly kind: CashKind;
	readonly cents: bigint;
	/** The expense, or the invoice and its instalment (n of count). */
	readonly expense?: Expense;
	readonly invoice?: Invoice;
	readonly instalment?: { readonly n: number; readonly count: number };
	/** The balance after this row, from zero at the period's start. */
	readonly balance: bigint;
};

export type CashBook = {
	readonly rows: readonly CashRow[];
	readonly totalIn: bigint;
	readonly totalOut: bigint;
	/** In less out. */
	readonly net: bigint;
	/** Invoices to collect paid in the period in another currency: not counted. */
	readonly otherCurrency: number;
	/** Invoices to pay marked paid in the period: outflows not in the register of expenses. */
	readonly paidPassive: number;
	/** Instalments of invoices to collect marked paid in the period whose amount does not read: not counted. */
	readonly unreadable: number;
	/** Credit notes to customers marked used in the period: whether money went back is not known, not counted. */
	readonly credits: number;
};

/** Kept here for the registers that import it from the cash book: the one helper is quote-sums.ts'. */
export { unitsToCents } from "./quote-sums.ts";

type Entry = Omit<CashRow, "balance">;

type Incassi = { entries: Entry[]; otherCurrency: number; paidPassive: number; unreadable: number; credits: number };

/** The incassi of `span`: every instalment of an invoice to collect (not a credit note) marked paid on a day in it; and what is left out. */
function incassiOf(invoices: readonly Invoice[], span: Span, dayOf: (at: string) => string): Incassi {
	const entries: Entry[] = [];
	const foreign = new Set<string>();
	const passive = new Set<string>();
	const credits = new Set<string>();
	let unreadable = 0;
	for (const invoice of invoices) {
		if (invoice.doc.integration) continue;
		for (const i of invoice.instalments) {
			if (i.paid === undefined || i.extra === true || !inPeriod(paidDay(i.paid, dayOf), span)) continue;
			const date = paidDay(i.paid, dayOf);
			// A credit note counts only on the side to collect: one of ours, used for a customer.
			if (invoice.credit) {
				if (invoice.side === "active") credits.add(invoice.key);
				continue;
			}
			if (invoice.side === "passive") passive.add(invoice.key);
			if (invoice.side !== "active") continue;
			if (i.amount === undefined) {
				unreadable++;
				continue;
			}
			if (i.amount <= 0n) continue;
			if (invoice.doc.currency !== "EUR") {
				foreign.add(invoice.key);
				continue;
			}
			entries.push({ date, kind: "in", cents: unitsToCents(i.amount), invoice, instalment: { n: i.n, count: invoice.instalments.length } });
		}
	}
	return { entries, otherCurrency: foreign.size, paidPassive: passive.size, unreadable, credits: credits.size };
}

/** The uscite of `span`: the expenses dated in it. */
function usciteOf(expenses: readonly Expense[], span: Span): Entry[] {
	return expenses.filter((e) => inPeriod(e.date, span)).map((e) => ({ date: e.date, kind: "out" as const, cents: cents(e.amount), expense: e }));
}

/** Order within a day: incassi first, then uscite; each by party or id, so the table reads the same every time. */
function sameDay(a: Entry, b: Entry): number {
	if (a.kind !== b.kind) return a.kind === "in" ? -1 : 1;
	const key = (e: Entry) => (e.expense?.id ?? (e.invoice === undefined ? "" : `${partyKey(e.invoice.customer)}|${e.invoice.doc.number ?? ""}|${e.instalment?.n ?? 0}`));
	return key(a).localeCompare(key(b));
}

/** The prima nota of `span`: incassi and uscite by day, with the balance after each row. */
export function cashBook(invoices: readonly Invoice[], expenses: readonly Expense[], span: Span, dayOf: (at: string) => string): CashBook {
	const incassi = incassiOf(invoices, span, dayOf);
	const entries = [...incassi.entries, ...usciteOf(expenses, span)].sort((a, b) => a.date.localeCompare(b.date) || sameDay(a, b));
	let balance = 0n;
	let totalIn = 0n;
	let totalOut = 0n;
	const rows = entries.map((e): CashRow => {
		if (e.kind === "in") totalIn += e.cents;
		else totalOut += e.cents;
		balance += e.kind === "in" ? e.cents : -e.cents;
		return { ...e, balance };
	});
	return { rows, totalIn, totalOut, net: totalIn - totalOut, otherCurrency: incassi.otherCurrency, paidPassive: incassi.paidPassive, unreadable: incassi.unreadable, credits: incassi.credits };
}
