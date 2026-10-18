/**
 * The arithmetic of le tasse del forfettario, pure, in bigint cents, half up to the cent:
 *
 * - ricavi: the instalments of invoices to collect marked paid in the year, by the day marked paid
 *   (the cash principle of the forfettario; cash-book.ts, the same incassi as the prima nota). What
 *   the client paid counts as it is: the rivalsa INPS 4% and a bollo charged to the client are part
 *   of the compensi.
 * - reddito = ricavi × coefficient.
 * - contributi on the reddito: gestione separata reddito × rate; artigiani and commercianti the
 *   fixed part as said plus (reddito − minimale) × rate when positive, that part less 35% with the
 *   reduction; cassa professionale reddito × rate, at least its minimum; none.
 * - deducted from the reddito: the contributions paid in the year when the person said them,
 *   otherwise the year's estimated contributions (and the answer says which).
 * - imponibile = reddito − deducted (not below zero); imposta = imponibile × the year's rate.
 * - to set aside: (imposta + contributi) / ricavi, rounded up to the whole percent.
 * - the calendar, metodo storico: in June the saldo of last year (its imposta less the acconti
 *   paid for it) and the first acconto; in November the second. The base is last year's figures as
 *   said, else last year's estimate from its incassi, else unknown (no amount). The acconti paid
 *   last year are as said, else none in a first year, else last year's rule on the year before.
 *   Next year's deadlines use this year's estimate projected to the year's end.
 * - every deadline moves to the next working day (dates.ts, Saturday included).
 */
import { cashBook } from "./cash-book.ts";
import { dayOfYear } from "./dates.ts";
import { payDay } from "./invoice-sums.ts";
import type { Invoice } from "./invoices.ts";
import { addDays, daysBetween, leapYear } from "./italian-calendar.ts";
import { halfUp, scaled } from "./quote-sums.ts";
import {
	ACCONTO_FIRST_PERCENT,
	ACCONTO_NONE_MAX_CENTS,
	ACCONTO_SINGLE_MAX_CENTS,
	ARTIGIANI_REDUCTION_PERCENT,
	CALENDAR_DAYS,
	GS_ACCONTO_FIRST_PERCENT,
	GS_ACCONTO_PERCENT,
	HARD_LIMIT_CENTS,
	JULY_EXTRA_BP,
	LIMIT_CENTS,
	LIMIT_WARN_PERCENT,
	type Pension,
	rateFor,
	type TaxProfile,
	type YearFigures,
} from "./taxes.ts";

/** `cents` × `percent` (a decimal string, two decimals at most) / 100, half up. */
export function percentOf(cents: bigint, percent: string): bigint {
	return halfUp(cents * scaled(percent, 2), 10_000n);
}

const cents = (euros: string | undefined): bigint | undefined => (euros === undefined ? undefined : scaled(euros, 2));

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
	const book = cashBook(invoices, [], { from: `${year}-01-01`, to }, dayOf);
	return { cents: book.totalIn, count: book.rows.length, otherCurrency: book.otherCurrency, unreadable: book.unreadable };
}

/** The incassi of each year, read once: this year up to `today`, a year to come none. */
export function yearIncassi(invoices: readonly Invoice[], today: string, dayOf: (at: string) => string): (year: number) => Incassi {
	const memo = new Map<number, Incassi>();
	const current = Number(today.slice(0, 4));
	return (year) => {
		let i = memo.get(year);
		if (i === undefined) {
			i = year === current ? incassiOf(invoices, year, dayOf, today) : year > current ? { cents: 0n, count: 0, otherCurrency: 0, unreadable: 0 } : incassiOf(invoices, year, dayOf);
			memo.set(year, i);
		}
		return i;
	};
}

export type Contributi = {
	readonly total: bigint;
	/** Artigiani and commercianti: the fixed part, paid in four instalments. */
	readonly fixed: bigint;
	/** The part on the reddito: what the June and November acconti are of. */
	readonly variable: bigint;
};

