/**
 * The scadenzario's payment reminders (invoice-tools.ts ops `reminder` and `reminder_sent`).
 * Writing a reminder only reads (unless the person gives an address, which is saved). Sending
 * asks: each mail goes on the approval card of the existing Google write path (google-actions.ts,
 * ADR 0021) and leaves only when the person approves it; it is recorded then, never before
 * (decideGoogleAction). Without a mail account that can write, the letters come back one per
 * message, to copy or open with a mailto: link. What comes from the files (names, numbers, IBAN,
 * addresses) stays inside the fence.
 */
import type { ToolContext } from "../engine.ts";
import { GOOGLE_ACTION_LIMITS, GoogleActionError, validAddress } from "../google-actions.ts";
import { sumsText } from "../invoice-sums.ts";
import { BROKEN_WRITE, type InvoiceStore, REMINDERS_BROKEN } from "../invoice-store.ts";
import type { Invoice } from "../invoices.ts";
import { todayIn } from "../italian-calendar.ts";
import type { Contact, ReminderItem, ReminderLevel } from "../reminder-book.ts";
import { ambiguous, fenced, type Loaded, markDay, notFound } from "./invoice-fence.ts";
import { companyText } from "./invoice-words.ts";
import { customersNamed, type Debtor, debtors, invoicesOf, isLate, lastFormal, levelOf, namedInvoice, remindedOn } from "./reminder-debtors.ts";
import { mailtoLink, parseRate, paymentOf, type Rate, recipientOf } from "./reminder-sources.ts";
import { asksSomething, composeReminder, LEVEL_NAMES, MAX_NOTE, MAX_REMINDERS, type ReminderDraft, type ReminderTerms } from "./reminder-text.ts";

type Thread = { readonly channel: string; readonly threadId: string };

/** Full drafts in one answer; the other customers get one line each. */
const MAX_FULL = 3;

/** A mail asked for: what the approval card shows, and what to record once it is sent. */
export type ReminderProposal = { readonly thread: Thread; readonly to: string; readonly subject: string; readonly body: string; readonly reason: string; readonly reminders: readonly ReminderItem[]; readonly key: string };

/**
 * How reminders are sent: through the approval card of the person's own mail account. `check`
 * says why this conversation cannot (no account linked, linked read-only, not a console thread);
 * `pending` the invoices with a reminder card still to decide; `propose` throws GoogleActionError
 * when too many requests wait.
 */
export type ReminderMail = {
	readonly check: (thread: Thread | undefined) => Promise<string | undefined>;
	readonly pending: () => Promise<ReadonlySet<string>>;
	readonly propose: (proposal: ReminderProposal) => Promise<{ readonly id: string }>;
};

export type ReminderEvent = { readonly type: "invoice.reminder"; readonly op: "queue" | "self" | "mail"; readonly count: number } | { readonly type: "invoice.contact"; readonly op: "save"; readonly count: 1 };

export type ReminderDeps = {
	readonly load: (ctx: ToolContext) => Promise<Loaded>;
	readonly store: InvoiceStore;
	readonly timeZone: string;
	readonly now: () => Date;
	readonly who: (ctx: ToolContext) => string;
	readonly record?: (event: ReminderEvent) => Promise<void>;
	readonly mail?: ReminderMail;
};

/** Without the paid marks and the reminders sent, a reminder could go to who paid, or twice: none is written. */
const BROKEN = `Errore: ${BROKEN_WRITE}. Finché non si legge non preparo solleciti, perché non so cosa è pagato.`;
const UNREADABLE = `Errore: ${REMINDERS_BROKEN}. Finché non si leggono non preparo né annoto solleciti, perché non so quali sono già partiti.`;
const NO_COMPANY = "Errore: per i solleciti serve sapere qual è l'azienda di chi ti scrive, per distinguere le fatture da incassare: chiedila e salvala con op set_company.";

const PHONE_LEAD = "Da qui non posso inviare mail. Ti mando ogni sollecito in un messaggio a parte: tienilo premuto per copiarlo, oppure tocca il link per aprirlo già pronto nella tua posta.";

