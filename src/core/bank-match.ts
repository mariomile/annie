/**
 * What explains a bank movement, pure: given the movements and what the other registers say
 * (the scadenzario's invoices, the expenses, the renewals, the F24 estimates), one outcome each.
 * Conservative, because a wrong «incassata» corrupts the taxes, the cashflow and the clients:
 *
 * - An invoice is a candidate only when the amount is its residual or one of its open instalments
 *   (to the cent, ±0,01), dated on or before the movement, still open (an instalment marked paid
 *   is never one), not a credit note, not already taken by another movement. Strong only when the
 *   description also names the party surely: its partita IVA, or its name of two or more words
 *   (every word, in any order); a one-word name only with the invoice's number too. The number
 *   alone, with the amount, stays weak. One strong candidate is
 *   proposed; alike ones of the same party (same amount), the oldest, and said (two equal
 *   instalments of one invoice: the first); otherwise the person is asked. Without a candidate, a
 *   description naming a party with an open invoice larger than the amount is a hint: maybe an
 *   acconto, never marked.
 * - Invoices come first; then an F24 by the bank's words only (F24, delega, Agenzia delle
 *   Entrate), tied to the tax estimate of the same amount within NEAR_DAYS when there is one, and
 *   only proposed when an open invoice has the same amount.
 * - An expense recorded within EXPENSE_DAYS of the date with the same amount: with the supplier's
 *   name in the description it explains the movement, without it is proposed.
 * - A renewal's charge: its amount and its name (or provider) in the description.
 * - A transfer between the person's own accounts (one of the company's IBANs, «giroconto») and a
 *   withdrawal (prelievo, ATM).
 *
 * Nothing here writes: the tools keep the outcomes and write the other registers only on a yes.
 */
import { BANK_LIMITS, type BankMovement, delDay, EXPENSE_DAYS, type MatchNote, type MatchTarget, NEAR_DAYS } from "./bank.ts";
import type { Expense } from "./expenses.ts";
import { euros } from "./format-words.ts";
import { type Invoice, nameKey, openAmount, partyKey, partyName } from "./invoices.ts";
import { daysBetween } from "./italian-calendar.ts";
import { eurosToCents, unitsToCents } from "./quote-sums.ts";
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
	readonly note?: MatchNote;
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

/** The words of a name or a description to compare: folded, «&» as «e», legal forms out (nameKey). */
export const nameWords = (text: string): string[] => nameKey(text.replace(/&/g, " e ")).split(" ").filter((w) => w !== "");

/** The words of a name that count: 3 or more characters. */
const nameParts = (name: string | undefined): string[] => (name === undefined ? [] : nameWords(name).filter((w) => w.length >= 3));

/**
 * A name said in the description: every word of 3 or more characters of the name is there, in any
 * order («Gallo Mario» in «MARIO GALLO»). Only the description's last word may be cut by the bank,
 * and only as the name's last word, from its first 5 characters («ROSSI ARREDAM» for «Rossi
 * Arredamenti»; never «MARIO ROSSI» for «Rossini Mario»).
 */
export function saysName(descWords: readonly string[], name: string | undefined): boolean {
	const want = nameParts(name);
	if (want.length === 0) return false;
	const lastAt = descWords.length - 1;
	return want.every((w, k) => descWords.some((d, at) => d === w || (at === lastAt && k === want.length - 1 && d.length >= 5 && w.startsWith(d))));
}

/** The party named surely: its partita IVA; or its name of 2 or more words; a name of one word only with the invoice's number too. */
function namesParty(descWords: readonly string[], description: string, party: { readonly name?: string; readonly vat?: { readonly code: string } }, number: string | undefined): boolean {
	if (saysVat(description, party.vat?.code)) return true;
	if (!saysName(descWords, party.name)) return false;
	return nameParts(party.name).length >= 2 || saysNumber(description, number);
}

function saysVat(description: string, code: string | undefined): boolean {
	if (code === undefined || code.length < 8) return false;
	return new RegExp(`(?<![0-9])${code.replace(/[^0-9A-Za-z]/g, "")}(?![0-9])`, "i").test(description.replace(/[\s.]/g, ""));
}

