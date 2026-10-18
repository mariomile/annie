/**
 * quotes op send: a preventivo by mail to its customer, with its document attached. The mail goes
 * on the approval card of the person's own account (mail-requests.ts, ADR 0021) and leaves only
 * when they approve it, with the file exactly as it was when asked and the quote still current.
 * Once sent, the day is recorded and an address the person gave is kept on the quote. Without a
 * mail account that can write, the text comes back to copy and the file goes in the chat.
 */
import { validAddress } from "../email-address.ts";
import type { ToolContext } from "../engine.ts";
import type { Company } from "../invoices.ts";
import { dayOfIn } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import { AttachmentError, attachFiles, attachmentsLine, type MailAttachment } from "../mail-attachments.ts";
import { type MailRequests, NO_MAIL_HERE, noMailFor, proposeMail } from "../mail-requests.ts";
import { oneLine } from "../plain-text.ts";
import { matchesCustomer, type Quote, shownStatus, validUntil } from "../quotes.ts";
import { PREPARING } from "../quote-store.ts";
import type { Workspace } from "../workspace.ts";
import { euros, fenced, totalsOf } from "./quote-render.ts";
import { isPrivateParty, mailtoLink } from "./letter-shared.ts";

type QuoteSendDeps = {
	readonly workspace: Workspace;
	readonly company: Partial<Company>;
	readonly today: string;
	readonly timeZone: string;
	readonly mail?: MailRequests;
	readonly record?: (event: { readonly type: "quote.changed"; readonly op: "send"; readonly count: number }) => Promise<void>;
};

/** Words that make a name a business even without a partita IVA on the quote. */
const BUSINESS_NAME = /\b(s\.?\s?r\.?\s?l\.?s?|s\.?\s?p\.?\s?a\.?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|soc(ietà|\.)?|coop(erativa)?|studio|ditta|associazione|consorzio|fondazione|comune|onlus)(\b|$)/i;

/** A person (Lei), not a business (voi): no partita IVA, no numeric codice fiscale, no company word in the name. */
function privateCustomer(quote: Quote): boolean {
	return isPrivateParty(quote.customer) && !BUSINESS_NAME.test(quote.customer.name);
}

/** «Beta Ristorazione Srl: preventivo n. 2026-012», or «Preventivo n. 2026-012» without a company name. */
function quoteSubject(quote: Quote, company: Partial<Company>): string {
	const from = company.name === undefined ? "" : oneLine(company.name, 200);
	return from === "" ? `Preventivo n. ${quote.number}` : `${from}: preventivo n. ${quote.number}`;
}

