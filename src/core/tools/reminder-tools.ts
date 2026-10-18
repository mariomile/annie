/**
 * The scadenzario's payment reminders (invoice-tools.ts ops `reminder` and `reminder_sent`).
 * Writing a reminder only reads: the drafts come back for the person to see. Sending asks: each
 * mail goes on the approval card of the existing Google write path (google-actions.ts, ADR 0021)
 * and leaves only when the person approves it; it is recorded in the scadenzario then, never
 * before (decideGoogleAction). Without a mail account that can write, the text comes back to copy.
 * What comes from the files (names, numbers, IBAN, addresses) stays inside the fence.
 */
import type { ToolContext } from "../engine.ts";
import { GOOGLE_ACTION_LIMITS, validAddress } from "../google-actions.ts";
import { BROKEN_WRITE, type Invoice, type InvoiceStore } from "../invoices.ts";
import { todayIn } from "../italian-calendar.ts";
import type { ReminderItem, ReminderLevel } from "../reminder-book.ts";
import { ambiguous, fenced, type Loaded, markDay, notFound, sumsText } from "./invoice-render.ts";
import {
	asksSomething,
	composeReminder,
	type Debtor,
	debtors,
	LEVEL_NAMES,
	MAX_NOTE,
	MAX_REMINDERS,
	namedInvoice,
	parseRate,
	type Rate,
	type ReminderDraft,
	type ReminderTerms,
} from "./reminder-text.ts";

type Thread = { readonly channel: string; readonly threadId: string };

/** Full drafts in one answer; the other customers get one line each. */
const MAX_FULL = 3;

/** A mail asked for: what the approval card shows, and what to record once it is sent. */
export type ReminderProposal = { readonly thread: Thread; readonly to: string; readonly subject: string; readonly body: string; readonly reason: string; readonly reminders: readonly ReminderItem[]; readonly key: string };

/**
 * How reminders are sent: through the approval card of the person's own mail account. `check`
 * says why this conversation cannot (no account linked, linked read-only, not a console thread).
 */
export type ReminderMail = {
	readonly check: (thread: Thread | undefined) => Promise<string | undefined>;
	readonly propose: (proposal: ReminderProposal) => Promise<{ readonly id: string }>;
};

export type ReminderEvent = { readonly type: "invoice.reminder"; readonly op: "queue" | "self"; readonly count: number };

export type ReminderDeps = {
	readonly load: (ctx: ToolContext) => Promise<Loaded>;
	readonly store: InvoiceStore;
	readonly timeZone: string;
	readonly now: () => Date;
	readonly who: (ctx: ToolContext) => string;
	readonly record?: (event: ReminderEvent) => Promise<void>;
	readonly mail?: ReminderMail;
};

/** Without the paid marks and the reminders sent, a reminder could go to who paid: none is written. */
const BROKEN = `Errore: ${BROKEN_WRITE}. Finché non si legge non preparo solleciti, perché non so cosa è pagato.`;

const NO_COMPANY = "Errore: per i solleciti serve sapere qual è l'azienda di chi ti scrive, per distinguere le fatture da incassare: chiedila e salvala con op set_company.";

/** The arguments of the reminder ops, typed; a problem in Italian otherwise. */
type ReminderArgs = { number?: string; party?: string; path?: string; terms: ReminderTerms; send: boolean };

