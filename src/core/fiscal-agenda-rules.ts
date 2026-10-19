/**
 * The yearly deadlines no other register models, each with its source, for l'agenda fiscale
 * (fiscal-agenda.ts): the dichiarazione dei redditi, the dichiarazione IVA and the comunicazioni
 * delle liquidazioni periodiche (LIPE) of the ordinario, the diritto annuale of the Camera di
 * Commercio for the imprese iscritte, the imposta di bollo on the electronic invoices. Where the
 * source is not certain, or the rule changes often, the comment says «da verificare». Every
 * deadline on a Saturday, a Sunday or a holiday moves to the next working day (art. 7, comma 1,
 * lett. h, DL 70/2011; dates.ts dueSlip). A year with a proroga goes in its table, the pattern of
 * taxes.ts JUNE_DEADLINES.
 *
 * What is modelled elsewhere stays there and is only read: the F24 of the forfettario and the INPS
 * instalments (taxes.ts, tax-sums.ts), the F24 of the IVA (vat-rules.ts, vat-sums.ts), the CU
 * (withholding-rules.ts). Left out on purpose:
 * - the 730 and the precompilata (30 September, art. 16-bis DLgs 241/1997): whoever has income from
 *   a partita IVA (lavoro autonomo abituale, impresa) files the modello Redditi PF, not the 730
 *   (istruzioni del 730, «chi non può presentare il 730»);
 * - the esterometro: from 1 July 2022 the cross-border operations go through the SdI with the
 *   electronic invoices (art. 1, comma 3-bis, DLgs 127/2015, as amended by L. 178/2020);
 * - the modello 770 (31 October, art. 4, comma 4-bis, DPR 322/1998): only for a sostituto
 *   d'imposta (employees, or compensi paid with a ritenuta), which the profile never says; never
 *   listed. Da verificare with the commercialista for whoever has employees;
 * - the IRAP: the forfettari are out of it (art. 1, comma 64, L. 190/2014) and the professionals
 *   without an autonomous organisation too; the commercialista says when it is due.
 */
import { dueSlip, type Slip } from "./dates.ts";
import { daysInMonth } from "./italian-calendar.ts";
import { BOLLO_CENTS } from "./sales-invoice-rules.ts";
import { juneDays } from "./tax-sums.ts";
import { JUNE_DUE } from "./taxes.ts";

/**
 * The modello Redditi PF, sent online by 31 October of the year after the income (art. 2, comma 2,
 * DPR 322/1998, as amended by art. 11 DLgs 1/2024 from the dichiarazioni of 2024; before, 30
 * November). A year whose deadline was prorogated goes in REDDITI_PROROGHE (none known; da
 * verificare each year).
 */
export const REDDITI_DUE = "10-31";
export const REDDITI_PROROGHE: Readonly<Record<number, string>> = {};

/**
 * The dichiarazione IVA annuale of the ordinario, sent from 1 February to 30 April of the next year
 * (art. 8, comma 1, DPR 322/1998, as amended by art. 1, comma 641, L. 190/2014 and DL 34/2019). The
 * forfettari are exempt (art. 1, comma 58, lett. c, L. 190/2014). Proroghe in IVA_PROROGHE (none
 * known; da verificare each year).
 */
export const IVA_RETURN_DUE = "04-30";
export const IVA_PROROGHE: Readonly<Record<number, string>> = {};

/**
 * The comunicazione delle liquidazioni periodiche IVA (LIPE), for every ordinario, monthly or
 * quarterly alike, by the last day of the second month after each quarter; the second quarter by 16
 * September (art. 21-bis DL 78/2010, as amended by art. 4 DL 193/2016 and art. 12-quater DL
 * 34/2019). The fourth quarter by the last day of February of the next year, or inside the
 * dichiarazione IVA when that is sent by the end of February (same article, comma 1, last period).
 * Da verificare each year.
 */
export const LIPE_DUE: Readonly<Record<1 | 2 | 3, string>> = { 1: "05-31", 2: "09-16", 3: "11-30" };

