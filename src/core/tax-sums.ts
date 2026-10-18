/**
 * The arithmetic of le tasse del forfettario, pure, in bigint cents, half up to the cent:
 *
 * - incassi: the instalments of invoices to collect marked paid in the year, by the day marked paid
 *   (the cash principle of the forfettario; cash-book.ts, the same incassi as the prima nota). What
 *   the client paid counts as it is: the rivalsa INPS 4% and a bollo charged to the client are part
 *   of the compensi. ricavi = incassi, less the contributo integrativo of a cassa professionale when
 *   its percentage is known (incassi / (1 + %)): it is the cassa's, not a ricavo, for the reddito
 *   and for the limits alike.
 * - reddito = ricavi × coefficient.
 * - contributi on the reddito: gestione separata reddito (up to the year's massimale) × rate;
 *   artigiani and commercianti the whole fixed part plus (reddito − minimale) × rate when positive,
 *   one point more over the top, the whole less 35% with the reduction (50% when first registered
 *   in 2025), each part rounded once; cassa professionale reddito × rate, at least its minimum; none.
 * - deducted from the reddito: the contributions paid in the year when the person said them,
 *   otherwise those the calendar has paid in the year (last year's saldo, this year's acconti, the
 *   fixed instalments paid in the year), otherwise the year's estimated contributions; the answer
 *   says which.
 * - imponibile = reddito − deducted (not below zero); imposta = imponibile × the year's rate.
 * - to set aside: (imposta + contributi) / incassi, rounded up to the whole percent.
 * - the calendar, metodo storico: in June (with the year's proroga for the forfettari) the saldo of
 *   last year (its imposta less the acconti paid for it) and the first acconto; in November the
 *   second. The base is last year's figures as said, else last year's estimate from its incassi,
 *   else unknown (no amount). The acconti paid last year are as said, else none in a first year,
 *   else last year's rule on the year before. Next year's deadlines use this year's estimate
 *   projected to the year's end (with the metodo previsionale, the incassi the person expects).
 * - every deadline moves to the next working day (dates.ts, Saturday included), and carries why.
 */
import { cashBook } from "./cash-book.ts";
import { dayOfYear, paymentSlip } from "./dates.ts";
import type { Invoice } from "./invoices.ts";
import { addDays, daysBetween, leapYear } from "./italian-calendar.ts";
import { halfUp, scaled } from "./quote-sums.ts";
import {
	ACCONTO_FIRST_MIN_CENTS,
	ACCONTO_FIRST_PERCENT,
	ACCONTO_NONE_MAX_CENTS,
	ARTIGIANI_REDUCTION_PERCENT,
	CALENDAR_DAYS,
	FERRAGOSTO,
	GS_ACCONTO_FIRST_PERCENT,
	GS_ACCONTO_PERCENT,
	GS_MASSIMALE,
	GS_RATE_DEFAULT,
	HARD_LIMIT_CENTS,
	IVS_ACCONTO_FIRST_PERCENT,
	IVS_TOP_EXTRA,
	IVS_YEARS,
	JUNE_ALTERNATIVE_DAYS,
	JUNE_DEADLINES,
	JUNE_DUE,
	JUNE_EXTRA_DEFAULT,
	LIMIT_BANDS,
	LIMIT_CENTS,
	LIMIT_WARN_PERCENT,
	NEW_2025_LAST_YEAR,
	NEW_2025_REDUCTION_PERCENT,
	type Pension,
	rateFor,
	type TaxProfile,
	type YearFigures,
	yearValues,
} from "./taxes.ts";

/** `cents` × `percent` (a decimal string, two decimals at most) / 100, half up. */
export function percentOf(cents: bigint, percent: string): bigint {
	return halfUp(cents * scaled(percent, 2), 10_000n);
}

const cents = (euros: string | undefined): bigint | undefined => (euros === undefined ? undefined : scaled(euros, 2));
const yearOf = (day: string) => Number(day.slice(0, 4));

/** The day a payment due on `due` is made, and why it moved: the next working day for a weekend or a holiday. */
export type Slip = { readonly to: string; readonly holiday?: string };

function slipOf(due: string): { readonly date: string; readonly slip?: Slip } {
	const slip = paymentSlip(due);
	return slip === undefined ? { date: due } : { date: slip.to, slip };
}

