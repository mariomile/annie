/**
 * Who the suppliers are and what Annie knows of each, read from the registers and never written:
 * the cards the person made, the suppliers of the invoices received (scadenzario), of the
 * expenses and of the renewals, grouped by the clients' rule (party-groups.ts): partita IVA or
 * codice fiscale first, then the name. A renewal without a provider goes to the one supplier
 * whose name is inside the renewal's. A payment the bank statement confirmed for an invoice
 * counts as paid on the bank's day, as if marked in the scadenzario.
 *
 * Spent is the business report's rule (business-report-sums.ts): the expenses dated in the span,
 * and the instalments of the supplier's invoices paid in the span that no expense stands for
 * (cashflow-sources.ts supplierPairing, run once over the whole register): the same money is
 * never counted twice. A renewal counts through the expense of its payment, never on its own.
 * Amounts in euro cents, VAT included; other currencies are left out.
 */
import { type BankMatch, type BankMovement } from "./bank.ts";
import { type MaybeTwin, type PaidInstalment, paidSupplierInstalments, supplierPairing } from "./cashflow-sources.ts";
import { invoicedCents } from "./client-sums.ts";
import { taxIdOf } from "./client-find.ts";
import { vatKey } from "./clients.ts";
import { cents as expenseCents } from "./expense-sums.ts";
import type { Expense } from "./expenses.ts";
import { validIban } from "./iban.ts";
import { daysLate, payDay } from "./invoice-sums.ts";
import { type Invoice, type Instalment, paidDay, partyName, vatOf } from "./invoices.ts";
import { addDays, daysBetween } from "./italian-calendar.ts";
import { businessKey } from "./name-keys.ts";
import { groupParties, lookalikeParties, type PartyRecord, partyOf } from "./party-groups.ts";
import { halfUp, unitsToCents } from "./quote-sums.ts";
import { yearlyOf } from "./renewal-sums.ts";
import type { Renewal } from "./renewals.ts";
import { IBAN_BRIEF_DAYS, type SupplierCard } from "./suppliers.ts";

/** The registers a supplier is read from. */
export type SupplierRegisters = {
	readonly cards: readonly SupplierCard[];
	/** The register (invoices.ts register, withBankPaid): only the received ones (side passive) count. */
	readonly invoices: readonly Invoice[];
	readonly expenses: readonly Expense[];
	readonly renewals: readonly Renewal[];
};

/** One supplier: its card when there is one, and its records in the registers. */
export type Supplier = {
	/** The card's id, else «vat:…», «cf:…» or «nome:…». */
	readonly key: string;
	readonly card?: SupplierCard;
	readonly name: string;
	/** Where the name shown comes from: the card, the person's words (expenses, renewals), an invoice. */
	readonly nameFrom: "card" | "person" | "file";
	readonly vat?: string;
	readonly cf?: string;
	/** Every spelling seen for it, as written. */
	readonly names: readonly string[];
	readonly invoices: readonly Invoice[];
	readonly expenses: readonly Expense[];
	readonly renewals: readonly Renewal[];
};

type Item = { readonly kind: "invoice"; readonly invoice: Invoice } | { readonly kind: "expense"; readonly expense: Expense } | { readonly kind: "renewal"; readonly renewal: Renewal };

/** A partita IVA or codice fiscale as an expense writes it, the client-find way: the partita IVA when it is one, else the codice fiscale. */
function expenseTax(text: string | undefined): { vat?: string; cf?: string } {
	if (text === undefined) return {};
	const t = taxIdOf(text);
	if (t?.vat !== undefined) return { vat: t.vat };
	return t?.cf === undefined ? {} : { cf: t.cf };
}

/**
 * The register with the payments the bank statement confirmed (a match confirmed for an instalment
 * of an invoice received) marked paid on the bank's day, where the scadenzario does not say it
 * already. Nothing is written: it is how the suppliers read the register.
 */
