/**
 * What the scadenzario keeps about payment reminders (solleciti), in `invoices.json` next to the
 * paid marks (invoice-store.ts): per invoice, each reminder's level, who and when, and whether it
 * went through an approved mail (with the request's id) or the person sent it themselves; and the
 * customers' addresses the person gave. Only what the person did or said is kept: an approved
 * mail, their word, an address they wrote. Never what a file, a mail or a page says.
 */
import { createHash } from "node:crypto";
import type { Marker } from "./marker.ts";

export const REMINDER_LIMITS = {
	/** Invoices with a reminder recorded: past it, no new one (the others are never dropped). */
	invoices: 5000,
	/** Reminders recorded for one invoice. */
	perInvoice: 20,
	/** Customers with a saved address. */
	contacts: 5000,
	/** An invoice's or a customer's key, who did it, a request's id. */
	key: 300,
	by: 200,
	action: 64,
} as const;

/** 1 a polite notice, 2 a firmer one, 3 the formal one. */
export type ReminderLevel = 1 | 2 | 3;

const REMINDER_LEVELS: readonly ReminderLevel[] = [1, 2, 3];

/** One reminder: `mail` through an approved request (`action` its id), `self` sent by the person. */
export type ReminderMark = Marker & { readonly level: ReminderLevel; readonly via: "mail" | "self"; readonly action?: string };

export type ReminderEntry = { readonly invoice: string; readonly sent: readonly ReminderMark[] };

/** What to record: which invoice, at which level. */
export type ReminderItem = { readonly invoice: string; readonly level: ReminderLevel };

/** A customer's address as the person gave it; `key` is the customer's (invoices.ts partyKey). */
export type Contact = Marker & { readonly key: string; readonly email: string };

export class ReminderLimit extends Error {
	override readonly name = "ReminderLimit";
}

/** A non-empty text of at most `max` characters. */
export const isText = (v: unknown, max = Number.POSITIVE_INFINITY): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * An invoice's or a customer's key as the book keeps it: as it is up to the limit, else its sha256
 * (64 hex characters), so a long invoice number or customer name never makes the file unreadable.
 * The same key always gives the same result, and a result given again is unchanged.
 */
export function bookKey(key: string): string {
	return key.length <= REMINDER_LIMITS.key ? key : sha256(key);
}

/** Who, within the limit: a longer one keeps its start and a digest of the whole, so two stay apart. */
function bookBy(by: string): string {
	return by.length <= REMINDER_LIMITS.by ? by : `${by.slice(0, REMINDER_LIMITS.by - 17)}#${sha256(by).slice(0, 16)}`;
}

/** An instant as the store writes it (toISOString): anything else would break the days shown. */
function isInstant(v: unknown): v is string {
	return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
}

function isMark(v: unknown): v is ReminderMark {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	return isText(m.by, REMINDER_LIMITS.by) && isInstant(m.at) && REMINDER_LEVELS.includes(m.level as ReminderLevel) && (m.via === "mail" || m.via === "self") && (m.action === undefined || isText(m.action, REMINDER_LIMITS.action));
}

/** Whether the stored reminders have their shape, within the limits, one entry per invoice; absent is fine. */
export function validReminders(raw: unknown): raw is readonly ReminderEntry[] | undefined {
	if (raw === undefined) return true;
	if (!Array.isArray(raw) || raw.length > REMINDER_LIMITS.invoices) return false;
	const seen = new Set<string>();
	for (const e of raw) {
		if (typeof e !== "object" || e === null || !isText(e.invoice, REMINDER_LIMITS.key) || seen.has(e.invoice)) return false;
		if (!Array.isArray(e.sent) || e.sent.length === 0 || e.sent.length > REMINDER_LIMITS.perInvoice || !e.sent.every(isMark)) return false;
		seen.add(e.invoice);
	}
	return true;
}

/** Whether the stored addresses have their shape, within the limits, one per customer; absent is fine. */
export function validContacts(raw: unknown, isAddress: (a: string) => boolean): raw is readonly Contact[] | undefined {
	if (raw === undefined) return true;
	if (!Array.isArray(raw) || raw.length > REMINDER_LIMITS.contacts) return false;
	const seen = new Set<string>();
	for (const c of raw) {
		if (typeof c !== "object" || c === null || !isText(c.key, REMINDER_LIMITS.key) || seen.has(c.key)) return false;
		if (!isText(c.email, 254) || !isAddress(c.email) || !isText(c.by, REMINDER_LIMITS.by) || !isInstant(c.at)) return false;
		seen.add(c.key);
	}
	return true;
}