export type Incassi = {
	readonly cents: bigint;
	/** Instalments counted. */
	readonly count: number;
	/** Left out: in another currency; an amount that does not read. */
	readonly otherCurrency: number;
	readonly unreadable: number;
};

/** The incassi of `year` up to `to` (default its last day): by the day marked paid, in euros. */
export function incassiOf(invoices: readonly Invoice[], year: number, dayOf: (at: string) => string, to = `${year}-12-31`): Incassi {
	if (to < `${year}-01-01`) return { cents: 0n, count: 0, otherCurrency: 0, unreadable: 0 };
	const book = cashBook(invoices, [], { from: `${year}-01-01`, to }, dayOf);
	return { cents: book.totalIn, count: book.rows.length, otherCurrency: book.otherCurrency, unreadable: book.unreadable };
}

/** The incassi of each year, read once: this year up to `today`, a year to come none. */
export function yearIncassi(invoices: readonly Invoice[], today: string, dayOf: (at: string) => string): (year: number) => Incassi {
	const memo = new Map<number, Incassi>();
	const current = yearOf(today);
	return (year) => {
		let i = memo.get(year);
		if (i === undefined) {
			i = year === current ? incassiOf(invoices, year, dayOf, today) : year > current ? { cents: 0n, count: 0, otherCurrency: 0, unreadable: 0 } : incassiOf(invoices, year, dayOf);
			memo.set(year, i);
		}
		return i;
	};
}

/** The ricavi of `incassi`: less a cassa's contributo integrativo when its percentage is known. */
export function ricaviOf(pension: Pension, incassi: bigint): bigint {
	if (pension.kind !== "cassa" || pension.integrativo === undefined) return incassi;
	return halfUp(incassi * 10_000n, 10_000n + scaled(pension.integrativo, 2));
}

export type Contributi = {
	readonly total: bigint;
	/** Artigiani and commercianti: the fixed part, reduced as the variable one, paid in four instalments. */
	readonly fixed: bigint;
	/** The part on the reddito: what the June and November acconti are of. */
	readonly variable: bigint;
	/** The INPS values used are of this other year: the year computed has none in the tables. */
	readonly valuesOf?: number;
};

/** What is left of artigiani and commercianti contributions after the reduction in `year`, in percent: 50% through NEW_2025_LAST_YEAR for the new ones of 2025, then 35% with the reduction. */
export function keptPercent(p: Extract<Pension, { kind: "artigiani" | "commercianti" }>, year: number): bigint {
	if (p.new2025 === true && year <= NEW_2025_LAST_YEAR) return BigInt(100 - NEW_2025_REDUCTION_PERCENT);
	return p.reduction ? BigInt(100 - ARTIGIANI_REDUCTION_PERCENT) : 100n;
}

/** The contributions of `year` on `reddito` (see above). */
export function contributiOf(pension: Pension, reddito: bigint, year: number): Contributi {
	switch (pension.kind) {
		case "gestione_separata": {
			const m = yearValues(GS_MASSIMALE, year);
			const cap = scaled(m.values, 2);
			const v = percentOf(reddito > cap ? cap : reddito, pension.rate ?? GS_RATE_DEFAULT);
			return { total: v, fixed: 0n, variable: v, ...(reddito > cap && m.year !== year ? { valuesOf: m.year } : {}) };
		}
		case "artigiani":
		case "commercianti": {
			const t = yearValues(IVS_YEARS, year);
			const own = pension.fixed !== undefined && pension.rate !== undefined && pension.minimale !== undefined;
			const kept = keptPercent(pension, year);
			const fixed = halfUp(scaled(pension.fixed ?? t.values.fixed[pension.kind], 2) * kept, 100n);
			const over = reddito - scaled(pension.minimale ?? t.values.minimale, 2);
			const top = scaled(pension.top ?? t.values.top, 2);
			const above = reddito > top ? reddito - top : 0n;
			// Cents × percent × 100, reduced, rounded once.
			const raw = over > 0n ? over * scaled(pension.rate ?? t.values.rate[pension.kind], 2) + above * scaled(IVS_TOP_EXTRA, 2) : 0n;
			const v = halfUp(raw * kept, 1_000_000n);
			return { total: fixed + v, fixed, variable: v, ...(!own && t.year !== year ? { valuesOf: t.year } : {}) };
		}
		case "cassa": {
			const v = percentOf(reddito, pension.rate);
			const min = pension.minimum === undefined ? 0n : scaled(pension.minimum, 2);
			const total = v > min ? v : min;
			return { total, fixed: 0n, variable: total };
		}
		case "nessuna":
			return { total: 0n, fixed: 0n, variable: 0n };
	}
}