export function withBankPaid(invoices: readonly Invoice[], bank: { readonly movements: readonly BankMovement[]; readonly matches: readonly BankMatch[] } | undefined): Invoice[] {
	if (bank === undefined) return [...invoices];
	const days = new Map(bank.movements.map((m) => [m.id, m.date]));
	const confirmed = new Map<string, Map<number | undefined, string>>();
	for (const m of bank.matches) {
		if (m.state !== "confirmed" || m.kind !== "invoice_in" || m.target === undefined) continue;
		const day = days.get(m.movement);
		if (day === undefined) continue;
		const of = confirmed.get(m.target) ?? new Map<number | undefined, string>();
		of.set(m.instalment, day);
		confirmed.set(m.target, of);
	}
	return invoices.map((i) => {
		const of = confirmed.get(i.key);
		if (of === undefined || i.paid) return i;
		const instalments = i.instalments.map((n): Instalment => {
			if (n.paid !== undefined || n.extra === true) return n;
			const day = of.get(n.n) ?? (i.instalments.length === 1 ? of.get(undefined) : undefined);
			return day === undefined ? n : { ...n, paid: { by: "estratto conto", at: `${day}T12:00:00.000Z`, on: day, source: "bank" } };
		});
		return { ...i, instalments, paid: instalments.every((n) => n.paid !== undefined || n.extra === true) };
	});
}

/** Every supplier: the cards first, then the suppliers without one, by the order they were met. */
export function suppliersOf(src: SupplierRegisters): Supplier[] {
	const records: PartyRecord<Item>[] = [];
	// The person's own words first (expenses, renewals), so their spelling is the one shown.
	for (const e of src.expenses) {
		if (e.supplier === undefined && e.supplierVat === undefined) continue;
		const tax = expenseTax(e.supplierVat);
		records.push({ ...partyOf(tax.vat, tax.cf, e.supplier), person: true, item: { kind: "expense", expense: e } });
	}
	const loose: Renewal[] = [];
	for (const r of src.renewals) {
		if (r.provider === undefined || businessKey(r.provider) === "") loose.push(r);
		else records.push({ ...partyOf(undefined, undefined, r.provider), person: true, item: { kind: "renewal", renewal: r } });
	}
	for (const i of src.invoices) {
		if (i.side !== "passive" || i.doc.integration) continue;
		const party = i.supplier;
		records.push({ ...partyOf(vatKey(vatOf(party)), party.fiscal?.toUpperCase(), party.name === undefined ? undefined : partyName(party)), person: false, item: { kind: "invoice", invoice: i } });
	}
	const groups = groupParties(src.cards, records, { splitHomonyms: true }).map(({ items, ...g }) => ({
		...g,
		invoices: items.flatMap((x) => (x.kind === "invoice" ? [x.invoice] : [])),
		expenses: items.flatMap((x) => (x.kind === "expense" ? [x.expense] : [])),
		renewals: items.flatMap((x) => (x.kind === "renewal" ? [x.renewal] : [])),
	}));
	// A renewal without a provider («Adobe Creative Cloud»): the one supplier whose name is inside it.
	for (const r of loose) {
		const words = ` ${businessKey(r.name)} `;
		const owners = groups.filter((g) => [g.name, ...g.names].some((n) => businessKey(n) !== "" && words.includes(` ${businessKey(n)} `)));
		if (owners.length === 1) owners[0]?.renewals.push(r);
	}
	return groups;
}

/** Every partita IVA and codice fiscale the supplier's invoices and expenses write, whatever its card holds. */
export function recordedTaxIds(s: Pick<Supplier, "invoices" | "expenses">): { readonly vats: ReadonlySet<string>; readonly cfs: ReadonlySet<string> } {
	const vats = new Set<string>();
	const cfs = new Set<string>();
	for (const i of s.invoices) {
		const vat = vatKey(vatOf(i.supplier));
		if (vat !== undefined) vats.add(vat);
		if (i.supplier.fiscal !== undefined && i.supplier.fiscal.trim() !== "") cfs.add(i.supplier.fiscal.trim().toUpperCase());
	}
	for (const e of s.expenses) {
		const t = expenseTax(e.supplierVat);
		if (t.vat !== undefined) vats.add(t.vat);
		if (t.cf !== undefined) cfs.add(t.cf);
	}
	return { vats, cfs };
}

/** The paid instalments of every invoice received and which of them an expense stands for: run once over the whole register. */
export type Ledger = { readonly paid: readonly (PaidInstalment & { readonly n: number })[]; readonly stands: readonly boolean[]; readonly maybe: readonly MaybeTwin[] };