/** The arguments of the reminder ops, typed; a problem in Italian otherwise. */
type ReminderArgs = { number?: string; party?: string; path?: string; email?: string; terms: ReminderTerms; send: boolean };

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
	const email = text("email")?.toLowerCase();
	if (email !== undefined && !validAddress(email)) return { problem: "email non è un indirizzo valido" };
	const terms: ReminderTerms = {
		...(level === undefined ? {} : { level: level as ReminderLevel }),
		...(args.compensation === true ? { compensation: true } : {}),
		...(rate === undefined ? {} : { rate }),
		...(typeof within === "number" ? { payWithin: within } : {}),
		...(typeof args.note === "string" && args.note.trim() !== "" ? { note: args.note } : {}),
	};
	const number = text("number");
	const party = text("party");
	const path = text("path");
	return { ...(number === undefined ? {} : { number }), ...(party === undefined ? {} : { party }), ...(path === undefined ? {} : { path }), ...(email === undefined ? {} : { email }), terms, send: args.send === true };
}

/** The customers the call means, with remarks (another customer the words fit), or the answer that says why there are none. */
function targets(loaded: Loaded, a: ReminderArgs, today: string): { list: Debtor[]; more: number; remarks: string[] } | { answer: string } {
	const { invoices } = loaded;
	if (!invoices.some((i) => i.side === "active")) {
		const company = loaded.book.company === undefined ? "" : companyText(loaded.book.company);
		return { answer: `Nessuna fattura risulta emessa da ${fenced(company)} tra le ${invoices.length} del workspace: controlla il nome o salva la partita IVA con set_company.` };
	}
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
		return { list, more: 0, remarks: [] };
	}
	const all = debtors(invoices, today, a.party === undefined ? {} : { party: a.party });
	const remarks: string[] = [];
	if (a.party !== undefined) {
		const late = new Set(all.map((d) => d.key));
		const others = [...customersNamed(invoices, a.party)].filter(([key]) => !late.has(key)).map(([, name]) => name);
		if (others.length > 0 && all.length > 0) remarks.push(`«${a.party}» corrisponde anche a ${others.slice(0, 3).join(", ")}, senza fatture scadute.`);
	}
	if (all.length === 0) {
		const of = a.party === undefined ? "Nessun cliente" : `Nessun cliente che corrisponde a ${fenced(a.party)}`;
		return { answer: `${of} ha fatture scadute e non segnate pagate (fatture trovate: ${invoices.length}).` };
	}
	return { list: all.slice(0, MAX_REMINDERS), more: all.length - Math.min(all.length, MAX_REMINDERS), remarks };
}

function customerName(debtor: Debtor): string {
	return debtor.customer.name ?? "cliente senza nome";
}

/** One draft for the model: recipient, subject, text, remarks; all of it from the files, so fenced by the caller. */
function draftText(draft: ReminderDraft, link: boolean): string {
	const to = draft.to === undefined ? "A: manca l'indirizzo" : `A: ${draft.to}${draft.toFrom === "pec" ? " (PEC di recapito SdI)" : draft.toFrom === "file" ? " (scritto in fattura)" : draft.toFrom === "saved" ? " (salvato)" : ""}`;
	const head = [`--- Sollecito per ${customerName(draft.debtor)}, livello ${draft.level} (${draft.late ? LEVEL_NAMES[draft.level] : "promemoria di scadenza"})`, to, ...draft.notes.map((n) => `Nota: ${n}.`)];
	const message = [`Oggetto: ${draft.subject}`, "", draft.body];
	if (!link) return [...head, ...message].join("\n");
	const mailto = mailtoLink(draft.to, draft.subject, draft.body);
	return [...head, "Messaggio da mandare:", ...message, "", mailto === undefined ? "Link: il testo è troppo lungo per un link, va copiato." : `Link: ${mailto}`].join("\n");
}

/** One line for a customer past the full drafts. */
function draftLine(draft: ReminderDraft): string {
	return `• ${customerName(draft.debtor)}: ${sumsText(draft.net)}, livello ${draft.level}, ${draft.to === undefined ? "manca l'indirizzo" : `indirizzo: ${draft.to}`}`;
}

/** Who was not prepared, and why: credit notes covering the debt, past the cap, words fitting others. */
function leftOver(covered: readonly Debtor[], more: number, remarks: readonly string[]): string[] {
	return [
		...(covered.length === 0 ? [] : [`Le note di credito coprono già quanto dovuto da: ${covered.map(customerName).join(", ")}.`]),
		...(more > 0 ? [`E altri ${more} clienti in ritardo, non preparati: al più ${MAX_REMINDERS} per volta.`] : []),
		...remarks,
	];
}