/** The invoice's number written in the description, as a whole: «FT FV-12», «fattura n. 12»; never inside another word or number («TRN 0012»). */
export function saysNumber(description: string, number: string | undefined): boolean {
	if (number === undefined) return false;
	const n = fold(number).replace(/[^a-z0-9]/g, "");
	if (n === "") return false;
	const d = fold(description);
	if (n.length >= 4 && /\D/.test(n)) return new RegExp(`(?<![a-z0-9])${[...n].join("[\\s./-]*")}(?![a-z0-9])`).test(d);
	const digits = n.replace(/^0+/, "") || "0";
	return new RegExp(`\\b(?:fatt(?:ura)?|ft|fat|n|nr|num(?:ero)?)\\.?\\s*(?:n\\.?\\s*)?0*${digits}(?![0-9a-z])`).test(d);
}

const OWN = /\bgiro ?conto\b|\btrasferimento tra (?:i )?(?:miei )?conti\b|\bconti propri\b|\bown account\b|\binternal transfer\b/;
const WITHDRAWAL = /\bprelievo\b|\bprelevamento\b|\batm\b|\bcash withdrawal\b/;
/** The bank's words for an F24: never a tax word alone («rivalsa INPS» on an invoice is no F24). */
const F24 = /\bf ?24\b|\bdelega\b|\bagenzia (?:delle )?entrate\b|\bag\.? ?entrate\b/;

const sideParty = (inv: Invoice, side: "in" | "out") => (side === "in" ? inv.customer : inv.supplier);

/** «fattura 21 di Rossi Srl», «…, rata 1 di 2». */
function invoiceLabel(inv: Invoice, n: number | undefined, side: "in" | "out"): string {
	const rata = n === undefined ? "" : `, rata ${n} di ${inv.instalments.length}`;
	return `fattura ${inv.doc.number ?? "senza numero"} di ${partyName(sideParty(inv, side))}${rata}`.slice(0, BANK_LIMITS.label);
}

type Cand = { target: MatchTarget; strong: boolean; numbered: boolean; party: string; invoice: string; n: number; date: string; cents: bigint };

/** An open invoice of the movement's side, not before it: the only ones a movement may pay. */
function openOfSide(inv: Invoice, side: "in" | "out", date: string): boolean {
	return inv.side === (side === "in" ? "active" : "passive") && !inv.credit && !inv.doc.integration && !inv.paid && inv.doc.currency === "EUR" && inv.doc.date !== undefined && inv.doc.date <= date;
}

/** The invoices a movement may pay: the residual, or one open instalment, of an open invoice of its side. */
function invoiceCandidates(m: BankMovement, c: bigint, i: MatchInputs, used: ReadonlySet<string>, descWords: readonly string[]): Cand[] {
	const side = c > 0n ? "in" : "out";
	const abs = c < 0n ? -c : c;
	const refused = i.refused.get(m.id);
	const out: Cand[] = [];
	for (const inv of i.invoices) {
		if (!openOfSide(inv, side, m.date)) continue;
		const party = sideParty(inv, side);
		const strong = namesParty(descWords, m.description, party, inv.doc.number);
		const numbered = saysNumber(m.description, inv.doc.number);
		const kind = side === "in" ? ("invoice_in" as const) : ("invoice_out" as const);
		const push = (n: number | undefined, cents: bigint) => {
			const target: MatchTarget = { kind, target: inv.key, ...(n === undefined ? {} : { instalment: n }), label: invoiceLabel(inv, n, side) };
			const key = targetKey(target);
			if (!free(key, used) || refused?.has(key) === true) return;
			out.push({ target, strong, numbered, party: partyKey(party), invoice: inv.key, n: n ?? 0, date: inv.doc.date as string, cents });
		};
		const open = unitsToCents(openAmount(inv));
		if (open > 0n && near(open, abs)) push(undefined, open);
		else if (inv.instalments.length > 1) {
			for (const r of inv.instalments) if (r.paid === undefined && r.extra !== true && r.amount !== undefined && near(unitsToCents(r.amount), abs)) push(r.n, unitsToCents(r.amount));
		}
	}
	return out;
}

