/**
 * Gli appuntamenti of a service business (parrucchiere, estetista, studio, officina): who comes,
 * for which services, on which day and at what time, how long, with which resource (a person, a
 * chair, a lift), and how it went (fissato, fatto, disdetto, non presentato). Times are wall-clock
 * times of the business's own day («09:30»), in minutes from midnight when counted: an appointment
 * never crosses midnight, so the summer-time changes (at night) never move one. The settings say
 * when the business is open (by weekday, with breaks), when it is closed (a range of days, the
 * national holidays), the slot step, the resources, and how long each service lasts (linked to
 * the voce of the listino that prices it). Ids (AP-0001) are for the model only, never said.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export const APPOINTMENT_LIMITS = {
	appointments: 20_000,
	calls: 500,
	alerts: 1000,
	name: 200,
	service: 120,
	services: 10,
	notes: 500,
	resources: 30,
	resource: 60,
	/** Services known with their duration. */
	known: 300,
	closures: 200,
	/** Minutes of one appointment, and of one service. */
	minutes: 12 * 60,
	business: 120,
	/** Rows shown in an answer. */
	shown: 40,
	/** Free slots proposed in place of a conflict. */
	proposals: 3,
	/** Days looked ahead for a free slot. */
	ahead: 14,
	fileBytes: 16 * 1024 * 1024,
} as const;

/** A service said that is not known: its duration is taken as this, and said. */
export const DEFAULT_MINUTES = 30;
export const DEFAULT_SLOT = 15;
export const SLOTS = [5, 10, 15, 20, 30, 60] as const;

export const STATUSES = ["booked", "done", "cancelled", "no_show"] as const;
export type AppointmentStatus = (typeof STATUSES)[number];
export const STATUS_WORDS: Readonly<Record<AppointmentStatus, string>> = { booked: "fissato", done: "fatto", cancelled: "disdetto", no_show: "non presentato" };

export class AppointmentError extends Error {}

/** The client: a card of the clients (card), or a name as said; `greeting`, how the person named them with a title («signora Rossi»), for the messages. */
export type AppointmentClient = { readonly name: string; readonly card?: string; readonly greeting?: string };

/** A service of the appointment: its name, the voce of the listino that prices it, how long. */
export type BookedService = { readonly name: string; readonly item?: string; readonly minutes: number };

/** The invoice that billed it, once issued. */
export type AppointmentBilled = { readonly invoice: string; readonly number: string; readonly day: string };

export type Appointment = Marker & {
	/** «AP-0001», never given twice; never said to the person. */
	readonly id: string;
	readonly status: AppointmentStatus;
	readonly client: AppointmentClient;
	readonly services: readonly BookedService[];
	/** The day and the wall-clock start, «HH:MM». */
	readonly day: string;
	readonly start: string;
	/** All its services together. */
	readonly minutes: number;
	readonly resource?: string;
	readonly notes?: string;
	/** The call that booked it: a call run again finds it. */
	readonly callId: string;
	/** Moved: when, by whom, from where, and the call that moved it (a call run again finds it). */
	readonly moved?: Marker & { readonly from: string; readonly call?: string };
	/** How it went (fatto, disdetto, non presentato): when, by whom, and the call. */
	readonly closed?: Marker & { readonly call?: string };
	readonly billed?: AppointmentBilled;
};

/** Opening of a weekday: from and to, wall clock. Breaks are the gaps between two. */
export type Opening = { readonly from: string; readonly to: string };

/** Closed from one day to another (holidays, a course): both included. */
export type Closure = { readonly from: string; readonly to: string; readonly note?: string };

/** A service with its duration: the voce of the listino (item) or a name, and which resources may do it. */
export type KnownService = { readonly name: string; readonly item?: string; readonly minutes: number; readonly needs?: readonly string[] };

