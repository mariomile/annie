/**
 * I clienti: one card per client with only what the person said (how they write the name, the
 * partita IVA or codice fiscale, other names, the referenti with role, phone, email and preferred
 * channel, the address, labels, dated notes, the ricontatti to do and the contacts had). Everything else Owni knows
 * about a client (invoices, solleciti, quotes, hours) stays in its own register and is read, never
 * copied here: a client seen in those registers is a client even without a card. Kept per
 * instance in `clients.json` (client-store.ts); the reading of the registers in client-sums.ts.
 */
import { validAddress } from "./email-address.ts";
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { spellingKey } from "./name-keys.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";
import { checkCodiceFiscale, checkVatNumber } from "./tax-ids.ts";
import { fold } from "./text-match.ts";

export class ClientError extends Error {
	override readonly name = "ClientError";
}

export const CLIENT_LIMITS = {
	cards: 5000,
	notes: 50,
	noteChars: 1000,
	contacts: 10,
	aliases: 10,
	tags: 10,
	tagChars: 40,
	/** Ricontatti kept per card: the oldest done ones go first past it. */
	followUps: 50,
	followUpChars: 300,
	/** Contacts had kept per card: the oldest go first past it. */
	log: 100,
	name: 120,
	role: 60,
	address: 200,
	phone: 30,
	email: 254,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 500,
	fileBytes: 16 * 1024 * 1024,
} as const;

/** Days without activity after which a client is «dormiente», by default. */
export const DORMANT_DAYS = 90;
/** A dormant client must have been invoiced within these days. */
export const DORMANT_INVOICED_DAYS = 730;
/** One client above this share of what is invoiced is a concentration to say. */
export const CONCENTRATION_PERCENT = 40n;
/** The brief says a concentration when it crossed the threshold within these days (on the last 365). */
export const CONCENTRATION_BRIEF_DAYS = 30;
export const CONCENTRATION_SPAN_DAYS = 365;
/** The hour of the day a ricontatto's reminder is sent, where the instance is. */
export const FOLLOW_UP_HOUR = 9;
/** How far ahead a ricontatto may be set, in days. */
export const FOLLOW_UP_MAX_DAYS = 2 * 366;

/** The ops that only read: they run in the brief. */
const CLIENT_READ_OPS = ["show", "list", "top", "dormant", "agenda"] as const;

export function clientCallReads(args: Record<string, unknown>): boolean {
	return CLIENT_READ_OPS.some((o) => o === args.op);
}

/**
 * What another agente may ask: totals, counts and shares, never the person's data nor a client's
 * name. The ranking and the clients not heard from (the tool cuts them to numbers); never a card,
 * a list, the brief's line, the agenda of ricontatti, nor a write.
 */
export function clientAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "top" || args.op === "dormant";
}

export const CHANNELS = ["telefono", "whatsapp", "email", "pec", "telegram", "di persona"] as const;
export type Channel = (typeof CHANNELS)[number];

/** A referente as the person said it: at least one of name, phone and email. */
export type ClientContact = {
	readonly name?: string;
	readonly role?: string;
	readonly phone?: string;
	readonly email?: string;
	readonly channel?: Channel;
};

export type ClientNote = Marker & {
	/** ISO day it was said. */
	readonly date: string;
	readonly text: string;
};

/** A ricontatto: the day, what to do, done or not, and the reminder made for it. */
export type FollowUp = Marker & {
	/** «FU-0001», never used again. */
	readonly id: string;
	readonly date: string;
	readonly text?: string;
	readonly done?: Marker;
	/** The call that marked it done: a call run again finds it. */
	readonly doneCall?: string;
	/** The task programmato that reminds the person (schedules.ts), and the key it was made with: only that task is ever removed. */
	readonly scheduleId?: string;
	readonly scheduleCall?: string;
	/** The call that made it: a call run again finds it. */
	readonly callId?: string;
};

/** A contact had with the client (a call, a meeting): the day, how it went, the ricontatto it left. */
export type ContactEntry = Marker & {
	readonly date: string;
	readonly note?: string;
	/** The ricontatto it marked done, or the one it fixed next. */
	readonly done?: string;
	readonly next?: string;
};