/** The drafts as the person reads them: the first MAX_FULL in full, the others in a line each with how to ask for them. */
function draftsBlock(drafts: readonly ReminderDraft[], extra: readonly string[], link = false): string {
	const full = drafts.slice(0, MAX_FULL).map((d) => draftText(d, link));
	const rest = drafts.slice(MAX_FULL);
	const lines = rest.length === 0 ? [] : ["", `Per gli altri chiedimi "sollecito per <nome>":`, ...rest.map(draftLine)];
	return fenced([full.join("\n\n"), ...lines, ...(extra.length === 0 ? [] : ["", ...extra])].join("\n"));
}

/** Why a draft is not sent now, if it is not. */
function skipReason(draft: ReminderDraft, terms: ReminderTerms, pending: ReadonlySet<string>, context: { today: string; dayOf: (at: string) => string }): string | undefined {
	if (remindedOn(draft.debtor, context.today, context.dayOf).length > 0) return "già sollecitato oggi";
	if (draft.items.some((i) => pending.has(i.invoice))) return "c'è già una richiesta di invio in attesa di decisione";
	if (terms.level === undefined && draft.level === 3 && lastFormal(draft.debtor) !== undefined) return "il sollecito formale è già stato mandato: per rimandarlo serve che chi ti scrive lo chieda, con level 3";
	if (draft.body.length > GOOGLE_ACTION_LIMITS.maxBody) return `testo troppo lungo per una mail (più di ${GOOGLE_ACTION_LIMITS.maxBody} caratteri): sollecita una fattura alla volta con number`;
	return undefined;
}

/** op reminder: the drafts; with send, the mails asked for on approval cards. */
export async function reminderAnswer(args: Record<string, unknown>, ctx: ToolContext, deps: ReminderDeps): Promise<string> {
	const a = reminderArgs(args);
	if ("problem" in a) return `Errore: ${a.problem}.`;
	const today = todayIn(deps.timeZone, deps.now());
	const dayOf = (at: string) => todayIn(deps.timeZone, new Date(at));
	const loaded = await deps.load(ctx);
	if (loaded.book.broken) return BROKEN;
	if (loaded.book.remindersBroken === true) return UNREADABLE;
	if (loaded.book.company === undefined) return NO_COMPANY;
	const found = targets(loaded, a, today);
	if ("answer" in found) return found.answer;
	if (a.email !== undefined && found.list.length !== 1) return "Errore: email vale per un cliente solo: indica anche party (o number).";
	if (found.list.length === 1 && !isLate(found.list[0] as Debtor)) {
		if (a.terms.level !== undefined && a.terms.level > 1) return "Errore: la fattura non è ancora scaduta: posso preparare solo un promemoria della scadenza (livello 1).";
		if (a.send) return "Errore: la fattura non è ancora scaduta: non mando solleciti. Posso preparare un promemoria della scadenza da leggere (senza send), che chi ti scrive manda da sé.";
	}
	let contacts: readonly Contact[] = loaded.book.contacts ?? [];
	let saved = false;
	if (a.email !== undefined) {
		const debtor = found.list[0] as Debtor;
		const contact: Contact = { key: debtor.key, email: a.email, by: deps.who(ctx), at: deps.now().toISOString() };
		await ctx.step("contact", async () => {
			deps.store.saveContact(contact);
			await deps.record?.({ type: "invoice.contact", op: "save", count: 1 });
			return true;
		});
		contacts = [...contacts.filter((c) => c.key !== contact.key), contact];
		saved = true;
	}
	const payment = paymentOf(loaded.book.company, loaded.invoices);
	const sender = loaded.book.company.name ?? found.list[0]?.rows[0]?.invoice.supplier.name;
	const { signature } = loaded.book.company;
	const drafts: ReminderDraft[] = [];
	const covered: Debtor[] = [];
	for (const debtor of found.list) {
		const recipient = recipientOf(debtor, undefined, contacts, validAddress);
		const draft = composeReminder(debtor, a.terms, { today, dayOf, payment, recipient, ...(sender === undefined ? {} : { sender }), ...(signature === undefined ? {} : { signature }) });
		if (asksSomething(draft)) drafts.push(draft);
		else covered.push(debtor);
	}
	const savedText = saved ? "Indirizzo salvato: lo uso anche le prossime volte. " : "";
	const extra = leftOver(covered, found.more, found.remarks);
	if (drafts.length === 0) return `${savedText}Niente da sollecitare: le note di credito coprono quanto dovuto. ${fenced(covered.map(customerName).join(", "))}`;
	const count = drafts.length === 1 ? "un sollecito" : `${drafts.length} solleciti`;
	if (!a.send) {
		const next = "Mostra la bozza a chi ti scrive, con le note che la riguardano. Per mandarla: op reminder con send true (parte solo dopo l'approvazione nella card). Se la manda da sé, annotala con op reminder_sent.";
		return `${savedText}Bozza: ${count}, solo da leggere, niente è stato inviato.\n${draftsBlock(drafts, extra)}\n${next}`;
	}
	if (a.party !== undefined && a.number === undefined && a.path === undefined && found.list.length > 1) {
		return `Errore: «${a.party}» corrisponde a più clienti: non preparo l'invio. Indica il nome intero o la partita IVA.\n${draftsBlock(drafts, extra)}`;
	}
	const unavailable = deps.mail === undefined ? "nessun account di posta è collegato" : await deps.mail.check(ctx.thread);
	if (unavailable !== undefined || ctx.thread === undefined || deps.mail === undefined) {
		const why = unavailable ?? "questa conversazione non ha un account di posta";
		const how = `Di' a chi ti scrive: «${PHONE_LEAD}» Poi manda un messaggio per ogni cliente con soltanto la riga «Oggetto: …», il testo della lettera e il link: le righe che iniziano con A:, Nota: e --- sono per te e non vanno incollate. Per gli altri clienti digli di chiederti "sollecito per <nome>". Quando l'ha mandato, annotalo con op reminder_sent.`;
		return `${savedText}Non posso inviare mail da qui (${why}): niente è stato inviato né annotato. ${how}\n${draftsBlock(drafts, extra, true)}`;
	}
	return savedText + (await queue(drafts, extra, a, ctx, deps, { today, dayOf, thread: ctx.thread, mail: deps.mail }));
}

