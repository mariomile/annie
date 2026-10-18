/**
 * timesheet op to_quote: a client's billable hours not yet billed, in a period, become a
 * preventivo through quotes' own create (its rules, numbering and document), and those entries
 * are then «nel preventivo» with its number. Three durable steps, each safe to run again:
 *
 * 1. reserve: under the store's lock the entries are picked and reserved to this call, each with
 *    its minutes, rate and rounding of then; another to_quote at the same time does not pick them.
 * 2. the quote, made from the reserved entries at the terms reserved (quotes keeps its steps
 *    apart and finds the quote of this call id again); not made: the reservation is released.
 * 3. bill: only the entries reserved to this call and unchanged since are marked, at the terms
 *    reserved; the audit counts those.
 *
 * Stopped after the quote was made, the call run again finds its reservation and bills; after
 * billing, the reserve step (kept by the engine) leads to the same quote and the audit is written.
 * A reservation whose quote was made never lapses: any change to the timesheet meanwhile bills it
 * with that quote (timesheet-store.ts), and the call run again says so. Without a quote it lapses
 * after an hour, and the call then makes no quote with it.
 */
import { hoursText } from "../durations.ts";
import type { ToolContext } from "../engine.ts";
import { italianDate } from "../italian-format.ts";
import { inPeriod, type Period } from "../periods.ts";
import { QUOTE_LIMITS } from "../quotes.ts";
import type { QuoteStore } from "../quote-store.ts";
import { billingState, oldestFirst, type ReservedEntry, sameClient, type WorkEntry } from "../timesheet.ts";
import type { TimesheetStore } from "../timesheet-store.ts";
import { hoursLines, type LineWords, priced, QUOTE_GROUPS, type QuoteGroup } from "../timesheet-sums.ts";
import type { CreateQuote } from "./quote-tools.ts";
import { billClient } from "./timesheet-clients.ts";
import { entries, rateText, whichClientAnswer } from "./timesheet-render.ts";

export type ToQuoteDeps = {
	readonly store: TimesheetStore;
	readonly quotes: Pick<QuoteStore, "read">;
	readonly createQuote?: CreateQuote;
	readonly by: (ctx: ToolContext) => string;
	readonly now: () => Date;
	readonly audit: (ctx: ToolContext, count: number) => Promise<void>;
};

const NO_QUOTES = "Errore: qui non posso fare preventivi. Prepara il riepilogo con op report.";

/** The quote's fields the person may give, passed as they are: quotes reads and checks them. */
const PASSED = ["vat", "vat_note", "terms", "notes", "valid_days", "format", "tax_id", "address", "email"] as const;

/** Activities named in a line for a project, at most; each cut to this length. */
const MAX_ACTIVITIES = 3;
const ACTIVITY_LENGTH = 40;

type Picked = { readonly kind: "reserved"; readonly client: string; entries: ReservedEntry[] } | { readonly kind: "done"; readonly number: string } | { readonly kind: "answer"; readonly text: string };

/** The words of the quote's lines: a project's hours with a few of its activities, an entry's day and description, a lump sum's hours and rate. */
export function lineWords(period: Period): LineWords {
	const short = (t: string) => (t.length > ACTIVITY_LENGTH ? `${t.slice(0, ACTIVITY_LENGTH - 1)}…` : t);
	return {
		group: (project, activities) => {
			const named = activities.slice(0, MAX_ACTIVITIES).map(short).join("; ");
			const what = activities.length === 0 ? "" : ` (attività: ${named}${activities.length > MAX_ACTIVITIES ? "…" : ""})`;
			return `Ore di lavoro${project === undefined ? "" : ` – ${project}`}, ${period.label}${what}`;
		},
		entry: (e) => {
			const project = e.project === undefined ? "" : ` – ${e.project}`;
			return e.description === undefined ? `Ore di lavoro del ${italianDate(e.date)}${project}` : `${italianDate(e.date)}${project}: ${e.description.replace(/\n/g, " ")}`;
		},
		lump: (minutes, rate) => ` (${hoursText(minutes)} a ${rateText(rate)})`,
	};
}

