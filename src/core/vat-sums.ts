/**
 * The arithmetic of la liquidazione IVA, pure, in bigint cents, half up to the cent, on the
 * documents of vat-docs.ts and what the person said (vat.ts):
 *
 * - a period's figures: IVA a debito and a credito by the rules of vat-docs.ts, with the split
 *   payment, the reverse charge, the IVA left out by the marks and the deferred IVA said apart;
 * - the periods of a year in a chain: balance = debito − credito − the credit carried in (from the
 *   period before; into January or the first quarter, only the credit the person said or confirmed
 *   for the year: last year's closing credit from the documents is proposed, never taken off by
 *   itself) + what was too little to pay before − the
 *   December acconto marked paid (in December or the fourth quarter). An acconto not marked paid is
 *   never taken off: the answer asks.
 *   A balance of 25,82 € or less is not paid and goes on; a negative one is a credit that goes on.
 *   Quarterly, the first three quarters add 1% interest to what is paid; the fourth is paid with
 *   the annual saldo, by 16 March, not under 10,33 €, with the 1% (vat-rules.ts). Monthly, what
 *   December leaves under the minimum goes in the annual saldo.
 * - the acconto of December: storico 88% of last year's December or fourth quarter before its
 *   acconto (as said, else from last year's documents), analitico 100% of the operations to 20
 *   December, previsionale 88% of what the person expects; none under 103,29 €; the smaller allowed.
 *   It is taken off December or the fourth quarter only once marked paid. None is computed when
 *   its deadline was over by more than OVERDUE_DAYS when the periodicity was first saved, nor for a
 *   year with no period over that has documents
 *   (unless the person said its base or what they expect).
 * - every deadline moves to the next working day (dates.ts, Saturday included), and carries why.
 */
import { addMonths, dueSlip, type Slip } from "./dates.ts";
import { addDays } from "./italian-calendar.ts";
import { eurosToCents, halfUp, halfUpSigned, scaled } from "./quote-sums.ts";
import { type PaidMark, paidKeyOf, periodOfDay, periodSpan, periodsOf, type YearFigures } from "./vat.ts";
import { isReverseRow, type VatDoc } from "./vat-docs.ts";
import {
	ACCONTO_ANALYTIC_DAY,
	ACCONTO_DUE,
	ACCONTO_MIN_CENTS,
	ACCONTO_PERCENT,
	ANNUAL_DEFER_PERCENT_PER_MONTH,
	ANNUAL_DEFER_TO,
	ANNUAL_DUE,
	ANNUAL_MIN_CENTS,
	CALENDAR_DAYS,
	CODE_ACCONTO,
	CODE_ANNUAL,
	OVERDUE_DAYS,
	PERIODIC_MIN_CENTS,
	type Periodicity,
	periodCode,
	periodDue,
	Q4_INTEREST,
	QUARTERLY_INTEREST_PERCENT,
	type VatPeriod,
} from "./vat-rules.ts";

/** `cents` × `percent` / 100, half up away from zero, the sign kept. */
export function share(cents: bigint, percent: string): bigint {
	return halfUpSigned(cents * scaled(percent, 2), 10_000n);
}

const cents = (euros: string | undefined): bigint | undefined => (euros === undefined ? undefined : eurosToCents(euros));
const inSpan = (day: string | undefined, from: string, to: string) => day !== undefined && day >= from && day <= to;

export type Figures = {
	readonly debito: bigint;
	readonly credito: bigint;
	/** Documents counted, each side. */
	readonly sales: number;
	readonly purchases: number;
	/** IVA of sales under split payment, not due; imponibile of sales under the reverse charge. */
	readonly split: bigint;
	readonly reverse: bigint;
	/** IVA of the reverse charge received, on both sides. */
	readonly integration: bigint;
	/** IVA received left out by the person's marks. */
	readonly undeducted: bigint;
	/** Deferred IVA of documents dated up to the period's end, not paid yet: not counted. */
	readonly deferred: { readonly sale: bigint; readonly purchase: bigint };
	/** Purchases put in the period by their date, the day of receipt not known, dated within APPROX_DAYS of its end: they may have arrived in the next one. */
	readonly approx: number;
};