/**
 * The diritto annuale of the Camera di Commercio, for the imprese iscritte (or annotate) in the
 * registro delle imprese, by the deadline of the first acconto delle imposte sui redditi (art. 8 DM
 * 359/2001), and so with the same proroga (note del MIMIT each year; da verificare). Here the same
 * day as the F24 of June the agenda shows: the forfettario's prorogated one (taxes.ts
 * JUNE_DEADLINES), the law's 30 June for the ordinario (tax-sums.ts plainCalendar). The amount is
 * fixed by the chamber (44 € for a ditta individuale in the sezione speciale, before any
 * maggiorazione of the chamber; DM 21 aprile 2011 and art. 28 DL 90/2014; da verificare): not
 * estimated.
 */
export const CAMERALE_RULE = "art. 8 DM 359/2001";

/**
 * The imposta di bollo on the electronic invoices (2,00 € each, sales-invoice-rules.ts), paid with
 * F24 by the last day of the second month after each quarter: Q1 by 31 May, Q2 by 30 September, Q3
 * by 30 November, Q4 by the last day of February of the next year (art. 6, comma 2, DM 17 giugno
 * 2014, as amended by DM 4 dicembre 2020; not the 20th of the month after the quarter of the rule
 * before 2021). When the bollo of Q1 is under 5.000 € it may be paid with Q2's; when Q1 and Q2
 * together are under 5.000 €, with Q3's (art. 17, comma 1-bis, DL 124/2019, threshold raised from
 * 250 € to 5.000 € by art. 3-bis DL 73/2022). Da verificare each year. Codici tributo 2521 to 2524,
 * one per quarter (ris. AdE 42/E del 2019; da verificare).
 */
export const BOLLO_DUE: Readonly<Record<1 | 2 | 3, string>> = { 1: "05-31", 2: "09-30", 3: "11-30" };
export const BOLLO_DEFER_BELOW_CENTS = 500_000n;
export const bolloCode = (quarter: 1 | 2 | 3 | 4): string => String(2520 + quarter);
export { BOLLO_CENTS };

export type RuleKind = "redditi" | "iva_annuale" | "lipe" | "camerale" | "bollo";

/** A deadline of a rule: the day written in the law (with the year's proroga), the working day it moves to, and why. */
export type RuleDeadline = {
	readonly kind: RuleKind;
	/** Stable per deadline: «redditi:2026», «lipe:2026-T3»; the bollo by its written day, «bollo:2026-11-30», so it stays the same as later quarters fill. */
	readonly key: string;
	readonly due: string;
	readonly date: string;
	readonly slip?: Slip;
	/** The year the deadline is about: the income's, the IVA's, the quarters'. */
	readonly year: number;
	readonly quarters?: readonly (1 | 2 | 3 | 4)[];
	readonly code?: string;
	/** The bollo: the amount and how many invoices; `partial` while a quarter of its group is under way or still to come. */
	readonly cents?: bigint;
	readonly count?: number;
	readonly partial?: boolean;
};

/** Who the person is, as far as the rules need it: the regime (undefined: not known) and whether they are an impresa iscritta in the registro delle imprese. */
export type Applies = { readonly regime?: "forfettario" | "ordinario"; readonly impresa: boolean };

const lastOfFebruary = (year: number) => `${year}-02-${String(daysInMonth(year, 2)).padStart(2, "0")}`;

function make(kind: RuleKind, key: string, due: string, year: number, more: Partial<RuleDeadline> = {}): RuleDeadline {
	return { kind, key, due, ...dueSlip(due), year, ...more };
}

/** The Redditi PF of the income of `year`, due in `year + 1`. */
export function redditiDue(year: number, proroghe: Readonly<Record<number, string>> = REDDITI_PROROGHE): string {
	return proroghe[year + 1] ?? `${year + 1}-${REDDITI_DUE}`;
}

/** The dichiarazione IVA of `year`, due in `year + 1`. */
export function ivaReturnDue(year: number, proroghe: Readonly<Record<number, string>> = IVA_PROROGHE): string {
	return proroghe[year + 1] ?? `${year + 1}-${IVA_RETURN_DUE}`;
}