export type Estimate = {
	readonly year: number;
	/** What came in; the ricavi are it less a cassa's contributo integrativo, when known. */
	readonly incassi: bigint;
	readonly ricavi: bigint;
	readonly coefficient: string;
	readonly reddito: bigint;
	readonly contributi: Contributi;
	/** Deducted from the reddito: the contributions paid in the year as said («detti»), as the calendar pays them («versati»), or the year's estimate («stima»). */
	readonly deducted: bigint;
	readonly deductedFrom: "detti" | "versati" | "stima";
	readonly imponibile: bigint;
	readonly rate: string;
	readonly imposta: bigint;
	/** Imposta and contributi. */
	readonly total: bigint;
	/** The whole percent of each incasso to set aside, rounded up; undefined without incassi. */
	readonly setAsidePercent?: number;
};

/** The year's estimate on `incassi` (see above); `paidInYear`: the contributions the calendar pays in the year, when known. */
export function estimate(profile: TaxProfile, year: number, incassi: bigint, figures?: YearFigures, paidInYear?: bigint): Estimate {
	const ricavi = ricaviOf(profile.pension, incassi);
	const reddito = percentOf(ricavi, profile.coefficient);
	const contributi = contributiOf(profile.pension, reddito, year);
	const said = cents(figures?.contributiVersati);
	const deducted = said ?? paidInYear ?? contributi.total;
	const imponibile = reddito > deducted ? reddito - deducted : 0n;
	const rate = rateFor(profile, year);
	const imposta = percentOf(imponibile, rate);
	const total = imposta + contributi.total;
	return {
		year,
		incassi,
		ricavi,
		coefficient: profile.coefficient,
		reddito,
		contributi,
		deducted,
		deductedFrom: said !== undefined ? "detti" : paidInYear !== undefined ? "versati" : "stima",
		imponibile,
		rate,
		imposta,
		total,
		...(incassi > 0n ? { setAsidePercent: Number((total * 100n + incassi - 1n) / incassi) } : {}),
	};
}

/** The days of `year`. */
function yearDays(year: number): number {
	return leapYear(year) ? 366 : 365;
}

export type Projection = { readonly ricavi: bigint; readonly perMonth: bigint; readonly days: number };

/** The year's incassi if they go on as so far: the incassi to `today` over the days gone, for the whole year; and the monthly average. */
export function projected(soFar: bigint, today: string): Projection {
	const days = dayOfYear(today);
	const ricavi = halfUp(soFar * BigInt(yearDays(yearOf(today))), BigInt(days));
	return { ricavi, perMonth: halfUp(ricavi, 12n), days };
}

export type Limit = "oltre_100" | "oltre_85" | "vicino";

/** Where ricavi stand against the forfettario's limits; undefined well below. */
export function limitOf(ricavi: bigint): Limit | undefined {
	if (ricavi > HARD_LIMIT_CENTS) return "oltre_100";
	if (ricavi > LIMIT_CENTS) return "oltre_85";
	if (ricavi * 100n >= LIMIT_CENTS * LIMIT_WARN_PERCENT) return "vicino";
	return undefined;
}

/** The band of the 85.000 € limit ricavi are in: 0 below 80%, then one more at 80%, 90%, past 85.000 € and past 100.000 €. */
export function limitBand(ricavi: bigint): number {
	if (ricavi > HARD_LIMIT_CENTS) return LIMIT_BANDS.length + 1;
	if (ricavi > LIMIT_CENTS) return LIMIT_BANDS.length;
	return LIMIT_BANDS.filter((b) => b < 100n && ricavi * 100n >= LIMIT_CENTS * b).length;
}

/** The share of the 85.000 € limit, whole percent, down. */
export function limitShare(ricavi: bigint): number {
	return Number((ricavi * 100n) / LIMIT_CENTS);
}

// The calendar.

type PartKind = "saldo_imposta" | "acconto_imposta" | "saldo_contributi" | "acconto_contributi" | "fissi";

