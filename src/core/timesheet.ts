/**
 * Ore di lavoro: the time the owner works for a client, billed by the hour. An entry is a day, a
 * client, the minutes (whole, at least one, at most a day) and, when said, the project, the
 * clock range (and the pause taken off it), a description, an hourly rate of its own; it is
 * billable unless said otherwise. Its billing state: to bill; «nel preventivo» once it went into a
 * preventivo (to_quote); billed («fatturata») once it has the reference the person gives (an
 * invoice's number), with or without a quote. While to_quote makes its quote, the entries it
 * picked are reserved to it under the store's lock, so another call does not bill them too. Numbered per year of the
 * day worked (O-2026-0001). One timer runs per person, kept with the entries so it survives a
 * restart. The default hourly rates (per client and for everyone) and the rounding a client is
 * billed with are kept here too. Kept per instance in `timesheet.json` (timesheet-store.ts);
 * amounts and periods in timesheet-sums.ts.
 */
import { MAX_MINUTES, MIN_MINUTES } from "./durations.ts";
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { spellingKey, words } from "./name-keys.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export class TimesheetError extends Error {
	override readonly name = "TimesheetError";
}

export const TIMESHEET_LIMITS = {
	/** Entries dated in one year: past it, no new one of that year. */
	perYear: 20_000,
	/** The store file: past it, nothing more is written (a full year is about 8 MB). */
	fileBytes: 16 * 1024 * 1024,
	client: 120,
	project: 120,
	description: 500,
	/** The reference of a billing: a quote's number, an invoice's, as the person says it. */
	ref: 100,
	/** Clients with a rate or a rounding of their own. */
	rates: 500,
	/** Timers running at once: one per person. */
	timers: 200,
	/** The highest hourly rate, in euros: no typo of a few zeros goes in unchecked. */
	maxRate: 10_000,
} as const;

/** Over this, one client's day is said: more than 16 hours of work is likely a typo. */
export const DAY_WARN_MINUTES = 16 * 60;

/** A timer stopped after this many hours is said, to be checked: it was likely forgotten. */
export const LONG_TIMER_MINUTES = 12 * 60;

/** The timesheet tool's ops that only read: they run in a brief's thread and for another agente. */
const TIMESHEET_READ_OPS = ["list", "summary", "status"] as const;

/** set_rate with neither rate nor rounding shows the rates: it reads too. */
export function timesheetCallReads(args: Record<string, unknown>): boolean {
	if (args.op === "set_rate") return args.rate === undefined && args.rounding === undefined;
	return TIMESHEET_READ_OPS.some((o) => o === args.op);
}

/** Minutes a billed entry is rounded up to, per entry, at billing time only: 0 is none. */
export const ROUNDINGS = [0, 15, 30] as const;
export type Rounding = (typeof ROUNDINGS)[number];

/** How an entry was billed: who marked it and when, the reference, and the rate and rounding it was billed at. */
export type Billed = Marker & {
	/** The reference the person gave («fattura 12/2026»): with it the entry is invoiced, not only quoted. */
	readonly ref?: string;
	/** The preventivo it went into (timesheet op to_quote). */
	readonly quote?: string;
	/** The hourly rate and rounding in force then: the amount billed does not move when a rate changes later. */
	readonly rate?: string;
	readonly rounding?: Rounding;
};

export type WorkEntry = Marker & {
	/** «O-2026-0001»: the year of the day worked and its progressive. */
	readonly id: string;
	/** ISO day worked. */
	readonly date: string;
	/** The client as said, or the name already used for it (timesheet, quotes, invoices). */
	readonly client: string;
	readonly project?: string;
	/** Whole minutes worked, as recorded: never changed by a rounding. */
	readonly minutes: number;
	/** The clock range, when it was said or a timer ran within one day: «09:00», «12:30». */
	readonly start?: string;
	readonly end?: string;
	/** Minutes of pause taken off the range: `minutes` is the range less these. */
	readonly pause?: number;
	readonly description?: string;
	/** False: worked, not to be billed. */
	readonly billable: boolean;
	/** An hourly rate of this entry's own, in euros VAT excluded, a canonical decimal («45.5»). */
	readonly rate?: string;
	readonly billed?: Billed;
	/** The tool call that recorded it: a call run again finds it instead of recording another. */
	readonly callId?: string;
	readonly edited?: Marker;
};

