/**
 * A recurring invoice's period made into a sales invoice DRAFT, by the very draft builder of
 * sales_invoices (sales-invoice-draft.ts draft, with the same env): the FatturaPA rules, the
 * forfettario, the bollo, the ritenuta, the cassa and what is asked when something is missing are
 * all its own. The period is claimed first (recurring-invoice-store.ts), and the draft's call id
 * is the schedule and the period, so a crash, a restart or two sweeps never make two drafts. A
 * draft that cannot be made (the customer's card gone, a voce of the listino gone, the person's
 * data missing) is recorded as failed for that period with the builder's own words, said once,
 * and not tried again by itself.
 *
 * The sweep: for each active schedule, the latest period due on today's date in the instance's
 * time zone (recurring-invoices.ts duePeriod), never a burst of the missed ones; then the
 * conversation it was set in is told, once per period (the notice's key), and again on a later
 * sweep only when telling failed.
 */
import type { ToolContext } from "../engine.ts";
import { todayIn } from "../italian-calendar.ts";
import { listLines } from "../price-list-lines.ts";
import type { RecurringStore } from "../recurring-invoice-store.ts";
import { duePeriod, filled, finished, hasPlaceholder, periodLabel, type RecurringLine, type Run, type Schedule } from "../recurring-invoices.ts";
import { FIELD_LIMITS } from "../sales-invoice-rules.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type SalesInvoice, SalesInvoiceError } from "../sales-invoices.ts";
import { failedNotice, readyNotice } from "./recurring-invoice-render.ts";
import { draft } from "./sales-invoice-draft.ts";
import type { SalesEnv } from "./sales-invoice-env.ts";

/** What changed, for the audit: the op and how many, never customers, amounts, lines or notes. */
export type RecurringEvent = { readonly type: "recurring_invoices.changed"; readonly op: "add" | "change" | "pause" | "resume" | "remove" | "prepared" | "failed"; readonly count: number };

export type RecurringEnv = {
	readonly store: RecurringStore;
	readonly sales: SalesEnv;
	readonly timeZone: string;
	readonly now: () => Date;
	readonly record?: (event: RecurringEvent) => Promise<void>;
	/** Tells a conversation from the instance's own work; the same key is told once. */
	readonly notify?: (thread: { readonly channel: string; readonly threadId: string }, text: string, key: string) => Promise<void>;
	readonly log?: (message: string) => void;
};

/** The call id of a period's draft: the same for every attempt, so the sales store makes it once. */
export const draftCallId = (s: Pick<Schedule, "id">, period: string) => `recurring:${s.id}:${period}`;

/** The arguments sales_invoices' draft gets for this period: the lines with the period in their description, the terms, the note. */
export function draftArgs(env: Pick<RecurringEnv, "sales">, s: Schedule, period: string): Record<string, unknown> | { readonly why: string } {
	const raw = s.lines.map(lineArgs);
	const listed = listLines({ ...(env.sales.priceList === undefined ? {} : { priceList: env.sales.priceList }), company: env.sales.company, taxes: env.sales.taxes }, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione - 40, doc: { vat: s.terms.vat, natura: s.terms.natura } });
	if (listed !== undefined && "ask" in listed) return { why: listed.ask };
	const label = periodLabel(s, period);
	const lines = (listed?.lines ?? raw).map((l) => {
		const line = l as Record<string, unknown>;
		const description = String(line.description ?? "");
		return { ...line, description: hasPlaceholder(description) ? filled(description, s, period) : `${description}, ${label}` };
	});
	const c = s.customer;
	return {
		customer: c.card ?? c.name,
		...(c.card === undefined && c.vat !== undefined ? { vat_number: c.vat } : {}),
		...(c.card === undefined && c.cf !== undefined ? { cf: c.cf } : {}),
		lines,
		...s.terms,
		...(s.note === undefined ? {} : { notes: filled(s.note, s, period) }),
	};
}

function lineArgs(l: RecurringLine): Record<string, unknown> {
	return Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
}