/** One candidate or the oldest of alike ones (same party, same amount; of one invoice, the first instalment); otherwise undefined (ask). */
function pick(list: readonly Cand[]): { cand: Cand; note?: MatchNote } | undefined {
	if (list.length === 1) return { cand: list[0] as Cand };
	const numbered = list.filter((x) => x.numbered);
	if (numbered.length === 1) return { cand: numbered[0] as Cand };
	const first = list[0] as Cand;
	if (list.every((x) => x.party === first.party && x.cents === first.cents)) {
		const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.invoice.localeCompare(b.invoice) || a.n - b.n);
		return { cand: sorted[0] as Cand, note: list.every((x) => x.invoice === first.invoice) ? "rate" : "oldest" };
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
	return { movement: m.id, state: isStrong && autoWhenStrong ? "auto" : "proposed", target: one.cand.target, ...(isStrong ? { strong: true as const } : {}), ...(one.note === undefined ? {} : { note: one.note }) };
}

/**
 * A party named in the description with an open invoice of its side larger than the amount, not
 * held by another movement: maybe an acconto. The invoice whose number is written, else the oldest.
 */
function partialHint(m: BankMovement, c: bigint, i: MatchInputs, used: ReadonlySet<string>, descWords: readonly string[]): Outcome | undefined {
	const side = c > 0n ? "in" : "out";
	const abs = c < 0n ? -c : c;
	const named = i.invoices.filter((inv) => openOfSide(inv, side, m.date) && free(`inv:${inv.key}`, used) && namesParty(descWords, m.description, sideParty(inv, side), inv.doc.number) && unitsToCents(openAmount(inv)) > abs);
	const numbered = named.filter((inv) => saysNumber(m.description, inv.doc.number));
	if (named.length === 0 || (numbered.length !== 1 && new Set(named.map((inv) => partyKey(sideParty(inv, side)))).size > 1)) return undefined;
	const oldest = numbered.length === 1 ? (numbered[0] as Invoice) : ([...named].sort((a, b) => (a.doc.date ?? "").localeCompare(b.doc.date ?? ""))[0] as Invoice);
	const label = `${invoiceLabel(oldest, undefined, side)} (${euros(unitsToCents(openAmount(oldest)))})`.slice(0, BANK_LIMITS.label);
	return { movement: m.id, state: "hint", note: "partial", target: { kind: side === "in" ? "invoice_in" : "invoice_out", target: oldest.key, label } };
}

/** The outcome of a list of candidates of an expense or a renewal: the one strong (auto), the one weak (proposed), several (ask). */
function oneOf(m: BankMovement, list: readonly Cand[]): Outcome | undefined {
	const strong = list.filter((x) => x.strong);
	const pool = strong.length > 0 ? strong : list;
	if (pool.length === 0) return undefined;
	if (pool.length > 1) return { movement: m.id, state: "ask", candidates: pool.slice(0, BANK_LIMITS.candidates).map((x) => x.target) };
	const one = pool[0] as Cand;
	return { movement: m.id, state: one.strong ? "auto" : "proposed", target: one.target, ...(one.strong ? { strong: true as const } : {}) };
}

const cand = (target: MatchTarget, strong: boolean, date: string, cents: bigint): Cand => ({ target, strong, numbered: false, party: target.target ?? "", invoice: "", n: 0, date, cents });

function expenseOutcome(m: BankMovement, abs: bigint, i: MatchInputs, used: ReadonlySet<string>, descWords: readonly string[]): Outcome | undefined {
	const refused = i.refused.get(m.id);
	const list: Cand[] = [];
	for (const e of i.expenses) {
		if (!near(eurosToCents(e.amount), abs) || Math.abs(daysBetween(e.date, m.date)) > EXPENSE_DAYS) continue;
		const target: MatchTarget = { kind: "expense", target: e.id, label: `spesa ${e.id}${e.supplier === undefined ? "" : ` di ${e.supplier}`} ${delDay(e.date)}`.slice(0, BANK_LIMITS.label) };
		const key = targetKey(target);
		if (used.has(key) || refused?.has(key) === true) continue;
		list.push(cand(target, saysName(descWords, e.supplier), e.date, abs));
	}
	return oneOf(m, list);
}

