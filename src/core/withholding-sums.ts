/**
 * The sums of the ritenute d'acconto, pure, in bigint cents, from the invoices with a ritenuta
 * (withholding-docs.ts), the CU said (withholding.ts) and, when there is one, the bank statement:
 *
 * - principio di cassa: a ritenuta counts in the year the client paid the invoice (the day of its
 *   last instalment marked paid), never the year of its date: an invoice of December paid in
 *   January is the next year's, in the next year's CU, a credit of the next year's dichiarazione
 *   (withholding-rules.ts CREDIT_RULE). A credit note counts with the minus in the year it is
 *   marked used; one not used yet is not counted, and is said.
 * - the payment: what came in (the bank's movements tied to the invoice, else an amount the person
 *   said, else what the scadenzario counts, which is the invoice's own figure and proves nothing)
 *   against the net (total less what is withheld) and the gross. Paid gross: the client withheld
 *   nothing, and that ritenuta is no credit; only the bank's word takes it off the credit.
 * - the CU: Annie's figures of the client and the year against the CU's; a difference is explained,
 *   when it can be, by the invoices that would make it (paid in another year, not marked paid,
 *   credit notes, paid gross), else it may be invoices that are not in the workspace.
 */
import { partyKey } from "./invoices.ts";
import { eurosToCents } from "./quote-sums.ts";
import type { FatturaParty } from "./fattura-pa.ts";
import type { WithheldDoc } from "./withholding-docs.ts";
import { cuDeadline, cuLate } from "./withholding-rules.ts";
import { type CuRecord, WITHHOLDING_LIMITS } from "./withholding.ts";

const abs = (n: bigint) => (n < 0n ? -n : n);
const yearOf = (day: string | undefined): number | undefined => (day === undefined ? undefined : Number(day.slice(0, 4)));

/** Whether a document counts in `year`: paid (or, a credit note, used) on a day of it. */
export const countsIn = (d: WithheldDoc, year: number): boolean => yearOf(d.paidOn) === year;

// --- Payments -----------------------------------------------------------------------------------

/** Where the amount received comes from: the bank statement, the person's word, the scadenzario (the invoice's own figure). */
export type ReceivedFrom = "bank" | "said" | "register";

/** net: the total less the ritenuta, as it should; gross: the whole total (nothing withheld); under: less than the net; other: between, or more than the gross. */
export type Verdict = "net" | "gross" | "under" | "other";

export type PaymentCheck = { readonly doc: WithheldDoc; readonly received: bigint; readonly from: ReceivedFrom; readonly verdict: Verdict; /** Received less the net. */ readonly diff: bigint };

/** A cent per side: what rounds differently is the same payment. */
const near = (a: bigint, b: bigint) => abs(a - b) <= 1n;

export function verdictOf(received: bigint, net: bigint, gross: bigint): Verdict {
	if (near(received, net)) return "net";
	if (near(received, gross)) return "gross";
	return received < net ? "under" : "other";
}

/** The money the bank says came in for each invoice: the movements tied to it (bank.ts statementOf, «inv:KEY»), summed. */
export function bankReceipts(statement: readonly { readonly amount: string; readonly target?: string }[]): Map<string, bigint> {
	const out = new Map<string, bigint>();
	for (const m of statement) {
		if (m.target === undefined || !m.target.startsWith("inv:")) continue;
		const cents = eurosToCents(m.amount.replace(/^-/, ""));
		if (m.amount.startsWith("-")) continue;
		const key = m.target.slice(4);
		out.set(key, (out.get(key) ?? 0n) + cents);
	}
	return out;
}

/** A paid invoice's payment checked (see above); `said`: the amount the person says came in, for this one invoice. */
export function checkPayment(d: WithheldDoc, bank: ReadonlyMap<string, bigint>, said?: bigint): PaymentCheck {
	const fromBank = bank.get(d.key);
	const [received, from]: [bigint, ReceivedFrom] = said !== undefined ? [said, "said"] : fromBank !== undefined ? [fromBank, "bank"] : [abs(d.received), "register"];
	const net = abs(d.net);
	return { doc: d, received, from, verdict: verdictOf(received, net, abs(d.total)), diff: received - net };
}

/** The ritenute of documents the bank says were paid gross: the client withheld nothing. */
const grossByBank = (c: PaymentCheck) => c.from === "bank" && c.verdict === "gross";

// --- The year -----------------------------------------------------------------------------------

export type ClientYear = { readonly clientKey: string; readonly client: FatturaParty; readonly compensi: bigint; readonly ritenuta: bigint; readonly count: number; readonly credits: number };