/** Each draft that may go, on an approval card of its own; the others said with why. */
async function queue(drafts: readonly ReminderDraft[], extra: readonly string[], a: ReminderArgs, ctx: ToolContext, deps: ReminderDeps, env: { today: string; dayOf: (at: string) => string; thread: Thread; mail: ReminderMail }): Promise<string> {
	const pending = await env.mail.pending();
	const skipped: string[] = [];
	const missing: ReminderDraft[] = [];
	const asked: { draft: ReminderDraft; id: string }[] = [];
	let full = 0;
	for (const draft of drafts) {
		const reason = skipReason(draft, a.terms, pending, env);
		if (reason !== undefined) {
			skipped.push(`• ${customerName(draft.debtor)}: non preparato, ${reason}.`);
			continue;
		}
		if (draft.to === undefined) {
			missing.push(draft);
			continue;
		}
		if (full > 0) {
			full++;
			continue;
		}
		// Each request in a step of its own, keyed by the call: a rerun finds the same request, never a second one.
		const made = await ctx.step(`propose:${draft.debtor.key}`, async (): Promise<{ id: string } | { full: true }> => {
			const reason = `Sollecito di pagamento (livello ${draft.level}) a ${customerName(draft.debtor)}`.slice(0, 300);
			try {
				return await env.mail.propose({ thread: env.thread, to: draft.to as string, subject: draft.subject, body: draft.body, reason, reminders: draft.items, key: `${ctx.callId}:${draft.debtor.key}` });
			} catch (error) {
				if (error instanceof GoogleActionError) return { full: true };
				throw error;
			}
		});
		if ("id" in made) asked.push({ draft, id: made.id });
		else full++;
	}
	if (asked.length > 0) {
		await ctx.step("audit", async () => {
			await deps.record?.({ type: "invoice.reminder", op: "queue", count: asked.length });
			return true;
		});
	}
	const parts: string[] = [];
	if (asked.length > 0) {
		const lead =
			asked.length === 1
				? "Ho preparato una richiesta di invio: la persona la vede nella card qui in chat e decide lei (scade fra 24 ore)."
				: `Ho preparato ${asked.length} richieste di invio: la persona le vede nelle card qui in chat e decide lei, una per una (scadono fra 24 ore).`;
		parts.push(`${lead} Parte solo ciò che approva, e il sollecito si annota allora. Non dire che è inviato finché non arriva l'esito. Riferisci in breve le note.`);
	}
	if (full > 0) parts.push(`${asked.length > 0 ? `Per gli altri ${full}` : `Per ${full === 1 ? "questo cliente" : `questi ${full} clienti`}`} ci sono troppe richieste in attesa: falle decidere e riprova.`);
	const lines = asked.flatMap(({ draft, id }) => [`• ${customerName(draft.debtor)}, livello ${draft.level}, indirizzo: ${draft.to} (richiesta ${id})`, ...draft.notes.map((n) => `  Nota: ${n}.`)]);
	const data = [...lines, ...skipped, ...extra];
	if (data.length > 0) parts.push(fenced(data.join("\n")));
	if (missing.length > 0) {
		parts.push(`Per ${missing.length === 1 ? "un cliente" : `${missing.length} clienti`} manca l'indirizzo: chiedilo a chi ti scrive e richiama con party ed email (lo salvo per le prossime volte). Le bozze:`, draftsBlock(missing, []));
	}
	if (asked.length === 0 && full === 0 && missing.length === 0) parts.unshift("Nessuna richiesta preparata.");
	return parts.join("\n");
}