export async function toQuote(args: Record<string, unknown>, ctx: ToolContext, period: Period, deps: ToQuoteDeps): Promise<string> {
	const { store, createQuote } = deps;
	if (createQuote === undefined) return NO_QUOTES;
	if (args.group !== undefined && !QUOTE_GROUPS.includes(args.group as QuoteGroup)) return `Errore: group è uno di questi: ${QUOTE_GROUPS.join(", ")}.`;
	const group = (args.group ?? "project") as QuoteGroup;
	const picked = await ctx.step("reserve", async (): Promise<Picked> => {
		const book = store.read();
		const quotes = deps.quotes.read();
		const made = quotes.broken ? undefined : quotes.quotes.find((q) => q.callId === ctx.callId);
		// The quote of this call is made and its reservation gone: billed already, nothing new is picked.
		if (made?.file !== undefined && !book.reservations.some((r) => r.callId === ctx.callId)) return { kind: "done", number: made.number };
		if (args.client === undefined) return { kind: "answer", text: whichClientAnswer(book.entries, period, true) };
		const chosen = billClient(args.client, book.entries);
		if ("error" in chosen) return { kind: "answer", text: chosen.error };
		const reservation = store.reserve(ctx.callId, deps.by(ctx), (free) => free.filter((e) => sameClient(e.client, chosen.client) && e.billable && e.billed === undefined && inPeriod(e.date, period)));
		if (reservation !== undefined) return { kind: "reserved", client: chosen.client, entries: [...reservation.entries] };
		const held = store.read().reservations.flatMap((r) => r.entries.map((x) => x.id));
		const busy = chosen.entries.filter((e) => held.includes(e.id) && e.billable && e.billed === undefined && inPeriod(e.date, period)).length;
		const why = busy > 0 ? ` ${entries(busy)} di quel cliente ${busy === 1 ? "è" : "sono"} in un altro preventivo che si sta preparando adesso.` : " O sono già fatturate o in un preventivo, o non ce ne sono: guarda con op list e filter da_fatturare.";
		return { kind: "answer", text: `Nessuna ora da fatturare per quel cliente ${period.in}.${why}` };
	});
	if (picked.kind === "answer") return picked.text;
	if (picked.kind === "done") return doneAnswer(picked.number, store.read().entries);
	const release = async (text: string) => {
		await ctx.step("release", async () => {
			store.release(ctx.callId);
			return true;
		});
		return text;
	};
	const book = store.read();
	const byId = new Map(book.entries.map((e) => [e.id, e]));
	const items = picked.entries
		.flatMap((r) => {
			const e = byId.get(r.id);
			return e === undefined ? [] : [{ e, r }];
		})
		.sort((a, b) => oldestFirst(a.e, b.e))
		.map(({ e, r }) => priced(e, book.rates, { ...(r.rate === undefined ? {} : { rate: r.rate }), rounding: r.rounding }));
	const unpriced = items.filter((p) => p.rate === undefined);
	if (unpriced.length > 0) {
		const which = unpriced.slice(0, 10).map((p) => p.entry.id).join(", ");
		return release(`Errore: ${unpriced.length === 1 ? "una voce non ha" : `${unpriced.length} voci non hanno`} una tariffa (${which}). Chiedi a chi ti scrive: «Quanto fai all'ora con questo cliente?» Poi salvala con op set_rate (client e rate) e rifai.`);
	}
	const lines = hoursLines(items, group, lineWords(period), QUOTE_LIMITS.description);
	if (lines.length > QUOTE_LIMITS.lines) return release(`Errore: verrebbero ${lines.length} righe, più delle ${QUOTE_LIMITS.lines} di un preventivo: usa group project o total.`);
	const passed = Object.fromEntries(PASSED.filter((k) => args[k] !== undefined && !(k === "format" && args[k] === "csv")).map((k) => [k, args[k]]));
	// No quote of this call yet: it is made only while this call's reservation is there (renewed now, so it holds meanwhile).
	const quotes = deps.quotes.read();
	const finished = !quotes.broken && quotes.quotes.some((q) => q.callId === ctx.callId && q.file !== undefined);
	if (!finished && !store.renew(ctx.callId)) return "Errore: le ore scelte per il preventivo non sono più tenute da parte (la richiesta si era fermata da più di un'ora): il preventivo non l'ho fatto e le ore non sono segnate. Rifai la richiesta.";
	// A throw here leaves the reservation: settled later by any change to the timesheet (billed if the quote was made, dropped past its time if not).
	const made = await createQuote({ ...passed, customer: picked.client, items: lines }, ctx);
	if (made.number === undefined) return release(`${made.text}\nLe ore non sono segnate: il preventivo non è fatto.`);
	const number = made.number;
	const billed = await ctx.step("bill", async () => {
		const done = store.bill(ctx.callId, { by: deps.by(ctx), at: deps.now().toISOString(), quote: number });
		if (done.reserved) return { changed: done.changed.length, skipped: [...done.skipped] };
		// The reservation was settled meanwhile by another change (billed with this quote): those entries are this call's.
		const mine = new Set(store.read().entries.filter((e) => e.billed?.quote === number).map((e) => e.id));
		return { changed: picked.entries.filter((r) => mine.has(r.id)).length, skipped: picked.entries.filter((r) => !mine.has(r.id)).map((r) => r.id) };
	});
	if (billed.changed > 0) await deps.audit(ctx, billed.changed);
	if (billed.changed === 0) {
		return [made.text, `Attenzione: il preventivo ${number} è fatto, ma nessuna voce di ore è segnata come nel preventivo: nel frattempo sono cambiate o sono state segnate in altro modo (${billed.skipped.slice(0, 10).join(", ")}). Ricontrollale con chi ti scrive prima di mandare il preventivo.`].join("\n");
	}
	const minutes = items.filter((p) => !billed.skipped.includes(p.entry.id)).reduce((s, p) => s + p.billed, 0);
	const skipped = billed.skipped.length === 0 ? [] : [`Attenzione: ${entries(billed.skipped.length, "cambiat")} mentre facevo il preventivo non ${billed.skipped.length === 1 ? "è segnata" : "sono segnate"} (${billed.skipped.slice(0, 10).join(", ")}): il preventivo le comprende come erano. Ricontrollale con chi ti scrive.`];
	return [
		made.text,
		`Le ore sono ora nel preventivo ${number}: ${entries(billed.changed)}, ${hoursText(minutes)} fatturabili.`,
		...skipped,
		"Quando il cliente accetta il preventivo, posso prepararne la fattura elettronica con sales_invoices: le ore si segnano come fatturate quando la fattura è emessa. Se invece la emette chi ti scrive con il suo programma, poi segna le ore come fatturate con op mark_billed e ref (il numero della fattura).",
	].join("\n");
}

/** The answer to a call run again after its entries were billed. */
function doneAnswer(number: string, all: readonly WorkEntry[]): string {
	const mine = all.filter((e) => e.billed?.quote === number);
	const state = mine.every((e) => billingState(e) === "quoted") ? `nel preventivo ${number}` : "con quel preventivo";
	return `Il preventivo ${number} è già fatto con queste ore: ${entries(mine.length)} ${state}. Mandalo con file_send o con quotes op send.`;
}
