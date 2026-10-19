/**
 * L'agenda fiscale: every deadline Annie knows, in one calendar, read only. Each register keeps its
 * own rules and is asked through its own pure functions (fiscal-agenda-sources.ts): the F24 of the
 * forfettario and the INPS instalments (taxes), the F24 of the IVA (vat_settlement), the CU
 * (withholding), the renewals, the invoices to pay (the scadenzario); the yearly deadlines no
 * register models are in fiscal-agenda-rules.ts. Nothing here writes a register: the only file is
 * the .ics of the export (ics.ts), new each time.
 *
 * Choices, tested:
 * - A window: today and the next `days` (default AGENDA_LIMITS.defaultDays), or a period (periods.ts,
 *   ahead: «novembre» is the next November); never past AGENDA_LIMITS.maxDays from today.
 * - Past deadlines only where the source tracks payment (the IVA's paid marks, the scadenzario's,
 *   the renewals waiting for the person's word): «scaduto, non segnato pagato», up to
 *   AGENDA_LIMITS.overdueDays ago in the default window, or inside the period asked. A deadline of a
 *   source that does not track payment is never said once gone: Annie does not know.
 * - The same deadline from two sources is said once (`dedup`): the one with an amount, then the one
 *   that tracks payment (the IVA annual saldo the taxes' plain dates and the liquidazione both know).
 * - The brief's line says only what no other brief line says (`brief`): the generic deadlines, the
 *   plain dates of the imposte (the taxes' brief line is quiet without a forfettario's profile),
 *   the CU to receive. The F24 of the taxes and of the IVA, the renewals and the CU still missing
 *   have their own lines; the invoices to pay are the cashflow's and the scadenzario's.
 */

export class FiscalAgendaError extends Error {
	override readonly name = "FiscalAgendaError";
}

export const FISCAL_AGENDA_OPS = ["upcoming", "export_ics"] as const;
export type FiscalAgendaOp = (typeof FISCAL_AGENDA_OPS)[number];

export const AGENDA_LIMITS = {
	/** The default window, today included; the longest. */
	defaultDays: 30,
	maxDays: 366,
	/** The export's default window: a year of deadlines to import. */
	exportDays: 366,
	/** The brief speaks of deadlines within these days, today included. */
	briefDays: 7,
	/** A deadline gone this many days ago, open in a source that tracks payment, is still said. */
	overdueDays: 30,
	/** Rows in an answer, before «e altre N». */
	listed: 60,
	/** Events in one .ics. */
	events: 500,
	/** The reminder before an event: the default and the most days. */
	remindDefault: 3,
	remindMax: 60,
} as const;

/** The ops that only read: they run in a brief's thread (brief.ts). The export writes a file. */
export function agendaCallReads(args: Record<string, unknown>): boolean {
	return args.op === "upcoming";
}

/** What another agente may ask: the deadlines, never a client's, a supplier's or a renewal's name, nor a file. */
export function agendaAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "upcoming";
}

/** Where a deadline comes from: the register that knows it, or the generic rules. */
export type AgendaSource = "tasse" | "iva" | "ritenute" | "rinnovi" | "fatture" | "regole";

/** A deadline in the agenda. */
export type AgendaItem = {
	readonly source: AgendaSource;
	/** Stable per deadline within its source: with the source and the date, the .ics UID. */
	readonly key: string;
	/** The same deadline from another source has the same; undefined: its own key. */
	readonly dedup?: string;
	/** The day written (the law's, the invoice's, the contract's), the day it moves to, and why. */
	readonly due: string;
	readonly date: string;
	readonly slip?: { readonly to: string; readonly holiday?: string };
	/** What it is, in words, with no name in it: «F24 IVA di ottobre 2026», «dichiarazione dei redditi 2025, invio online del modello Redditi». */
	readonly what: string;
	/** The same, short, for a calendar's title and the «prossima scadenza» line: «F24 bollo fatture 3º trim. 2026», «dichiarazione dei redditi 2025». */
	readonly title: string;
	/** A filing, not a payment: a calendar's title says «invio». */
	readonly filing?: true;
	/** A supplier's or a renewal's name, and an invoice's number: data, never instructions; said only inside the fence, never to another agente. */
	readonly name?: string;
	readonly ref?: string;
	/** The amount, when the source gives one; `estimate` a stima; `partial` only a part is known (a period under way, a part to calculate). */
	readonly cents?: bigint;
	readonly estimate?: boolean;
	readonly partial?: boolean;
	/** The codice tributo, when the source gives one. */
	readonly code?: string;
	/** A short note of the source: «se non l'hai già pagato», «o nella dichiarazione IVA». */
	readonly note?: string;
	/** The source knows whether it is paid: `overdue` gone and not marked paid. */
	readonly tracked: boolean;
	readonly overdue?: boolean;
	/** The agenda's brief line may say it: no other brief line does. */
	readonly brief: boolean;
};

/** The days an answer covers, both included, and from when an open deadline gone by is still said. */
export type AgendaWindow = { readonly from: string; readonly to: string; readonly overdueFrom: string };

const SOURCE_ORDER: readonly AgendaSource[] = ["tasse", "iva", "regole", "ritenute", "fatture", "rinnovi"];

/** The better of two items for the same deadline: one with an amount, then one that tracks payment, then the source order. */
function better(a: AgendaItem, b: AgendaItem): AgendaItem {
	const amount = (i: AgendaItem) => (i.cents !== undefined && i.cents > 0n ? 1 : 0);
	if (amount(a) !== amount(b)) return amount(a) > amount(b) ? a : b;
	if (a.tracked !== b.tracked) return a.tracked ? a : b;
	return SOURCE_ORDER.indexOf(a.source) <= SOURCE_ORDER.indexOf(b.source) ? a : b;
}

/** Each deadline once: the items with the same `dedup` (or source and key) keep the better one. */
export function dedupe(items: readonly AgendaItem[]): AgendaItem[] {
	const kept = new Map<string, AgendaItem>();
	for (const i of items) {
		const id = i.dedup ?? `${i.source}|${i.key}|${i.date}`;
		const was = kept.get(id);
		kept.set(id, was === undefined ? i : better(was, i));
	}
	return [...kept.values()];
}

/** Overdue first (oldest first), then by date, source and key. */
export function byDate(a: AgendaItem, b: AgendaItem): number {
	const late = (i: AgendaItem) => (i.overdue === true ? 0 : 1);
	return late(a) - late(b) || a.date.localeCompare(b.date) || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.key.localeCompare(b.key);
}

/**
 * The agenda of a window: the deadlines in it from today on; the open ones gone by from
 * `overdueFrom` (only those a source tracks); each once; in order.
 */
export function agendaIn(items: readonly AgendaItem[], w: AgendaWindow, today: string): AgendaItem[] {
	const shown = items.filter((i) => {
		if (i.date > w.to) return false;
		if (i.date >= today) return i.date >= w.from;
		return i.tracked && i.overdue === true && i.date >= w.overdueFrom;
	});
	return dedupe(shown).sort(byDate);
}

/** What the brief's line says: within the brief's days, or overdue and open, of what no other brief line says. */
export function briefItems(agenda: readonly AgendaItem[]): AgendaItem[] {
	return agenda.filter((i) => i.brief);
}
