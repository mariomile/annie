/**
 * What explains a bank movement, pure: given the movements and what the other registers say
 * (the scadenzario's invoices, the expenses, the renewals, the F24 estimates), one outcome each.
 * Conservative, because a wrong «incassata» corrupts the taxes, the cashflow and the clients:
 *
 * - An invoice is a candidate only when the amount is its residual or one of its open instalments
 *   (to the cent, ±0,01), dated on or before the movement, still open (an instalment marked paid
 *   is never one), not a credit note, not already taken by another movement. Strong when the
 *   description also says the party's name, its partita IVA or the invoice's number. One strong
 *   candidate is proposed; two alike of the same party (same amount), the oldest, and said;
 *   otherwise the person is asked. Without a candidate, a description naming a party with an open
 *   invoice larger than the amount is a hint: maybe a partial payment.
 * - An expense recorded within EXPENSE_DAYS of the date with the same amount: with the supplier's
 *   name in the description it explains the movement, without it is proposed.
 * - A renewal's charge: its amount and its name (or provider) in the description.
 * - An F24 by its words (F24, delega, Agenzia delle Entrate…), tied to the tax estimate of the same
 *   amount within NEAR_DAYS when there is one.
 * - A transfer between the person's own accounts (one of the company's IBANs, «giroconto») and a
 *   withdrawal (prelievo, ATM).
 *
 * Nothing here writes: the tools keep the outcomes and write the other registers only on a yes.
 */
import { BANK_LIMITS, type BankMovement, EXPENSE_DAYS, type MatchTarget, movementCents, NEAR_DAYS } from "./bank.ts";
import { unitsToCents } from "./cash-book.ts";
import { isTaxName } from "./cashflow-sources.ts";
import type { Expense } from "./expenses.ts";
import { cents as expenseCents } from "./expense-sums.ts";
import { type Invoice, nameKey, openAmount, partyKey, partyName } from "./invoices.ts";
import { daysBetween } from "./italian-calendar.ts";
import { italianDate } from "./italian-format.ts";
import type { Renewal } from "./renewals.ts";
import { fold } from "./text-match.ts";

export type TaxEstimate = { readonly date: string; readonly cents: bigint; readonly what: string };

export type MatchInputs = {
	readonly movements: readonly BankMovement[];
	readonly invoices: readonly Invoice[];
	readonly expenses: readonly Expense[];
	readonly renewals: readonly Renewal[];
	readonly taxes: readonly TaxEstimate[];
	/** The targets live matches hold already (targetKey). */
	readonly used: ReadonlySet<string>;
	/** Per movement, the targets the person refused for it (targetKey). */
	readonly refused: ReadonlyMap<string, ReadonlySet<string>>;
};

export type Outcome = {
	readonly movement: string;
	readonly state: "auto" | "proposed" | "ask" | "hint";
	readonly target?: MatchTarget;
	readonly strong?: true;
	readonly note?: "oldest" | "partial";
	readonly candidates?: readonly MatchTarget[];
};

/** What a target holds: an invoice whole («inv:KEY»), one instalment («inv:KEY#2»), an expense, a renewal… */
export function targetKey(t: Pick<MatchTarget, "kind" | "target" | "instalment">): string {
	if (t.kind === "invoice_in" || t.kind === "invoice_out") return `inv:${t.target ?? ""}${t.instalment === undefined ? "" : `#${t.instalment}`}`;
	return `${t.kind}:${t.target ?? ""}`;
}

/** The kinds whose target one movement holds: an invoice (or instalment) and an expense; a renewal charges again, an F24 has none. */
export const holdsTarget = (kind: MatchTarget["kind"]): boolean => kind === "invoice_in" || kind === "invoice_out" || kind === "expense";

