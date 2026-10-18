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
import { validAddress } from "../email-address.ts";
import { BROKEN_WRITE, type InvoiceStore, REMINDERS_BROKEN } from "../invoice-store.ts";
import { dayOfIn, todayIn } from "../italian-calendar.ts";
import { type MailRequests, NO_MAIL_HERE, noMailFor } from "../mail-requests.ts";
import { bookKey, type Contact, nextLevel, type ReminderItem } from "../reminder-book.ts";
import type { Workspace } from "../workspace.ts";
import { ambiguous, fenced, type Loaded, markDay, notFound } from "./invoice-fence.ts";
import { companyText } from "./invoice-words.ts";
import { LETTER_ONLY, type ReminderArgs, reminderArgs } from "./reminder-args.ts";
import { filesToForward, type ReadText } from "./reminder-attachments.ts";
import { customersNamed, type Debtor, debtors, invoicesOf, isLate, letters, marksOn, namedInvoice } from "./reminder-debtors.ts";
import { customerName, draftsBlock, leftOver } from "./reminder-drafts.ts";
import { queueReminders } from "./reminder-queue.ts";
import { paymentOf, recipientOf } from "./reminder-sources.ts";
import { asksSomething, composeReminder, MAX_REMINDERS, type ReminderDraft } from "./reminder-text.ts";

export type ReminderEvent = { readonly type: "invoice.reminder"; readonly op: "queue" | "self" | "mail"; readonly count: number } | { readonly type: "invoice.contact"; readonly op: "save"; readonly count: 1 };

type ReminderDeps = {
	readonly load: (ctx: ToolContext) => Promise<Loaded>;
	readonly store: InvoiceStore;
	readonly timeZone: string;
	readonly now: () => Date;
	readonly who: (ctx: ToolContext) => string;
	readonly record?: (event: ReminderEvent) => Promise<void>;
	readonly mail?: MailRequests;
	/** Where the invoice files are: what attach_invoice attaches. */
	readonly workspace?: Workspace;
	/** Tests: the text of a PDF, to tell it is the invoice (default: the document reader). */
	readonly readText?: ReadText;
	/** Tests: how long one call may spend reading courtesy PDFs (default 30 seconds). */
	readonly pdfBudgetMs?: number;
};

/** Without the paid marks and the reminders sent, a reminder could go to who paid, or twice: none is written. */
const BROKEN = `Errore: ${BROKEN_WRITE}. Finché non si legge non preparo solleciti, perché non so cosa è pagato.`;
const UNREADABLE = `Errore: ${REMINDERS_BROKEN}. Finché non si leggono non preparo né annoto solleciti, perché non so quali sono già partiti.`;
const CONTACTS_UNREADABLE = "Errore: gli indirizzi dei clienti salvati in invoices.json non si leggono: finché non si sistema il file non mando solleciti e non salvo indirizzi, perché potrei scrivere all'indirizzo sbagliato. Le bozze si possono ancora leggere (senza send né email).";
const NO_COMPANY = "Errore: per i solleciti serve sapere qual è l'azienda di chi ti scrive, per distinguere le fatture da incassare: chiedila e salvala con op set_company.";

const PHONE_LEAD = `${NO_MAIL_HERE} Ti mando ogni sollecito in un messaggio a parte: tienilo premuto per copiarlo, oppure tocca il link per aprirlo già pronto nella tua posta.`;

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

