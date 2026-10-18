/**
 * The payment reminders (solleciti) recorded for the scadenzario, kept in `invoices.json` next to
 * the paid marks (invoices.ts): per invoice, each reminder's level, who and when, and whether it
 * went through an approved mail (with the request's id) or the person sent it themselves. Only
 * what the person did is recorded: an approved mail, or their word.
 */
import type { Marker } from "./invoices.ts";

export const REMINDER_LIMITS = {
	/** Invoices with a reminder recorded: past it, no new one (the others are never dropped). */
	invoices: 5000,
	/** Reminders recorded for one invoice. */
	perInvoice: 20,
} as const;

/** 1 a polite notice, 2 a firmer one, 3 the formal one. */
export type ReminderLevel = 1 | 2 | 3;

export const REMINDER_LEVELS: readonly ReminderLevel[] = [1, 2, 3];

/** One reminder: `mail` through an approved request (`action` its id), `self` sent by the person. */
export type ReminderMark = Marker & { readonly level: ReminderLevel; readonly via: "mail" | "self"; readonly action?: string };

export type ReminderEntry = { readonly invoice: string; readonly sent: readonly ReminderMark[] };

/** What to record: which invoice, at which level. */
export type ReminderItem = { readonly invoice: string; readonly level: ReminderLevel };

export class ReminderLimit extends Error {
	override readonly name = "ReminderLimit";
}

const isText = (v: unknown): v is string => typeof v === "string";

function isMark(v: unknown): v is ReminderMark {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	return isText(m.by) && isText(m.at) && REMINDER_LEVELS.includes(m.level as ReminderLevel) && (m.via === "mail" || m.via === "self") && (m.action === undefined || isText(m.action));
}

/** Whether the stored list has the shape it should; undefined (absent) is fine. */
export function validReminders(raw: unknown): raw is readonly ReminderEntry[] | undefined {
	if (raw === undefined) return true;
	if (!Array.isArray(raw)) return false;
	return raw.every((e) => typeof e === "object" && e !== null && isText(e.invoice) && Array.isArray(e.sent) && e.sent.every(isMark));
}

/**
 * The list with `items` recorded. An item already recorded for the same mail request is not
 * recorded again, so an approval told twice counts once. ReminderLimit, and nothing changes, when
 * a limit would be passed.
 */
export function withReminders(
	entries: readonly ReminderEntry[],
	items: readonly ReminderItem[],
	made: Marker & { readonly via: "mail" | "self"; readonly action?: string },
): { entries: readonly ReminderEntry[]; recorded: number } {
	const byInvoice = new Map(entries.map((e) => [e.invoice, e]));
	let recorded = 0;
	for (const item of items) {
		const before = byInvoice.get(item.invoice);
		if (made.action !== undefined && before?.sent.some((m) => m.action === made.action)) continue;
		if (before === undefined && byInvoice.size >= REMINDER_LIMITS.invoices) {
			throw new ReminderLimit(`ci sono già solleciti annotati per ${REMINDER_LIMITS.invoices} fatture, il massimo: non ne annoto altri`);
		}
		const sent = before?.sent ?? [];
		if (sent.length >= REMINDER_LIMITS.perInvoice) throw new ReminderLimit(`una fattura ha già ${REMINDER_LIMITS.perInvoice} solleciti annotati, il massimo`);
		const mark: ReminderMark = { level: item.level, by: made.by, at: made.at, via: made.via, ...(made.action === undefined ? {} : { action: made.action }) };
		byInvoice.set(item.invoice, { invoice: item.invoice, sent: [...sent, mark] });
		recorded++;
	}
	return { entries: recorded === 0 ? entries : [...byInvoice.values()], recorded };
}

/** The level a new reminder of an invoice gets: one past those recorded, at most the formal one. */
export function nextLevel(sent: readonly ReminderMark[] | undefined): ReminderLevel {
	const count = sent?.length ?? 0;
	return count >= 2 ? 3 : count === 1 ? 2 : 1;
}