export type YearSummary = {
	readonly year: number;
	/** By client, the largest ritenute first. */
	readonly clients: readonly ClientYear[];
	readonly compensi: bigint;
	readonly ritenuta: bigint;
	/** The ritenute that are a credit for the dichiarazione: all but those the bank says were paid gross. */
	readonly credit: bigint;
	/** Paid gross by the bank's word: no credit. */
	readonly gross: readonly PaymentCheck[];
	/** The scadenzario says the invoice asks the gross (its payment data), not proof of what came in: to check. */
	readonly toCheck: readonly PaymentCheck[];
	/** Dated in the year, not paid (or paid in part) yet. */
	readonly open: number;
	readonly partly: number;
	/** Credit notes with a ritenuta not marked used. */
	readonly unusedCredits: number;
	/** Fatture in uscita whose XML is not in the workspace: their paid mark cannot be read. */
	readonly notInWorkspace: number;
};

export function yearSummary(docs: readonly WithheldDoc[], year: number, bank: ReadonlyMap<string, bigint>): YearSummary {
	const byClient = new Map<string, { clientKey: string; client: FatturaParty; compensi: bigint; ritenuta: bigint; count: number; credits: number }>();
	const gross: PaymentCheck[] = [];
	const toCheck: PaymentCheck[] = [];
	let compensi = 0n;
	let ritenuta = 0n;
	let excluded = 0n;
	for (const d of docs) {
		if (!countsIn(d, year)) continue;
		const c = byClient.get(d.clientKey) ?? { clientKey: d.clientKey, client: d.client, compensi: 0n, ritenuta: 0n, count: 0, credits: 0 };
		c.compensi += d.compensi;
		c.ritenuta += d.ritenuta;
		if (d.credit) c.credits++;
		else c.count++;
		byClient.set(d.clientKey, c);
		compensi += d.compensi;
		ritenuta += d.ritenuta;
		if (d.credit) continue;
		const check = checkPayment(d, bank);
		if (grossByBank(check)) {
			gross.push(check);
			excluded += d.ritenuta;
		} else if (check.from === "register" && check.verdict === "gross") toCheck.push(check);
	}
	const inYear = (d: WithheldDoc) => yearOf(d.date) === year;
	return {
		year,
		clients: [...byClient.values()].sort((a, b) => (b.ritenuta > a.ritenuta ? 1 : b.ritenuta < a.ritenuta ? -1 : a.clientKey.localeCompare(b.clientKey))),
		compensi,
		ritenuta,
		credit: ritenuta - excluded,
		gross,
		toCheck,
		open: docs.filter((d) => inYear(d) && !d.credit && d.paidOn === undefined && !d.partly).length,
		partly: docs.filter((d) => inYear(d) && !d.credit && d.partly).length,
		unusedCredits: docs.filter((d) => inYear(d) && d.credit && d.paidOn === undefined).length,
		notInWorkspace: docs.filter((d) => (inYear(d) || countsIn(d, year)) && !d.inRegister).length,
	};
}

// --- The CU -------------------------------------------------------------------------------------

/** Why an invoice may make Annie's figure differ from the CU's, and by how much (added to Annie's to get the CU's). */
export type Reason = "paid_next_year" | "paid_this_year" | "not_marked" | "credit_counted" | "credit_unused" | "paid_gross";

export type Explaining = { readonly doc: WithheldDoc; readonly reason: Reason; readonly effect: bigint };

export type CuComparison = {
	readonly cu: CuRecord;
	/** Annie's figures of the client and the year. */
	readonly compensi: bigint;
	readonly ritenuta: bigint;
	readonly count: number;
	/** The CU's less Annie's. */
	readonly diffRitenuta: bigint;
	readonly diffCompensi: bigint;
	readonly matches: boolean;
	/** The invoices that make the difference exactly, when some do; else every one that may. */
	readonly explained: readonly Explaining[];
	readonly exact: boolean;
	/** The CU says more and nothing explains it: maybe invoices not in the workspace. */
	readonly missing: boolean;
};

/** The documents of a client that may make the difference, each with the effect counting it the other way would have. */
function candidates(docs: readonly WithheldDoc[], year: number, checks: (d: WithheldDoc) => PaymentCheck): Explaining[] {
	const out: Explaining[] = [];
	for (const d of docs) {
		const dated = yearOf(d.date) as number;
		const paid = yearOf(d.paidOn);
		if (d.credit) {
			if (paid === year) out.push({ doc: d, reason: "credit_counted", effect: -d.ritenuta });
			else if (paid === undefined && (dated === year || dated === year + 1)) out.push({ doc: d, reason: "credit_unused", effect: d.ritenuta });
			continue;
		}
		if (dated === year && paid !== undefined && paid > year) out.push({ doc: d, reason: "paid_next_year", effect: d.ritenuta });
		else if (dated < year && paid === year) out.push({ doc: d, reason: "paid_this_year", effect: -d.ritenuta });
		else if (paid === undefined && dated <= year) out.push({ doc: d, reason: "not_marked", effect: d.ritenuta });
		else if (paid === year && grossByBank(checks(d))) out.push({ doc: d, reason: "paid_gross", effect: -d.ritenuta });
	}
	return out;
}

