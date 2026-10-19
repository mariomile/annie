/**
 * Il personale of a small business: the people who work there (not Annie's users: HR data only),
 * their usual week, what they are entitled to (ferie in days, permessi/ROL in hours) with the
 * balance the owner said, their absences (ferie, permesso, malattia, altro), the changes to the
 * usual shifts and the extra hours the owner recorded. Days are the business's own («2026-08-03»,
 * Europe/Rome); times wall clock («15:00»), in minutes from midnight when counted. Days and hours
 * are exact: hundredths of a day, whole minutes. Health data: of a malattia only the dates and,
 * optionally, the INPS certificate's protocol number; never a diagnosis. Ids (PE-0001, AS-0001)
 * are for the model only, never said.
 */
import { type Opening, TIME, toMinutes, minutesOf } from "./appointments.ts";
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export const STAFF_LIMITS = {
	people: 200,
	absences: 20_000,
	extras: 20_000,
	shifts: 5000,
	calls: 500,
	alerts: 1000,
	name: 120,
	role: 80,
	reason: 200,
	protocol: 40,
	resource: 60,
	/** Days of one absence. */
	absenceDays: 366,
	/** Hours of a weekly contract; days of ferie, hours of permessi a year. */
	weeklyHours: 80,
	ferieDays: 60,
	rolHours: 400,
	/** Minutes of extra hours recorded on one day. */
	extraMinutes: 16 * 60,
	/** Rows shown in an answer. */
	shown: 60,
	fileBytes: 16 * 1024 * 1024,
} as const;

export const KINDS = ["ferie", "permesso", "malattia", "altro"] as const;
export type AbsenceKind = (typeof KINDS)[number];
export const KIND_WORDS: Readonly<Record<AbsenceKind, string>> = { ferie: "ferie", permesso: "permesso", malattia: "malattia", altro: "assenza" };

export const HALVES = ["mattina", "pomeriggio"] as const;
export type Half = (typeof HALVES)[number];
/** Where a half day splits: the morning ends at 13:00. */
export const NOON = 13 * 60;

export class StaffError extends Error {}

/** The usual week: by weekday, 0 (Sunday) to 6, the hours worked; a weekday absent is a day off. */
export type Week = Readonly<Record<string, readonly Opening[]>>;

/** The balance the owner said on a day (what is left then, of this year): from then on, what is used is taken from it. */
export type OpeningBalance = { readonly day: string; readonly ferie?: string; readonly rol?: string };

export type Person = Marker & {
	/** «PE-0001», never given twice; never said to the person. */
	readonly id: string;
	readonly name: string;
	readonly role?: string;
	/** Contract hours a week, a decimal («40», «37.5»). */
	readonly weeklyHours?: string;
	readonly week?: Week;
	/** A year's ferie in days and permessi/ROL in hours, decimals. */
	readonly ferieDays?: string;
	readonly rolHours?: string;
	readonly opening?: OpeningBalance;
	/** The resource of the appointments this person is: an absence blocks it. */
	readonly resource?: string;
};

export type Absence = Marker & {
	/** «AS-0001», never given twice; never said. */
	readonly id: string;
	readonly person: string;
	readonly kind: AbsenceKind;
	/** First and last day, both included; `to` absent: a malattia whose end is not said yet. */
	readonly from: string;
	readonly to?: string;
	/** Ferie of half a day (one day only). */
	readonly half?: Half;
	/** Permesso: from what time, to what time (absent: to the end of the day's shift). */
	readonly start?: string;
	readonly end?: string;
	/** Malattia: the INPS certificate's protocol number, only that. */
	readonly protocol?: string;
	/** Altro: why (lutto, congedo, 104), as said. */
	readonly reason?: string;
	readonly callId: string;
	readonly changed?: Marker & { readonly call?: string };
	readonly cancelled?: Marker & { readonly call?: string };
};

/** A day's shift said apart from the usual week: the hours (none: a day off). */
export type ShiftChange = Marker & { readonly person: string; readonly day: string; readonly hours: readonly Opening[] };

/** Extra hours the owner recorded («Marco ieri ha fatto 2 ore in più»). */
export type ExtraHours = Marker & { readonly person: string; readonly day: string; readonly minutes: number; readonly callId: string };

export type StaffSettings = Marker & {
	/** Ferie and permessi accrue month by month; absent: the whole year's at once («saldo annuo, senza maturazione mensile»). */
	readonly monthly?: true;
};

export type StaffClaim = { readonly k: string; readonly day: string; readonly call: string };