export function reminderArgs(args: Record<string, unknown>): ReminderArgs | { problem: string } {
	const text = (name: string) => (typeof args[name] === "string" && (args[name] as string).trim() !== "" ? (args[name] as string).trim() : undefined);
	const level = args.level;
	if (level !== undefined && level !== 1 && level !== 2 && level !== 3) return { problem: "level è 1 (cortese), 2 (più fermo) o 3 (formale)" };
	let rate: Rate | undefined;
	if (args.interest_rate !== undefined) {
		if (typeof args.interest_rate !== "string" && typeof args.interest_rate !== "number") return { problem: "interest_rate è il tasso annuo dato dalla persona, per esempio «8,5»" };
		const parsed = parseRate(String(args.interest_rate));
		if ("problem" in parsed) return { problem: parsed.problem };
		rate = parsed;
	}
	const within = args.pay_within;
	if (within !== undefined && !(Number.isInteger(within) && (within as number) >= 1 && (within as number) <= 90)) return { problem: "pay_within è un numero di giorni, da 1 a 90" };
	for (const flag of ["send", "compensation"] as const) if (args[flag] !== undefined && typeof args[flag] !== "boolean") return { problem: `${flag} è true o false` };
	if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > MAX_NOTE)) return { problem: `note è un testo di al più ${MAX_NOTE} caratteri` };
	const to = text("email");
	if (to !== undefined && !validAddress(to.toLowerCase())) return { problem: "email non è un indirizzo valido" };
	const terms: ReminderTerms = {
		...(level === undefined ? {} : { level: level as ReminderLevel }),
		...(args.compensation === true ? { compensation: true } : {}),
		...(rate === undefined ? {} : { rate }),
		...(typeof within === "number" ? { payWithin: within } : {}),
		...(typeof args.note === "string" && args.note.trim() !== "" ? { note: args.note } : {}),
		...(to === undefined ? {} : { to }),
	};
	const number = text("number");
	const party = text("party");
	const path = text("path");
	return { ...(number === undefined ? {} : { number }), ...(party === undefined ? {} : { party }), ...(path === undefined ? {} : { path }), terms, send: args.send === true };
}

/** The customers the call means, or the answer that says why there are none. */
function targets(loaded: Loaded, a: ReminderArgs, today: string): { list: Debtor[]; more: number } | { answer: string } {
	const { invoices } = loaded;
	if (a.number !== undefined || a.path !== undefined) {
		const query = { ...(a.number === undefined ? {} : { number: a.number }), ...(a.party === undefined ? {} : { party: a.party }), ...(a.path === undefined ? {} : { path: a.path }) };
		const named = namedInvoice(invoices, query);
		if ("problem" in named) {
			if (named.problem === "none") return { answer: notFound(invoices, query) };
			if (named.problem === "many") return { answer: ambiguous(named.found) };
			if (named.problem === "credit") return { answer: "Errore: è una nota di credito o un documento senza niente da incassare: non si sollecita." };
			if (named.problem === "paid") return { answer: "Errore: la fattura è segnata pagata: niente da sollecitare. Se non è così, toglile il segno con op mark_unpaid." };
			return { answer: "Errore: questa fattura è da pagare, non da incassare: i solleciti vanno ai clienti." };
		}
		const list = debtors(invoices, today, { only: named });
		if (list.length === 0) return { answer: "Errore: la fattura non ha rate aperte con un importo leggibile: niente da sollecitare." };
		return { list, more: 0 };
	}
	const all = debtors(invoices, today, a.party === undefined ? {} : { party: a.party });
	if (all.length === 0) {
		const of = a.party === undefined ? "Nessun cliente" : `Nessun cliente che corrisponde a ${fenced(a.party)}`;
		return { answer: `${of} ha fatture scadute e non segnate pagate (fatture trovate: ${invoices.length}).` };
	}
	return { list: all.slice(0, MAX_REMINDERS), more: all.length - Math.min(all.length, MAX_REMINDERS) };
}

function draftsOf(list: readonly Debtor[], a: ReminderArgs, loaded: Loaded, deps: ReminderDeps, today: string): { drafts: ReminderDraft[]; covered: Debtor[] } {
	const sender = loaded.book.company?.name ?? list[0]?.rows[0]?.invoice.supplier.name;
	const remindedToday = (invoice: Invoice) => (invoice.reminders ?? []).some((m) => todayIn(deps.timeZone, new Date(m.at)) === today);
	const drafts: ReminderDraft[] = [];
	const covered: Debtor[] = [];
	for (const debtor of list) {
		const draft = composeReminder(debtor, a.terms, { today, ...(sender === undefined ? {} : { sender }), remindedToday });
		if (asksSomething(draft)) drafts.push(draft);
		else covered.push(debtor);
	}
	return { drafts, covered };
}

function customerName(debtor: Debtor): string {
	return debtor.customer.name ?? "cliente senza nome";
}

/** One draft for the person: recipient, subject, text, remarks; all of it from the files, so fenced by the caller. */
function draftText(draft: ReminderDraft): string {
	const to = draft.to === undefined ? "A: manca l'indirizzo" : `A: ${draft.to}${draft.toFrom === "pec" ? " (PEC in fattura)" : draft.toFrom === "email" ? " (email in fattura)" : ""}`;
	const notes = draft.notes.map((n) => `Nota: ${n}.`);
	return [`Sollecito per ${customerName(draft.debtor)}, livello ${draft.level} (${LEVEL_NAMES[draft.level]})`, to, `Oggetto: ${draft.subject}`, "", draft.body, ...(notes.length === 0 ? [] : ["", ...notes])].join("\n");
}

