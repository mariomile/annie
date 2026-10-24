/**
 * A recurring invoice's period made into a sales invoice DRAFT, by the very draft builder of
 * sales_invoices (sales-invoice-draft.ts draft, with the same env): the FatturaPA rules, the
 * forfettario, the bollo, the ritenuta, the cassa and what is asked when something is missing are
 * all its own. The period is claimed first (recurring-invoice-store.ts) with the draft's call id,
 * so a crash, a restart or two sweeps never make two drafts. A draft that cannot be made (the
 * customer's card gone, a voce of the listino gone, the person's data missing) is recorded as
 * failed for that period with the builder's own words, said once, and not tried again by itself.
 *
 * A draft covers months: the sweep never prepares a period that overlaps a month already covered
 * (by this recurring invoice, or by the same canone removed for the same customer and added again,
 * whose draft is still there),
 * and never makes again a draft the person removed; only run_now does, when asked, with a new call
 * id («recurring:RI-0001:2026-10:2»).
 *
 * The sweep: for each active schedule, the latest period due on today's date in the instance's
 * time zone (recurring-invoices.ts duePeriod), never a burst of the missed ones; then the
 * conversation it was set in is told, once per period (the notice's key), and again on a later
 * sweep only when telling failed: TELL_TRIES times, then at most once a day.
 *
 * A draft made in place of another with sales_invoices (replace) keeps the first call as `origin`:
 * it is still this run's draft.
 */
import type { ClientStore } from "../client-store.ts";
import type { ToolContext } from "../engine.ts";
import { todayIn } from "../italian-calendar.ts";
import { listLines } from "../price-list-lines.ts";
import { centsDecimal, halfUp, scaled } from "../quote-sums.ts";
import type { RecurringBook, RecurringStore } from "../recurring-invoice-store.ts";
import { type Billed, CADENCES, canoneKey, duePeriod, filled, hasPlaceholder, longestLabel, type RecurringCustomer, type RecurringLine, type Run, runMonths, rangeLabel, type Schedule, scheduleNumber, TELL_TRIES } from "../recurring-invoices.ts";
import { FIELD_LIMITS } from "../sales-invoice-rules.ts";
import type { SalesInvoiceStore } from "../sales-invoice-store.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type SalesInvoice, SalesInvoiceError } from "../sales-invoices.ts";
import { failedNotice, readyNotice } from "./recurring-invoice-render.ts";
import { DRAFT_CHECKED, draft } from "./sales-invoice-draft.ts";
import { readLines } from "./sales-invoice-input.ts";
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

/** What the lineage of the drafts reads: the sales store, and the client cards (a card's own tax ids). The cash-flow forecast reads it too. */
export type SalesReads = { readonly sales: { readonly store: Pick<SalesInvoiceStore, "read">; readonly clients?: Pick<ClientStore, "read"> } };

/** The first call id of a period's draft; a draft made again after the person removed it takes «:2», «:3»… */
export const draftCallId = (s: Pick<Schedule, "id">, period: string) => `recurring:${s.id}:${period}`;