/** A running timer: whose, for what, since when. */
export type Timer = {
	/** The person, as the tool names who did something (participant, or the thread). */
	readonly person: string;
	readonly client: string;
	readonly project?: string;
	readonly description?: string;
	readonly billable: boolean;
	readonly rate?: string;
	/** ISO instant it started. */
	readonly startedAt: string;
	/** The call that started it: a call run again finds it as its own. */
	readonly callId?: string;
};

/** An entry as to_quote picked it: its minutes, rate and rounding then, checked again when it is billed. */
export type ReservedEntry = { readonly id: string; readonly minutes: number; readonly rate?: string; readonly rounding: Rounding };

/** The entries a to_quote call picked, reserved to it while its quote is made. */
export type Reservation = Marker & { readonly callId: string; readonly entries: readonly ReservedEntry[] };

/** A reservation older than this no longer holds its entries: the call that made it stopped for good. */
export const RESERVATION_MS = 60 * 60_000;

/** Whether a reservation still holds its entries at `now`. */
export function activeReservation(r: Reservation, now: Date): boolean {
	return now.getTime() - Date.parse(r.at) < RESERVATION_MS;
}

/** A default: for a client (`client` given) or for everyone (no client). */
export type RateRule = Marker & {
	readonly client?: string;
	readonly rate?: string;
	readonly rounding?: Rounding;
};

/** «O-2026-0001». */
export function entryId(year: number, n: number): string {
	return `O-${year}-${String(n).padStart(4, "0")}`;
}

const ID = /^O-(\d{4})-(\d{4,6})$/;

/** The year and progressive of an id, for ordering. */
export function idOrder(id: string): [number, number] {
	const m = ID.exec(id);
	return m === null ? [0, 0] : [Number(m[1]), Number(m[2])];
}

const SAID_ID = /^(?:o(?:re)?\s*[-.]?\s*)?(?:n(?:r|um(?:ero)?)?\.?\s*)?(?:(\d{4})[-/ ])?0*(\d{1,6})(?:[-/ ](\d{4}))?$/i;

/** The year (when said) and progressive of an id as a person writes it: «O-2026-0001», «2026-1», «1/2026», «12». */
export function parseEntryId(text: string): { readonly year?: number; readonly n: number } | undefined {
	const m = SAID_ID.exec(text.trim());
	if (m === null || Number(m[2]) === 0) return undefined;
	const year = m[1] ?? m[3];
	return { ...(year === undefined ? {} : { year: Number(year) }), n: Number(m[2]) };
}

/** The entries a person's words name; more than one when the progressive without a year is in several years. */
export function findEntries(entries: readonly WorkEntry[], text: string): WorkEntry[] {
	const said = parseEntryId(text);
	if (said === undefined) return [];
	return entries.filter((e) => {
		const [y, seq] = idOrder(e.id);
		return seq === said.n && (said.year === undefined || y === said.year);
	});
}

/** Newest first: by date, then by id. */
export function newestFirst(a: WorkEntry, b: WorkEntry): number {
	const [ay, an] = idOrder(a.id);
	const [by, bn] = idOrder(b.id);
	return b.date.localeCompare(a.date) || by - ay || bn - an;
}

/** Oldest first: by date, then by start, then by id. */
export function oldestFirst(a: WorkEntry, b: WorkEntry): number {
	const [ay, an] = idOrder(a.id);
	const [by, bn] = idOrder(b.id);
	return a.date.localeCompare(b.date) || (a.start ?? "").localeCompare(b.start ?? "") || ay - by || an - bn;
}

/** Whether two names are the same client: no case, accents nor punctuation; the legal form counts («Rossi Srl» is not «Rossi Spa»). */
export function sameClient(a: string, b: string): boolean {
	const ka = spellingKey(a);
	return ka !== "" && ka === spellingKey(b);
}

/** Words of a text, matched anywhere in a name without case and accents (the projects' filter). */
export function matchesWords(name: string, text: string): boolean {
	const all = words(name).join(" ");
	const wanted = words(text);
	return wanted.length > 0 && wanted.every((w) => all.includes(w));
}

export type BillingState = "unbilled" | "quoted" | "invoiced";

/** To bill; in a preventivo without a reference yet; billed with a reference. */
export function billingState(e: Pick<WorkEntry, "billed">): BillingState {
	if (e.billed === undefined) return "unbilled";
	return e.billed.ref === undefined && e.billed.quote !== undefined ? "quoted" : "invoiced";
}

const sameText = (a: string | undefined, b: string | undefined) => (a === undefined || b === undefined ? a === b : spellingKey(a) === spellingKey(b));

