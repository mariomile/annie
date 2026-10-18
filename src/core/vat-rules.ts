/**
 * The rules of la liquidazione IVA for the regime ordinario, each with its source. Where the source
 * is not certain, or the rule changes often, the comment says «da verificare». Pure constants and
 * the few functions that only read them (the deadline of a period, its codice tributo); the
 * arithmetic is in vat-sums.ts.
 */
import { FERRAGOSTO } from "./italian-calendar.ts";

/**
 * Quarterly liquidazione by option: allowed when last year's volume d'affari was within the limits
 * of the contabilità semplificata (art. 7 DPR 542/1999, which points to art. 18 DPR 600/1973):
 * 500.000 € for services and 800.000 € for the other activities, as raised by L. 197/2022 (art. 1,
 * comma 276) from 2023. Da verificare: the brief that asked for this said 800.000 € for
 * professionals and 500.000 € for goods, the other way round; and the limits are revised often.
 */
export const QUARTERLY_LIMIT_CENTS = { servizi: 50_000_000n, altro: 80_000_000n } as const;
export type Activity = keyof typeof QUARTERLY_LIMIT_CENTS;

/** Quarterly by option: the amount due for each of the first three quarters is increased by 1% interest (art. 7, comma 1, lett. b, DPR 542/1999). */
export const QUARTERLY_INTEREST_PERCENT = "1";
/**
 * The 1% applies to the fourth quarter too, paid with the annual saldo: the istruzioni of the
 * modello IVA (rigo VL36) charge the trimestrali per opzione the 1% on the saldo of the
 * dichiarazione as well. Da verificare each year on the istruzioni. One constant, so it changes in
 * one place.
 */
export const Q4_INTEREST = true;

/** Monthly: the IVA of a month is paid by the 16th of the next one (art. 1, comma 1, DPR 100/1998). */
export const MONTHLY_DAY = 16;
/** Quarterly: the first three quarters by 16 May, 16 August (20 August, see FERRAGOSTO) and 16 November (art. 7 DPR 542/1999); the fourth with the annual saldo. */
export const QUARTER_DUE: Readonly<Record<1 | 2 | 3, string>> = { 1: "05-16", 2: "08-20", 3: "11-16" };
/**
 * The annual saldo, and the fourth quarter of the trimestrali, by 16 March of the next year (art.
 * 6 DPR 542/1999). It may be paid by the deadline of the imposte sui redditi (30 June), adding
 * 0,40% for each month or part of a month after 16 March (art. 6 DPR 542/1999, art. 17 DPR
 * 435/2001): da verificare each year, with the proroghe of the June deadline.
 */
export const ANNUAL_DUE = "03-16";
export const ANNUAL_DEFER_TO = "06-30";
export const ANNUAL_DEFER_PERCENT_PER_MONTH = "0.40";
/** The acconto IVA by 27 December (art. 6, comma 2, L. 405/1990). */
export const ACCONTO_DUE = "12-27";
/** The acconto, metodo storico and previsionale: 88% (art. 6, comma 2, L. 405/1990). */
export const ACCONTO_PERCENT = 88n;
/** No acconto is due when it is under 103,29 € (art. 6, comma 2, L. 405/1990, as converted to euros). */
export const ACCONTO_MIN_CENTS = 10_329n;
/** The metodo analitico: the liquidazione of the operations up to 20 December (art. 6, comma 3-bis, L. 405/1990). */
export const ACCONTO_ANALYTIC_DAY = "12-20";

/** A periodic payment of 25,82 € or less is not made: it goes with the next one (art. 1, comma 4, DPR 100/1998; art. 7 DPR 542/1999). */
export const PERIODIC_MIN_CENTS = 2_582n;
/** The annual saldo is not paid when it is 10,33 € or less (art. 6 DPR 542/1999 as converted to euros; istruzioni del modello IVA). Da verificare. */
export const ANNUAL_MIN_CENTS = 1_033n;

/**
 * Codici tributo of the F24 (risoluzioni dell'Agenzia delle Entrate; da verificare on the tables of
 * the Agenzia): monthly 6001-6012 by month; quarterly 6031-6033 for the first three quarters (the
 * 1% interest goes with the same code); acconto 6013 monthly, 6035 quarterly; annual saldo 6099.
 */
export const CODE_ACCONTO = { mensile: "6013", trimestrale: "6035" } as const;
export const CODE_ANNUAL = "6099";
export const monthCode = (month: number): string => String(6000 + month);
export const quarterCode = (quarter: 1 | 2 | 3): string => String(6030 + quarter);

/**
 * Received invoices: the IVA is deductible in the period the invoice is received (art. 1 DPR
 * 100/1998 as amended by DL 50/2017) and at the latest in the dichiarazione of the year of
 * receipt, due by 30 April of the next year (art. 19 DPR 633/1972; art. 8 DPR 322/1998). Annie
 * takes the period of receipt, and the invoice's date when the receipt is not known.
 */
export const DEDUCTION_LAST_DAY = "04-30";

/** Partial deductibility the person may set, as examples to say: cars 40% (art. 19-bis1, lett. c, DPR 633/1972); phones 50% (prassi; da verificare). */
export const PARTIAL_EXAMPLES = "auto al 40%, telefono al 50% (da verificare con il commercialista)";

/** Past this yearly credit, the compensazione with other taxes needs the visto di conformità (art. 10 DL 78/2009, as amended by DL 50/2017): Annie says to talk to the commercialista. */
export const CREDIT_VISTO_CENTS = 500_000n;

/** Days before an F24 of the IVA the morning brief says it. */
export const BRIEF_DAYS = 10;
/** The calendar's window, in days today included, and the most deadlines it lists (those with an amount, then the next one without). */
export const CALENDAR_DAYS = 366;
export const CALENDAR_ROWS = 3;
/** A deadline gone this many days ago and not marked paid is still said, «se non l'hai già pagato». */
export const OVERDUE_DAYS = 30;

export type Periodicity = "mensile" | "trimestrale";

/** A liquidazione: a month (1-12) or a quarter (1-4) of a year. */
export type VatPeriod = { readonly year: number; readonly kind: "month" | "quarter"; readonly n: number };

/**
 * The day written in the law for a period's payment, before it moves to a working day: the 16th of
 * the next month; a quarter's day; the fourth quarter on the annual saldo's day. A day from 1 to 20
 * August moves to 20 August (art. 3-quater DL 16/2012, the proroga di ferragosto).
 */
export function periodDue(p: VatPeriod): string {
	if (p.kind === "quarter") return p.n === 4 ? `${p.year + 1}-${ANNUAL_DUE}` : `${p.year}-${QUARTER_DUE[p.n as 1 | 2 | 3]}`;
	const next = p.n === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.n + 1 };
	return ferragosto(`${next.year}-${String(next.month).padStart(2, "0")}-${MONTHLY_DAY}`);
}

/** A day in the ferragosto window moved to its end. */
export function ferragosto(day: string): string {
	const md = day.slice(5);
	return md >= FERRAGOSTO.from && md <= FERRAGOSTO.to ? `${day.slice(0, 4)}-${FERRAGOSTO.to}` : day;
}

/** The codice tributo of a period's payment; the fourth quarter goes with the annual saldo. */
export function periodCode(p: VatPeriod): string {
	if (p.kind === "month") return monthCode(p.n);
	return p.n === 4 ? CODE_ANNUAL : quarterCode(p.n as 1 | 2 | 3);
}
