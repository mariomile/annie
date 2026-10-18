/**
 * La previsione di cassa: how much money there will be, day by day, from the bank balance the
 * person says (set_balance) and what is known to come in and go out: the open invoices of the
 * scadenzario, the renewals, the average of the expenses, and the voci the person adds by hand
 * (stipendio del titolare, F24, rata del mutuo, a payment expected without an invoice), numbered
 * C-0001. Only the balance, its alert threshold and the voci are this module's to keep, in
 * `cashflow.json` (cashflow-store.ts); everything else is read from its own register and never
 * written. Gathering in cashflow-sources.ts, the day-by-day arithmetic in cashflow-projection.ts.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { scaled } from "./quote-sums.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export class CashflowError extends Error {
	override readonly name = "CashflowError";
}

export const CASHFLOW_LIMITS = {
	/** Voci kept: past it, no new one. */
	items: 500,
	/** Balances kept, newest last: the older ones are dropped. */
	balances: 50,
	/** The store file: past it, nothing more is written. */
	fileBytes: 1024 * 1024,
	name: 120,
	note: 500,
	/** The largest amount of a voce or a balance, in euros: no typo of a few zeros goes in unchecked. */
	maxAmount: 10_000_000,
	/** The longest horizon of a forecast: a year and a day. */
	maxDays: 366,
	/** Hypothetical voci of one what_if. */
	whatIf: 10,
	/** The longest period of a recurring voce: ten years. */
	maxMonths: 120,
} as const;

/** Days after which the balance is said to be old in a forecast, and in the brief. */
export const STALE_BALANCE_DAYS = 14;
export const BRIEF_STALE_DAYS = 30;
/** The brief looks this far ahead. */
export const BRIEF_DAYS = 30;
/** The forecast's horizon when none is said. */
export const DEFAULT_DAYS = 30;
/** The days of expenses the average spending is taken from. */
export const AVERAGE_DAYS = 90;

/** The ops that only read and that the brief runs: forecast and list_items (brief.ts). */
const CASHFLOW_BRIEF_OPS = ["forecast", "list_items"] as const;

export function cashflowCallReads(args: Record<string, unknown>): boolean {
	return CASHFLOW_BRIEF_OPS.some((o) => o === args.op);
}

/** The ops that write (the balance, the voci, a file): refused for another agente. what_if writes nothing. */
export const CASHFLOW_WRITE_OPS = ["set_balance", "add_item", "remove_item", "export"] as const;

export function cashflowCallWrites(args: Record<string, unknown>): boolean {
	return CASHFLOW_WRITE_OPS.some((o) => o === args.op);
}

export type Kind = "in" | "out";

/** The bank balance on a day, as the person said it. */
export type Balance = Marker & {
	/** A canonical decimal string, a minus in front when overdrawn («-350.5»). */
	readonly amount: string;
	/** ISO day the balance is of. */
	readonly date: string;
	/** The call that set it: a call run again finds it instead of adding another. */
	readonly callId?: string;
};

/** A voce added by hand: once on `date`, or every `months` months from it keeping day `day`, up to `until`. */
export type CashItem = Marker & {
	/** «C-0001». */
	readonly id: string;
	readonly kind: Kind;
	/** A canonical decimal string, more than zero («1500», «89.9»). */
	readonly amount: string;
	readonly name: string;
	/** ISO day of the (first) movement. */
	readonly date: string;
	readonly months?: number;
	/** The day of the month kept on each roll (31: always the month's last day). */
	readonly day?: number;
	/** The last day a recurring voce runs. */
	readonly until?: string;
	readonly note?: string;
	readonly callId?: string;
};

/** «C-0001». */
export function itemId(n: number): string {
	return `C-${String(n).padStart(4, "0")}`;
}

const ID = /^C-(\d{4,6})$/;

/** The progressive of an id; 0 when it is none. */
export function idNumber(id: string): number {
	const m = ID.exec(id);
	return m === null ? 0 : Number(m[1]);
}

const SAID_ID = /^(?:c(?:assa)?\s*[-.]?\s*)?(?:voce\s*)?(?:n(?:r|um(?:ero)?)?\.?\s*)?0*(\d{1,6})$/i;

/** The progressive of an id as a person writes it: «C-0001», «C1», «voce 3», «3». */
export function parseItemId(text: string): number | undefined {
	const m = SAID_ID.exec(text.trim());
	if (m === null || Number(m[1]) === 0) return undefined;
	return Number(m[1]);
}

const AMOUNT = /^\d{1,8}(?:\.\d{1,2})?$/;
const SIGNED = /^-?\d{1,8}(?:\.\d{1,2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && realDate(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
export const isAmount = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && Number(v) > 0 && Number(v) <= CASHFLOW_LIMITS.maxAmount;
export const isSignedAmount = (v: unknown): v is string => typeof v === "string" && SIGNED.test(v) && v !== "-0" && Math.abs(Number(v)) <= CASHFLOW_LIMITS.maxAmount;

/** A signed canonical decimal string («-350.5») in cents. */
export function signedCents(value: string): bigint {
	return value.startsWith("-") ? -scaled(value.slice(1), 2) : scaled(value, 2);
}

export function validBalance(v: unknown): v is Balance {
	if (!isMarker(v)) return false;
	const b = v as Balance;
	return isSignedAmount(b.amount) && isDay(b.date) && optText(b.callId, 200);
}

/** A voce as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validItem(v: unknown): v is CashItem {
	if (!isMarker(v)) return false;
	const i = v as CashItem;
	if (typeof i.id !== "string" || !ID.test(i.id)) return false;
	if (i.kind !== "in" && i.kind !== "out") return false;
	if (!isAmount(i.amount) || !isText(i.name, CASHFLOW_LIMITS.name) || !optText(i.note, CASHFLOW_LIMITS.note) || !optText(i.callId, 200)) return false;
	if (!isDay(i.date)) return false;
	if ((i.months === undefined) !== (i.day === undefined)) return false;
	if (i.months !== undefined && (!isInt(i.months, 1, CASHFLOW_LIMITS.maxMonths) || !isInt(i.day, 1, 31))) return false;
	if (i.until !== undefined && (i.months === undefined || !isDay(i.until) || i.until < i.date)) return false;
	return true;
}