export type ClientCard = Marker & {
	/** «CL-0001», never used again. */
	readonly id: string;
	/** The name as the person writes it. */
	readonly name: string;
	/** «IT01234567897», or a foreign VAT number with its prefix. */
	readonly vat?: string;
	readonly cf?: string;
	readonly aliases: readonly string[];
	readonly contacts: readonly ClientContact[];
	readonly address?: string;
	readonly tags: readonly string[];
	readonly notes: readonly ClientNote[];
	readonly followUps: readonly FollowUp[];
	/** The contacts had, oldest first: they count as activity (a note does not). */
	readonly log?: readonly ContactEntry[];
	readonly edited?: Marker;
};

export const cardId = (n: number) => `CL-${String(n).padStart(4, "0")}`;
export const followUpId = (n: number) => `FU-${String(n).padStart(4, "0")}`;
export const CARD_ID = /^CL-(\d{4,6})$/;
export const FOLLOW_UP_ID = /^FU-(\d{4,6})$/;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Digits, spaces and at most a + in front, as the company's phone (invoice-company.ts). */
const PHONE = /^\+?[\d\s./()-]{6,30}$/;

const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && realDate(v);

/** What is wrong with a phone number as said, or undefined. */
export function phoneProblem(text: string): string | undefined {
	if (!PHONE.test(text) || (text.match(/\d/g) ?? []).length < 6) return "il numero di telefono ha cifre, spazi e al più un + davanti";
	return undefined;
}

/** What is wrong with an email address, or undefined (email-address.ts, the same check as the solleciti). */
export function emailProblem(text: string): string | undefined {
	return validAddress(text) ? undefined : "l'indirizzo email non è valido";
}

/** A partita IVA or a foreign VAT number as kept: «IT» and 11 digits for an Italian one. A problem otherwise. */
export function cardVat(text: string): { readonly vat: string } | { readonly problem: string } {
	const checked = checkVatNumber(text);
	if (checked === undefined) return { problem: "questo sembra un codice fiscale di una persona, non una partita IVA" };
	if ("problem" in checked) return { problem: `la partita IVA non va: ${checked.problem}` };
	return { vat: /^\d{11}$/.test(checked.number) ? `IT${checked.number}` : checked.number };
}

/** A codice fiscale as kept: a person's (16 characters, checked) or a body's (11 digits). A problem otherwise. */
export function cardCf(text: string): { readonly cf: string } | { readonly problem: string } {
	const compact = text.replace(/[\s.\-/]/g, "").toUpperCase();
	if (/^\d{11}$/.test(compact)) {
		const v = cardVat(compact);
		return "problem" in v ? { problem: v.problem.replace("la partita IVA", "il codice fiscale") } : { cf: compact };
	}
	const checked = checkCodiceFiscale(compact);
	return "problem" in checked ? { problem: `il codice fiscale non va: ${checked.problem}` } : { cf: checked.code };
}

/** A VAT number from a register (an invoice's party, a quote's customer) compared the card's way; undefined when it does not read. */
export function vatKey(text: string | undefined): string | undefined {
	if (text === undefined || text.trim() === "") return undefined;
	const v = cardVat(text);
	if ("vat" in v) return v.vat;
	// A number a file writes with a wrong check digit is still how that file names its party.
	const compact = text.replace(/[\s.\-/]/g, "").toUpperCase();
	if (/^\d{11}$/.test(compact)) return `IT${compact}`;
	return /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(compact) ? compact : undefined;
}

/** Whether a partita IVA passes the checks, as a card keeps it. */
export function goodVat(vat: string): boolean {
	const v = cardVat(vat);
	return "vat" in v && v.vat === vat;
}

/** The channel a person names: «WhatsApp», «al telefono», «per mail». */
export function channelOf(text: string): Channel | undefined {
	const t = fold(text).trim();
	if (/\bwhats ?app\b|\bwa\b/.test(t)) return "whatsapp";
	if (/\bpec\b/.test(t)) return "pec";
	if (/\be-?mail\b|\bmail\b|\bposta\b/.test(t)) return "email";
	if (/\btelegram\b/.test(t)) return "telegram";
	if (/\bdi persona\b|\bdal vivo\b|\bin presenza\b/.test(t)) return "di persona";
	if (/\btelefon|\bchiamat|\bcellulare\b|\bsms\b/.test(t)) return "telefono";
	return undefined;
}