/** A purchase dated this close to a period's end may have arrived through the SdI in the next one: only those are said as an approximation. */
export const APPROX_DAYS = 12;

/** The figures of the days `from` to `to` (see vat-docs.ts for what counts where). */
export function figuresOf(docs: readonly VatDoc[], from: string, to: string): Figures {
	let debito = 0n;
	let credito = 0n;
	let split = 0n;
	let reverse = 0n;
	let integration = 0n;
	let undeducted = 0n;
	const deferred = { sale: 0n, purchase: 0n };
	const sales = new Set<string>();
	const purchases = new Set<string>();
	const approx = new Set<string>();
	for (const d of docs) {
		const day = d.side === "purchase" ? (d.received ?? d.date) : d.date;
		for (const r of d.rows) {
			const deferredRow = r.esigibilita === "D";
			const when = deferredRow ? d.paidOn : day;
			if (deferredRow && d.paidOn === undefined) {
				if (d.date <= to && d.date.slice(0, 4) === to.slice(0, 4)) deferred[d.side] += r.tax;
				continue;
			}
			if (!inSpan(when, from, to)) continue;
			if (d.side === "sale") {
				sales.add(d.key);
				if (r.esigibilita === "S") split += r.tax;
				else if (isReverseRow(r)) reverse += r.taxable;
				else debito += r.tax;
				continue;
			}
			purchases.add(d.key);
			if (!deferredRow && d.received === undefined && d.date >= addDays(to, -APPROX_DAYS)) approx.add(d.key);
			const deductible = d.percent === undefined ? r.tax : share(r.tax, d.percent);
			credito += deductible;
			undeducted += r.tax - deductible;
			if (d.integration) {
				debito += r.tax;
				integration += r.tax;
			}
		}
	}
	return { debito, credito, sales: sales.size, purchases: purchases.size, split, reverse, integration, undeducted, deferred, approx: approx.size };
}

/** The day a payment is made, and why it moved: the next working day for a weekend or a holiday. */
export type { Slip };

const slipOf = dueSlip;

export type Liquidation = {
	readonly period: VatPeriod;
	readonly from: string;
	readonly to: string;
	readonly figures: Figures;
	/** Begun and not over: the figures so far. Not begun: nothing to say. */
	readonly begun: boolean;
	readonly partial: boolean;
	readonly carriedCredit: bigint;
	readonly carriedDue: bigint;
	/** The acconto taken off (December, the fourth quarter): only as marked paid. */
	readonly acconto: bigint;
	/** The last period: the acconto due and not marked paid, never taken off; the answer asks. */
	readonly accontoUnpaid?: bigint;
	/** The first period: the credit carried in is the one the person said or confirmed. */
	readonly openingFrom?: "detto";
	readonly balance: bigint;
	readonly interest: bigint;
	/** To pay; what is under the minimum and goes on; the credit that goes on. */
	readonly due: bigint;
	readonly under: bigint;
	readonly credit: bigint;
	readonly paid?: PaidMark;
};

export type VatInputs = {
	readonly docs: readonly VatDoc[];
	readonly periodicity: Periodicity;
	readonly paid: readonly PaidMark[];
	readonly years: readonly YearFigures[];
	readonly today: string;
	/** The day the periodicity was first saved: no acconto for a year over before it. */
	readonly since?: string;
};

const yearFigures = (i: VatInputs, year: number) => i.years.find((y) => y.year === year);
const paidOf = (i: VatInputs, key: string) => i.paid.find((p) => p.key === key);
const lastOfYear = (p: VatPeriod) => (p.kind === "month" ? p.n === 12 : p.n === 4);