/** How a reminder was made; `dayOf` tells two self marks of the same level on the same local day apart from new ones. */
export type ReminderMade = Marker & { readonly via: "mail" | "self"; readonly action?: string; readonly dayOf?: (at: string) => string };

/**
 * The list with `items` recorded. Not recorded again: an item already recorded for the same mail
 * request (an approval told twice), or a self mark of a level already recorded that local day
 * (by the person or by an approved mail). Keys and who are kept within the limits (bookKey,
 * bookBy); ReminderLimit, and nothing changes, when a limit would be passed or the instant is not
 * one. The result always passes validReminders.
 */
export function withReminders(entries: readonly ReminderEntry[], items: readonly ReminderItem[], made: ReminderMade): { entries: readonly ReminderEntry[]; recorded: number } {
	if (!isInstant(made.at)) throw new ReminderLimit("la data del sollecito non è valida");
	if (made.action !== undefined && !isText(made.action, REMINDER_LIMITS.action)) throw new ReminderLimit("il codice della richiesta non è valido");
	const by = bookBy(made.by);
	if (by === "") throw new ReminderLimit("manca chi ha mandato il sollecito");
	const byInvoice = new Map(entries.map((e) => [e.invoice, e]));
	let recorded = 0;
	for (const item of items) {
		if (!REMINDER_LEVELS.includes(item.level) || item.invoice === "") throw new ReminderLimit("un sollecito da annotare non è valido");
		const invoice = bookKey(item.invoice);
		const before = byInvoice.get(invoice);
		const sent = before?.sent ?? [];
		if (made.action !== undefined && sent.some((m) => m.action === made.action)) continue;
		const { dayOf } = made;
		if (made.via === "self" && dayOf !== undefined && sent.some((m) => m.level === item.level && dayOf(m.at) === dayOf(made.at))) continue;
		if (before === undefined && byInvoice.size >= REMINDER_LIMITS.invoices) {
			throw new ReminderLimit(`ci sono già solleciti annotati per ${REMINDER_LIMITS.invoices} fatture, il massimo: non ne annoto altri`);
		}
		if (sent.length >= REMINDER_LIMITS.perInvoice) throw new ReminderLimit(`una fattura ha già ${REMINDER_LIMITS.perInvoice} solleciti annotati, il massimo`);
		const mark: ReminderMark = { level: item.level, by, at: made.at, via: made.via, ...(made.action === undefined ? {} : { action: made.action }) };
		byInvoice.set(invoice, { invoice, sent: [...sent, mark] });
		recorded++;
	}
	return { entries: recorded === 0 ? entries : [...byInvoice.values()], recorded };
}

/**
 * The list with `contact` saved over the customer's old address, its key and who kept within the
 * limits. ReminderLimit when the book is full or the address or instant is not valid.
 */
export function withContact(contacts: readonly Contact[], contact: Contact, isAddress: (a: string) => boolean): readonly Contact[] {
	if (!isText(contact.email, 254) || !isAddress(contact.email)) throw new ReminderLimit("l'indirizzo non è valido");
	if (!isInstant(contact.at) || contact.key === "" || contact.by === "") throw new ReminderLimit("l'indirizzo da salvare non è valido");
	const key = bookKey(contact.key);
	const others = contacts.filter((c) => c.key !== key);
	if (others.length === contacts.length && contacts.length >= REMINDER_LIMITS.contacts) {
		throw new ReminderLimit(`ci sono già ${REMINDER_LIMITS.contacts} indirizzi di clienti salvati, il massimo`);
	}
	return [...others, { key, email: contact.email, by: bookBy(contact.by), at: contact.at }];
}

/** The reminders of invoices paid in full (`paidSince`: the invoice's key in the book, when) before `cutoff`: they go. */
export function withoutPaidBefore(entries: readonly ReminderEntry[], paidSince: ReadonlyMap<string, string>, cutoff: string): readonly ReminderEntry[] {
	const kept = entries.filter((e) => {
		const at = paidSince.get(e.invoice);
		return at === undefined || at >= cutoff;
	});
	return kept.length === entries.length ? entries : kept;
}

/** The level a new reminder of an invoice gets: one past the highest recorded, at most the formal one. */
export function nextLevel(sent: readonly ReminderMark[] | undefined): ReminderLevel {
	const top = (sent ?? []).reduce((n, m) => Math.max(n, m.level), 0);
	return top >= 2 ? 3 : top === 1 ? 2 : 1;
}
