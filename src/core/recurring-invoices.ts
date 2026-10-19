/**
 * Le fatture ricorrenti (canoni): what the person says once («canone mensile di manutenzione 300 €
 * a Rossi srl») and Annie prepares as a sales invoice DRAFT every period, never issued, numbered
 * or sent: the owner issues it with sales_invoices as any other draft. A schedule has a customer
 * (a card or a customer already invoiced), the lines as said (a voce of the listino by `item`, or
 * description and price), the draft's own terms (IVA, ritenuta, cassa, bollo, payment), a cadence
 * (every 1, 2, 3, 6 or 12 months from a first month), the day of the period's first month it is
 * due on (1 to 28, or the last), an optional end month or number of invoices, and an optional
 * note with {mese} and {periodo}. Kept per instance in `recurring-invoices.json`
 * (recurring-invoice-store.ts) with the periods already prepared or failed, each once.
 *
 * Periods, pure here: period k starts k × months after the first month; it is due on its day in
 * its first month (Rome time is the caller's). A period before the schedule was set (or resumed)
 * is never prepared, but the one it was set in is; when several are due at once (the server was
 * down) only the latest is prepared and the others are said as skipped, never a burst.
 */
import { MONTH_NAMES, daysInMonth, isoDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { isMarker, isText } from "./stored-fields.ts";

export class RecurringError extends Error {
	override readonly name = "RecurringError";
}

export const RECURRING_OPS = ["add", "list", "show", "pause", "resume", "change", "remove", "run_now"] as const;
export type RecurringOp = (typeof RECURRING_OPS)[number];

export const RECURRING_LIMITS = {
	schedules: 200,
	/** Periods prepared or failed, remembered so each is prepared once: the oldest go first. */
	runs: 5000,
	calls: 500,
	lines: 20,
	note: 200,
	/** Room kept in a line's description for «, novembre 2026 - gennaio 2027». */
	label: 40,
	/** Invoices a schedule may be limited to. */
	count: 600,
	fileBytes: 2 * 1024 * 1024,
} as const;

export const CADENCES = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, yearly: 12 } as const;
export type Cadence = keyof typeof CADENCES;
export const CADENCE_NAMES = Object.keys(CADENCES) as Cadence[];

export const CADENCE_WORDS: Readonly<Record<Cadence, string>> = { monthly: "ogni mese", bimonthly: "ogni due mesi", quarterly: "ogni trimestre", semiannual: "ogni sei mesi", yearly: "ogni anno" };

/** The day of the period's first month a draft is due: 1 to 28, or the last day of the month. */
export type DueDay = number | "end";

/** A line as said: a voce of the listino (`item`), or description and price; the rest as sales_invoices reads it. */
export type RecurringLine = {
	readonly item?: string;
	readonly description?: string;
	readonly quantity?: string;
	readonly unit?: string;
	readonly price?: string;
	readonly discount?: string;
	readonly vat?: string;
	readonly natura?: string;
	readonly reference?: string;
	readonly advance?: boolean;
};

/** The draft's own terms, as sales_invoices reads them at each draft. */
export type RecurringTerms = {
	readonly vat?: string;
	readonly natura?: string;
	readonly reference?: string;
	readonly ritenuta?: boolean | string;
	readonly cassa?: { readonly kind: string; readonly type?: string; readonly rate?: string };
	readonly bollo_to_client?: boolean;
	readonly split_payment?: boolean;
	readonly payment_days?: number;
	readonly end_of_month?: boolean;
	readonly method?: string;
	readonly iban?: string;
};

/** The customer, as found when the schedule was set: a card by its id, else the name and tax ids it was invoiced with. */
export type RecurringCustomer = { readonly name: string; readonly card?: string; readonly vat?: string; readonly cf?: string };

export type Schedule = Marker & {
	/** «RI-0001», never given again. */
	readonly id: string;
	readonly customer: RecurringCustomer;
	readonly lines: readonly RecurringLine[];
	readonly terms: RecurringTerms;
	readonly cadence: Cadence;
	readonly day: DueDay;
	/** The first period's first month, «2026-10». */
	readonly start: string;
	/** The last month a period may start in. */
	readonly end?: string;
	/** How many invoices in all. */
	readonly count?: number;
	readonly note?: string;
	readonly status: "active" | "paused";
	/** The day periods count from: set and resumed (a period before it is never prepared, the one it falls in is). */
	readonly from: string;
	/** The conversation it was set in: told there when a draft is ready, or could not be made. */
	readonly thread?: { readonly channel: string; readonly threadId: string };
	readonly callId?: string;
	readonly edited?: Marker;
};

/** A period handled: claimed (being prepared), drafted, or failed (said once, not tried again by itself). */
export type Run = {
	readonly schedule: string;
	/** The period's first month, «2026-10». */
	readonly period: string;
	readonly state: "claimed" | "drafted" | "failed";
	readonly at: string;
	readonly draft?: string;
	/** Periods due before this one and never prepared (the server was down). */
	readonly skipped?: number;
	/** What was missing, for the owner (the draft builder's own words). */
	readonly why?: string;
	/** The conversation was told (once per period). */
	readonly told?: true;
};