/** The credit carried into `year`: only as the person said or confirmed it (set_credit); 0 otherwise. */
export function openingCredit(i: VatInputs, year: number): { readonly cents: bigint; readonly from?: "detto" } {
	const said = cents(yearFigures(i, year)?.credit);
	return said === undefined ? { cents: 0n } : { cents: said, from: "detto" };
}

/** Whether every period of `year` has a document in it (by its date, or a purchase's day of receipt). */
function fullYear(i: VatInputs, year: number): boolean {
	return periodsOf(year, i.periodicity).every((p) => {
		const { from, to } = periodSpan(p);
		return i.docs.some((d) => inSpan(d.date, from, to) || inSpan(d.received, from, to));
	});
}

/**
 * Last year's closing credit from the documents, to propose for `year` when the person has not
 * said one: only when last year is over and every one of its periods has documents; one year back
 * only (its own opening is what the person said, or 0). Never taken off until confirmed.
 */
export function proposedCredit(i: VatInputs, year: number): bigint | undefined {
	if (yearFigures(i, year)?.credit !== undefined || i.today <= `${year - 1}-12-31` || !fullYear(i, year - 1)) return undefined;
	const c = yearCredit(i, year - 1);
	return c !== undefined && c > 0n ? c : undefined;
}

/**
 * The periods of `year` in their chain (see above), the acconto `acconto` (marked paid) taken off
 * the last one, `unpaid` the acconto due and not marked. Under way, the figures so far; not begun,
 * none, and the chain stops there.
 */
export function chain(i: VatInputs, year: number, acconto = 0n, unpaid = 0n): Liquidation[] {
	const out: Liquidation[] = [];
	const opening = openingCredit(i, year);
	let credit = opening.cents;
	let carried = 0n;
	for (const period of periodsOf(year, i.periodicity)) {
		const { from, to } = periodSpan(period);
		const begun = from <= i.today;
		const figures = figuresOf(begun ? i.docs : [], from, to);
		const last = lastOfYear(period);
		const off = last ? acconto : 0n;
		const balance = figures.debito - figures.credito - credit + carried - off;
		// The fourth quarter is the annual saldo: its own minimum, and the 1% only if the rule says so.
		const annual = period.kind === "quarter" && period.n === 4;
		const min = annual ? ANNUAL_MIN_CENTS : PERIODIC_MIN_CENTS;
		const paid = paidOf(i, paidKeyOf(period));
		const over = balance > min || (paid !== undefined && balance > 0n);
		const interest = period.kind === "quarter" && over && (!annual || Q4_INTEREST) ? share(balance, QUARTERLY_INTEREST_PERCENT) : 0n;
		const l: Liquidation = {
			period,
			from,
			to,
			figures,
			begun,
			partial: begun && i.today <= to,
			carriedCredit: credit,
			carriedDue: carried,
			acconto: off,
			...(last && unpaid > 0n ? { accontoUnpaid: unpaid } : {}),
			...(out.length === 0 && opening.from !== undefined && opening.cents > 0n ? { openingFrom: opening.from } : {}),
			balance,
			interest,
			due: over ? balance + interest : 0n,
			under: !over && balance > 0n ? balance : 0n,
			credit: balance < 0n ? -balance : 0n,
			...(paid === undefined ? {} : { paid }),
		};
		out.push(l);
		if (!begun) break;
		credit = l.credit;
		carried = l.under;
	}
	return out;
}

export type Acconto = {
	readonly year: number;
	/** 88% of last year's December or fourth quarter before its acconto, said or from the documents; undefined when not known. */
	readonly storico?: { readonly base: bigint; readonly cents: bigint; readonly from: "detto" | "fatture" };
	/** 100% of the operations to 20 December; `partial` before that day. */
	readonly analitico?: { readonly cents: bigint; readonly partial: boolean };
	readonly previsionale?: { readonly expected: bigint; readonly cents: bigint };
	/** The smallest known (a partial analitico is not known yet), 0 under 103,29 €; undefined when none is known; `method` the one it comes from. */
	readonly cents?: bigint;
	readonly method?: "storico" | "analitico" | "previsionale";
	readonly belowMin: boolean;
	readonly paid?: PaidMark;
};