/** Whether an invoice target is free: the whole invoice blocks its instalments, an instalment the whole. */
function free(key: string, used: ReadonlySet<string>): boolean {
	if (used.has(key)) return false;
	const whole = key.replace(/#\d+$/, "");
	if (whole !== key) return !used.has(whole);
	for (const u of used) if (u.startsWith(`${whole}#`)) return false;
	return true;
}

const near = (cents: bigint, other: bigint) => (cents > other ? cents - other : other - cents) <= 1n;

/** The description as words to look names up in: folded, legal forms out (nameKey). */
const keyOf = (text: string) => ` ${nameKey(text)} `;

/** A name said in the description, as a whole phrase of at least 3 characters. */
export function saysName(descKey: string, name: string | undefined): boolean {
	if (name === undefined) return false;
	const k = nameKey(name);
	return k.length >= 3 && descKey.includes(` ${k} `);
}

function saysVat(description: string, code: string | undefined): boolean {
	if (code === undefined || code.length < 8) return false;
	return description.replace(/[\s.]/g, "").toUpperCase().includes(code.toUpperCase());
}

function saysNumber(description: string, number: string | undefined): boolean {
	if (number === undefined) return false;
	const n = fold(number).replace(/[^a-z0-9]/g, "");
	if (n === "") return false;
	const d = fold(description);
	if (n.length >= 4 && /\D/.test(number)) return d.replace(/[^a-z0-9]/g, "").includes(n);
	const digits = n.replace(/^0+/, "");
	return new RegExp(`(?:fatt(?:ura)?|ft|fat|fatt n|n|nr|num(?:ero)?)\\.?\\s*0*${digits.replace(/[^a-z0-9]/g, "")}(?![0-9a-z])`).test(d);
}

const OWN = /\bgiro ?conto\b|\btrasferimento tra (?:i )?(?:miei )?conti\b|\bconti propri\b|\bown account\b|\binternal transfer\b/;
const WITHDRAWAL = /\bprelievo\b|\bprelevamento\b|\batm\b|\bcash withdrawal\b/;
const F24 = /\bf24\b|\bf ?23\b|\bdelega\b|\bagenzia (?:delle )?entrate\b|\bpagamento (?:imposte|tributi)\b/;

function invoiceLabel(inv: Invoice, n: number | undefined, side: "in" | "out"): string {
	const party = side === "in" ? inv.customer : inv.supplier;
	const rata = n === undefined ? "" : `, rata ${n} di ${inv.instalments.length}`;
	return `fattura ${inv.doc.number ?? "senza numero"}${inv.doc.date === undefined ? "" : ` del ${italianDate(inv.doc.date)}`} di ${partyName(party)}${rata}`.slice(0, BANK_LIMITS.label);
}

type Cand = { target: MatchTarget; strong: boolean; party: string; date: string; cents: bigint };

/** The invoices a movement may pay: the residual, or one open instalment, of an open invoice of its side. */
function invoiceCandidates(m: BankMovement, c: bigint, i: MatchInputs, used: ReadonlySet<string>, descKey: string): Cand[] {
	const side = c > 0n ? "in" : "out";
	const abs = c < 0n ? -c : c;
	const refused = i.refused.get(m.id);
	const out: Cand[] = [];
	for (const inv of i.invoices) {
		if (inv.side !== (side === "in" ? "active" : "passive") || inv.credit || inv.doc.integration || inv.paid || inv.doc.currency !== "EUR" || inv.doc.date === undefined || inv.doc.date > m.date) continue;
		const party = side === "in" ? inv.customer : inv.supplier;
		const strong = saysName(descKey, party.name) || saysVat(m.description, party.vat?.code) || saysNumber(m.description, inv.doc.number);
		const kind = side === "in" ? ("invoice_in" as const) : ("invoice_out" as const);
		const push = (n: number | undefined, cents: bigint) => {
			const target: MatchTarget = { kind, target: inv.key, ...(n === undefined ? {} : { instalment: n }), label: invoiceLabel(inv, n, side) };
			const key = targetKey(target);
			if (!free(key, used) || refused?.has(key) === true) return;
			out.push({ target, strong, party: partyKey(party), date: inv.doc.date as string, cents });
		};
		const open = unitsToCents(openAmount(inv));
		if (open > 0n && near(open, abs)) push(undefined, open);
		else if (inv.instalments.length > 1) {
			for (const r of inv.instalments) if (r.paid === undefined && r.extra !== true && r.amount !== undefined && near(unitsToCents(r.amount), abs)) push(r.n, unitsToCents(r.amount));
		}
	}
	return out;
}

/** One candidate or the oldest of alike ones (same party, same amount); otherwise undefined (ask). */
function pick(list: readonly Cand[]): { cand: Cand; oldest: boolean } | undefined {
	if (list.length === 1) return { cand: list[0] as Cand, oldest: false };
	const first = list[0] as Cand;
	if (list.every((x) => x.party === first.party && x.cents === first.cents)) {
		const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.target.label.localeCompare(b.target.label));
		return { cand: sorted[0] as Cand, oldest: true };
	}
	return undefined;
}