/** The LIPE of a quarter of `year`: the fourth by the end of February of the next year. */
export function lipeDue(year: number, quarter: 1 | 2 | 3 | 4): string {
	return quarter === 4 ? lastOfFebruary(year + 1) : `${year}-${LIPE_DUE[quarter]}`;
}

/** The bollo of a quarter of `year`, before any deferral: the fourth by the end of February of the next year. */
export function bolloDue(year: number, quarter: 1 | 2 | 3 | 4): string {
	return quarter === 4 ? lastOfFebruary(year + 1) : `${year}-${BOLLO_DUE[quarter]}`;
}

/** The diritto camerale of `year`: the June F24's day the agenda shows (see CAMERALE_RULE). */
export function cameraleDue(year: number, ordinario: boolean): string {
	return ordinario ? `${year}-${JUNE_DUE}` : juneDays(year).due;
}

/**
 * The generic deadlines whose written day falls in `year`, as they apply: the Redditi PF to every
 * partita IVA; the dichiarazione IVA and the LIPE to the ordinario; the diritto camerale to an
 * impresa iscritta. The bollo is apart (bolloDeadlines): it depends on the invoices.
 */
export function genericDeadlines(year: number, a: Applies): RuleDeadline[] {
	const out: RuleDeadline[] = [make("redditi", `redditi:${year - 1}`, redditiDue(year - 1), year - 1)];
	if (a.regime === "ordinario") {
		out.push(make("iva_annuale", `iva_annuale:${year - 1}`, ivaReturnDue(year - 1), year - 1));
		out.push(make("lipe", `lipe:${year - 1}-T4`, lipeDue(year - 1, 4), year - 1, { quarters: [4] }));
		for (const q of [1, 2, 3] as const) out.push(make("lipe", `lipe:${year}-T${q}`, lipeDue(year, q), year, { quarters: [q] }));
	}
	if (a.impresa) out.push(make("camerale", `camerale:${year}`, cameraleDue(year, a.regime === "ordinario"), year));
	return out.sort((x, y) => x.due.localeCompare(y.due) || x.key.localeCompare(y.key));
}

/** The bollo of one quarter: its amount, the invoices, whether the quarter is still under way. */
export type QuarterBollo = { readonly cents: bigint; readonly count: number; readonly partial: boolean };

/**
 * The payments of the bollo of `year` (Q1 to Q3 in `year`, Q4 in February of the next), with the
 * deferrals under BOLLO_DEFER_BELOW_CENTS: Q1 with Q2, or Q1 and Q2 with Q3. Only payments with an
 * amount; the deferral is decided on the amounts known (a quarter under way counts what it has).
 * The quarters, the codes and the amount are those with invoices; the payment is partial while any
 * quarter of its group is under way or still to come (more invoices may join it); its key is its
 * written day, the same however the group fills.
 */
export function bolloDeadlines(year: number, of: (quarter: 1 | 2 | 3 | 4) => QuarterBollo): RuleDeadline[] {
	const q = ([1, 2, 3, 4] as const).map((n) => ({ n, ...of(n) }));
	const [q1, q2, q3, q4] = q as [(typeof q)[0], (typeof q)[0], (typeof q)[0], (typeof q)[0]];
	const groups: (typeof q)[] = [];
	if (q1.cents + q2.cents < BOLLO_DEFER_BELOW_CENTS) groups.push([q1, q2, q3]);
	else if (q1.cents < BOLLO_DEFER_BELOW_CENTS) groups.push([q1, q2], [q3]);
	else groups.push([q1], [q2], [q3]);
	groups.push([q4]);
	const out: RuleDeadline[] = [];
	for (const g of groups) {
		const paid = g.filter((x) => x.cents > 0n);
		if (paid.length === 0) continue;
		const last = g.at(-1) as (typeof q)[0];
		const quarters = paid.map((x) => x.n);
		const cents = paid.reduce((n, x) => n + x.cents, 0n);
		const count = paid.reduce((n, x) => n + x.count, 0);
		const due = bolloDue(year, last.n);
		const code = quarters.map(bolloCode).join(", ");
		out.push(make("bollo", `bollo:${due}`, due, year, { quarters, code, cents, count, ...(g.some((x) => x.partial) ? { partial: true } : {}) }));
	}
	return out;
}