/** One amount of a deadline; `cents` undefined when it cannot be known (last year's figures missing). */
export type Part = { readonly kind: PartKind; readonly cents?: bigint; readonly n?: 1 | 2; readonly single?: true; readonly quarter?: 1 | 2 | 3 | 4; readonly forYear: number };

export type Deadline = {
	/** The day written in the law (with the year's proroga), the working day it moves to, and why. */
	readonly due: string;
	readonly date: string;
	readonly slip?: Slip;
	readonly kind: "giugno" | "novembre" | "fissi";
	readonly parts: readonly Part[];
	/** June only: a later day with a percentage more, on the parts known. */
	readonly alternative?: { readonly due: string; readonly date: string; readonly slip?: Slip; readonly cents: bigint; readonly extra: string };
	/** June only: the year has no proroga in JUNE_DEADLINES, so the law's 30 June; the answer says to check. */
	readonly noProroga?: true;
	/** A June F24 whose day has gone: due now on its alternative day (`due`, `date`), at `cents`, if not paid already. */
	readonly late?: { readonly due: string; readonly date: string; readonly cents: bigint; readonly extra: string };
};

/** The known total of a deadline's parts. */
export function deadlineCents(d: Deadline): bigint {
	return d.parts.reduce((n, p) => n + (p.cents ?? 0n), 0n);
}

/** What is to pay on the deadline's day: the parts, or with the percentage more when late. */
export function dueCents(d: Deadline): bigint {
	return d.late?.cents ?? deadlineCents(d);
}

export const hasUnknown = (d: Deadline) => d.parts.some((p) => p.cents === undefined);

/** The June deadline of `year` and its alternative (see the constants' sources). */
export function juneDays(year: number): { readonly due: string; readonly alternative: string; readonly extra: string; readonly proroga: boolean } {
	const t = JUNE_DEADLINES[year];
	if (t !== undefined) return { ...t, proroga: true };
	const due = `${year}-${JUNE_DUE}`;
	let alternative = addDays(slipOf(due).date, JUNE_ALTERNATIVE_DAYS);
	const md = alternative.slice(5);
	if (md >= FERRAGOSTO.from && md <= FERRAGOSTO.to) alternative = `${yearOf(alternative)}-${FERRAGOSTO.to}`;
	return { due, alternative, extra: JUNE_EXTRA_DEFAULT, proroga: false };
}

/** Where last year's base came from: said, from its incassi, this year's estimate, nothing (before the activity), unknown. */
type BaseSource = "detti" | "fatture" | "stima" | "nessuna" | "ignota";

export type Base = { readonly imposta?: bigint; readonly contributi?: bigint; readonly source: BaseSource };

export type CalendarInputs = {
	readonly profile: TaxProfile;
	readonly figures: readonly YearFigures[];
	readonly incassi: (year: number) => Incassi;
	readonly today: string;
	/** Metodo previsionale for this year: the acconti and the next saldo on this year's estimate, with these incassi (default the projection). */
	readonly previsionale?: { readonly ricavi?: bigint };
};

const figuresOf = (i: CalendarInputs, year: number) => i.figures.find((f) => f.year === year);
const before = (i: CalendarInputs, year: number) => i.profile.startYear !== undefined && year < i.profile.startYear;
const firstYear = (i: CalendarInputs, year: number) => i.profile.startYear !== undefined && year <= i.profile.startYear;

/** Whether the profile pays contributions on the reddito through the F24 June and November: not a cassa (its own deadlines), not none. */
function f24Contributions(p: Pension): boolean {
	return p.kind === "gestione_separata" || p.kind === "artigiani" || p.kind === "commercianti";
}

/** The incassi a year's figures are estimated on: last years' as collected (undefined without any), this year's projected or as expected. */
function incassiFor(i: CalendarInputs, year: number): bigint | undefined {
	const current = yearOf(i.today);
	if (year === current) return i.previsionale?.ricavi ?? projected(i.incassi(year).cents, i.today).ricavi;
	if (year > current) return undefined;
	const inc = i.incassi(year);
	return inc.count > 0 ? inc.cents : undefined;
}

/** `year`'s contributions on the reddito: as said, else on its incassi; none before the activity. Never through an imposta. */
function contributiBase(i: CalendarInputs, year: number): bigint | undefined {
	if (before(i, year)) return 0n;
	const said = cents(figuresOf(i, year)?.contributi);
	if (said !== undefined) return said;
	const inc = incassiFor(i, year);
	if (inc === undefined) return undefined;
	const p = i.profile;
	return contributiOf(p.pension, percentOf(ricaviOf(p.pension, inc), p.coefficient), year).variable;
}