/** op reminder: the drafts; with send, the mails asked for on approval cards. */
export async function reminderAnswer(args: Record<string, unknown>, ctx: ToolContext, deps: ReminderDeps): Promise<string> {
	const a = reminderArgs(args);
	if ("problem" in a) return `Errore: ${a.problem}.`;
	const today = todayIn(deps.timeZone, deps.now());
	const dayOf = dayOfIn(deps.timeZone);
	const loaded = await deps.load(ctx);
	if (loaded.book.broken) return BROKEN;
	if (loaded.book.remindersBroken === true) return UNREADABLE;
	if (loaded.book.contactsBroken === true && (a.send || a.email !== undefined)) return CONTACTS_UNREADABLE;
	const { company } = loaded.book;
	if (company === undefined) return NO_COMPANY;
	const found = targets(loaded, a, today);
	if ("answer" in found) return found.answer;
	if (a.email !== undefined && found.list.length !== 1) return "Errore: email vale per un cliente solo: indica anche party (o number).";
	if (found.list.length === 1 && !isLate(found.list[0] as Debtor)) {
		if (a.terms.level !== undefined && a.terms.level > 1) return "Errore: la fattura non è ancora scaduta: posso preparare solo un promemoria della scadenza (livello 1).";
		if (a.send) return "Errore: la fattura non è ancora scaduta: non mando solleciti. Posso preparare un promemoria della scadenza da leggere (senza send), che chi ti scrive manda da sé.";
	}
	let contacts: readonly Contact[] | "broken" = loaded.book.contactsBroken === true ? "broken" : (loaded.book.contacts ?? []);
	let saved = false;
	if (a.email !== undefined && contacts !== "broken") {
		const debtor = found.list[0] as Debtor;
		const contact: Contact = { key: debtor.key, email: a.email, by: deps.who(ctx), at: deps.now().toISOString() };
		await ctx.step("contact", async () => {
			deps.store.saveContact(contact);
			await deps.record?.({ type: "invoice.contact", op: "save", count: 1 });
			return true;
		});
		contacts = [...contacts.filter((c) => c.key !== bookKey(contact.key)), { ...contact, key: bookKey(contact.key) }];
		saved = true;
	}
	const payment = paymentOf(company, loaded.invoices, { send: a.send, today });
	const context = { today, dayOf, payment, ...(company.name === undefined ? {} : { sender: company.name }), ...(company.signature === undefined ? {} : { signature: company.signature }), ...(company.vat === undefined ? {} : { vat: company.vat }) };
	const drafts: ReminderDraft[] = [];
	const covered: Debtor[] = [];
	const remarks = [...found.remarks];
	for (const debtor of found.list) {
		const split = letters(debtor, a.terms.level);
		if (split.higher.length > 0) {
			const numbers = split.higher.map((i) => i.doc.number ?? "senza numero").join(", ");
			remarks.push(`${customerName(debtor)}: ${split.higher.length === 1 ? "la fattura" : "le fatture"} ${numbers} ${split.higher.length === 1 ? "ha" : "hanno"} già avuto un sollecito di livello più alto: non ${split.higher.length === 1 ? "la rimetto" : "le rimetto"} a livello ${a.terms.level}.`);
		}
		for (const letter of split.letters) {
			const draft = composeReminder(letter, a.terms, { ...context, recipient: recipientOf(letter, contacts, validAddress) });
			if (asksSomething(draft)) drafts.push(draft);
			else if (!covered.includes(debtor)) covered.push(debtor);
		}
	}
	const savedText = saved ? "Indirizzo salvato: lo uso anche le prossime volte. " : "";
	const extra = leftOver(covered, found.more, remarks);
	if (drafts.length === 0) {
		if (covered.length === 0) return `${savedText}Niente da preparare. ${fenced(extra.join("\n"))}`;
		return `${savedText}Niente da sollecitare: le note di credito coprono quanto dovuto. ${fenced(covered.map(customerName).join(", "))}`;
	}
	const count = drafts.length === 1 ? "un sollecito" : `${drafts.length} solleciti`;
	if (!a.send) {
		const attachOnly = a.attach ? " attach_invoice vale solo con send: niente è stato allegato." : "";
		const next = `Mostra la bozza a chi ti scrive, con le note che la riguardano. Per mandarla: op reminder con send true (parte solo dopo l'approvazione nella card). Se la manda da sé, annotala con op reminder_sent.${attachOnly}`;
		return `${savedText}Bozza: ${count}, solo da leggere, niente è stato inviato.\n${draftsBlock(drafts, extra)}\n${next}`;
	}
	if (a.party !== undefined && a.number === undefined && a.path === undefined && found.list.length > 1) {
		return `Errore: «${a.party}» corrisponde a più clienti: non preparo l'invio. Indica il nome intero o la partita IVA.\n${draftsBlock(drafts, extra)}`;
	}
	const unavailable = deps.mail === undefined ? "nessun account di posta è collegato" : await deps.mail.check(ctx.thread);
	if (unavailable !== undefined || ctx.thread === undefined || deps.mail === undefined) {
		const why = unavailable ?? "questa conversazione non ha un account di posta";
		const how = `Di' a chi ti scrive: «${PHONE_LEAD}» Poi manda un messaggio per ogni sollecito con soltanto la riga «Oggetto: …», il testo della lettera e il link: le righe che iniziano con A:, Nota: e --- sono per te e non vanno incollate. Per gli altri clienti digli di chiederti "sollecito per <nome>". Quando l'ha mandato, annotalo con op reminder_sent.`;
		const files = a.attach && deps.workspace !== undefined ? await filesToForward(deps.workspace, drafts.flatMap((d) => invoicesOf(d.debtor))) : [];
		const check = files.some((f) => f.endsWith(" (da controllare)")) ? " I PDF segnati «da controllare» li ho trovati solo dal nome, senza aprirli: digli di guardarli prima di inoltrarli." : "";
		const attach = files.length === 0 ? "" : ` Poi digli: «Ti mando qui anche le fatture: allegale tu alla mail.» e mandagli con file_send i file elencati in fondo.${check}`;
		return `${savedText}${noMailFor(why, true)} ${how}${attach}\n${draftsBlock(drafts, files.length === 0 ? extra : [...extra, `File delle fatture: ${files.join(", ")}`], true)}`;
	}
	return savedText + (await queueReminders(drafts, extra, a, ctx, deps, { today, dayOf, thread: ctx.thread, mail: deps.mail }));
}