/** The acconto of `year` by each method Annie can compute (see above); `expected`: the previsionale's base. */
export function accontoOf(i: VatInputs, year: number, expected?: bigint): Acconto {
	const said = cents(yearFigures(i, year - 1)?.base);
	const paid = paidOf(i, `${year}-acconto`);
	// Not for an acconto already past being said overdue when the periodicity was saved, nor from documents of a year with no period over that has any.
	if ((i.since !== undefined && addDays(slipOf(`${year}-${ACCONTO_DUE}`).date, OVERDUE_DAYS) < i.since) || (said === undefined && expected === undefined && !anyPeriodOver(i, year))) return { year, belowMin: false, ...(paid === undefined ? {} : { paid }) };
	const lastYear = i.docs.some((d) => d.date.startsWith(`${year - 1}-`));
	const gross = (() => {
		if (said !== undefined) return { base: said, from: "detto" as const };
		if (!lastYear || i.today < `${year}-01-01`) return undefined;
		const last = chain(i, year - 1).at(-1);
		return last === undefined || !lastOfYear(last.period) || last.partial ? undefined : { base: last.balance, from: "fatture" as const };
	})();
	const storico = gross === undefined ? undefined : { ...gross, cents: gross.base > 0n ? halfUp(gross.base * ACCONTO_PERCENT, 100n) : 0n };
	const analitico = analyticOf(i, year);
	const previsionale = expected === undefined ? undefined : { expected, cents: expected > 0n ? halfUp(expected * ACCONTO_PERCENT, 100n) : 0n };
	const known = [
		storico === undefined ? undefined : { method: "storico" as const, cents: storico.cents },
		analitico === undefined || analitico.partial ? undefined : { method: "analitico" as const, cents: analitico.cents },
		previsionale === undefined ? undefined : { method: "previsionale" as const, cents: previsionale.cents },
	].filter((c) => c !== undefined);
	const least = known.length === 0 ? undefined : known.reduce((a, b) => (b.cents < a.cents ? b : a));
	const belowMin = least !== undefined && least.cents < ACCONTO_MIN_CENTS;
	return { year, ...(storico === undefined ? {} : { storico }), ...(analitico === undefined ? {} : { analitico }), ...(previsionale === undefined ? {} : { previsionale }), ...(least === undefined ? {} : { cents: belowMin ? 0n : least.cents, method: least.method }), belowMin, ...(paid === undefined ? {} : { paid }) };
}

/** Whether a period of `year` is over by today with a document in it. */
function anyPeriodOver(i: VatInputs, year: number): boolean {
	return periodsOf(year, i.periodicity).some((p) => {
		const { from, to } = periodSpan(p);
		return to < i.today && i.docs.some((d) => inSpan(d.date, from, to) || inSpan(d.received, from, to));
	});
}

/** The liquidazione to 20 December: December's days (monthly) or from October (quarterly), with what the period before carries in. */
function analyticOf(i: VatInputs, year: number): Acconto["analitico"] {
	const to = `${year}-${ACCONTO_ANALYTIC_DAY}`;
	const from = i.periodicity === "mensile" ? `${year}-12-01` : `${year}-10-01`;
	if (i.today < from) return undefined;
	const before = chain({ ...i, today: addDays(from, -1) }, year).filter((l) => l.to < from).at(-1);
	const f = figuresOf(i.docs, from, to);
	const balance = f.debito - f.credito - (before?.credit ?? openingCredit(i, year).cents) + (before?.under ?? 0n);
	return { cents: balance > 0n ? balance : 0n, partial: i.today < to };
}

/** The year's periods with the acconto taken off only as marked paid; one due and not marked is said, never taken off. */
export function yearOf(i: VatInputs, year: number): Liquidation[] {
	const a = accontoOf(i, year);
	const marked = cents(a.paid?.amount);
	return chain(i, year, marked ?? 0n, marked === undefined ? (a.cents ?? 0n) : 0n);
}