/** The fixed contributions of artigiani and commercianti of `year`, reduced, in four instalments: the fourth balances the rounding. */
function fixedQuarter(p: Pension, q: 1 | 2 | 3 | 4, year: number): bigint {
	if (p.kind !== "artigiani" && p.kind !== "commercianti") return 0n;
	const fixed = contributiOf(p, 0n, year).fixed;
	const quarter = halfUp(fixed, 4n);
	return q === 4 ? fixed - quarter * 3n : quarter;
}

/** The contributions the calendar pays during `year`: last year's saldo, this year's acconti, the fixed instalments paid in it; undefined when a part is unknown or for a cassa. */
function contributiPaidIn(i: CalendarInputs, year: number): bigint | undefined {
	const p = i.profile.pension;
	if (p.kind === "nessuna" || before(i, year)) return 0n;
	if (!f24Contributions(p)) return undefined;
	const last = saldo(contributiBase(i, year - 1), contributiPaid(i, year - 1));
	const acconti = contributiAcconti(i, year);
	if (last === undefined || acconti?.first === undefined) return undefined;
	let fixed = 0n;
	if (!before(i, year - 1)) fixed += fixedQuarter(p, 4, year - 1);
	fixed += fixedQuarter(p, 1, year) + fixedQuarter(p, 2, year) + fixedQuarter(p, 3, year);
	return last + acconti.first + acconti.second + fixed;
}

/** `year`'s estimate on its incassi (default as the calendar takes them), with the contributions the calendar pays in it deducted. */
export function yearEstimate(i: CalendarInputs, year: number, incassi?: bigint): Estimate {
	return estimate(i.profile, year, incassi ?? incassiFor(i, year) ?? i.incassi(year).cents, figuresOf(i, year), contributiPaidIn(i, year));
}

/** This year's estimate projected to its end, or on the incassi expected. */
export function currentEstimate(i: CalendarInputs, incassi?: bigint): Estimate {
	return yearEstimate(i, yearOf(i.today), incassi);
}

/** `year`'s imposta: as said, else on its incassi; none before the activity. */
function impostaBase(i: CalendarInputs, year: number): bigint | undefined {
	if (before(i, year)) return 0n;
	const said = cents(figuresOf(i, year)?.imposta);
	if (said !== undefined) return said;
	return incassiFor(i, year) === undefined ? undefined : yearEstimate(i, year).imposta;
}

/** The base of the acconti of `year + 1` and of the saldo paid then: `year`'s imposta and contributions on the reddito, and where they came from. */
export function baseOf(i: CalendarInputs, year: number): Base {
	const imposta = impostaBase(i, year);
	const contributi = contributiBase(i, year);
	const said = figuresOf(i, year)?.imposta !== undefined;
	const source: BaseSource = before(i, year) ? "nessuna" : said ? "detti" : year >= yearOf(i.today) ? "stima" : imposta !== undefined ? "fatture" : "ignota";
	return { ...(imposta === undefined ? {} : { imposta }), ...(contributi === undefined ? {} : { contributi }), source };
}

/** An acconto in two instalments; `first` undefined when it is not known (paid in June on a base Annie does not know). */
export type Split = { readonly first?: bigint; readonly second: bigint };

export type Acconti = {
	readonly imposta: (Split & { readonly single: boolean }) | undefined;
	readonly contributi: Split | undefined;
};

/** The acconti of a year on a base (see the constants' sources): undefined where the base is unknown. */
export function accontiOn(base: Pick<Base, "imposta" | "contributi">, pension: Pension): Acconti {
	let imposta: Acconti["imposta"];
	const b = base.imposta;
	if (b !== undefined) {
		if (b <= ACCONTO_NONE_MAX_CENTS) imposta = { first: 0n, second: 0n, single: false };
		// A first instalment strictly under 103 €: all in November.
		else if (b * ACCONTO_FIRST_PERCENT < ACCONTO_FIRST_MIN_CENTS * 100n) imposta = { first: 0n, second: b, single: true };
		else {
			const first = halfUp(b * ACCONTO_FIRST_PERCENT, 100n);
			imposta = { first, second: b - first, single: false };
		}
	}
	let contributi: Acconti["contributi"];
	const c = base.contributi;
	if (!f24Contributions(pension)) contributi = { first: 0n, second: 0n };
	else if (c !== undefined) {
		if (pension.kind === "gestione_separata") {
			const total = halfUp(c * GS_ACCONTO_PERCENT, 100n);
			const first = halfUp(c * GS_ACCONTO_FIRST_PERCENT, 100n);
			contributi = { first, second: total - first };
		} else {
			const first = halfUp(c * IVS_ACCONTO_FIRST_PERCENT, 100n);
			contributi = { first, second: c - first };
		}
	}
	return { imposta, contributi };
}