/**
 * An entry already recorded that `e` looks like: the same client, project, day and minutes, and
 * the same range (or neither has one). Said to the person, never refused: two calls of an hour on
 * the same day are two entries.
 */
export function lookalike(entries: readonly WorkEntry[], e: WorkEntry): string | undefined {
	const sameRange = (o: WorkEntry) => o.start === e.start && o.end === e.end;
	return entries.find((o) => o.id !== e.id && o.date === e.date && o.minutes === e.minutes && sameClient(o.client, e.client) && sameText(o.project, e.project) && sameRange(o))?.id;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const RATE = /^\d{1,5}(?:\.\d{1,2})?$/;

/** An hourly rate as stored: a canonical decimal, more than zero, at most TIMESHEET_LIMITS.maxRate. */
export function validRate(v: unknown): v is string {
	return typeof v === "string" && RATE.test(v) && !/^0\d/.test(v) && !/\.\d*0$/.test(v) && Number(v) > 0 && Number(v) <= TIMESHEET_LIMITS.maxRate;
}

const optRate = (v: unknown) => v === undefined || validRate(v);
const validRounding = (v: unknown): v is Rounding => ROUNDINGS.includes(v as Rounding);

function validBilled(v: unknown): v is Billed {
	if (!isMarker(v)) return false;
	const b = v as Billed;
	return optText(b.ref, TIMESHEET_LIMITS.ref) && optText(b.quote, 30) && optRate(b.rate) && (b.rounding === undefined || validRounding(b.rounding));
}

/** An entry as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validEntry(v: unknown): v is WorkEntry {
	if (!isMarker(v)) return false;
	const e = v as WorkEntry;
	if (typeof e.id !== "string" || !ID.test(e.id)) return false;
	if (typeof e.date !== "string" || !DAY.test(e.date) || !realDate(e.date) || Number(e.date.slice(0, 4)) !== idOrder(e.id)[0]) return false;
	if (!isText(e.client, TIMESHEET_LIMITS.client) || !optText(e.project, TIMESHEET_LIMITS.project) || !optText(e.description, TIMESHEET_LIMITS.description) || !optText(e.callId, 200)) return false;
	if (!Number.isInteger(e.minutes) || e.minutes < MIN_MINUTES || e.minutes > MAX_MINUTES) return false;
	if ((e.start === undefined) !== (e.end === undefined)) return false;
	if (e.start !== undefined && (typeof e.start !== "string" || typeof e.end !== "string" || !CLOCK.test(e.start) || !CLOCK.test(e.end) || e.start >= e.end)) return false;
	if (e.pause !== undefined && (e.start === undefined || !Number.isInteger(e.pause) || e.pause < 1 || e.pause >= MAX_MINUTES)) return false;
	if (typeof e.billable !== "boolean" || !optRate(e.rate)) return false;
	if (e.billed !== undefined && !validBilled(e.billed)) return false;
	return e.edited === undefined || isMarker(e.edited);
}

export function validTimer(v: unknown): v is Timer {
	if (typeof v !== "object" || v === null) return false;
	const t = v as Timer;
	if (!isText(t.person, 200) || !isText(t.client, TIMESHEET_LIMITS.client) || !optText(t.project, TIMESHEET_LIMITS.project) || !optText(t.description, TIMESHEET_LIMITS.description)) return false;
	if (typeof t.billable !== "boolean" || !optRate(t.rate) || !optText(t.callId, 200)) return false;
	return typeof t.startedAt === "string" && t.startedAt.length <= 40 && !Number.isNaN(Date.parse(t.startedAt));
}

export function validRule(v: unknown): v is RateRule {
	if (!isMarker(v)) return false;
	const r = v as RateRule;
	if (!optText(r.client, TIMESHEET_LIMITS.client) || !optRate(r.rate)) return false;
	if (r.rounding !== undefined && !validRounding(r.rounding)) return false;
	return r.rate !== undefined || r.rounding !== undefined;
}

export function validReservation(v: unknown): v is Reservation {
	if (!isMarker(v)) return false;
	const r = v as Reservation;
	if (!isText(r.callId, 200) || !Array.isArray(r.entries) || r.entries.length === 0 || r.entries.length > TIMESHEET_LIMITS.perYear) return false;
	return r.entries.every((e) => typeof e === "object" && e !== null && typeof e.id === "string" && ID.test(e.id) && Number.isInteger(e.minutes) && e.minutes >= MIN_MINUTES && e.minutes <= MAX_MINUTES && optRate(e.rate) && validRounding(e.rounding));
}