/** A label as kept: lower case, single spaces. */
export function tagOf(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

const plainText = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);

/** A referente as stored (the suppliers keep theirs the same way). */
export function validContact(v: unknown): v is ClientContact {
	if (typeof v !== "object" || v === null) return false;
	const c = v as ClientContact;
	for (const key of Object.keys(c)) if (!["name", "role", "phone", "email", "channel"].includes(key)) return false;
	if (c.name === undefined && c.phone === undefined && c.email === undefined) return false;
	if (c.name !== undefined && !plainText(c.name, CLIENT_LIMITS.name)) return false;
	if (c.role !== undefined && !plainText(c.role, CLIENT_LIMITS.role)) return false;
	if (c.phone !== undefined && (!plainText(c.phone, CLIENT_LIMITS.phone) || phoneProblem(c.phone) !== undefined)) return false;
	if (c.email !== undefined && (!plainText(c.email, CLIENT_LIMITS.email) || emailProblem(c.email) !== undefined)) return false;
	return c.channel === undefined || CHANNELS.includes(c.channel);
}

/** A dated note as stored (the suppliers keep theirs the same way). */
export function validNote(v: unknown): v is ClientNote {
	if (!isMarker(v)) return false;
	const n = v as ClientNote;
	return isDay(n.date) && isText(n.text, CLIENT_LIMITS.noteChars);
}

function validFollowUp(v: unknown): v is FollowUp {
	if (!isMarker(v)) return false;
	const f = v as FollowUp;
	if (typeof f.id !== "string" || !FOLLOW_UP_ID.test(f.id) || !isDay(f.date)) return false;
	if (f.text !== undefined && !isText(f.text, CLIENT_LIMITS.followUpChars)) return false;
	if (f.done !== undefined && !isMarker(f.done)) return false;
	return optText(f.scheduleId, 40) && optText(f.scheduleCall, 240) && optText(f.callId, 200) && optText(f.doneCall, 200) && (f.doneCall === undefined || f.done !== undefined);
}

function validEntry(v: unknown): v is ContactEntry {
	if (!isMarker(v)) return false;
	const e = v as ContactEntry;
	if (!isDay(e.date) || (e.note !== undefined && !isText(e.note, CLIENT_LIMITS.noteChars))) return false;
	return [e.done, e.next].every((id) => id === undefined || (typeof id === "string" && FOLLOW_UP_ID.test(id)));
}

/** A card as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validCard(v: unknown): v is ClientCard {
	if (!isMarker(v)) return false;
	const c = v as ClientCard;
	if (typeof c.id !== "string" || !CARD_ID.test(c.id) || !plainText(c.name, CLIENT_LIMITS.name) || spellingKey(c.name) === "") return false;
	if (c.vat !== undefined && (typeof c.vat !== "string" || !goodVat(c.vat))) return false;
	if (c.cf !== undefined && (typeof c.cf !== "string" || !("cf" in cardCf(c.cf)))) return false;
	if (!Array.isArray(c.aliases) || c.aliases.length > CLIENT_LIMITS.aliases || !c.aliases.every((a) => plainText(a, CLIENT_LIMITS.name))) return false;
	if (!Array.isArray(c.contacts) || c.contacts.length > CLIENT_LIMITS.contacts || !c.contacts.every(validContact)) return false;
	if (c.address !== undefined && !plainText(c.address, CLIENT_LIMITS.address)) return false;
	if (!Array.isArray(c.tags) || c.tags.length > CLIENT_LIMITS.tags || !c.tags.every((t) => plainText(t, CLIENT_LIMITS.tagChars))) return false;
	if (!Array.isArray(c.notes) || c.notes.length > CLIENT_LIMITS.notes || !c.notes.every(validNote)) return false;
	if (!Array.isArray(c.followUps) || c.followUps.length > CLIENT_LIMITS.followUps || !c.followUps.every(validFollowUp)) return false;
	if (c.log !== undefined && (!Array.isArray(c.log) || c.log.length > CLIENT_LIMITS.log || !c.log.every(validEntry))) return false;
	return c.edited === undefined || isMarker(c.edited);
}

export const validCall = (v: unknown): boolean => isText(v, 200);