const total = (a: Split | undefined) => (a === undefined || a.first === undefined ? undefined : a.first + a.second);

/** The June deadline's working day of `year`, and November's. */
const juneDate = (year: number) => slipOf(juneDays(year).due).date;
const novemberDate = (year: number) => slipOf(`${year}-11-30`).date;

/**
 * The acconti due during `year` for it: none in a first year (or before); else the rule on the
 * year before (metodo storico). With the metodo previsionale for this year, the rule on this
 * year's estimate; once the June F24 is gone, its first acconto was paid (as said this year, else
 * on the storico), and the second is the new total less it; when that first is not known, the
 * second is the new rule's second instalment and the June part stays to calculate. Imposta and
 * contributi apart: the contributions never go through an imposta, so the deduction of the
 * contributions paid does not loop back.
 */
export function accontiOfYear(i: CalendarInputs, year: number): Acconti {
	return { imposta: impostaAcconti(i, year), contributi: contributiAcconti(i, year) };
}

/** After the June F24 with the metodo previsionale: what is left of `all` once `paid` went in June. */
function afterJune(all: Split | undefined, paid: bigint | undefined): Split | undefined {
	if (all === undefined) return undefined;
	if (paid === undefined) return { second: all.second };
	const t = total(all) ?? 0n;
	return { first: paid, second: t > paid ? t - paid : 0n };
}

const previsionaleNow = (i: CalendarInputs, year: number) => i.previsionale !== undefined && year === yearOf(i.today);

function impostaAcconti(i: CalendarInputs, year: number): Acconti["imposta"] {
	const pension = i.profile.pension;
	if (firstYear(i, year)) return { first: 0n, second: 0n, single: false };
	const storico = accontiOn(opt("imposta", impostaBase(i, year - 1)), pension).imposta;
	if (!previsionaleNow(i, year)) return storico;
	const fresh = accontiOn(opt("imposta", impostaBase(i, year)), pension).imposta;
	if (i.today <= juneDate(year)) return fresh;
	const paid = cents(figuresOf(i, year)?.accontiImposta) ?? storico?.first;
	const rest = afterJune(fresh, paid);
	return rest === undefined ? undefined : { ...rest, single: fresh?.single === true && (paid === undefined || paid === 0n) };
}

function contributiAcconti(i: CalendarInputs, year: number): Acconti["contributi"] {
	const pension = i.profile.pension;
	if (firstYear(i, year) || !f24Contributions(pension)) return { first: 0n, second: 0n };
	const storico = accontiOn(opt("contributi", contributiBase(i, year - 1)), pension).contributi;
	if (!previsionaleNow(i, year)) return storico;
	const fresh = accontiOn(opt("contributi", contributiBase(i, year)), pension).contributi;
	if (i.today <= juneDate(year)) return fresh;
	return afterJune(fresh, cents(figuresOf(i, year)?.accontiContributi) ?? storico?.first);
}

/** An acconto paid during `year`: as said (this year, those paid so far plus the November one still to come), else the rule's. */
function paidOf(i: CalendarInputs, year: number, said: string | undefined, rule: Split | undefined): bigint | undefined {
	const s = cents(said);
	if (s === undefined) return total(rule);
	return year === yearOf(i.today) && i.today <= novemberDate(year) ? s + (rule?.second ?? 0n) : s;
}