export type DeadlineKind = "periodo" | "acconto" | "annuale";

/** An F24 of the IVA: the day in the law and the working day it moves to, the codice tributo, what for and how much (undefined: not known yet). */
export type Deadline = {
	readonly kind: DeadlineKind;
	readonly due: string;
	readonly date: string;
	readonly slip?: Slip;
	readonly code: string;
	/** The key it is marked paid under (vat.ts). */
	readonly key: string;
	readonly year: number;
	readonly period?: VatPeriod;
	readonly cents?: bigint;
	/** The figures so far: the period is under way. */
	readonly partial: boolean;
	readonly interest?: bigint;
	readonly paid?: PaidMark;
	/** An acconto of a year over before the periodicity was saved: Annie never saw it, «se non l'hai già versato». */
	readonly beforeSetup?: true;
	/** The first period of a year: the credit the person said or confirmed, taken off it. */
	readonly opening?: bigint;
	/** The annual saldo paid later, with its percentage more. */
	readonly alternative?: { readonly date: string; readonly slip?: Slip; readonly cents: bigint; readonly percent: string };
};

/** The annual saldo by 30 June: 0,40% for each month or part of a month after 16 March. */
function deferred(year: number, amount: bigint): Deadline["alternative"] {
	const from = `${year + 1}-${ANNUAL_DUE}`;
	const to = slipOf(`${year + 1}-${ANNUAL_DEFER_TO}`);
	let months = 0;
	while (addMonths(from, months).date < to.date) months++;
	const percent = (Number(scaled(ANNUAL_DEFER_PERCENT_PER_MONTH, 2)) * months) / 100;
	const p = percent.toFixed(2);
	return { date: to.date, ...(to.slip === undefined ? {} : { slip: to.slip }), cents: amount + share(amount, p), percent: p };
}

/** The deadlines of payments for `year`: its periods, its acconto, its annual saldo (with the fourth quarter of the trimestrali). */
export function deadlinesOf(i: VatInputs, year: number): Deadline[] {
	const out: Deadline[] = [];
	const periods = yearOf(i, year);
	const all = periodsOf(year, i.periodicity);
	for (const period of all) {
		const l = periods.find((x) => x.period.n === period.n);
		const due = periodDue(period);
		const annual = period.kind === "quarter" && period.n === 4;
		const amount = l === undefined || !l.begun ? undefined : l.due;
		const key = paidKeyOf(period);
		const paid = paidOf(i, key);
		out.push({
			kind: annual ? "annuale" : "periodo",
			due,
			...slipOf(due),
			code: periodCode(period),
			key,
			year,
			period,
			...(amount === undefined ? {} : { cents: amount }),
			partial: l?.partial ?? false,
			...(l !== undefined && l.interest > 0n ? { interest: l.interest } : {}),
			...(paid === undefined ? {} : { paid }),
			...(l?.openingFrom === "detto" ? { opening: l.carriedCredit } : {}),
			...(annual && amount !== undefined && amount > 0n ? { alternative: deferred(year, amount) } : {}),
		});
	}
	const a = accontoOf(i, year);
	const accontoDue = `${year}-${ACCONTO_DUE}`;
	out.push({ kind: "acconto", due: accontoDue, ...slipOf(accontoDue), code: CODE_ACCONTO[i.periodicity], key: `${year}-acconto`, year, ...(a.cents === undefined ? {} : { cents: a.cents }), ...(i.since !== undefined && `${year}-12-31` < i.since ? { beforeSetup: true as const } : {}), partial: a.analitico?.partial === true && a.storico === undefined, ...(a.paid === undefined ? {} : { paid: a.paid }) });
	if (i.periodicity === "mensile") {
		// Monthly: what December leaves under the minimum is the annual saldo, if over 10,33 €.
		const december = periods.find((l) => l.period.n === 12);
		const left = december === undefined || !december.begun ? undefined : december.under > ANNUAL_MIN_CENTS ? december.under : 0n;
		const due = `${year + 1}-${ANNUAL_DUE}`;
		const key = `${year}-annuale`;
		const paid = paidOf(i, key);
		out.push({ kind: "annuale", due, ...slipOf(due), code: CODE_ANNUAL, key, year, ...(left === undefined ? {} : { cents: left }), partial: december?.partial ?? false, ...(paid === undefined ? {} : { paid }), ...(left !== undefined && left > 0n ? { alternative: deferred(year, left) } : {}) });
	}
	return out;
}

