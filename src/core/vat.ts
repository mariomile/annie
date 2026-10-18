/**
 * La liquidazione IVA of the regime ordinario: how much IVA to pay for a month or a quarter, when,
 * with which codice tributo, the acconto of December, and what a purchase or a payment moves. The
 * IVA a debito is read from the invoices issued (the fatture in uscita and the XML found in the
 * workspace), the IVA a credito from the invoices received; nothing of them is written. What is
 * kept is what the person says, in `vat.json` (vat-store.ts): monthly or quarterly, the F24 paid,
 * which suppliers or invoices are not (or partly) deductible and when an invoice was received, the
 * credit carried into a year and last year's figure for the acconto. Rules and sources in
 * vat-rules.ts, the documents in vat-docs.ts, the arithmetic in vat-sums.ts.
 *
 * Every amount is an estimate to check with the commercialista, and the answers say so.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { isMarker, optText } from "./stored-fields.ts";
import type { Activity, Periodicity, VatPeriod } from "./vat-rules.ts";

export class VatError extends Error {
	override readonly name = "VatError";
}

export const VAT_LIMITS = {
	fileBytes: 512 * 1024,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 200,
	/** F24 marked paid, deductibility marks, years with figures: the oldest go past these. */
	paid: 400,
	marks: 2000,
	years: 30,
	/** The largest amount said, in euros. */
	maxAmount: 100_000_000,
	firstYear: 2000,
} as const;

/** The op the brief runs: calendar, with compact true (brief.ts). */
const VAT_BRIEF_OPS = ["calendar"] as const;

export function vatCallReads(args: Record<string, unknown>): boolean {
	return VAT_BRIEF_OPS.some((o) => o === args.op);
}

/** The ops another agente may ask: totals of a period and the calendar, never names. Everything else is refused. */
const VAT_AGENT_OPS = ["period", "calendar"] as const;

export function vatAgentReads(args: Record<string, unknown>): boolean {
	return VAT_AGENT_OPS.some((o) => o === args.op);
}

/** How the person liquidates, said once; `activity` only to say the quarterly limit. */
export type VatSettings = Marker & { readonly periodicity: Periodicity; readonly activity?: Activity; readonly edited?: Marker };

/**
 * What a payment is for: «2026-10» a month, «2026-T3» a quarter, «2026-acconto» the December
 * acconto, «2026-annuale» the annual saldo (with the fourth quarter of the trimestrali).
 */
export const PAID_KEY = /^(\d{4})-(?:(0[1-9]|1[0-2])|T([1-3])|(acconto)|(annuale))$/;

/** An F24 the person says paid: for what, the day and the amount (canonical euros). */
export type PaidMark = Marker & { readonly key: string; readonly date: string; readonly amount: string };

/**
 * What the person says of the IVA of a supplier (by partita IVA, «IT» and the digits) or of one
 * received invoice (by its key in the scadenzario): the share deductible («0» not at all, «40»),
 * and, for an invoice, the day it was received through the SdI.
 */
export type DeductMark = Marker & { readonly vat?: string; readonly invoice?: string; readonly percent?: string; readonly received?: string };

/** What the person says of a year: the IVA credit carried into it (from last year's dichiarazione), and the amount of its last liquidazione (December, or the fourth quarter) before the acconto, the acconto storico's base of the next year. */
export type YearFigures = { readonly year: number; readonly credit?: string; readonly base?: string };

const AMOUNT = /^\d{1,9}(?:\.\d{1,2})?$/;
const PERCENT = /^\d{1,2}(?:\.\d{1,2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isAmount = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && Number(v) <= VAT_LIMITS.maxAmount;
const isPercent = (v: unknown): v is string => typeof v === "string" && PERCENT.test(v);
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && realDate(v);
const isYear = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= VAT_LIMITS.firstYear && v <= 2200;

export function validSettings(v: unknown): v is VatSettings {
	if (!isMarker(v)) return false;
	const s = v as VatSettings;
	return (s.periodicity === "mensile" || s.periodicity === "trimestrale") && (s.activity === undefined || s.activity === "servizi" || s.activity === "altro") && (s.edited === undefined || isMarker(s.edited));
}

export function validPaid(v: unknown): v is PaidMark {
	if (!isMarker(v)) return false;
	const p = v as PaidMark;
	return typeof p.key === "string" && PAID_KEY.test(p.key) && isDay(p.date) && isAmount(p.amount);
}

export function validMark(v: unknown): v is DeductMark {
	if (!isMarker(v)) return false;
	const m = v as DeductMark;
	// One target: a supplier or an invoice; a supplier needs a share, an invoice a share or its day of receipt.
	if ((m.vat === undefined) === (m.invoice === undefined)) return false;
	if (m.vat !== undefined && (typeof m.vat !== "string" || !/^[A-Z]{2}[0-9A-Z]{2,28}$/.test(m.vat) || m.percent === undefined || m.received !== undefined)) return false;
	if (m.invoice !== undefined && !optText(m.invoice, 300)) return false;
	if (m.percent !== undefined && !isPercent(m.percent)) return false;
	if (m.received !== undefined && !isDay(m.received)) return false;
	return m.percent !== undefined || m.received !== undefined;
}

export function validYear(v: unknown): v is YearFigures {
	if (typeof v !== "object" || v === null) return false;
	const y = v as YearFigures;
	for (const key of Object.keys(y)) if (key !== "year" && key !== "credit" && key !== "base") return false;
	return isYear(y.year) && (y.credit === undefined || isAmount(y.credit)) && (y.base === undefined || /^-?\d{1,9}(?:\.\d{1,2})?$/.test(y.base));
}

export const validCall = (v: unknown): boolean => optText(v, 200) && v !== undefined;

/** The key a period's payment is marked under: the fourth quarter is the annual saldo's. */
export function paidKeyOf(p: VatPeriod): string {
	if (p.kind === "month") return `${p.year}-${String(p.n).padStart(2, "0")}`;
	return p.n === 4 ? `${p.year}-annuale` : `${p.year}-T${p.n}`;
}

/** The first and last day of a period. */
export function periodSpan(p: VatPeriod): { readonly from: string; readonly to: string } {
	const first = p.kind === "month" ? p.n : (p.n - 1) * 3 + 1;
	const last = p.kind === "month" ? p.n : first + 2;
	const end = new Date(Date.UTC(p.year, last, 0)).getUTCDate();
	return { from: `${p.year}-${String(first).padStart(2, "0")}-01`, to: `${p.year}-${String(last).padStart(2, "0")}-${String(end).padStart(2, "0")}` };
}

/** The period of `periodicity` a day is in. */
export function periodOfDay(day: string, periodicity: Periodicity): VatPeriod {
	const year = Number(day.slice(0, 4));
	const month = Number(day.slice(5, 7));
	return periodicity === "mensile" ? { year, kind: "month", n: month } : { year, kind: "quarter", n: Math.floor((month - 1) / 3) + 1 };
}

/** The periods of a year, in order. */
export function periodsOf(year: number, periodicity: Periodicity): VatPeriod[] {
	return periodicity === "mensile" ? Array.from({ length: 12 }, (_, i) => ({ year, kind: "month" as const, n: i + 1 })) : Array.from({ length: 4 }, (_, i) => ({ year, kind: "quarter" as const, n: i + 1 }));
}