/** The acconti paid during `year` for it (see paidOf); undefined when unknown. */
export function accontiPaid(i: CalendarInputs, year: number): { readonly imposta?: bigint; readonly contributi?: bigint; readonly source: "detti" | "regola" | "nessuno" | "ignoti" } {
	const said = figuresOf(i, year);
	const imposta = paidOf(i, year, said?.accontiImposta, impostaAcconti(i, year));
	const contributi = contributiPaid(i, year);
	const source = said?.accontiImposta !== undefined || said?.accontiContributi !== undefined ? "detti" : firstYear(i, year) ? "nessuno" : imposta === undefined ? "ignoti" : "regola";
	return { ...(imposta === undefined ? {} : { imposta }), ...(contributi === undefined ? {} : { contributi }), source };
}

function contributiPaid(i: CalendarInputs, year: number): bigint | undefined {
	return paidOf(i, year, figuresOf(i, year)?.accontiContributi, contributiAcconti(i, year));
}

/** saldo = due − acconti paid, never below zero (an excess is a credit for the commercialista). */
function saldo(due: bigint | undefined, paid: bigint | undefined): bigint | undefined {
	if (due === undefined || paid === undefined) return undefined;
	return due > paid ? due - paid : 0n;
}

/** The deadlines of payments made in `year`. */
function deadlinesOfYear(i: CalendarInputs, year: number): Deadline[] {
	const p = i.profile;
	const out: Deadline[] = [];
	const make = (due: string, kind: Deadline["kind"], parts: Part[], more: Partial<Deadline> = {}): void => {
		const kept = parts.filter((x) => x.cents === undefined || x.cents > 0n);
		if (kept.length === 0) return;
		out.push({ due, ...slipOf(due), kind, parts: kept, ...more });
	};
	// Artigiani and commercianti: the fixed part in four instalments, the fourth in February of the next year.
	if (p.pension.kind === "artigiani" || p.pension.kind === "commercianti") {
		const of = (q: 1 | 2 | 3 | 4, forYear: number): Part => ({ kind: "fissi", cents: fixedQuarter(p.pension, q, forYear), quarter: q, forYear });
		if (!before(i, year - 1)) make(`${year}-02-16`, "fissi", [of(4, year - 1)]);
		if (!before(i, year)) {
			make(`${year}-05-16`, "fissi", [of(1, year)]);
			make(`${year}-08-20`, "fissi", [of(2, year)]);
			make(`${year}-11-16`, "fissi", [of(3, year)]);
		}
	}
	const last = baseOf(i, year - 1);
	const paid = accontiPaid(i, year - 1);
	const acconti = accontiOfYear(i, year);
	const june: Part[] = [
		{ kind: "saldo_imposta", ...opt("cents", saldo(last.imposta, paid.imposta)), forYear: year - 1 },
		{ kind: "acconto_imposta", ...opt("cents", acconti.imposta?.first), n: 1, forYear: year },
	];
	const november: Part[] = [{ kind: "acconto_imposta", ...opt("cents", acconti.imposta?.second), n: 2, ...(acconti.imposta?.single === true ? { single: true as const } : {}), forYear: year }];
	if (f24Contributions(p.pension)) {
		june.push({ kind: "saldo_contributi", ...opt("cents", saldo(last.contributi, paid.contributi)), forYear: year - 1 }, { kind: "acconto_contributi", ...opt("cents", acconti.contributi?.first), n: 1, forYear: year });
		november.push({ kind: "acconto_contributi", ...opt("cents", acconti.contributi?.second), n: 2, forYear: year });
	}
	// Before the activity began nothing is due: «nessuna» gives zeros, which are dropped.
	const days = juneDays(year);
	const known = june.reduce((n, x) => n + (x.cents ?? 0n), 0n);
	const alternative = { due: days.alternative, ...slipOf(days.alternative), cents: halfUp(known * (10_000n + scaled(days.extra, 2)), 10_000n), extra: days.extra };
	make(days.due, "giugno", june, { ...(known > 0n ? { alternative } : {}), ...(days.proroga ? {} : { noProroga: true as const }) });
	make(`${year}-11-30`, "novembre", november);
	return out;
}

function opt<K extends string>(key: K, c: bigint | undefined): { [k in K]?: bigint } {
	return (c === undefined ? {} : { [key]: c }) as { [k in K]?: bigint };
}