export const PERSON_ID = /^PE-(\d{4,6})$/;
export const ABSENCE_ID = /^AS-(\d{4,6})$/;
export const personId = (n: number): string => `PE-${String(n).padStart(4, "0")}`;
export const absenceId = (n: number): string => `AS-${String(n).padStart(4, "0")}`;

/** Not cancelled. */
export const isActive = (a: Absence): boolean => a.cancelled === undefined;

/** The last day an absence covers for counting, an open malattia up to `until`. */
export const lastDay = (a: Absence, until: string): string => a.to ?? (until < a.from ? a.from : until);

/** Whether two absences share a time: days, then (one day each) the hours. */
export function overlaps(a: Pick<Absence, "from" | "to" | "half" | "start" | "end">, b: Pick<Absence, "from" | "to" | "half" | "start" | "end">): boolean {
	const aTo = a.to ?? "9999-12-31";
	const bTo = b.to ?? "9999-12-31";
	if (aTo < b.from || bTo < a.from) return false;
	// Only one shared day can be told apart by the hours.
	if (a.from !== aTo || b.from !== bTo) return true;
	const sa = spanOf(a);
	const sb = spanOf(b);
	return sa.from < sb.to && sb.from < sa.to;
}

/** The time of one day an absence takes, wall clock in minutes. */
export function spanOf(a: Pick<Absence, "half" | "start" | "end">): { readonly from: number; readonly to: number } {
	if (a.half === "mattina") return { from: 0, to: NOON };
	if (a.half === "pomeriggio") return { from: NOON, to: 24 * 60 };
	if (a.start !== undefined) return { from: minutesOf(a.start), to: a.end === undefined ? 24 * 60 : toMinutes(a.end) };
	return { from: 0, to: 24 * 60 };
}

/** A decimal in hundredths («22.5» → 2250); exact. */
export function hundredths(decimal: string): number {
	const [whole, frac = ""] = decimal.split(".");
	return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

/** Hundredths as a decimal: «22,5» with the comma, as said to the person. */
export function decimalWords(h: number): string {
	const sign = h < 0 ? "-" : "";
	const a = Math.abs(h);
	const frac = String(a % 100).padStart(2, "0").replace(/0+$/, "");
	return `${sign}${Math.floor(a / 100)}${frac === "" ? "" : `,${frac}`}`;
}

/** Minutes as hours: «7,5», «2», «0,25»; to the hundredth, half up, when not exact. */
export function hoursWords(minutes: number): string {
	const sign = minutes < 0 ? -1 : 1;
	return decimalWords(sign * Math.floor((Math.abs(minutes) * 200 + 60) / 120));
}

/** The calls that only read: allowed in the brief's thread (who compact marks what the brief said, once a day). */
const READ_OPS = ["who", "shifts", "balance", "absences", "summary"] as const;
export function staffCallReads(args: Record<string, unknown>): boolean {
	return READ_OPS.some((o) => o === args.op);
}

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v);
const plain = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);
const DECIMAL = /^\d{1,4}(?:\.\d{1,2})?$/;
const decimalUpTo = (v: unknown, max: number) => typeof v === "string" && DECIMAL.test(v) && Number(v) <= max;
export const PROTOCOL = /^[A-Za-z0-9][A-Za-z0-9/-]{3,39}$/;

function validOpening(v: unknown): v is Opening {
	if (typeof v !== "object" || v === null || !Object.keys(v).every((k) => k === "from" || k === "to")) return false;
	const o = v as Opening;
	return typeof o.from === "string" && TIME.test(o.from) && typeof o.to === "string" && (TIME.test(o.to) || o.to === "24:00") && minutesOf(o.from) < toMinutes(o.to);
}

const validHours = (list: unknown): boolean => {
	if (!Array.isArray(list) || list.length > 4 || !list.every(validOpening)) return false;
	for (let i = 1; i < list.length; i++) if (minutesOf((list[i] as Opening).from) < toMinutes((list[i - 1] as Opening).to)) return false;
	return true;
};

export function validWeek(v: unknown): v is Week {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	return Object.entries(v).every(([d, list]) => /^[0-6]$/.test(d) && validHours(list) && (list as unknown[]).length > 0);
}