/** One line for a customer past the full drafts. */
function draftLine(draft: ReminderDraft): string {
	return `• ${customerName(draft.debtor)}: ${sumsText(draft.net)}, livello ${draft.level}, ${draft.to === undefined ? "manca l'indirizzo" : `a ${draft.to}`}`;
}

/** The drafts as the person reads them: the first in full, the others in a line each. */
function draftsBlock(drafts: readonly ReminderDraft[], covered: readonly Debtor[], more: number): string {
	const full = drafts.slice(0, MAX_FULL).map(draftText);
	const lines = drafts.slice(MAX_FULL).map(draftLine);
	const extra = [
		...(covered.length === 0 ? [] : [`Le note di credito coprono già lo scaduto di: ${covered.map(customerName).join(", ")}.`]),
		...(more > 0 ? [`E altri ${more} clienti in ritardo, non preparati: al più ${MAX_REMINDERS} per volta.`] : []),
	];
	return fenced([full.join("\n\n---\n\n"), ...(lines.length === 0 ? [] : ["", "Altri clienti:", ...lines]), ...(extra.length === 0 ? [] : ["", ...extra])].join("\n"));
}

/** op reminder: the drafts; with send, the mails asked for on approval cards. */
export async function reminderAnswer(args: Record<string, unknown>, ctx: ToolContext, deps: ReminderDeps): Promise<string> {
	const a = reminderArgs(args);
	if ("problem" in a) return `Errore: ${a.problem}.`;
	const today = todayIn(deps.timeZone, deps.now());
	const loaded = await deps.load(ctx);
	if (loaded.book.broken) return BROKEN;
	if (loaded.book.company === undefined) return NO_COMPANY;
	const found = targets(loaded, a, today);
	if ("answer" in found) return found.answer;
	if (a.terms.to !== undefined && found.list.length !== 1) return "Errore: email vale per un cliente solo: indica anche party (o number).";
	const { drafts, covered } = draftsOf(found.list, a, loaded, deps, today);
	if (drafts.length === 0) return `Niente da sollecitare: le note di credito coprono lo scaduto. ${fenced(covered.map(customerName).join(", "))}`;
	const count = drafts.length === 1 ? "un sollecito" : `${drafts.length} solleciti`;
	if (!a.send) {
		const next = "Mostra la bozza a chi ti scrive. Per mandarla: op reminder con send true (parte solo dopo l'approvazione nella card). Se la manda da sé, annotala con op reminder_sent.";
		return `Bozza: ${count}, solo da leggere, niente è stato inviato.\n${draftsBlock(drafts, covered, found.more)}\n${next}`;
	}
	if (a.party !== undefined && a.number === undefined && a.path === undefined && found.list.length > 1) {
		return `Errore: «${a.party}» corrisponde a più clienti: non preparo l'invio. Indica il nome intero o la partita IVA.\n${draftsBlock(drafts, covered, found.more)}`;
	}
	const unavailable = deps.mail === undefined ? "nessun account di posta è collegato" : await deps.mail.check(ctx.thread);
	if (unavailable !== undefined || ctx.thread === undefined) {
		const why = unavailable ?? "questa conversazione non ha un account di posta";
		return `Non posso inviare mail da qui (${why}): niente è stato inviato né annotato. Ecco il testo da copiare e incollare nella sua posta.\n${draftsBlock(drafts, covered, found.more)}\nQuando l'ha mandato, annotalo con op reminder_sent.`;
	}
	const thread = ctx.thread;
	const mail = deps.mail as ReminderMail;
	const fits = (d: ReminderDraft) => d.body.length <= GOOGLE_ACTION_LIMITS.maxBody;
	const ready = drafts.filter((d) => d.to !== undefined && fits(d));
	const missing = drafts.filter((d) => d.to === undefined && fits(d));
	const long = drafts.filter((d) => !fits(d));
	// Each request in a step of its own, keyed by the call: a rerun finds the same request, never a second one.
	const asked: { name: string; id: string; to: string }[] = [];
	for (const draft of ready) {
		const id = await ctx.step(`propose:${draft.debtor.key}`, async () => {
			const reason = `Sollecito di pagamento (livello ${draft.level}) a ${customerName(draft.debtor)}`.slice(0, 300);
			const made = await mail.propose({ thread, to: draft.to as string, subject: draft.subject, body: draft.body, reason, reminders: draft.items, key: `${ctx.callId}:${draft.debtor.key}` });
			return made.id;
		});
		asked.push({ name: customerName(draft.debtor), id, to: draft.to as string });
	}
	if (asked.length > 0) {
		await ctx.step("audit", async () => {
			await deps.record?.({ type: "invoice.reminder", op: "queue", count: asked.length });
			return true;
		});
	}
	const parts: string[] = [];
	if (asked.length > 0) {
		const lines = asked.map((x) => `• ${x.name}: a ${x.to} (richiesta ${x.id})`);
		parts.push(
			`${asked.length === 1 ? "Ho preparato una richiesta di invio" : `Ho preparato ${asked.length} richieste di invio`}: la persona le vede nelle card qui in chat e decide lei, una per una (scadono fra 24 ore). Parte solo ciò che approva, e il sollecito si annota allora. Non dire che è inviato finché non arriva l'esito.`,
			fenced(lines.join("\n")),
		);
	}
	if (missing.length > 0) {
		parts.push(`Per ${missing.length === 1 ? "un cliente" : `${missing.length} clienti`} manca l'indirizzo: chiedilo a chi ti scrive e richiama con party ed email. Le bozze:`, draftsBlock(missing, [], 0));
	}
	if (long.length > 0) {
		parts.push(`Per ${long.length === 1 ? "un cliente" : `${long.length} clienti`} il testo è troppo lungo per una mail (più di ${GOOGLE_ACTION_LIMITS.maxBody} caratteri): sollecita una fattura alla volta con number. ${fenced(long.map((d) => customerName(d.debtor)).join(", "))}`);
	}
	return parts.join("\n");
}