export const scheduleId = (n: number) => `RI-${String(n).padStart(4, "0")}`;
export const SCHEDULE_ID = /^RI-(\d{4,6})$/;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** «2026-10» plus `n` months. */
export function addMonths(month: string, n: number): string {
	const m = MONTH.exec(month);
	if (m === null) throw new RecurringError("mese non valido");
	const index = Number(m[1]) * 12 + Number(m[2]) - 1 + n;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Months from `a` to `b` («2026-10» to «2027-01»: 3). */
export function monthsBetween(a: string, b: string): number {
	const [ay, am] = a.split("-").map(Number) as [number, number];
	const [by, bm] = b.split("-").map(Number) as [number, number];
	return (by - ay) * 12 + (bm - am);
}

/** The day a period starting in `month` is due on. */
export function dueDate(month: string, day: DueDay): string {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7));
	return isoDate(y, m, day === "end" ? daysInMonth(y, m) : day);
}

/** The period of the schedule `day` falls in (its first month), or undefined before the first one. */
export function periodOn(s: Pick<Schedule, "start" | "cadence">, day: string): string | undefined {
	const n = monthsBetween(s.start, day.slice(0, 7));
	if (n < 0) return undefined;
	return addMonths(s.start, n - (n % CADENCES[s.cadence]));
}

/** The period's index (0 for the first). */
export const periodIndex = (s: Pick<Schedule, "start" | "cadence">, period: string): number => monthsBetween(s.start, period) / CADENCES[s.cadence];

/** Whether the schedule still has this period: within its end month and its number of invoices. */
export function within(s: Pick<Schedule, "start" | "cadence" | "end" | "count">, period: string): boolean {
	if (monthsBetween(s.start, period) < 0) return false;
	if (s.end !== undefined && period > s.end) return false;
	return s.count === undefined || periodIndex(s, period) < s.count;
}

/** Whether no period is left after `day`'s. */
export function finished(s: Pick<Schedule, "start" | "cadence" | "end" | "count">, day: string): boolean {
	const now = periodOn(s, day);
	const next = now === undefined ? s.start : addMonths(now, CADENCES[s.cadence]);
	return !within(s, next) && (now === undefined || !within(s, now));
}

/**
 * What is due on `day`: the latest period due (on or after the day the schedule counts from, or
 * the one that day falls in) not handled yet, and how many due before it were never handled.
 */
export function duePeriod(s: Schedule, day: string, handled: ReadonlySet<string>): { period: string; skipped: number } | undefined {
	const latest = periodOn(s, day);
	if (latest === undefined) return undefined;
	const first = periodOn(s, s.from) ?? s.start;
	const step = CADENCES[s.cadence];
	const due: string[] = [];
	for (let p = monthsBetween(first, s.start) > 0 ? s.start : first; monthsBetween(p, latest) >= 0; p = addMonths(p, step)) {
		if (within(s, p) && dueDate(p, s.day) <= day) due.push(p);
	}
	const last = due.at(-1);
	if (last === undefined || handled.has(last)) return undefined;
	// Only those after the last one handled: what came before that was handled or said already.
	const lastHandled = [...handled].filter((p) => p < last).sort().at(-1);
	const skipped = due.filter((p) => p !== last && !handled.has(p) && (lastHandled === undefined || p > lastHandled)).length;
	return { period: last, skipped };
}

const ROMAN_HALF = ["1º semestre", "2º semestre"];

/** The period in words: «ottobre 2026», «4º trimestre 2026», «ottobre-novembre 2026», «novembre 2026 - gennaio 2027», «2027». */
export function periodLabel(s: Pick<Schedule, "cadence">, period: string): string {
	const months = CADENCES[s.cadence];
	const y = Number(period.slice(0, 4));
	const m = Number(period.slice(5, 7));
	const name = (month: number) => MONTH_NAMES[month - 1] as string;
	if (months === 1) return `${name(m)} ${y}`;
	const aligned = (m - 1) % months === 0;
	if (months === 3 && aligned) return `${(m - 1) / 3 + 1}º trimestre ${y}`;
	if (months === 6 && aligned) return `${ROMAN_HALF[(m - 1) / 6]} ${y}`;
	if (months === 12 && m === 1) return String(y);
	const last = addMonths(period, months - 1);
	const ly = Number(last.slice(0, 4));
	const lm = Number(last.slice(5, 7));
	return ly === y ? `${name(m)}-${name(lm)} ${y}` : `${name(m)} ${y} - ${name(lm)} ${ly}`;
}