/** The draft of a period (with the builder's answer), or why it could not be made. */
async function build(env: RecurringEnv, s: Schedule, period: string, signal: AbortSignal): Promise<{ readonly draft: SalesInvoice; readonly answer: string } | { readonly why: string }> {
	if (s.customer.card !== undefined) {
		const cards = env.sales.clients?.read();
		if (cards !== undefined && !cards.broken && !cards.cards.some((c) => c.id === s.customer.card)) return { why: `La scheda del cliente (${s.customer.card}) non c'è più tra i clienti: la fattura ricorrente va rifatta per un cliente che c'è, o tolta.` };
	}
	const args = draftArgs(env, s, period);
	if ("why" in args) return { why: String(args.why) };
	// Not from a person: the draft's marker says Annie, its steps run once (the sales store keeps the call id).
	const ctx: ToolContext = { callId: draftCallId(s, period), step: async (_key, work) => work(), progress: () => {}, signal };
	const day = todayIn(env.timeZone, env.now());
	let answer: string;
	let made: SalesInvoice | undefined;
	try {
		answer = await draft(env.sales, args, ctx, day);
		made = env.sales.book().invoices.find((i) => i.callId === ctx.callId);
	} catch (error) {
		if (error instanceof SalesInvoiceError) answer = `Errore: ${error.message}.`;
		else throw error;
	}
	return made === undefined ? { why: answer } : { draft: made, answer };
}

export type Prepared = { readonly kind: "drafted"; readonly run: Run; readonly draft: SalesInvoice; readonly answer: string } | { readonly kind: "failed"; readonly run: Run } | { readonly kind: "handled"; readonly run: Run };

/** A period claimed and made into a draft (or failed); what was done when it was handled already. `retry`: a failed period, asked again by the person. */
export async function preparePeriod(env: RecurringEnv, s: Schedule, period: string, o: { readonly skipped?: number; readonly retry?: boolean; readonly signal?: AbortSignal } = {}): Promise<Prepared> {
	const claim = env.store.claim(s.id, period, env.now().toISOString(), o);
	if (!claim.mine) return { kind: "handled", run: claim.run };
	const built = await build(env, s, period, o.signal ?? new AbortController().signal);
	const run = env.store.settle(s.id, period, "draft" in built ? { draft: built.draft.id } : { why: built.why });
	if (run === undefined) return { kind: "handled", run: claim.run };
	await env.record?.({ type: "recurring_invoices.changed", op: "draft" in built ? "prepared" : "failed", count: 1 }).catch(() => {});
	return "draft" in built ? { kind: "drafted", run, draft: built.draft, answer: built.answer } : { kind: "failed", run };
}

/** Tells the schedule's conversation how its period went, once (the key); marked told when it went. */
export async function tell(env: RecurringEnv, s: Schedule, run: Run): Promise<void> {
	if (env.notify === undefined || s.thread === undefined || run.told === true || run.state === "claimed") return;
	let text: string;
	if (run.state === "drafted") {
		const inv = env.sales.store.read().invoices.find((i) => i.id === run.draft && i.callId === draftCallId(s, run.period));
		if (inv === undefined) return;
		const t = salesTotals(inv);
		text = readyNotice(s, run, t.taxable, t.toPay);
	} else text = failedNotice(s, run);
	try {
		await env.notify(s.thread, text, `recurring-invoice:${s.id}:${run.period}`);
		env.store.markTold(s.id, run.period);
	} catch (error) {
		env.log?.(`recurring invoices: ${s.id} ${run.period} not told: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** One sweep of an instance: the latest period due of each active schedule, then told. Returns the drafts made. */
export async function sweepRecurring(env: RecurringEnv): Promise<number> {
	const book = env.store.read();
	if (book.broken) return 0;
	const day = todayIn(env.timeZone, env.now());
	let made = 0;
	for (const s of book.schedules) {
		if (s.status !== "active") continue;
		const runs = book.runs.filter((r) => r.schedule === s.id);
		// A period told before failed: tried again.
		for (const r of runs) if (r.told !== true && r.state !== "claimed") await tell(env, s, r);
		if (finished(s, day) && runs.every((r) => r.state !== "claimed")) continue;
		const claimed = runs.find((r) => r.state === "claimed");
		const due = claimed !== undefined ? { period: claimed.period, skipped: claimed.skipped ?? 0 } : duePeriod(s, day, new Set(runs.map((r) => r.period)));
		if (due === undefined) continue;
		try {
			const p = await preparePeriod(env, s, due.period, { skipped: due.skipped });
			if (p.kind === "drafted") made++;
			if (p.kind !== "handled") await tell(env, s, p.run);
		} catch (error) {
			// One schedule failing does not stop the others; its claim is taken up on the next sweep.
			env.log?.(`recurring invoices: ${s.id} ${due.period} not prepared: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return made;
}