export function ledgerOf(invoices: readonly Invoice[], expenses: readonly Expense[], dayOf: (at: string) => string): Ledger {
	const paid = paidSupplierInstalments(invoices, dayOf);
	return { paid, ...supplierPairing(paid, expenses) };
}

/** Spent with a supplier in a span: the cents, the expenses and the invoice payments counted, and the payments that may be an expense too (both counted, said). */
export type Spent = { readonly cents: bigint; readonly expenses: number; readonly payments: number; readonly twins: number };

const inSpan = (day: string, from: string, to: string) => day >= from && day <= to;

export function spentIn(s: Pick<Supplier, "invoices" | "expenses">, ledger: Ledger, from: string, to: string): Spent {
	const keys = new Set(s.invoices.map((i) => i.key));
	let cents = 0n;
	let expenses = 0;
	let payments = 0;
	for (const e of s.expenses) {
		if (!inSpan(e.date, from, to)) continue;
		cents += expenseCents(e.amount);
		expenses++;
	}
	ledger.paid.forEach((p, n) => {
		if (!keys.has(p.invoice.key) || !inSpan(p.day, from, to) || ledger.stands[n] === true) return;
		cents += p.cents;
		payments++;
	});
	const twins = ledger.maybe.filter((m) => keys.has(m.paid.invoice.key) && inSpan(m.paid.day, from, to)).length;
	return { cents, expenses, payments, twins };
}

/** What is open with a supplier today: the invoices to pay (credit notes apart), the overdue part, the next due date. */
export type Open = {
	readonly cents: bigint;
	readonly invoices: number;
	readonly overdue: bigint;
	readonly overdueCount: number;
	/** Days the oldest overdue instalment is late. */
	readonly overdueDays: number;
	readonly next?: { readonly due: string; readonly cents: bigint };
	/** Credit notes received not used yet, IVA included. */
	readonly credits: bigint;
	/** Invoices in another currency, left out. */
	readonly foreign: number;
};

const absCents = (units: bigint) => unitsToCents(units < 0n ? -units : units);

export function openOf(s: Pick<Supplier, "invoices">, today: string): Open {
	let cents = 0n;
	let invoices = 0;
	let overdue = 0n;
	let overdueCount = 0;
	let overdueDays = 0;
	let credits = 0n;
	let foreign = 0;
	let next: { due: string; cents: bigint } | undefined;
	for (const i of s.invoices) {
		if (i.paid) continue;
		if (i.doc.currency !== "EUR") {
			foreign++;
			continue;
		}
		const open = i.instalments.filter((n) => n.paid === undefined && n.extra !== true && n.amount !== undefined);
		if (open.length === 0) continue;
		if (i.credit) {
			credits += open.reduce((t, n) => t + absCents(n.amount as bigint), 0n);
			continue;
		}
		invoices++;
		for (const n of open) {
			const c = absCents(n.amount as bigint);
			cents += c;
			if (n.due === undefined) continue;
			const late = daysLate(n.due, today);
			if (late > 0) {
				overdue += c;
				overdueCount++;
				overdueDays = Math.max(overdueDays, late);
			} else if (next === undefined || n.due < next.due) next = { due: n.due, cents: c };
		}
	}
	return { cents, invoices, overdue, overdueCount, overdueDays, credits, foreign, ...(next === undefined ? {} : { next }) };
}

/**
 * How a supplier is paid: over the instalments paid in the span, the days from the invoice's date
 * to the payment, the terms (due date less the invoice's date), and those paid after the due
 * date (from the day it could be paid: a due date on a holiday moves to the next working day).
 */
export type Timing = { readonly count: number; readonly avgDays?: number; readonly withTerms: number; readonly avgTerms?: number; readonly late: number; readonly avgLate?: number };