/** op reminder_sent: the person says they sent a reminder themselves. */
export async function reminderSentAnswer(args: Record<string, unknown>, ctx: ToolContext, deps: ReminderDeps): Promise<string> {
	const a = reminderArgs(args);
	if ("problem" in a) return `Errore: ${a.problem}.`;
	if (a.party === undefined && a.number === undefined && a.path === undefined) return "Errore: indica a chi è andato il sollecito: party (il cliente), o number, o path.";
	const today = todayIn(deps.timeZone, deps.now());
	type Picked = { error: string } | { items: ReminderItem[]; level: number; said: string };
	const picked = await ctx.step("resolve", async (): Promise<Picked> => {
		const loaded = await deps.load(ctx);
		if (loaded.book.broken) return { error: BROKEN };
		if (loaded.book.company === undefined) return { error: NO_COMPANY };
		const found = targets(loaded, a, today);
		if ("answer" in found) return { error: found.answer };
		if (found.list.length > 1) return { error: `Errore: «${a.party ?? ""}» corrisponde a più clienti: indica il nome intero o la partita IVA. ${fenced(found.list.map(customerName).join(", "))}` };
		const debtor = found.list[0] as Debtor;
		const draft = composeReminder(debtor, a.terms, { today, remindedToday: () => false });
		const invoices = [...new Set(debtor.rows.map((r) => r.invoice))];
		const numbers = invoices.map((i) => i.doc.number ?? "senza numero").join(", ");
		return { items: [...draft.items], level: draft.level, said: `${customerName(debtor)}, ${invoices.length === 1 ? "fattura" : "fatture"} ${numbers}` };
	});
	if ("error" in picked) return picked.error;
	const applied = await ctx.step("apply", async () => {
		const at = deps.now().toISOString();
		return { count: deps.store.remind(picked.items, { by: deps.who(ctx), at, via: "self" }), at };
	});
	if (applied.count > 0) {
		await ctx.step("audit", async () => {
			await deps.record?.({ type: "invoice.reminder", op: "self", count: applied.count });
			return true;
		});
	}
	return `Annotato il ${markDay(applied.at, deps.timeZone)}: sollecito di livello ${picked.level} mandato da chi ti scrive, per ${applied.count === 1 ? "una fattura" : `${applied.count} fatture`}. ${fenced(picked.said)}`;
}