function renewalOutcome(m: BankMovement, abs: bigint, i: MatchInputs, descWords: readonly string[]): Outcome | undefined {
	const refused = i.refused.get(m.id);
	const list: Cand[] = [];
	for (const r of i.renewals) {
		const amount = r.amountFrom !== undefined && m.date >= r.amountFrom.from ? r.amountFrom.amount : r.amount;
		if (amount === undefined || !near(eurosToCents(amount), abs)) continue;
		const target: MatchTarget = { kind: "renewal", target: r.id, label: `rinnovo ${r.name}${r.provider === undefined ? "" : `, ${r.provider}`}`.slice(0, BANK_LIMITS.label) };
		if (refused?.has(targetKey(target)) === true) continue;
		const strong = saysName(descWords, r.name) || saysName(descWords, r.provider);
		const dayGap = Math.abs(Number(m.date.slice(8, 10)) - Math.min(r.day, 28));
		if (!strong && !(r.autoPay === true && (dayGap <= 5 || dayGap >= 25))) continue;
		list.push(cand(target, strong, r.due, abs));
	}
	return oneOf(m, list);
}

/** Whether an open invoice of the movement's side has its amount (the residual or an open instalment), taken or not. */
function invoiceOfAmount(m: BankMovement, c: bigint, i: MatchInputs): boolean {
	const side = c > 0n ? "in" : "out";
	const abs = c < 0n ? -c : c;
	return i.invoices.some((inv) => openOfSide(inv, side, m.date) && (near(unitsToCents(openAmount(inv)), abs) || inv.instalments.some((r) => r.paid === undefined && r.amount !== undefined && near(unitsToCents(r.amount), abs))));
}

/** An F24 by the bank's words; the estimate of the same amount within NEAR_DAYS named when there is one. Only proposed when an invoice has the same amount. */
function f24Outcome(m: BankMovement, c: bigint, i: MatchInputs): Outcome | undefined {
	if (!F24.test(fold(m.description))) return undefined;
	const abs = -c;
	const estimate = i.taxes.find((t) => near(t.cents, abs) && Math.abs(daysBetween(t.date, m.date)) <= NEAR_DAYS);
	const label = estimate === undefined ? "F24 per tasse o contributi" : `F24 per ${estimate.what}, come la stima delle tasse ${delDay(estimate.date)}`;
	const target: MatchTarget = { kind: "f24", label: label.slice(0, BANK_LIMITS.label) };
	return invoiceOfAmount(m, c, i) ? { movement: m.id, state: "proposed", target } : { movement: m.id, state: "auto", target, strong: true };
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
	// The acconto hints after every match: an invoice a later movement takes is not hinted for an earlier one.
	const unexplained: { readonly m: BankMovement; readonly c: bigint; readonly descWords: readonly string[] }[] = [];
	for (const m of ordered) {
		const c = eurosToCents(m.amount);
		const abs = c < 0n ? -c : c;
		const words = fold(m.description);
		const descWords = nameWords(m.description);
		let o: Outcome | undefined;
		if (m.own === true || OWN.test(words)) o = { movement: m.id, state: "auto", target: { kind: "transfer", label: "trasferimento tra i tuoi conti" }, strong: true };
		else if (c < 0n && WITHDRAWAL.test(words)) o = { movement: m.id, state: "auto", target: { kind: "withdrawal", label: "prelievo" }, strong: true };
		else {
			o = decide(m, invoiceCandidates(m, c, i, used, descWords), autoInvoices);
			if (o === undefined && c < 0n) o = f24Outcome(m, c, i) ?? expenseOutcome(m, abs, i, used, descWords) ?? renewalOutcome(m, abs, i, descWords);
		}
		if (o === undefined) {
			unexplained.push({ m, c, descWords });
			continue;
		}
		if (o.target !== undefined && o.state !== "hint" && holdsTarget(o.target.kind)) used.add(targetKey(o.target));
		out.push(o);
	}
	for (const { m, c, descWords } of unexplained) {
		const hint = partialHint(m, c, i, used, descWords);
		if (hint !== undefined) out.push(hint);
	}
	const at = new Map(ordered.map((m, k) => [m.id, k]));
	return out.sort((a, b) => (at.get(a.movement) ?? 0) - (at.get(b.movement) ?? 0));
}