export type AppointmentSettings = Marker & {
	/** The business's name, for the reminders. */
	readonly business?: string;
	/** By weekday, 0 (Sunday) to 6: the openings; a weekday absent is closed. Absent: hours not known. */
	readonly week?: Readonly<Record<string, readonly Opening[]>>;
	readonly closures?: readonly Closure[];
	/** Open on the national holidays (default: closed). */
	readonly holidaysOpen?: true;
	readonly slot?: number;
	readonly resources?: readonly string[];
	readonly services?: readonly KnownService[];
};

/** What the brief said: a key a day. */
export type AppointmentClaim = { readonly k: string; readonly day: string; readonly call: string };

export const APPOINTMENT_ID = /^AP-(\d{4,6})$/;
export const appointmentId = (n: number): string => `AP-${String(n).padStart(4, "0")}`;

export const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** «09:30» in minutes from midnight. */
export const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Minutes from midnight as «09:30». */
export const timeOf = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** The end, wall clock: «10:15». */
/** A time as said to the person: «15», «9:30». */
export const clockOf = (m: number): string => (m % 60 === 0 ? String(m / 60) : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);

export const endOf = (a: Pick<Appointment, "start" | "minutes">): string => timeOf(minutesOf(a.start) + a.minutes);

/** Booked or done: it takes its time. Disdetto and non presentato free it. */
export const takesTime = (a: Pick<Appointment, "status">): boolean => a.status === "booked" || a.status === "done";

const READ_OPS = ["agenda", "free_slots", "history", "reminders"] as const;

/** The calls that only read: allowed in the brief's thread (agenda compact marks what the brief said, once a day). The export writes a file. */
export function appointmentCallReads(args: Record<string, unknown>): boolean {
	return READ_OPS.some((o) => o === args.op);
}

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v);
const plain = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);
const minutes = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 5 && v <= APPOINTMENT_LIMITS.minutes;
const ITEM = /^LS-\d{4,6}$/;

function validService(v: unknown): v is BookedService {
	if (typeof v !== "object" || v === null) return false;
	const s = v as BookedService;
	return Object.keys(s).every((k) => ["name", "item", "minutes"].includes(k)) && plain(s.name, APPOINTMENT_LIMITS.service) && (s.item === undefined || (typeof s.item === "string" && ITEM.test(s.item))) && minutes(s.minutes);
}

export function validAppointment(v: unknown): v is Appointment {
	if (typeof v !== "object" || v === null || !isMarker(v)) return false;
	const a = v as Appointment;
	const keys = ["id", "status", "client", "services", "day", "start", "minutes", "resource", "notes", "callId", "moved", "closed", "billed", "by", "at"];
	if (!Object.keys(a).every((k) => keys.includes(k))) return false;
	if (typeof a.id !== "string" || !APPOINTMENT_ID.test(a.id) || !STATUSES.includes(a.status)) return false;
	const c = a.client as AppointmentClient | undefined;
	if (typeof c !== "object" || c === null || !Object.keys(c).every((k) => k === "name" || k === "card" || k === "greeting") || !plain(c.name, APPOINTMENT_LIMITS.name) || (c.greeting !== undefined && !plain(c.greeting, APPOINTMENT_LIMITS.name)) || (c.card !== undefined && (typeof c.card !== "string" || !/^CL-\d{4,6}$/.test(c.card)))) return false;
	if (!Array.isArray(a.services) || a.services.length === 0 || a.services.length > APPOINTMENT_LIMITS.services || !a.services.every(validService)) return false;
	if (!isDay(a.day) || typeof a.start !== "string" || !TIME.test(a.start) || !minutes(a.minutes)) return false;
	// It never crosses midnight; its services make up its time.
	if (minutesOf(a.start) + a.minutes > 24 * 60 || a.services.reduce((n, s) => n + s.minutes, 0) !== a.minutes) return false;
	if (a.resource !== undefined && !plain(a.resource, APPOINTMENT_LIMITS.resource)) return false;
	if (!optText(a.notes, APPOINTMENT_LIMITS.notes) || !isText(a.callId, 200)) return false;
	if (a.moved !== undefined && (!isMarker(a.moved) || typeof a.moved.from !== "string" || !/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(a.moved.from) || !optText(a.moved.call, 200))) return false;
	if (a.closed !== undefined && (!isMarker(a.closed) || !optText(a.closed.call, 200))) return false;
	if ((a.status === "booked") !== (a.closed === undefined)) return false;
	if (a.billed !== undefined && (a.status !== "done" || !validBilled(a.billed))) return false;
	return true;
}