/** An F24 gone by, not marked paid, with an amount, up to OVERDUE_DAYS ago; an acconto never after 16 March of the next year. */
export function isOverdue(d: Deadline, today: string): boolean {
	if (d.paid !== undefined || d.date >= today || d.cents === undefined || d.cents <= 0n) return false;
	return d.date >= addDays(today, -OVERDUE_DAYS) && (d.kind !== "acconto" || today <= `${d.year + 1}-${ANNUAL_DUE}`);
}

/**
 * The F24 from `from` (default today) for `days` days, by date, not marked paid: those not known
 * yet without amount; the overdue ones (isOverdue) first, with their amount.
 */
export function calendar(i: VatInputs, days = CALENDAR_DAYS, from = i.today): Deadline[] {
	const end = addDays(from, days - 1);
	const year = Number(from.slice(0, 4));
	const all = [year - 1, year, year + 1].flatMap((y) => deadlinesOf(i, y));
	return all
		.filter((d) => d.paid === undefined && d.date <= end && (d.date >= from || isOverdue(d, i.today)))
		.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

/** The liquidazione of the period `day` is in, with the year's acconto taken off. */
export function periodAt(i: VatInputs, day: string): Liquidation | undefined {
	const p = periodOfDay(day, i.periodicity);
	return yearOf(i, p.year).find((l) => l.period.n === p.n);
}

/** The deadline of a period. */
export function deadlineOf(i: VatInputs, p: VatPeriod): Deadline | undefined {
	return deadlinesOf(i, p.year).find((d) => d.period !== undefined && d.period.n === p.n);
}

/** An F24 of the IVA for the cashflow: its day, amount and words, «iva» so it pairs only with voci about IVA, `key` its period (vat.ts) for a voce that names one; `was` the day of one overdue, counted today. */
export type VatPayment = { readonly date: string; readonly cents: bigint; readonly what: string; readonly iva: true; readonly key: string; readonly was?: string; readonly late?: true };

/**
 * The F24 the cashflow counts: the calendar's deadlines with an amount, from today to `end`, and
 * the overdue ones (isOverdue) today, like an overdue invoice; `words` says what each pays.
 */
export function vatPayments(i: VatInputs, end: string, words: (d: Deadline) => string): VatPayment[] {
	if (end < i.today) return [];
	return calendar(i, CALENDAR_DAYS)
		.filter((d) => d.date <= end && d.cents !== undefined && d.cents > 0n && (d.date >= i.today || isOverdue(d, i.today)))
		.map((d) => ({ date: d.date < i.today ? i.today : d.date, cents: d.cents as bigint, what: words(d), iva: true as const, key: d.key, ...(d.date < i.today ? { was: d.date, late: true as const } : {}) }));
}

/** The year's IVA credit at its end (the last period's credit), when the year is over. */
export function yearCredit(i: VatInputs, year: number): bigint | undefined {
	const last = yearOf(i, year).at(-1);
	return last === undefined || !lastOfYear(last.period) || last.partial ? undefined : last.credit;
}

/** The volume of sales of a year (imponibili, reverse charge included), for the quarterly limit. */
export function salesVolume(docs: readonly VatDoc[], year: number): bigint {
	return docs.filter((d) => d.side === "sale" && d.date.startsWith(`${year}-`)).reduce((n, d) => n + d.rows.reduce((m, r) => m + r.taxable, 0n), 0n);
}