/** A call id for a period's draft that the sales store has never seen (a removed draft's call stays there). */
export function freshCall(env: SalesReads, s: Pick<Schedule, "id">, period: string): string {
	const base = draftCallId(s, period);
	const book = env.sales.store.read();
	const used = new Set([...book.calls, ...book.invoices.flatMap((i) => (i.origin === undefined ? [i.callId] : [i.callId, i.origin]))]);
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}:${n}`)) n++;
	return `${base}:${n}`;
}

/** Whether a sales invoice is the one a call made: by its own call, or one made in its place (replace keeps the first call as `origin`). */
const madeBy = (i: SalesInvoice, call: string) => i.callId === call || i.origin === call;

/** The sales invoice (draft or issued) a call made, or the one made in its place, when it is still there. */
export function invoiceOf(env: SalesReads, call: string): SalesInvoice | undefined {
	return env.sales.store.read().invoices.find((i) => madeBy(i, call));
}

/** A run whose draft the person removed (never an issued invoice: that is never removed). Unknown when the sales store does not read. */
export function draftGone(env: SalesReads, r: Run): boolean {
	if (r.state !== "drafted") return false;
	const book = env.sales.store.read();
	return !book.broken && !book.invoices.some((i) => madeBy(i, r.call));
}

type Who = Pick<RecurringCustomer, "name" | "card" | "vat" | "cf">;

/**
 * Whether two customers are the same one: a card, a partita IVA or a codice fiscale in common (a
 * card's own tax ids count, so a card on one side and its partita IVA on the other match); by name
 * only when neither has any.
 */
export function sameCustomer(env: SalesReads, a: Who, b: Who): boolean {
	const cardBook = a.card === undefined && b.card === undefined ? undefined : env.sales.clients?.read();
	const cards = cardBook === undefined || cardBook.broken ? [] : cardBook.cards;
	const ids = (c: Who) => {
		const card = c.card === undefined ? undefined : cards.find((x) => x.id === c.card);
		const vats = [c.vat, card?.vat].filter((v): v is string => v !== undefined).map((v) => v.replace(/^IT/, ""));
		const cfs = [c.cf, card?.cf].filter((v): v is string => v !== undefined);
		return { card: c.card, vats, cfs };
	};
	const x = ids(a);
	const y = ids(b);
	if (x.card !== undefined && x.card === y.card) return true;
	if (x.vats.some((v) => y.vats.includes(v)) || x.cfs.some((v) => y.cfs.includes(v))) return true;
	const none = (c: Who) => c.card === undefined && c.vat === undefined && c.cf === undefined;
	return none(a) && none(b) && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

/**
 * The months of a removed recurring invoice held back for this one, whose draft (or invoice) is
 * still there: the same customer and the same canone (lines and cadence) added again after it was
 * removed; never another canone of the customer, never one that was there already.
 */
export function billedFor(env: SalesReads, book: Pick<RecurringBook, "billed">, s: Pick<Schedule, "id" | "customer" | "lines" | "terms" | "cadence">): Billed[] {
	const key = canoneKey(s);
	const n = scheduleNumber(s.id);
	return book.billed.filter((b) => b.canone === key && b.after !== undefined && n >= b.after && sameCustomer(env, b.customer, s.customer) && invoiceOf(env, b.call) !== undefined);
}

/** The months covered for a schedule: its runs (all but those `skip` leaves out) and the drafts still there of one removed for the same customer. */
export function coveredMonths(env: SalesReads, book: Pick<RecurringBook, "runs" | "billed">, s: Schedule, skip: (r: Run) => boolean = () => false): Set<string> {
	const covered = new Set<string>();
	for (const r of book.runs) if (r.schedule === s.id && !skip(r)) for (const m of runMonths(r)) covered.add(m);
	for (const b of billedFor(env, book, s)) for (const m of runMonths(b)) covered.add(m);
	return covered;
}

/**
 * The arguments sales_invoices' draft gets for these months: the lines with the period in their
 * description, the terms, the customer's data, the note. `share`: a month left out by a new cadence,
 * made alone: each line becomes one of its amount divided by `share`, to the cent half up.
 */
export function draftArgs(env: Pick<RecurringEnv, "sales">, s: Schedule, period: string, months: number, share?: number): Record<string, unknown> | { readonly why: string } {
	const raw = s.lines.map(lineArgs);
	const listed = listLines({ ...(env.sales.priceList === undefined ? {} : { priceList: env.sales.priceList }), company: env.sales.company, taxes: env.sales.taxes }, raw, { kind: "invoice", descriptionMax: FIELD_LIMITS.descrizione - longestLabel(s.cadence).length - 2, doc: { vat: s.terms.vat, natura: s.terms.natura } });
	if (listed !== undefined && "ask" in listed) return { why: listed.ask };
	const label = rangeLabel(period, months);
	const lines = (listed?.lines ?? raw).map((l) => {
		const line = l as Record<string, unknown>;
		const description = String(line.description ?? "");
		const named = { ...line, description: hasPlaceholder(description) ? filled(description, period, months) : `${description}, ${label}` };
		return share === undefined ? named : shared(named, share);
	});
	const c = s.customer;
	return {
		customer: c.card ?? c.name,
		...(c.card === undefined && c.vat !== undefined ? { vat_number: c.vat } : {}),
		...(c.card === undefined && c.cf !== undefined ? { cf: c.cf } : {}),
		...(c.address === undefined ? {} : { address: c.address }),
		...(c.code === undefined ? {} : { recipient_code: c.code }),
		...(c.pec === undefined ? {} : { pec: c.pec }),
		...(c.country === undefined ? {} : { country: c.country }),
		lines,
		...s.terms,
		...(s.note === undefined ? {} : { notes: filled(s.note, period, months) }),
	};
}

/** A line as one of its amount divided by `share` (quantity 1, no unit), to the cent half up; as it is when it does not read (the draft says why). */
function shared(line: Record<string, unknown>, share: number): Record<string, unknown> {
	const read = readLines([line]);
	if (!Array.isArray(read)) return line;
	const l = read[0];
	if (l === undefined) return line;
	const { unit: _u, ...rest } = line;
	// Price to 4 decimals × quantity to 3: 7 decimals, to cents divided by the share.
	const cents = halfUp(scaled(l.price, 4) * scaled(l.quantity, 3), 100_000n * BigInt(share));
	return { ...rest, quantity: "1", price: centsDecimal(cents) };
}

function lineArgs(l: RecurringLine): Record<string, unknown> {
	return Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
}

/** A ToolContext for the instance's own work: the marker says Owni, its steps run once (the sales store keeps the call id). */
const ownContext = (callId: string, signal: AbortSignal): ToolContext => ({ callId, step: async (_key, work) => work(), progress: () => {}, signal });

/** Whether this period's draft could be made now, saving nothing: undefined when it could, else what is missing (the builder's own words). */
export async function checkDraft(env: RecurringEnv, s: Schedule, period: string, months: number, signal: AbortSignal): Promise<string | undefined> {
	const args = draftArgs(env, s, period, months);
	if ("why" in args) return String(args.why);
	try {
		const answer = await draft(env.sales, args, ownContext(`recurring-check:${s.id}:${period}`, signal), todayIn(env.timeZone, env.now()), { check: true });
		return answer === DRAFT_CHECKED ? undefined : answer;
	} catch (error) {
		if (error instanceof SalesInvoiceError) return `Errore: ${error.message}.`;
		throw error;
	}
}

/** The draft of a run (with the builder's answer), or why it could not be made. */
async function build(env: RecurringEnv, s: Schedule, run: Run, signal: AbortSignal): Promise<{ readonly draft: SalesInvoice; readonly answer: string } | { readonly why: string }> {
	if (s.customer.card !== undefined) {
		const cards = env.sales.clients?.read();
		if (cards !== undefined && !cards.broken && !cards.cards.some((c) => c.id === s.customer.card)) return { why: `La scheda del cliente (${s.customer.card}) non c'è più tra i clienti: la fattura ricorrente va rifatta per un cliente che c'è, o tolta.` };
	}
	const args = draftArgs(env, s, run.period, run.months, run.share);
	if ("why" in args) return { why: String(args.why) };
	const ctx = ownContext(run.call, signal);
	let answer: string;
	let made: SalesInvoice | undefined;
	try {
		answer = await draft(env.sales, args, ctx, todayIn(env.timeZone, env.now()));
		made = env.sales.book().invoices.find((i) => i.callId === run.call);
	} catch (error) {
		if (error instanceof SalesInvoiceError) answer = `Errore: ${error.message}.`;
		else throw error;
	}
	return made === undefined ? { why: answer } : { draft: made, answer };
}

export type Prepared = { readonly kind: "drafted"; readonly run: Run; readonly draft: SalesInvoice; readonly answer: string } | { readonly kind: "failed"; readonly run: Run } | { readonly kind: "handled"; readonly run: Run };

/**
 * Months claimed and made into a draft (or failed); what was done when they were handled already.
 * `months`: how many from `period` (the cadence's by default); `replace`: the periods whose runs
 * give way (failed, or with their draft removed: the person asked again).
 */
export async function preparePeriod(
	env: RecurringEnv,
	s: Schedule,
	period: string,
	o: { readonly months?: number; readonly share?: number; readonly missed?: readonly string[]; readonly replace?: readonly string[]; readonly signal?: AbortSignal } = {},
): Promise<Prepared> {
	const old = env.store.read().runs.find((r) => r.schedule === s.id && r.period === period);
	// A claim never finished keeps its call id: its draft, if it was made, is found again.
	const call = old !== undefined && old.state === "claimed" ? old.call : freshCall(env, s, period);
	const claim = env.store.claim(s.id, period, env.now().toISOString(), { months: o.months ?? CADENCES[s.cadence], call, ...(o.share === undefined ? {} : { share: o.share }), ...(o.missed === undefined ? {} : { missed: o.missed }), ...(o.replace === undefined ? {} : { replace: o.replace }) });
	if (!claim.mine) return { kind: "handled", run: claim.run };
	const built = await build(env, s, claim.run, o.signal ?? new AbortController().signal);
	const run = env.store.settle(s.id, period, "draft" in built ? { draft: built.draft.id } : { why: built.why });
	if (run === undefined) return { kind: "handled", run: claim.run };
	await env.record?.({ type: "recurring_invoices.changed", op: "draft" in built ? "prepared" : "failed", count: 1 }).catch(() => {});
	return "draft" in built ? { kind: "drafted", run, draft: built.draft, answer: built.answer } : { kind: "failed", run };
}

/** Tells the schedule's conversation how its period went, once (the key); marked told when it went; after TELL_TRIES failed sends, tried at most once a day. */
export async function tell(env: RecurringEnv, s: Schedule, run: Run): Promise<void> {
	if (env.notify === undefined || s.thread === undefined || run.told === true || run.state === "claimed") return;
	const day = todayIn(env.timeZone, env.now());
	if ((run.tellFails ?? 0) >= TELL_TRIES && run.lastTry === day) return;
	let text: string;
	if (run.state === "drafted") {
		const inv = invoiceOf(env, run.call);
		// Removed before it was said: nothing to tell.
		if (inv === undefined) return;
		const t = salesTotals(inv);
		text = readyNotice(s, run, t.taxable, t.toPay);
	} else text = failedNotice(s, run);
	try {
		// One key per draft: «recurring-invoice:RI-0001:2026-10», «…:2» for one made again.
		await env.notify(s.thread, text, `recurring-invoice:${run.call.replace(/^recurring:/, "")}`);
		env.store.markTold(s.id, run.period);
	} catch (error) {
		const tries = env.store.tellFailed(s.id, run.period, day);
		const why = error instanceof Error ? error.message : String(error);
		// Said once when it gives up; the daily tries after it are not logged again.
		if (tries.count >= TELL_TRIES && tries.before < TELL_TRIES) env.log?.(`recurring invoices: ${s.id} ${run.period} not told after ${TELL_TRIES} tries, given up for today, tried again once a day: ${why}`);
		else if (tries.count < TELL_TRIES) env.log?.(`recurring invoices: ${s.id} ${run.period} not told: ${why}`);
	}
}

/** One sweep of an instance: the latest period due of each active schedule, then told. Returns the drafts made. */
export async function sweepRecurring(env: RecurringEnv): Promise<number> {
	const book = env.store.read();
	if (book.broken) return 0;
	const day = todayIn(env.timeZone, env.now());
	let made = 0;
	for (const s of book.schedules) {
		const runs = book.runs.filter((r) => r.schedule === s.id);
		// A period not told yet (telling failed) is told, paused or not.
		for (const r of runs) if (r.told !== true && r.state !== "claimed") await tell(env, s, r);
		if (s.status !== "active") continue;
		const claimed = runs.find((r) => r.state === "claimed");
		// The end, the number of invoices and what is covered are duePeriod's: the last period missed while down is still made.
		const due = claimed !== undefined ? { period: claimed.period, missed: claimed.missed ?? [], months: claimed.months } : duePeriod(s, day, coveredMonths(env, book, s));
		if (due === undefined) continue;
		try {
			const p = await preparePeriod(env, s, due.period, { missed: due.missed, ...("months" in due ? { months: due.months } : {}) });
			if (p.kind === "drafted") made++;
			if (p.kind !== "handled") await tell(env, s, p.run);
		} catch (error) {
			// One schedule failing does not stop the others; its claim is taken up on the next sweep.
			env.log?.(`recurring invoices: ${s.id} ${due.period} not prepared: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return made;
}