function validBilled(b: unknown): b is AppointmentBilled {
	if (typeof b !== "object" || b === null) return false;
	const x = b as AppointmentBilled;
	return Object.keys(x).every((k) => ["invoice", "number", "day"].includes(k)) && typeof x.invoice === "string" && /^BZ-\d{4,6}$/.test(x.invoice) && plain(x.number, 30) && isDay(x.day);
}

/** «24:00» too, for an opening to midnight. */
export const toMinutes = (t: string): number => (t === "24:00" ? 24 * 60 : minutesOf(t));

function validOpening(v: unknown): v is Opening {
	if (typeof v !== "object" || v === null || !Object.keys(v).every((k) => k === "from" || k === "to")) return false;
	const o = v as Opening;
	return typeof o.from === "string" && TIME.test(o.from) && typeof o.to === "string" && (TIME.test(o.to) || o.to === "24:00") && minutesOf(o.from) < toMinutes(o.to);
}

export function validSettings(v: unknown): v is AppointmentSettings {
	if (typeof v !== "object" || v === null || !isMarker(v)) return false;
	const s = v as AppointmentSettings;
	if (!Object.keys(s).every((k) => ["business", "week", "closures", "holidaysOpen", "slot", "resources", "services", "by", "at"].includes(k))) return false;
	if (s.business !== undefined && !plain(s.business, APPOINTMENT_LIMITS.business)) return false;
	if (s.week !== undefined) {
		if (typeof s.week !== "object" || s.week === null || Array.isArray(s.week)) return false;
		for (const [d, list] of Object.entries(s.week)) {
			if (!/^[0-6]$/.test(d) || !Array.isArray(list) || list.length > 4 || !list.every(validOpening)) return false;
			// In order, not overlapping.
			for (let i = 1; i < list.length; i++) if (minutesOf((list[i] as Opening).from) < toMinutes((list[i - 1] as Opening).to)) return false;
		}
	}
	if (s.closures !== undefined && (!Array.isArray(s.closures) || s.closures.length > APPOINTMENT_LIMITS.closures || !s.closures.every((c) => typeof c === "object" && c !== null && isDay(c.from) && isDay(c.to) && c.from <= c.to && optText(c.note, 120)))) return false;
	if (s.holidaysOpen !== undefined && s.holidaysOpen !== true) return false;
	if (s.slot !== undefined && !SLOTS.includes(s.slot as (typeof SLOTS)[number])) return false;
	if (s.resources !== undefined && (!Array.isArray(s.resources) || s.resources.length > APPOINTMENT_LIMITS.resources || !s.resources.every((r) => plain(r, APPOINTMENT_LIMITS.resource)) || new Set(s.resources.map((r) => r.toLowerCase())).size !== s.resources.length)) return false;
	if (s.services !== undefined) {
		if (!Array.isArray(s.services) || s.services.length > APPOINTMENT_LIMITS.known) return false;
		for (const k of s.services) {
			if (typeof k !== "object" || k === null || !Object.keys(k).every((x) => ["name", "item", "minutes", "needs"].includes(x))) return false;
			if (!plain(k.name, APPOINTMENT_LIMITS.service) || (k.item !== undefined && (typeof k.item !== "string" || !ITEM.test(k.item))) || !minutes(k.minutes)) return false;
			if (k.needs !== undefined && (!Array.isArray(k.needs) || k.needs.length === 0 || !(k.needs as unknown[]).every((r) => typeof r === "string" && (s.resources ?? []).includes(r)))) return false;
		}
	}
	return true;
}

export const validClaim = (v: unknown): v is AppointmentClaim => typeof v === "object" && v !== null && isText((v as AppointmentClaim).k, 80) && isDay((v as AppointmentClaim).day) && isText((v as AppointmentClaim).call, 200);