/** The contributions of a year on `reddito` (see above). */
export function contributiOf(pension: Pension, reddito: bigint): Contributi {
	switch (pension.kind) {
		case "gestione_separata": {
			const v = percentOf(reddito, pension.rate);
			return { total: v, fixed: 0n, variable: v };
		}
		case "artigiani":
		case "commercianti": {
			const fixed = scaled(pension.fixed, 2);
			const over = reddito - scaled(pension.minimale, 2);
			let v = over > 0n ? percentOf(over, pension.rate) : 0n;
			if (pension.reduction) v = halfUp(v * BigInt(100 - ARTIGIANI_REDUCTION_PERCENT), 100n);
			return { total: fixed + v, fixed, variable: v };
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
	readonly ricavi: bigint;
	readonly coefficient: string;
	readonly reddito: bigint;
	readonly contributi: Contributi;
	/** Deducted from the reddito: the contributions paid in the year as said («detti»), or the estimate («stima»). */
	readonly deducted: bigint;
	readonly deductedFrom: "detti" | "stima";
	readonly imponibile: bigint;
	readonly rate: string;
	readonly imposta: bigint;
	/** Imposta and contributi. */
	readonly total: bigint;
	/** The whole percent of each incasso to set aside, rounded up; undefined without ricavi. */
	readonly setAsidePercent?: number;
};

/** The year's estimate on `ricavi` (see above). */
export function estimate(profile: TaxProfile, year: number, ricavi: bigint, figures?: YearFigures): Estimate {
	const reddito = percentOf(ricavi, profile.coefficient);
	const contributi = contributiOf(profile.pension, reddito);
	const paid = cents(figures?.contributiVersati);
	const deducted = paid ?? contributi.total;
	const imponibile = reddito > deducted ? reddito - deducted : 0n;
	const rate = rateFor(profile, year);
	const imposta = percentOf(imponibile, rate);
	const total = imposta + contributi.total;
	return {
		year,
		ricavi,
		coefficient: profile.coefficient,
		reddito,
		contributi,
		deducted,
		deductedFrom: paid === undefined ? "stima" : "detti",
		imponibile,
		rate,
		imposta,
		total,
		...(ricavi > 0n ? { setAsidePercent: Number((total * 100n + ricavi - 1n) / ricavi) } : {}),
	};
}

/** The days of `year`. */
function yearDays(year: number): number {
	return leapYear(year) ? 366 : 365;
}

export type Projection = { readonly ricavi: bigint; readonly perMonth: bigint; readonly days: number };

/** The year's ricavi if they go on as so far: the incassi to `today` over the days gone, for the whole year; and the monthly average. */
export function projected(ricaviSoFar: bigint, today: string): Projection {
	const year = Number(today.slice(0, 4));
	const days = dayOfYear(today);
	const ricavi = halfUp(ricaviSoFar * BigInt(yearDays(year)), BigInt(days));
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

/** The share of the 85.000 € limit, whole percent, down. */
export function limitShare(ricavi: bigint): number {
	return Number((ricavi * 100n) / LIMIT_CENTS);
}

// The calendar.

export type PartKind = "saldo_imposta" | "acconto_imposta" | "saldo_contributi" | "acconto_contributi" | "fissi";

/** One amount of a deadline; `cents` undefined when it cannot be known (last year's figures missing). */
export type Part = { readonly kind: PartKind; readonly cents?: bigint; readonly n?: 1 | 2; readonly single?: true; readonly quarter?: 1 | 2 | 3 | 4; readonly forYear: number };

export type Deadline = {
	/** The day written in the law, and the working day it moves to. */
	readonly due: string;
	readonly date: string;
	readonly kind: "giugno" | "novembre" | "fissi";
	readonly parts: readonly Part[];
	/** June only: by 31 July with 0,40% more, on the parts known. */
	readonly july?: { readonly due: string; readonly date: string; readonly cents: bigint };
};

/** The known total of a deadline; undefined when a part is unknown and nothing is known. */
export function deadlineCents(d: Deadline): bigint {
	return d.parts.reduce((n, p) => n + (p.cents ?? 0n), 0n);
}

export const hasUnknown = (d: Deadline) => d.parts.some((p) => p.cents === undefined);

/** Where last year's base came from: said, from its incassi, this year's estimate, nothing (before the activity), unknown. */
export type BaseSource = "detti" | "fatture" | "stima" | "nessuna" | "ignota";

export type Base = { readonly imposta?: bigint; readonly contributi?: bigint; readonly source: BaseSource; readonly estimate?: Estimate };

export type CalendarInputs = {
	readonly profile: TaxProfile;
	readonly figures: readonly YearFigures[];
	readonly incassi: (year: number) => Incassi;
	readonly today: string;
	/** Metodo previsionale for this year: the acconti on this year's estimate, with these ricavi (default the projection). */
	readonly previsionale?: { readonly ricavi?: bigint };
};

const figuresOf = (i: CalendarInputs, year: number) => i.figures.find((f) => f.year === year);

/** Whether the profile pays contributions on the reddito through the F24 June and November: not a cassa (its own deadlines), not none. */
function f24Contributions(p: Pension): boolean {
	return p.kind === "gestione_separata" || p.kind === "artigiani" || p.kind === "commercianti";
}

/** This year's estimate projected to its end. */
export function currentEstimate(i: CalendarInputs, ricavi?: bigint): Estimate {
	const year = Number(i.today.slice(0, 4));
	const r = ricavi ?? projected(i.incassi(year).cents, i.today).ricavi;
	return estimate(i.profile, year, r, figuresOf(i, year));
}

/** The base of the acconti of `year + 1` and of the saldo paid then: `year`'s imposta and contributions on the reddito. */
export function baseOf(i: CalendarInputs, year: number): Base {
	const current = Number(i.today.slice(0, 4));
	const said = figuresOf(i, year);
	const start = i.profile.startYear;
	if (start !== undefined && year < start) return { imposta: 0n, contributi: 0n, source: "nessuna" };
	if (year >= current) {
		const e = currentEstimate(i);
		return { imposta: cents(said?.imposta) ?? e.imposta, contributi: cents(said?.contributi) ?? e.contributi.variable, source: said?.imposta !== undefined ? "detti" : "stima", estimate: e };
	}
	const incassi = i.incassi(year);
	const e = incassi.count > 0 ? estimate(i.profile, year, incassi.cents, said) : undefined;
	const imposta = cents(said?.imposta) ?? e?.imposta;
	const contributi = cents(said?.contributi) ?? e?.contributi.variable;
	const source: BaseSource = said?.imposta !== undefined ? "detti" : e !== undefined ? "fatture" : "ignota";
	return { ...(imposta === undefined ? {} : { imposta }), ...(contributi === undefined ? {} : { contributi }), source, ...(e === undefined ? {} : { estimate: e }) };
}

export type Acconti = {
	readonly imposta: { readonly first: bigint; readonly second: bigint; readonly single: boolean } | undefined;
	readonly contributi: { readonly first: bigint; readonly second: bigint } | undefined;
};

/** The acconti of a year on a base (see the constants' sources): undefined where the base is unknown. */
export function accontiOn(base: Pick<Base, "imposta" | "contributi">, pension: Pension): Acconti {
	let imposta: Acconti["imposta"];
	const b = base.imposta;
	if (b !== undefined) {
		if (b <= ACCONTO_NONE_MAX_CENTS) imposta = { first: 0n, second: 0n, single: false };
		else if (b <= ACCONTO_SINGLE_MAX_CENTS) imposta = { first: 0n, second: b, single: true };
		else {
			const first = halfUp(b * ACCONTO_FIRST_PERCENT, 100n);
			imposta = { first, second: b - first, single: false };
		}
	}
	let contributi: Acconti["contributi"];
	const c = base.contributi;
	if (c !== undefined && f24Contributions(pension)) {
		if (pension.kind === "gestione_separata") {
			const total = halfUp(c * GS_ACCONTO_PERCENT, 100n);
			const first = halfUp(c * GS_ACCONTO_FIRST_PERCENT, 100n);
			contributi = { first, second: total - first };
		} else {
			const first = halfUp(c * ACCONTO_FIRST_PERCENT, 100n);
			contributi = { first, second: c - first };
		}
	} else if (!f24Contributions(pension)) contributi = { first: 0n, second: 0n };
	return { imposta, contributi };
}

const total = (a: { readonly first: bigint; readonly second: bigint } | undefined) => (a === undefined ? undefined : a.first + a.second);

/**
 * The acconti due during `year` for it: none in a first year (or before); else the rule on the
 * year before (metodo storico). With the metodo previsionale for this year, the rule on this
 * year's estimate; once the June F24 is gone, its first acconto was paid on the storico, and the
 * second is the new total less it.
 */
export function accontiOfYear(i: CalendarInputs, year: number): Acconti {
	const p = i.profile;
	if (p.startYear !== undefined && year <= p.startYear) return { imposta: { first: 0n, second: 0n, single: false }, contributi: { first: 0n, second: 0n } };
	const storico = accontiOn(baseOf(i, year - 1), p.pension);
	if (i.previsionale === undefined || year !== Number(i.today.slice(0, 4))) return storico;
	const e = currentEstimate(i, i.previsionale.ricavi);
	const fresh = accontiOn({ imposta: e.imposta, contributi: e.contributi.variable }, p.pension);
	if (i.today <= payDay(`${year}-06-30`)) return fresh;
	const rest = (all: { readonly first: bigint; readonly second: bigint } | undefined, paid: bigint | undefined) => {
		const t = total(all) ?? 0n;
		const first = paid ?? 0n;
		return { first, second: t > first ? t - first : 0n };
	};
	return {
		imposta: { ...rest(fresh.imposta, storico.imposta?.first), single: false },
		contributi: fresh.contributi === undefined ? undefined : rest(fresh.contributi, storico.contributi?.first),
	};
}

/** The acconti paid during `year` for it: as said, else as accontiOfYear; undefined when unknown. */
export function accontiPaid(i: CalendarInputs, year: number): { readonly imposta?: bigint; readonly contributi?: bigint; readonly source: "detti" | "regola" | "nessuno" | "ignoti" } {
	const said = figuresOf(i, year);
	const saidImposta = cents(said?.accontiImposta);
	const saidContributi = cents(said?.accontiContributi);
	if (saidImposta !== undefined && saidContributi !== undefined) return { imposta: saidImposta, contributi: saidContributi, source: "detti" };
	const first = i.profile.startYear !== undefined && year <= i.profile.startYear;
	const rule = accontiOfYear(i, year);
	const imposta = saidImposta ?? total(rule.imposta);
	const contributi = saidContributi ?? total(rule.contributi);
	const source = saidImposta !== undefined || saidContributi !== undefined ? "detti" : first ? "nessuno" : imposta === undefined ? "ignoti" : "regola";
	return { ...(imposta === undefined ? {} : { imposta }), ...(contributi === undefined ? {} : { contributi }), source };
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
	const make = (due: string, kind: Deadline["kind"], parts: Part[]): void => {
		const kept = parts.filter((x) => x.cents === undefined || x.cents > 0n);
		if (kept.length === 0) return;
		out.push({ due, date: payDay(due), kind, parts: kept });
	};
	// Artigiani and commercianti: the fixed part in four instalments, the fourth in February of the next year.
	if (p.pension.kind === "artigiani" || p.pension.kind === "commercianti") {
		const quarter = halfUp(scaled(p.pension.fixed, 2), 4n);
		const fixed = scaled(p.pension.fixed, 2);
		const of = (q: 1 | 2 | 3 | 4, forYear: number): Part => ({ kind: "fissi", cents: q === 4 ? fixed - quarter * 3n : quarter, quarter: q, forYear });
		const active = (y: number) => p.startYear === undefined || y >= p.startYear;
		if (active(year - 1)) make(`${year}-02-16`, "fissi", [of(4, year - 1)]);
		if (active(year)) {
			make(`${year}-05-16`, "fissi", [of(1, year)]);
			make(`${year}-08-20`, "fissi", [of(2, year)]);
			make(`${year}-11-16`, "fissi", [of(3, year)]);
		}
	}
	const last = baseOf(i, year - 1);
	const paid = accontiPaid(i, year - 1);
	const acconti = accontiOfYear(i, year);
	const june: Part[] = [
		{ kind: "saldo_imposta", ...opt(saldo(last.imposta, paid.imposta)), forYear: year - 1 },
		{ kind: "acconto_imposta", ...opt(acconti.imposta?.first), n: 1, forYear: year },
	];
	const november: Part[] = [{ kind: "acconto_imposta", ...opt(acconti.imposta?.second), n: 2, ...(acconti.imposta?.single === true ? { single: true as const } : {}), forYear: year }];
	if (f24Contributions(p.pension)) {
		june.push({ kind: "saldo_contributi", ...opt(saldo(last.contributi, paid.contributi)), forYear: year - 1 }, { kind: "acconto_contributi", ...opt(acconti.contributi?.first), n: 1, forYear: year });
		november.push({ kind: "acconto_contributi", ...opt(acconti.contributi?.second), n: 2, forYear: year });
	}
	// Before the activity began nothing is due: «nessuna» gives zeros, which are dropped.
	make(`${year}-06-30`, "giugno", june);
	make(`${year}-11-30`, "novembre", november);
	return out.map((d) => {
		if (d.kind !== "giugno") return d;
		const known = deadlineCents(d);
		const due = `${year}-07-31`;
		return known > 0n ? { ...d, july: { due, date: payDay(due), cents: halfUp(known * (10_000n + JULY_EXTRA_BP), 10_000n) } } : d;
	});
}

function opt(c: bigint | undefined): { cents?: bigint } {
	return c === undefined ? {} : { cents: c };
}

/** The F24 deadlines from `from` (default today) for `days` days, today included, by date. */
export function calendar(i: CalendarInputs, days = CALENDAR_DAYS, from = i.today): Deadline[] {
	const end = addDays(from, days - 1);
	const year = Number(from.slice(0, 4));
	const all = [...deadlinesOfYear(i, year), ...deadlinesOfYear(i, year + 1)];
	return all.filter((d) => d.date >= from && d.date <= end).sort((a, b) => a.date.localeCompare(b.date) || a.due.localeCompare(b.due));
}

/** The regime ordinario's dates, without amounts: IVA quarterly and annual, imposte in June and November. */
export type PlainDeadline = { readonly due: string; readonly date: string; readonly what: "iva_trimestrale" | "iva_annuale" | "imposte_giugno" | "imposte_novembre" };

export function plainCalendar(today: string, ordinario: boolean, days = CALENDAR_DAYS): PlainDeadline[] {
	const end = addDays(today, days - 1);
	const year = Number(today.slice(0, 4));
	const out: PlainDeadline[] = [];
	for (const y of [year, year + 1]) {
		const add = (due: string, what: PlainDeadline["what"]) => out.push({ due, date: payDay(due), what });
		if (ordinario) {
			add(`${y}-03-16`, "iva_annuale");
			add(`${y}-05-16`, "iva_trimestrale");
			add(`${y}-08-20`, "iva_trimestrale");
			add(`${y}-11-16`, "iva_trimestrale");
		}
		add(`${y}-06-30`, "imposte_giugno");
		add(`${y}-11-30`, "imposte_novembre");
	}
	return out.filter((d) => d.date >= today && d.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}

/** What a deadline pays for, in a few words, for the cashflow's label. */
export function deadlineWords(d: Deadline): string {
	return d.kind === "fissi" ? "contributi fissi INPS" : d.kind === "giugno" ? "saldo e primo acconto" : "secondo acconto";
}

/** The F24 the cashflow counts: the calendar's deadlines with a known amount from `today` to `end`. */
export function taxPayments(i: CalendarInputs, end: string): { readonly date: string; readonly cents: bigint; readonly what: string }[] {
	const days = daysBetween(i.today, end) + 1;
	if (days < 1) return [];
	return calendar(i, days)
		.map((d) => ({ date: d.date, cents: deadlineCents(d), what: deadlineWords(d) }))
		.filter((d) => d.cents > 0n);
}
