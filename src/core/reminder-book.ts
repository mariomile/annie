/**
 * What the scadenzario keeps about payment reminders (solleciti), in `invoices.json` next to the
 * paid marks (invoice-store.ts): per invoice, each reminder's level, who and when, and whether it
 * went through an approved mail (with the request's id) or the person sent it themselves; and the
 * customers' addresses the person gave. Only what the person did or said is kept: an approved
 * mail, their word, an address they wrote. Never what a file, a mail or a page says.
 */
import type { Marker } from "./invoices.ts";

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

export const REMINDER_LEVELS: readonly ReminderLevel[] = [1, 2, 3];

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

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** An instant as the store writes it (toISOString): anything else would break the days shown. */
export function isInstant(v: unknown): v is string {
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
 * request (an approval told twice), or a self mark of the same level on the same day. ReminderLimit,
 * and nothing changes, when a limit would be passed.
 */
export function withReminders(entries: readonly ReminderEntry[], items: readonly ReminderItem[], made: ReminderMade): { entries: readonly ReminderEntry[]; recorded: number } {
	const byInvoice = new Map(entries.map((e) => [e.invoice, e]));
	let recorded = 0;
	for (const item of items) {
		const before = byInvoice.get(item.invoice);
		const sent = before?.sent ?? [];
		if (made.action !== undefined && sent.some((m) => m.action === made.action)) continue;
		const { dayOf } = made;
		if (made.via === "self" && dayOf !== undefined && sent.some((m) => m.via === "self" && m.level === item.level && dayOf(m.at) === dayOf(made.at))) continue;
		if (before === undefined && byInvoice.size >= REMINDER_LIMITS.invoices) {
			throw new ReminderLimit(`ci sono già solleciti annotati per ${REMINDER_LIMITS.invoices} fatture, il massimo: non ne annoto altri`);
		}
		if (sent.length >= REMINDER_LIMITS.perInvoice) throw new ReminderLimit(`una fattura ha già ${REMINDER_LIMITS.perInvoice} solleciti annotati, il massimo`);
		const mark: ReminderMark = { level: item.level, by: made.by, at: made.at, via: made.via, ...(made.action === undefined ? {} : { action: made.action }) };
		byInvoice.set(item.invoice, { invoice: item.invoice, sent: [...sent, mark] });
		recorded++;
	}
	return { entries: recorded === 0 ? entries : [...byInvoice.values()], recorded };
}

/** The list with `contact` saved over the customer's old address. ReminderLimit when the book is full. */
export function withContact(contacts: readonly Contact[], contact: Contact): readonly Contact[] {
	const others = contacts.filter((c) => c.key !== contact.key);
	if (others.length === contacts.length && contacts.length >= REMINDER_LIMITS.contacts) {
		throw new ReminderLimit(`ci sono già ${REMINDER_LIMITS.contacts} indirizzi di clienti salvati, il massimo`);
	}
	return [...others, contact];
}

/** The level a new reminder of an invoice gets: one past the highest recorded, at most the formal one. */
export function nextLevel(sent: readonly ReminderMark[] | undefined): ReminderLevel {
	const top = (sent ?? []).reduce((n, m) => Math.max(n, m.level), 0);
	return top >= 2 ? 3 : top === 1 ? 2 : 1;
}