/** The first month of a period in words, for {mese}: «ottobre 2026». */
export const monthLabel = (period: string): string => `${MONTH_NAMES[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

/** A text with {mese} and {periodo} put in. */
export function filled(text: string, s: Pick<Schedule, "cadence">, period: string): string {
	return text.replaceAll("{mese}", monthLabel(period)).replaceAll("{periodo}", periodLabel(s, period));
}

export const hasPlaceholder = (text: string): boolean => /\{(?:mese|periodo)\}/.test(text);

/** The ops that only read: they run in a brief's thread. */
export function recurringCallReads(args: Record<string, unknown>): boolean {
	return args.op === "list" || args.op === "show";
}

/** What another agente may ask: the list, as totals only (never a customer, never one schedule). */
export function recurringAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "list";
}

const plain = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);
const opt = (v: unknown, max: number) => v === undefined || plain(v, max);
const keysIn = (o: object, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validLine(v: unknown): v is RecurringLine {
	if (!record(v) || !keysIn(v, ["item", "description", "quantity", "unit", "price", "discount", "vat", "natura", "reference", "advance"])) return false;
	if (v.item === undefined && (v.description === undefined || v.price === undefined)) return false;
	return opt(v.item, 120) && opt(v.description, 1000) && opt(v.quantity, 30) && opt(v.unit, 40) && opt(v.price, 30) && opt(v.discount, 10) && opt(v.vat, 5) && opt(v.natura, 5) && opt(v.reference, 100) && (v.advance === undefined || typeof v.advance === "boolean");
}

function validTerms(v: unknown): v is RecurringTerms {
	if (!record(v) || !keysIn(v, ["vat", "natura", "reference", "ritenuta", "cassa", "bollo_to_client", "split_payment", "payment_days", "end_of_month", "method", "iban"])) return false;
	const bool = (x: unknown) => x === undefined || typeof x === "boolean";
	if (!(opt(v.vat, 5) && opt(v.natura, 5) && opt(v.reference, 100) && opt(v.method, 20) && opt(v.iban, 40))) return false;
	if (!(bool(v.bollo_to_client) && bool(v.split_payment) && bool(v.end_of_month))) return false;
	if (!(v.ritenuta === undefined || typeof v.ritenuta === "boolean" || plain(v.ritenuta, 3))) return false;
	if (!(v.payment_days === undefined || (typeof v.payment_days === "number" && Number.isInteger(v.payment_days) && v.payment_days >= 0 && v.payment_days <= 365))) return false;
	const c = v.cassa;
	return c === undefined || (record(c) && keysIn(c, ["kind", "type", "rate"]) && plain(c.kind, 30) && opt(c.type, 4) && opt(c.rate, 10));
}

const validThread = (t: unknown) => t === undefined || (record(t) && keysIn(t, ["channel", "threadId"]) && plain(t.channel, 100) && plain(t.threadId, 300));

/** A schedule as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validSchedule(v: unknown): v is Schedule {
	if (!isMarker(v) || !record(v)) return false;
	const s = v as unknown as Schedule;
	if (!keysIn(s, ["id", "customer", "lines", "terms", "cadence", "day", "start", "end", "count", "note", "status", "from", "thread", "callId", "edited", "by", "at"])) return false;
	if (typeof s.id !== "string" || !SCHEDULE_ID.test(s.id)) return false;
	const c = s.customer as unknown;
	if (!record(c) || !keysIn(c, ["name", "card", "vat", "cf"]) || !plain(c.name, 200) || !opt(c.card, 20) || !opt(c.vat, 30) || !opt(c.cf, 20)) return false;
	if (!Array.isArray(s.lines) || s.lines.length === 0 || s.lines.length > RECURRING_LIMITS.lines || !s.lines.every(validLine)) return false;
	if (!validTerms(s.terms)) return false;
	if (!CADENCE_NAMES.includes(s.cadence)) return false;
	if (!(s.day === "end" || (typeof s.day === "number" && Number.isInteger(s.day) && s.day >= 1 && s.day <= 28))) return false;
	if (!MONTH.test(s.start) || (s.end !== undefined && (!MONTH.test(s.end) || s.end < s.start))) return false;
	if (s.count !== undefined && !(Number.isInteger(s.count) && s.count >= 1 && s.count <= RECURRING_LIMITS.count)) return false;
	if (!opt(s.note, RECURRING_LIMITS.note) || (s.status !== "active" && s.status !== "paused")) return false;
	if (typeof s.from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.from) || !validThread(s.thread)) return false;
	if (s.callId !== undefined && !isText(s.callId, 200)) return false;
	return s.edited === undefined || isMarker(s.edited);
}

export function validRun(v: unknown): v is Run {
	if (!record(v) || !keysIn(v, ["schedule", "period", "state", "at", "draft", "skipped", "why", "told"])) return false;
	const r = v as unknown as Run;
	return typeof r.schedule === "string" && SCHEDULE_ID.test(r.schedule) && MONTH.test(r.period) && ["claimed", "drafted", "failed"].includes(r.state) && plain(r.at, 40) && opt(r.draft, 10) && (r.skipped === undefined || (Number.isInteger(r.skipped) && r.skipped >= 0)) && (r.why === undefined || isText(r.why, 4000)) && (r.told === undefined || r.told === true);
}