function decide(m: BankMovement, list: readonly Cand[], autoWhenStrong: boolean): Outcome | undefined {
	if (list.length === 0) return undefined;
	const strong = list.filter((x) => x.strong);
	const pool = strong.length > 0 ? strong : list;
	const one = pick(pool);
	if (one === undefined) return { movement: m.id, state: "ask", candidates: pool.slice(0, BANK_LIMITS.candidates).map((x) => x.target) };
	const isStrong = one.cand.strong;
	return { movement: m.id, state: isStrong && autoWhenStrong ? "auto" : "proposed", target: one.cand.target, ...(isStrong ? { strong: true as const } : {}), ...(one.oldest ? { note: "oldest" as const } : {}) };
}

/** A party named in the description with an open invoice of its side larger than the amount: maybe paid in part. */
function partialHint(m: BankMovement, c: bigint, i: MatchInputs, descKey: string): Outcome | undefined {
	const side = c > 0n ? "in" : "out";
	const abs = c < 0n ? -c : c;
	const named = i.invoices.filter((inv) => {
		if (inv.side !== (side === "in" ? "active" : "passive") || inv.credit || inv.doc.integration || inv.paid || inv.doc.date === undefined || inv.doc.date > m.date) return false;
		const party = side === "in" ? inv.customer : inv.supplier;
		return (saysName(descKey, party.name) || saysVat(m.description, party.vat?.code) || saysNumber(m.description, inv.doc.number)) && unitsToCents(openAmount(inv)) > abs;
	});
	if (named.length === 0 || new Set(named.map((inv) => partyKey(side === "in" ? inv.customer : inv.supplier))).size > 1) return undefined;
	const oldest = [...named].sort((a, b) => (a.doc.date ?? "").localeCompare(b.doc.date ?? ""))[0] as Invoice;
	return { movement: m.id, state: "hint", note: "partial", target: { kind: side === "in" ? "invoice_in" : "invoice_out", target: oldest.key, label: invoiceLabel(oldest, undefined, side) } };
}

function expenseOutcome(m: BankMovement, abs: bigint, i: MatchInputs, used: ReadonlySet<string>, descKey: string): Outcome | undefined {
	const refused = i.refused.get(m.id);
	const list: Cand[] = [];
	for (const e of i.expenses) {
		if (!near(expenseCents(e.amount), abs) || Math.abs(daysBetween(e.date, m.date)) > EXPENSE_DAYS) continue;
		const target: MatchTarget = { kind: "expense", target: e.id, label: `spesa ${e.id}${e.supplier === undefined ? "" : ` di ${e.supplier}`} del ${italianDate(e.date)}`.slice(0, BANK_LIMITS.label) };
		const key = targetKey(target);
		if (used.has(key) || refused?.has(key) === true) continue;
		list.push({ target, strong: saysName(descKey, e.supplier), party: e.id, date: e.date, cents: abs });
	}
	const strong = list.filter((x) => x.strong);
	const pool = strong.length > 0 ? strong : list;
	if (pool.length === 0) return undefined;
	if (pool.length > 1) return { movement: m.id, state: "ask", candidates: pool.slice(0, BANK_LIMITS.candidates).map((x) => x.target) };
	const one = pool[0] as Cand;
	return { movement: m.id, state: one.strong ? "auto" : "proposed", target: one.target, ...(one.strong ? { strong: true as const } : {}) };
}