/** A June F24 whose day is before `from` but whose alternative is not: on the alternative's day, at its amount; none when the person said acconti paid that year (it was paid). */
function lateOf(i: CalendarInputs, d: Deadline, from: string): Deadline | undefined {
	const a = d.alternative;
	if (a === undefined || d.date >= from || a.date < from) return undefined;
	const said = figuresOf(i, yearOf(d.due));
	if ((cents(said?.accontiImposta) ?? 0n) > 0n || (cents(said?.accontiContributi) ?? 0n) > 0n) return undefined;
	const { alternative: _, slip: __, ...rest } = d;
	return { ...rest, due: a.due, date: a.date, ...(a.slip === undefined ? {} : { slip: a.slip }), late: { due: d.due, date: d.date, cents: a.cents, extra: a.extra } };
}

/** The F24 deadlines from `from` (default today) for `days` days, today included, by date; a June F24 gone by stays to its alternative day, if not paid. */
export function calendar(i: CalendarInputs, days = CALENDAR_DAYS, from = i.today): Deadline[] {
	const end = addDays(from, days - 1);
	const year = yearOf(from);
	const all = [...deadlinesOfYear(i, year), ...deadlinesOfYear(i, year + 1)].map((d) => lateOf(i, d, from) ?? d);
	return all.filter((d) => d.date >= from && d.date <= end).sort((a, b) => a.date.localeCompare(b.date) || a.due.localeCompare(b.due));
}

/** The dates without amounts, for the regime ordinario or without a profile: IVA quarterly and annual (ordinario), imposte in June (the forfettari's proroga without a profile) and November. */
export type PlainDeadline = { readonly due: string; readonly date: string; readonly slip?: Slip; readonly what: "iva_trimestrale" | "iva_annuale" | "imposte_giugno" | "imposte_novembre" };

export function plainCalendar(today: string, ordinario: boolean, days = CALENDAR_DAYS): PlainDeadline[] {
	const end = addDays(today, days - 1);
	const year = yearOf(today);
	const out: PlainDeadline[] = [];
	for (const y of [year, year + 1]) {
		const add = (due: string, what: PlainDeadline["what"]) => out.push({ due, ...slipOf(due), what });
		if (ordinario) {
			add(`${y}-03-16`, "iva_annuale");
			add(`${y}-05-16`, "iva_trimestrale");
			add(`${y}-08-20`, "iva_trimestrale");
			add(`${y}-11-16`, "iva_trimestrale");
		}
		add(ordinario ? `${y}-${JUNE_DUE}` : juneDays(y).due, "imposte_giugno");
		add(`${y}-11-30`, "imposte_novembre");
	}
	return out.filter((d) => d.date >= today && d.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}

/** What a deadline pays for, in a few words, for the cashflow's label. */
function deadlineWords(d: Deadline): string {
	const what = d.kind === "fissi" ? "contributi fissi INPS" : d.kind === "giugno" ? "saldo e primo acconto" : "secondo acconto";
	return d.late === undefined ? what : `${what}, se non l'hai già pagato, dimmelo`;
}

/** An F24 for the cashflow: its day, amount and words; the part of it that is INPS contributions; `was` the June day a late one had first. */
export type TaxPayment = { readonly date: string; readonly cents: bigint; readonly what: string; readonly contributi: bigint; readonly was?: string };

const CONTRIBUTI_PARTS: readonly string[] = ["saldo_contributi", "acconto_contributi", "fissi"];

/** The F24 the cashflow counts: the calendar's deadlines with a known amount from `today` to `end`. */
export function taxPayments(i: CalendarInputs, end: string): TaxPayment[] {
	const days = daysBetween(i.today, end) + 1;
	if (days < 1) return [];
	return calendar(i, days)
		.map((d): TaxPayment => ({ date: d.date, cents: dueCents(d), what: deadlineWords(d), contributi: d.parts.filter((p) => CONTRIBUTI_PARTS.includes(p.kind)).reduce((n, p) => n + (p.cents ?? 0n), 0n), ...(d.late === undefined ? {} : { was: d.late.date }) }))
		.filter((d) => d.cents > 0n);
}

/** What the acconti paid for `year` exceed its imposta and contributions by: a credit for the commercialista to use in compensazione. */
export function creditOf(i: CalendarInputs, year: number): { readonly imposta: bigint; readonly contributi: bigint } {
	const paid = accontiPaid(i, year);
	const over = (p: bigint | undefined, due: bigint | undefined) => (p === undefined || due === undefined || p <= due ? 0n : p - due);
	return { imposta: over(paid.imposta, impostaBase(i, year)), contributi: over(paid.contributi, contributiBase(i, year)) };
}