/** A short letter: the quote, its total and how long it holds; to a business or to a person; signed as the company. */
function quoteBody(quote: Quote, company: Partial<Company>): string {
	const t = totalsOf(quote);
	const vat = quote.lines.every((l) => l.vat === 0) ? "senza IVA" : "IVA inclusa";
	const net = t.ritenuta > 0n ? ` (netto a pagare ${euros(t.net)})` : "";
	const person = privateCustomer(quote);
	const name = oneLine(quote.customer.name, 200);
	const sign = (company.signature ?? company.name ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	return [
		person ? `Gentile ${name},` : `Spett.le ${name},`,
		"",
		`${person ? "Le" : "Vi"} inviamo in allegato il preventivo n. ${quote.number} del ${italianDate(quote.date)}, per un totale di ${euros(t.total)} ${vat}${net}.`,
		`Il preventivo è valido fino al ${italianDate(validUntil(quote))}.`,
		"",
		"Restiamo a disposizione per qualsiasi chiarimento.",
		"",
		"Cordiali saluti",
		...sign,
	].join("\n");
}

/** Why the quote should not go as it is, unless the person confirms it. */
function statusProblem(quote: Quote, args: Record<string, unknown>, today: string): string | undefined {
	if (shownStatus(quote, today) === "expired" && args.confirm_expired !== true) {
		return `Errore: il preventivo ${quote.number} è scaduto il ${italianDate(validUntil(quote))}. Chiedi se vuole rifarlo con una nuova validità (op revise con valid_days) o mandarlo così com'è (op send con confirm_expired true).`;
	}
	if (quote.status === "declined" && args.confirm_declined !== true) {
		return `Errore: il preventivo ${quote.number} è segnato rifiutato dal cliente. Chiedi se vuole mandarlo lo stesso (op send con confirm_declined true) o rifarlo con op revise.`;
	}
	return undefined;
}

/** The answer to op send for one quote already picked. */
export async function sendQuote(quote: Quote, args: Record<string, unknown>, ctx: ToolContext, deps: QuoteSendDeps): Promise<string> {
	if (quote.status === "superseded") return `Errore: il preventivo ${quote.number} è stato sostituito da ${fenced(quote.replacedBy ?? "una revisione")}: manda quello.`;
	if (quote.file === undefined) return `Errore: ${PREPARING}.`;
	if (typeof args.customer === "string" && args.customer.trim() !== "" && !matchesCustomer(quote, args.customer)) {
		return `Errore: non preparo l'invio. ${fenced(`Il preventivo ${quote.number} è di ${quote.customer.name}, non di ${args.customer.trim()}: controlla`)}`;
	}
	const problem = statusProblem(quote, args, deps.today);
	if (problem !== undefined) return problem;
	const given = typeof args.email === "string" ? args.email.trim().toLowerCase() : undefined;
	if (given !== undefined && !validAddress(given)) return "Errore: email non è un indirizzo valido.";
	const to = given ?? quote.customer.email?.toLowerCase();
	const subject = quoteSubject(quote, deps.company);
	const body = quoteBody(quote, deps.company);
	const unavailable = deps.mail === undefined ? "nessun account di posta è collegato" : await deps.mail.check(ctx.thread);
	if (unavailable !== undefined || deps.mail === undefined || ctx.thread === undefined) {
		const why = unavailable ?? "questa conversazione non ha un account di posta";
		const what = quote.file.endsWith(".docx") ? "il file Word" : "il PDF";
		const link = mailtoLink(to, subject, body);
		const tell = `Di' a chi ti scrive: «${NO_MAIL_HERE} Ti mando qui ${what} del preventivo e il testo da copiare: inoltrali tu a ${oneLine(quote.customer.name, 80)}.» Poi mandagli il file con file_send (File: ${quote.file}) e, in un messaggio a parte, soltanto l'oggetto, il testo e il link qui sotto.`;
		return `${noMailFor(why)} ${tell}\n${fenced([`A: ${to ?? "manca l'indirizzo"}`, `Oggetto: ${subject}`, "", body, "", link === undefined ? "Link: il testo è troppo lungo per un link, va copiato." : `Link: ${link}`].join("\n"))}`;
	}
	if (to === undefined || !validAddress(to)) return `Errore: non ho l'indirizzo email di ${fenced(quote.customer.name)}. Chiedilo a chi ti scrive e richiama op send con email: lo salvo sul preventivo quando la mail parte.`;
	// In a step: a replay after a crash finds the call's own card asked, not one more waiting.
	const mail = deps.mail;
	const waiting = await ctx.step("pending", async () => (await mail.pending()).quotes.has(quote.number));
	if (waiting) return `C'è già una richiesta in attesa per il preventivo ${quote.number}: approvala o rifiutala nella card.`;
	let attachments: MailAttachment[];
	try {
		attachments = await attachFiles(deps.workspace, [quote.file]);
	} catch (error) {
		if (error instanceof AttachmentError) return `Errore: ${error.message}. Se il file non c'è più, rifallo con op revise.`;
		throw error;
	}
	const save = given !== undefined && given !== quote.customer.email?.toLowerCase() ? given : undefined;
	const thread = ctx.thread;
	const reason = oneLine(`Invio del preventivo ${quote.number} a ${quote.customer.name}`, 300);
	const made = await ctx.step("propose", async () => proposeMail(mail, { thread, to, subject, body, reason, attachments, key: ctx.callId, quote: { number: quote.number, base: quote.base, ...(save === undefined ? {} : { email: save }), ...(quote.status === "declined" ? { confirmedDeclined: true as const } : {}) } }));
	if (!("id" in made)) return "Errore: ci sono troppe richieste in attesa: falle decidere e riprova.";
	await ctx.step("audit", async () => {
		await deps.record?.({ type: "quote.changed", op: "send", count: attachments.length });
		return true;
	});
	const saved = save === undefined ? "" : " L'indirizzo lo salvo sul preventivo quando la mail parte.";
	const again = quote.sentAt === undefined ? "" : ` Nota: il preventivo è già inviato per mail il ${italianDate(dayOfIn(deps.timeZone)(quote.sentAt))}: dillo a chi ti scrive.`;
	const what = quote.file.endsWith(".docx") ? "il Word" : "il PDF";
	return `Richiesta ${made.id} pronta: inviare il preventivo ${quote.number} per mail, con ${what} allegato. La persona la vede in una card qui in chat e decide lei (scade fra 24 ore): parte solo se la approva. Non dire che è inviato finché non arriva l'esito.${saved}${again}\n${fenced(`A: ${to}\nOggetto: ${subject}\n${attachmentsLine(attachments)}`)}`;
}