export function timingOf(s: Pick<Supplier, "invoices">, from: string, to: string, dayOf: (at: string) => string): Timing {
	const days: number[] = [];
	const terms: number[] = [];
	const late: number[] = [];
	for (const i of s.invoices) {
		if (i.credit || i.doc.date === undefined) continue;
		for (const n of i.instalments) {
			if (n.paid === undefined || n.extra === true) continue;
			const paid = paidDay(n.paid, dayOf);
			if (!inSpan(paid, from, to)) continue;
			days.push(Math.max(0, daysBetween(i.doc.date, paid)));
			if (n.due === undefined) continue;
			terms.push(Math.max(0, daysBetween(i.doc.date, n.due)));
			const after = daysBetween(payDay(n.due), paid);
			if (after > 0) late.push(after);
		}
	}
	const avg = (xs: readonly number[]) => (xs.length === 0 ? undefined : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
	const avgDays = avg(days);
	const avgTerms = avg(terms);
	const avgLate = avg(late);
	return { count: days.length, withTerms: terms.length, late: late.length, ...(avgDays === undefined ? {} : { avgDays }), ...(avgTerms === undefined ? {} : { avgTerms }), ...(avgLate === undefined ? {} : { avgLate }) };
}

/** The last money that went to a supplier: an invoice paid or an expense, the day and how much. */
export type LastPayment = { readonly date: string; readonly cents: bigint; readonly what: "fattura" | "spesa" };

export function lastPayment(s: Pick<Supplier, "invoices" | "expenses">, ledger: Ledger, today: string): LastPayment | undefined {
	const keys = new Set(s.invoices.map((i) => i.key));
	let last: LastPayment | undefined;
	const take = (p: LastPayment) => {
		if (p.date > today) return;
		if (last === undefined || p.date > last.date) last = p;
	};
	for (const e of s.expenses) take({ date: e.date, cents: expenseCents(e.amount), what: "spesa" });
	for (const p of ledger.paid) if (keys.has(p.invoice.key)) take({ date: p.day, cents: p.cents, what: "fattura" });
	return last;
}

/** An IBAN written on an instalment still to pay: the IBAN, the invoice's number, the instalment (of how many), whether it passes the check. */
export type OpenIban = { readonly iban: string; readonly number?: string; readonly n: number; readonly of: number; readonly valid: boolean };

/**
 * The IBAN of a supplier, checked against a reference that a file cannot forge by its dates or by
 * how many it is: the one the person dictated; else every IBAN already paid to (the invoice paid
 * last, by the day it was paid, is the one shown). Invoices still to pay never make a reference:
 * three forged ones do not outvote a real one. Every IBAN on every instalment still to pay is
 * compared with it: a backdated invoice, one without a date or a second instalment on a new
 * account all show. `history`: the IBAN of the invoice paid last, to tell when an IBAN differs
 * from both. `mixed`: no reference, and the instalments to pay write more than one IBAN: all of
 * them are to verify; with one only, it is shown as never paid so far.
 */
export type IbanView = {
	readonly pinned?: string;
	readonly history?: { readonly iban: string; readonly from: "paid"; readonly number?: string };
	/** Every IBAN the paid instalments went to, in the order last paid first: more than one is said. */
	readonly paid: readonly string[];
	/** The IBAN of the earliest payment: when the payments moved to another, the new one is said in the brief too. */
	readonly firstPaid?: string;
	/** The distinct IBAN of the instalments to pay, with the first invoice writing each. */
	readonly open: readonly OpenIban[];
	/** Those to verify before paying. */
	readonly differs: readonly OpenIban[];
	/** Some IBAN to pay differs from the one dictated; from the files' reference. */
	readonly diffPinned: boolean;
	readonly diffHistory: boolean;
	/** The one dictated was never paid to, and an IBAN to pay is the one paid last: the one dictated may be wrong. */
	readonly wrongPin: boolean;
	readonly mixed: boolean;
};

const ibanText = (text: string) => text.replace(/[\s-]+/g, "").toUpperCase();
const ibansOf = (i: Invoice, only: (n: Instalment) => boolean = () => true): string[] => [...new Set(i.instalments.filter((n) => only(n) && n.iban !== undefined && ibanText(n.iban) !== "").map((n) => ibanText(n.iban as string)))];
const toPay = (n: Instalment) => n.paid === undefined && n.extra !== true;

export function ibanOf(s: Pick<Supplier, "invoices" | "card">, dayOf: (at: string) => string): IbanView {
	const invoices = s.invoices.filter((i) => !i.credit && ibansOf(i).length > 0);
	// What the person already paid to, the invoice paid last first (by the day of its last payment).
	const paidTo = invoices
		.flatMap((i) => {
			const days = i.instalments.flatMap((n) => (n.paid === undefined ? [] : [paidDay(n.paid, dayOf)]));
			const own = ibansOf(i, (n) => n.paid !== undefined);
			return days.length === 0 ? [] : [{ i, day: days.sort().at(-1) as string, ibans: own.length > 0 ? own : ibansOf(i) }];
		})
		.sort((a, b) => b.day.localeCompare(a.day));
	const paid = [...new Set(paidTo.flatMap((p) => p.ibans))];
	const last = paidTo[0];
	const history: IbanView["history"] = last === undefined ? undefined : { iban: last.ibans[0] as string, from: "paid", ...(last.i.doc.number === undefined ? {} : { number: last.i.doc.number }) };
	// The IBAN of the earliest payment, instalment by instalment.
	const firstPaid = invoices
		.flatMap((i) => i.instalments.flatMap((n) => (n.paid === undefined ? [] : [{ day: paidDay(n.paid, dayOf), iban: n.iban !== undefined && ibanText(n.iban) !== "" ? ibanText(n.iban) : ibansOf(i)[0] }])))
		.sort((a, b) => a.day.localeCompare(b.day))[0]?.iban;
	const pinned = s.card?.iban;
	const open: OpenIban[] = [];
	for (const i of invoices) {
		if (i.paid) continue;
		for (const n of i.instalments) {
			if (!toPay(n) || n.iban === undefined || ibanText(n.iban) === "") continue;
			const iban = ibanText(n.iban);
			if (open.some((o) => o.iban === iban)) continue;
			open.push({ iban, ...(i.doc.number === undefined ? {} : { number: i.doc.number }), n: n.n, of: i.instalments.length, valid: validIban(iban) !== undefined });
		}
	}
	// Known from the files: every IBAN already paid to.
	const known = paid;
	const mixed = pinned === undefined && known.length === 0 && open.length > 1;
	const differs = open.filter((o) => (pinned !== undefined ? o.iban !== pinned : known.length > 0 ? !known.includes(o.iban) : mixed));
	return {
		...(pinned === undefined ? {} : { pinned }),
		...(history === undefined ? {} : { history }),
		paid,
		...(firstPaid === undefined ? {} : { firstPaid }),
		open,
		differs,
		diffPinned: pinned !== undefined && open.some((o) => o.iban !== pinned),
		diffHistory: known.length > 0 && open.some((o) => !known.includes(o.iban)),
		wrongPin: pinned !== undefined && !paid.includes(pinned) && history !== undefined && open.some((o) => o.iban === history.iban),
		mixed,
	};
}

/** The IBAN the files make known: every one already paid to. */
export function fileIbans(v: Pick<IbanView, "paid">): string[] {
	return [...v.paid];
}

/** The IBAN a supplier is known by: the one dictated, and those the files make known. */
function knownIbans(v: IbanView): string[] {
	return [...(v.pinned === undefined ? [] : [v.pinned]), ...fileIbans(v)];
}

/**
 * A supplier the person never confirmed, tied to its own tax id: no instalment paid, no expense
 * written with its partita IVA or codice fiscale, no card holding them or an IBAN dictated. A
 * bare card (a note, a referente) or an expense with a name only confirms nothing: the name is
 * what someone using another's would copy. Only such a supplier can be flagged as using another's
 * name: once paid or confirmed, it is not flagged again, however many invoices it sends.
 */
export function unconfirmed(s: Pick<Supplier, "invoices" | "expenses" | "card" | "vat" | "cf">): boolean {
	if (s.invoices.some((i) => i.instalments.some((n) => n.paid !== undefined))) return false;
	const mine = (t: { vat?: string; cf?: string }) => (s.vat !== undefined && t.vat === s.vat) || (s.cf !== undefined && t.cf === s.cf);
	if (s.expenses.some((e) => mine(expenseTax(e.supplierVat)))) return false;
	const c = s.card;
	return c === undefined || (c.iban === undefined && !mine(c));
}

/** Another supplier with the same name (another partita IVA, or another IBAN than the one known for it) when this one was never confirmed and has something to pay: to verify by phone before paying. */
export type Impostor = { readonly other: Supplier; readonly vat: boolean; readonly iban: boolean };

export function impostorOf(all: readonly Supplier[], s: Supplier, dayOf: (at: string) => string): Impostor | undefined {
	if (!unconfirmed(s)) return undefined;
	if (!s.invoices.some((i) => !i.credit && !i.paid && i.instalments.some(toPay))) return undefined;
	const mine = ibanOf(s, dayOf).open.map((o) => o.iban);
	for (const other of lookalikeParties(all, s, { anyTax: true })) {
		if (other.invoices.filter((i) => !i.credit).length === 0 && other.card === undefined && other.expenses.length === 0) continue;
		const vat = s.vat !== undefined && other.vat !== undefined && s.vat !== other.vat;
		const known = knownIbans(ibanOf(other, dayOf));
		const iban = known.length > 0 && mine.some((m) => !known.includes(m));
		if (vat || iban) return { other, vat, iban };
	}
	return undefined;
}

/** The renewals with a supplier still active, and what they cost in a year. */
export function renewalsOf(s: Pick<Supplier, "renewals">, today: string): { readonly active: readonly Renewal[]; readonly yearly: bigint; readonly cancelled: number } {
	const active = s.renewals.filter((r) => r.status === "active").sort((a, b) => a.due.localeCompare(b.due));
	return { active, yearly: active.reduce((t, r) => t + (yearlyOf(r, today) ?? 0n), 0n), cancelled: s.renewals.length - active.length };
}

/** The ritenute d'acconto on the supplier's invoices dated in the span: withheld by the person, to be paid with an F24. */
export function withheldIn(s: Pick<Supplier, "invoices">, from: string, to: string): bigint {
	return s.invoices.reduce((t, i) => (i.withheld !== undefined && !i.credit && i.doc.date !== undefined && inSpan(i.doc.date, from, to) ? t + i.withheld.tax : t), 0n);
}

/** What the supplier invoiced in the span, IVA included (credit notes less), by the invoice's date. */
export function invoicedIn(s: Pick<Supplier, "invoices">, from: string, to: string): { readonly cents: bigint; readonly count: number } {
	let cents = 0n;
	let count = 0;
	for (const i of s.invoices) {
		if (i.doc.date === undefined || !inSpan(i.doc.date, from, to)) continue;
		const a = invoicedCents(i);
		if (a === undefined) continue;
		cents += a.total;
		if (!i.credit) count++;
	}
	return { cents, count };
}

/** Everything a supplier's card shows, for a span. */
export type SupplierFigures = {
	readonly spent: Spent;
	readonly invoiced: { readonly cents: bigint; readonly count: number };
	readonly open: Open;
	readonly timing: Timing;
	readonly last?: LastPayment;
	readonly renewals: ReturnType<typeof renewalsOf>;
	readonly iban: IbanView;
	readonly impostor?: Impostor;
	readonly withheld: bigint;
};

/** `all`: every supplier, to find one using the same name (impostorOf). */
export function supplierFigures(s: Supplier, ledger: Ledger, from: string, to: string, today: string, dayOf: (at: string) => string, all: readonly Supplier[] = []): SupplierFigures {
	const last = lastPayment(s, ledger, today);
	const impostor = impostorOf(all, s, dayOf);
	return {
		spent: spentIn(s, ledger, from, to),
		invoiced: invoicedIn(s, from, to),
		open: openOf(s, today),
		timing: timingOf(s, from, to, dayOf),
		...(last === undefined ? {} : { last }),
		renewals: renewalsOf(s, today),
		iban: ibanOf(s, dayOf),
		...(impostor === undefined ? {} : { impostor }),
		withheld: withheldIn(s, from, to),
	};
}

export type RankedSupplier = { readonly supplier: Supplier; readonly cents: bigint; readonly percent: bigint };

/** The suppliers by what was spent with them in the span, most first, with their share; zero left out. */
/** `twins`: payments of invoices that may be an expense too, both counted (spentIn). */
export function rankedSuppliers(suppliers: readonly Supplier[], ledger: Ledger, from: string, to: string): { readonly rows: readonly RankedSupplier[]; readonly total: bigint; readonly twins: number } {
	let twins = 0;
	const values = suppliers
		.map((supplier) => {
			const spent = spentIn(supplier, ledger, from, to);
			twins += spent.twins;
			return { supplier, cents: spent.cents };
		})
		.filter((r) => r.cents > 0n);
	const total = values.reduce((n, r) => n + r.cents, 0n);
	const rows = values
		.map((r) => ({ ...r, percent: total === 0n ? 0n : halfUp(r.cents * 100n, total) }))
		.sort((a, b) => (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : a.supplier.name.localeCompare(b.supplier.name, "it")));
	return { rows, total, twins };
}

/** A supplier paid late: what is overdue now, and the instalments paid after their due date in the span. */
export type LateRow = { readonly supplier: Supplier; readonly open: Open; readonly timing: Timing };

export function lateSuppliers(suppliers: readonly Supplier[], from: string, to: string, today: string, dayOf: (at: string) => string): LateRow[] {
	return suppliers
		.map((supplier) => ({ supplier, open: openOf(supplier, today), timing: timingOf(supplier, from, to, dayOf) }))
		.filter((r) => r.open.overdueCount > 0 || r.timing.late > 0)
		.sort((a, b) => (b.open.overdue > a.open.overdue ? 1 : b.open.overdue < a.open.overdue ? -1 : b.timing.late - a.timing.late || a.supplier.name.localeCompare(b.supplier.name, "it")));
}

/** The payments went to more than one IBAN, and an instalment due by `until` is on one of them other than the first used: said in the brief too. */
function movedTo(s: Pick<Supplier, "invoices">, v: IbanView, until: string): boolean {
	if (v.paid.length <= 1 || v.firstPaid === undefined) return false;
	return s.invoices.some((i) => !i.paid && !i.credit && i.instalments.some((n) => toPay(n) && n.due !== undefined && n.due <= until && n.iban !== undefined && ibanText(n.iban) !== v.firstPaid && v.paid.includes(ibanText(n.iban))));
}

/** Why a supplier is in the brief: an IBAN to pay that differs from the files' one, from the one dictated, or another supplier using its name. */
export type IbanAlert = { readonly supplier: Supplier; readonly kind: "changed" | "pinned" | "impostor"; readonly wrongPin?: true };

/** The suppliers with an instalment to pay due within IBAN_BRIEF_DAYS (or already due) and an IBAN to verify, or a same-name impostor: the brief's line. */
export function ibanAlerts(suppliers: readonly Supplier[], today: string, dayOf: (at: string) => string): IbanAlert[] {
	const until = addDays(today, IBAN_BRIEF_DAYS);
	const out: IbanAlert[] = [];
	for (const s of suppliers) {
		if (!s.invoices.some((i) => !i.paid && !i.credit && i.instalments.some((n) => toPay(n) && n.due !== undefined && n.due <= until))) continue;
		if (impostorOf(suppliers, s, dayOf) !== undefined) {
			out.push({ supplier: s, kind: "impostor" });
			continue;
		}
		const iban = ibanOf(s, dayOf);
		if (iban.diffPinned) out.push({ supplier: s, kind: "pinned", ...(iban.wrongPin ? { wrongPin: true as const } : {}) });
		else if (iban.differs.length > 0 || movedTo(s, iban, until)) out.push({ supplier: s, kind: "changed" });
	}
	return out;
}

/** The totals over every supplier for a span: what another agente may read. */
export type SupplierTotals = { readonly suppliers: number; readonly spent: bigint; readonly twins: number; readonly open: bigint; readonly overdue: bigint; readonly overdueSuppliers: number; readonly timing: Timing; readonly first?: bigint };

export function supplierTotals(suppliers: readonly Supplier[], ledger: Ledger, from: string, to: string, today: string, dayOf: (at: string) => string): SupplierTotals {
	const { rows, total, twins } = rankedSuppliers(suppliers, ledger, from, to);
	let open = 0n;
	let overdue = 0n;
	let overdueSuppliers = 0;
	for (const s of suppliers) {
		const o = openOf(s, today);
		open += o.cents;
		overdue += o.overdue;
		if (o.overdueCount > 0) overdueSuppliers++;
	}
	const timing = timingOf({ invoices: suppliers.flatMap((s) => s.invoices) }, from, to, dayOf);
	return { suppliers: rows.length, spent: total, twins, open, overdue, overdueSuppliers, timing, ...(rows[0] === undefined ? {} : { first: rows[0].percent }) };
}