/** Arguments that only make sense for writing a letter: reminder_sent refuses them rather than ignore them. */
const LETTER_ONLY = ["send", "email", "compensation", "interest_rate", "pay_within", "note"] as const;

/** op reminder_sent: the person says they sent a reminder themselves. */
export async function reminderSentAnswer(args: Record<string, unknown>, ctx: ToolContext, deps: ReminderDeps): Promise<string> {
	const extra = LETTER_ONLY.filter((k) => args[k] !== undefined);
	if (extra.length > 0) return `Errore: reminder_sent annota soltanto un sollecito già mandato da chi ti scrive: ${extra.join(", ")} non servono qui.`;
	const a = reminderArgs(args);
	if ("problem" in a) return `Errore: ${a.problem}.`;
	if (a.party === undefined && a.number === undefined && a.path === undefined) return "Errore: indica a chi è andato il sollecito: party (il cliente), o number, o path.";
	const today = todayIn(deps.timeZone, deps.now());
	type Picked = { error: string } | { items: ReminderItem[]; level: number; said: string };
	const picked = await ctx.step("resolve", async (): Promise<Picked> => {
		const loaded = await deps.load(ctx);
		if (loaded.book.broken) return { error: BROKEN };
		if (loaded.book.remindersBroken === true) return { error: UNREADABLE };
		if (loaded.book.company === undefined) return { error: NO_COMPANY };
		const found = targets(loaded, a, today);
		if ("answer" in found) return { error: found.answer };
		if (found.list.length > 1) return { error: `Errore: «${a.party ?? ""}» corrisponde a più clienti: indica il nome intero o la partita IVA. ${fenced(found.list.map(customerName).join(", "))}` };
		const debtor = found.list[0] as Debtor;
		// Said twice the same day: the same level as the mark already there, so it is not counted twice.
		const dayOf = (instant: string) => todayIn(deps.timeZone, new Date(instant));
		const todays = invoicesOf(debtor).flatMap((i) => (i.reminders ?? []).filter((m) => m.via === "self" && dayOf(m.at) === today));
		const again = todays.reduce<ReminderLevel | undefined>((top, m) => (top === undefined || m.level > top ? m.level : top), undefined);
		const level: ReminderLevel = a.terms.level ?? again ?? (isLate(debtor) ? levelOf(debtor, undefined) : 1);
		const invoices: Invoice[] = invoicesOf(debtor);
		const numbers = invoices.map((i) => i.doc.number ?? "senza numero").join(", ");
		return { items: invoices.map((i) => ({ invoice: i.key, level })), level, said: `${customerName(debtor)}, ${invoices.length === 1 ? "fattura" : "fatture"} ${numbers}` };
	});
	if ("error" in picked) return picked.error;
	const applied = await ctx.step("apply", async () => {
		const at = deps.now().toISOString();
		const dayOf = (instant: string) => todayIn(deps.timeZone, new Date(instant));
		return { count: deps.store.remind(picked.items, { by: deps.who(ctx), at, via: "self", dayOf }), at };
	});
	if (applied.count === 0) return `Era già annotato oggi un sollecito di livello ${picked.level}: non lo annoto due volte. ${fenced(picked.said)}`;
	await ctx.step("audit", async () => {
		await deps.record?.({ type: "invoice.reminder", op: "self", count: applied.count });
		return true;
	});
	return `Annotato il ${markDay(applied.at, deps.timeZone)}: sollecito di livello ${picked.level} mandato da chi ti scrive, per ${applied.count === 1 ? "una fattura" : `${applied.count} fatture`}. ${fenced(picked.said)}`;
}