/** «Era già annotato oggi…»: by an approved mail from the console, or by the person's own word. */
function alreadyToday(mail: boolean, level: number): string {
	return mail ? "Era già annotato oggi (inviato dalla console): non lo annoto due volte." : `Era già annotato oggi un sollecito di livello ${level}: non lo annoto due volte.`;
}

/**
 * op reminder_sent: the person says they sent a reminder themselves. Each invoice at its own
 * level (the one asked, else one past those recorded); an invoice with a reminder recorded today,
 * by the person or by an approved mail, is not recorded again unless a level is asked.
 */
export async function reminderSentAnswer(args: Record<string, unknown>, ctx: ToolContext, deps: ReminderDeps): Promise<string> {
	const extra = LETTER_ONLY.filter((k) => args[k] !== undefined);
	if (extra.length > 0) return `Errore: reminder_sent annota soltanto un sollecito già mandato da chi ti scrive: ${extra.join(", ")} non servono qui.`;
	const a = reminderArgs(args);
	if ("problem" in a) return `Errore: ${a.problem}.`;
	if (a.party === undefined && a.number === undefined && a.path === undefined) return "Errore: indica a chi è andato il sollecito: party (il cliente), o number, o path.";
	const today = todayIn(deps.timeZone, deps.now());
	const dayOf = dayOfIn(deps.timeZone);
	type Picked = { error: string } | { items: ReminderItem[]; already: number; mailToday: boolean; topToday: number; said: string };
	const picked = await ctx.step("resolve", async (): Promise<Picked> => {
		const loaded = await deps.load(ctx);
		if (loaded.book.broken) return { error: BROKEN };
		if (loaded.book.remindersBroken === true) return { error: UNREADABLE };
		if (loaded.book.company === undefined) return { error: NO_COMPANY };
		const found = targets(loaded, a, today);
		if ("answer" in found) return { error: found.answer };
		if (found.list.length > 1) return { error: `Errore: «${a.party ?? ""}» corrisponde a più clienti: indica il nome intero o la partita IVA. ${fenced(found.list.map(customerName).join(", "))}` };
		const debtor = found.list[0] as Debtor;
		const late = isLate(debtor);
		const items: ReminderItem[] = [];
		let already = 0;
		let mailToday = false;
		let topToday = 0;
		for (const invoice of invoicesOf(debtor)) {
			const todays = marksOn(invoice, today, dayOf);
			mailToday ||= todays.some((m) => m.via === "mail" && (a.terms.level === undefined || m.level === a.terms.level));
			topToday = todays.reduce((n, m) => Math.max(n, m.level), topToday);
			if (a.terms.level === undefined && todays.length > 0) {
				already++;
				continue;
			}
			items.push({ invoice: bookKey(invoice.key), level: a.terms.level ?? (late ? nextLevel(invoice.reminders) : 1) });
		}
		const invoices = invoicesOf(debtor);
		const numbers = invoices.map((i) => i.doc.number ?? "senza numero").join(", ");
		return { items, already, mailToday, topToday: a.terms.level ?? topToday, said: `${customerName(debtor)}, ${invoices.length === 1 ? "fattura" : "fatture"} ${numbers}` };
	});
	if ("error" in picked) return picked.error;
	if (picked.items.length === 0) return `${alreadyToday(picked.mailToday, picked.topToday)} ${fenced(picked.said)}`;
	const applied = await ctx.step("apply", async () => {
		const at = deps.now().toISOString();
		return { count: deps.store.remind(picked.items, { by: deps.who(ctx), at, via: "self", dayOf }), at };
	});
	if (applied.count === 0) return `${alreadyToday(picked.mailToday, picked.topToday)} ${fenced(picked.said)}`;
	await ctx.step("audit", async () => {
		await deps.record?.({ type: "invoice.reminder", op: "self", count: applied.count });
		return true;
	});
	const levels = [...new Set(picked.items.map((i) => i.level))].sort();
	const what = levels.length === 1 ? `sollecito di livello ${levels[0]}` : `solleciti di livello ${levels.slice(0, -1).join(", ")} e ${levels.at(-1)}`;
	const rest = picked.already > 0 ? ` Per ${picked.already === 1 ? "un'altra fattura" : `altre ${picked.already} fatture`} era già annotato oggi.` : "";
	return `Annotato il ${markDay(applied.at, deps.timeZone)}: ${what} mandato da chi ti scrive, per ${applied.count === 1 ? "una fattura" : `${applied.count} fatture`}.${rest} ${fenced(picked.said)}`;
}