/** The smallest set of `list` whose effects add up to `diff` within `tolerance`; undefined when none (or the list is too long to try). */
function exactSet(list: readonly Explaining[], diff: bigint, tolerance: bigint): Explaining[] | undefined {
	if (list.length === 0 || list.length > WITHHOLDING_LIMITS.tried) return undefined;
	let best: Explaining[] | undefined;
	for (let mask = 1; mask < 1 << list.length; mask++) {
		const set = list.filter((_, i) => (mask & (1 << i)) !== 0);
		if (best !== undefined && set.length >= best.length) continue;
		const sum = set.reduce((n, e) => n + e.effect, 0n);
		if (abs(sum - diff) <= tolerance) best = set;
	}
	return best;
}

/** A CU against Annie's figures of its client and year (see above). */
export function compareCu(cu: CuRecord, docs: readonly WithheldDoc[], bank: ReadonlyMap<string, bigint>): CuComparison {
	const own = docs.filter((d) => d.clientKey === cu.client.key);
	const counted = own.filter((d) => countsIn(d, cu.year));
	const compensi = counted.reduce((n, d) => n + d.compensi, 0n);
	const ritenuta = counted.reduce((n, d) => n + d.ritenuta, 0n);
	const count = counted.filter((d) => !d.credit).length;
	const diffRitenuta = eurosToCents(cu.withheld) - ritenuta;
	const diffCompensi = eurosToCents(cu.gross) - compensi;
	// A cent for each invoice: the client's software rounds each one too.
	const tolerance = BigInt(Math.max(1, counted.length));
	const matches = abs(diffRitenuta) <= tolerance;
	if (matches) return { cu, compensi, ritenuta, count, diffRitenuta, diffCompensi, matches, explained: [], exact: true, missing: false };
	const list = candidates(own, cu.year, (d) => checkPayment(d, bank));
	const exact = exactSet(list, diffRitenuta, tolerance);
	const towards = list.filter((e) => (e.effect > 0n) === (diffRitenuta > 0n));
	return { cu, compensi, ritenuta, count, diffRitenuta, diffCompensi, matches, explained: exact ?? towards, exact: exact !== undefined, missing: exact === undefined && diffRitenuta > 0n };
}

// --- The CU still to come -----------------------------------------------------------------------

export type CuState = { readonly client: ClientYear; readonly cu?: CuRecord; readonly comparison?: CuComparison };

export type CuList = {
	readonly year: number;
	readonly deadline: string;
	readonly late: boolean;
	/** The clients with ritenute in the year whose CU has not been said. */
	readonly missing: readonly ClientYear[];
	/** Those received, compared. */
	readonly received: readonly CuComparison[];
	/** CU said for clients without ritenute in the year by Annie's figures. */
	readonly unexpected: readonly CuComparison[];
};

export function cuList(docs: readonly WithheldDoc[], cus: readonly CuRecord[], year: number, today: string, bank: ReadonlyMap<string, bigint>): CuList {
	const summary = yearSummary(docs, year, bank);
	const ofYear = cus.filter((c) => c.year === year);
	const keys = new Set(ofYear.map((c) => c.client.key));
	const withRitenute = summary.clients.filter((c) => c.ritenuta > 0n);
	const clientKeys = new Set(withRitenute.map((c) => c.clientKey));
	const comparisons = ofYear.map((c) => compareCu(c, docs, bank));
	return {
		year,
		deadline: cuDeadline(year),
		late: cuLate(year, today),
		missing: withRitenute.filter((c) => !keys.has(c.clientKey)),
		received: comparisons.filter((c) => clientKeys.has(c.cu.client.key)),
		unexpected: comparisons.filter((c) => !clientKeys.has(c.cu.client.key)),
	};
}

/** The key a client said for a CU is grouped by, as its invoices are. */
export function cuKey(client: { readonly name: string; readonly vat?: string; readonly cf?: string }): string {
	return partyKey({ name: client.name, ...(client.vat === undefined ? {} : { vat: { country: client.vat.slice(0, 2), code: client.vat.slice(2) } }), ...(client.cf === undefined ? {} : { fiscal: client.cf }) });
}