export function validPerson(v: unknown): v is Person {
	if (typeof v !== "object" || v === null || !isMarker(v)) return false;
	const p = v as Person;
	if (!Object.keys(p).every((k) => ["id", "name", "role", "weeklyHours", "week", "ferieDays", "rolHours", "opening", "resource", "by", "at"].includes(k))) return false;
	if (typeof p.id !== "string" || !PERSON_ID.test(p.id) || !plain(p.name, STAFF_LIMITS.name)) return false;
	if (p.role !== undefined && !plain(p.role, STAFF_LIMITS.role)) return false;
	if (p.weeklyHours !== undefined && !decimalUpTo(p.weeklyHours, STAFF_LIMITS.weeklyHours)) return false;
	if (p.week !== undefined && !validWeek(p.week)) return false;
	if (p.ferieDays !== undefined && !decimalUpTo(p.ferieDays, STAFF_LIMITS.ferieDays)) return false;
	if (p.rolHours !== undefined && !decimalUpTo(p.rolHours, STAFF_LIMITS.rolHours)) return false;
	if (p.opening !== undefined) {
		const o = p.opening;
		if (typeof o !== "object" || o === null || !Object.keys(o).every((k) => ["day", "ferie", "rol"].includes(k)) || !isDay(o.day)) return false;
		if (o.ferie !== undefined && !decimalUpTo(o.ferie, STAFF_LIMITS.ferieDays * 3)) return false;
		if (o.rol !== undefined && !decimalUpTo(o.rol, STAFF_LIMITS.rolHours * 3)) return false;
	}
	if (p.resource !== undefined && !plain(p.resource, STAFF_LIMITS.resource)) return false;
	return true;
}

export function validAbsence(v: unknown): v is Absence {
	if (typeof v !== "object" || v === null || !isMarker(v)) return false;
	const a = v as Absence;
	if (!Object.keys(a).every((k) => ["id", "person", "kind", "from", "to", "half", "start", "end", "protocol", "reason", "callId", "changed", "cancelled", "by", "at"].includes(k))) return false;
	if (typeof a.id !== "string" || !ABSENCE_ID.test(a.id) || typeof a.person !== "string" || !PERSON_ID.test(a.person) || !KINDS.includes(a.kind)) return false;
	if (!isDay(a.from) || (a.to !== undefined && (!isDay(a.to) || a.to < a.from))) return false;
	// Only a malattia may be open-ended.
	if (a.to === undefined && a.kind !== "malattia") return false;
	if (a.half !== undefined && (a.kind !== "ferie" || !HALVES.includes(a.half) || a.to !== a.from)) return false;
	if (a.kind === "permesso") {
		if (a.to !== a.from || typeof a.start !== "string" || !TIME.test(a.start)) return false;
		if (a.end !== undefined && (typeof a.end !== "string" || !(TIME.test(a.end) || a.end === "24:00") || toMinutes(a.end) <= minutesOf(a.start))) return false;
	} else if (a.start !== undefined || a.end !== undefined) return false;
	// Health data: of a malattia only the protocol; a reason only for «altro».
	if (a.protocol !== undefined && (a.kind !== "malattia" || typeof a.protocol !== "string" || !PROTOCOL.test(a.protocol))) return false;
	if (a.reason !== undefined && (a.kind !== "altro" || !plain(a.reason, STAFF_LIMITS.reason))) return false;
	if (!isText(a.callId, 300)) return false;
	if (a.changed !== undefined && (!isMarker(a.changed) || !optText(a.changed.call, 300))) return false;
	if (a.cancelled !== undefined && (!isMarker(a.cancelled) || !optText(a.cancelled.call, 300))) return false;
	return true;
}

export const validShiftChange = (v: unknown): v is ShiftChange => {
	if (typeof v !== "object" || v === null || !isMarker(v)) return false;
	const s = v as ShiftChange;
	return Object.keys(s).every((k) => ["person", "day", "hours", "by", "at"].includes(k)) && typeof s.person === "string" && PERSON_ID.test(s.person) && isDay(s.day) && validHours(s.hours);
};

export const validExtra = (v: unknown): v is ExtraHours => {
	if (typeof v !== "object" || v === null || !isMarker(v)) return false;
	const e = v as ExtraHours;
	return Object.keys(e).every((k) => ["person", "day", "minutes", "callId", "by", "at"].includes(k)) && typeof e.person === "string" && PERSON_ID.test(e.person) && isDay(e.day) && Number.isInteger(e.minutes) && e.minutes > 0 && e.minutes <= STAFF_LIMITS.extraMinutes && isText(e.callId, 300);
};

export const validStaffSettings = (v: unknown): v is StaffSettings => typeof v === "object" && v !== null && isMarker(v) && Object.keys(v).every((k) => ["monthly", "by", "at"].includes(k)) && ((v as StaffSettings).monthly === undefined || (v as StaffSettings).monthly === true);

export const validStaffClaim = (v: unknown): v is StaffClaim => typeof v === "object" && v !== null && isText((v as StaffClaim).k, 80) && isDay((v as StaffClaim).day) && isText((v as StaffClaim).call, 300);