function renewalOutcome(m: BankMovement, abs: bigint, i: MatchInputs, descKey: string): Outcome | undefined {
	const refused = i.refused.get(m.id);
	const list: Cand[] = [];
	for (const r of i.renewals) {
		const amount = r.amountFrom !== undefined && m.date >= r.amountFrom.from ? r.amountFrom.amount : r.amount;
		if (amount === undefined || !near(expenseCents(amount), abs)) continue;
		const target: MatchTarget = { kind: "renewal", target: r.id, label: `rinnovo ${r.id} ${r.name}${r.provider === undefined ? "" : ` (${r.provider})`}`.slice(0, BANK_LIMITS.label) };
		if (refused?.has(targetKey(target)) === true) continue;
		const strong = saysName(descKey, r.name) || saysName(descKey, r.provider);
		const dayGap = Math.abs(Number(m.date.slice(8, 10)) - Math.min(r.day, 28));
		if (!strong && !(r.autoPay === true && (dayGap <= 5 || dayGap >= 25))) continue;
		list.push({ target, strong, party: r.id, date: r.due, cents: abs });
	}
	const strong = list.filter((x) => x.strong);
	const pool = strong.length > 0 ? strong : list;
	if (pool.length === 0) return undefined;
	if (pool.length > 1) return { movement: m.id, state: "ask", candidates: pool.slice(0, BANK_LIMITS.candidates).map((x) => x.target) };
	const one = pool[0] as Cand;
	return { movement: m.id, state: one.strong ? "auto" : "proposed", target: one.target, ...(one.strong ? { strong: true as const } : {}) };
}

/** An F24 by its words; the estimate of the same amount within NEAR_DAYS named when there is one. */
function f24Outcome(m: BankMovement, abs: bigint, i: MatchInputs): Outcome | undefined {
	const words = fold(m.description);
	if (!F24.test(words) && !isTaxName(m.description)) return undefined;
	const estimate = i.taxes.find((t) => near(t.cents, abs) && Math.abs(daysBetween(t.date, m.date)) <= NEAR_DAYS);
	const label = estimate === undefined ? "F24 (tasse o contributi)" : `F24: ${estimate.what} (come la stima delle tasse del ${italianDate(estimate.date)})`;
	return { movement: m.id, state: "auto", target: { kind: "f24", label: label.slice(0, BANK_LIMITS.label) }, strong: true };
}

/**
 * The outcome of each movement that has one, oldest movement first (an earlier payment takes an
 * earlier invoice); a target given to one movement is not given to another. `autoInvoices`: the
 * person enabled «abbina da solo quando è sicuro», and a strong invoice match is «auto».
 */
export function matchMovements(i: MatchInputs, autoInvoices: boolean): Outcome[] {
	const used = new Set(i.used);
	const out: Outcome[] = [];
	const ordered = [...i.movements].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
	for (const m of ordered) {
		const c = movementCents(m.amount);
		const abs = c < 0n ? -c : c;
		const words = fold(m.description);
		const descKey = keyOf(m.description);
		let o: Outcome | undefined;
		if (m.own === true || OWN.test(words)) o = { movement: m.id, state: "auto", target: { kind: "transfer", label: "trasferimento tra i tuoi conti" }, strong: true };
		else if (c < 0n && WITHDRAWAL.test(words)) o = { movement: m.id, state: "auto", target: { kind: "withdrawal", label: "prelievo" }, strong: true };
		else if (c < 0n && (o = f24Outcome(m, abs, i)) !== undefined) {
			// an F24
		} else {
			o = decide(m, invoiceCandidates(m, c, i, used, descKey), autoInvoices);
			if (o === undefined && c < 0n) o = expenseOutcome(m, abs, i, used, descKey) ?? renewalOutcome(m, abs, i, descKey);
			if (o === undefined) o = partialHint(m, c, i, descKey);
		}
		if (o === undefined) continue;
		if (o.target !== undefined && o.state !== "hint" && holdsTarget(o.target.kind)) used.add(targetKey(o.target));
		out.push(o);
	}
	return out;
}
