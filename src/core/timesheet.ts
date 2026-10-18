/**
 * Ore di lavoro: the time the owner works for a client, billed by the hour. An entry is a day, a
 * client, the minutes (whole, at least one, at most a day) and, when said, the project, the
 * clock range, a description, an hourly rate of its own; it is billable unless said otherwise,
 * and billed once it went into a preventivo or the person marks it so. Numbered per year of the
 * day worked (O-2026-0001). One timer runs per person, kept with the entries so it survives a
 * restart. The default hourly rates (per client and for everyone) and the rounding a client is
 * billed with are kept here too. Kept per instance in `timesheet.json` (timesheet-store.ts);
 * amounts and periods in timesheet-sums.ts.
 */
import { MAX_MINUTES, MIN_MINUTES } from "./durations.ts";
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { businessKey, keyWithin, words } from "./name-keys.ts";
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
	/** The reference the person gave («fattura 12/2026»), or the quote's number. */
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

/** Whether two names are the same client: no case, accents, punctuation nor legal form. */
export function sameClient(a: string, b: string): boolean {
	const ka = businessKey(a);
	return ka !== "" && ka === businessKey(b);
}

/** Words of a client, matched anywhere in its name without case and accents (the list's filter). */
export function matchesClient(client: string, text: string): boolean {
	const name = words(client).join(" ");
	const wanted = words(text);
	return wanted.length > 0 && wanted.every((w) => name.includes(w));
}

export type ClientMatch = {
	/** The name to use: one already known when the match is obvious, else the one said. */
	readonly name: string;
	/** A known name other than the one said was used. */
	readonly matched?: true;
	/** Known names it could be, none obvious: the one said is kept. */
	readonly ambiguous?: readonly string[];
};

/**
 * The client a person names, against the names already used (`known`, in order of preference:
 * the timesheet's, then the quotes', then the invoices'): the same name without case, accents and
 * legal form («rossi srl» is «Rossi S.r.l.»), else the only known name that holds it as whole
 * words («Rossi» is «Mario Rossi Consulting»). Never the other way: «Rossi Luca» is no «Rossi».
 * Several such: none is obvious, the name said is kept and the others are said.
 */
export function matchClient(said: string, known: readonly string[]): ClientMatch {
	const key = businessKey(said);
	if (key === "") return { name: said };
	const exact = known.find((k) => businessKey(k) === key);
	if (exact !== undefined) return exact === said ? { name: said } : { name: exact, matched: true };
	const close = new Map<string, string>();
	for (const k of known) {
		const kk = businessKey(k);
		if (kk.length > key.length && keyWithin(key, kk) && !close.has(kk)) close.set(kk, k);
	}
	const found = [...close.values()];
	if (found.length === 1) return { name: found[0] as string, matched: true };
	return found.length === 0 ? { name: said } : { name: said, ambiguous: found.slice(0, 5) };
}

/**
 * An entry already recorded that `e` looks like: the same client, day and minutes. Said to the
 * person, never refused: two calls of an hour on the same day are two entries.
 */
export function lookalike(entries: readonly WorkEntry[], e: WorkEntry): string | undefined {
	return entries.find((o) => o.id !== e.id && o.date === e.date && o.minutes === e.minutes && sameClient(o.client, e.client))?.id;
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
