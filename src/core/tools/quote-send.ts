/**
 * quotes op send: a preventivo by mail to its customer, with its document attached. The mail goes
 * on the approval card of the person's own account (google-actions.ts, ADR 0021) and leaves only
 * when they approve it, with the file exactly as it was when asked. Without a mail account that
 * can write, the text comes back to copy and the file is sent here with file_send.
 */
import { validAddress } from "../email-address.ts";
import type { ToolContext } from "../engine.ts";
import { GoogleActionError } from "../google-actions.ts";
import type { Company } from "../invoices.ts";
import { italianDate } from "../italian-format.ts";
import { AttachmentError, attachFiles, attachmentsLine, type MailAttachment } from "../mail-attachments.ts";
import { type Quote, shownStatus, validUntil } from "../quotes.ts";
import { PREPARING, type QuoteStore } from "../quote-store.ts";
import type { Workspace } from "../workspace.ts";
import { euros, fenced, totalsOf } from "./quote-render.ts";

type Thread = { readonly channel: string; readonly threadId: string };

/** A quote's mail asked for: what the approval card shows. */
export type QuoteMailProposal = { readonly thread: Thread; readonly to: string; readonly subject: string; readonly body: string; readonly reason: string; readonly attachments: readonly MailAttachment[]; readonly key: string };

/**
 * How quotes are sent: through the approval card of the person's own mail account. `check` says
 * why this conversation cannot (not a console thread, no account, read only); `propose` throws
 * GoogleActionError when too many requests wait.
 */
export type QuoteMail = {
	readonly check: (thread: Thread | undefined) => Promise<string | undefined>;
	readonly propose: (proposal: QuoteMailProposal) => Promise<{ readonly id: string }>;
};

export type QuoteSendDeps = {
	readonly workspace: Workspace;
	readonly store: QuoteStore;
	readonly company: Partial<Company>;
	readonly today: string;
	readonly mail?: QuoteMail;
	readonly record?: (event: { readonly type: "quote.changed"; readonly op: "send"; readonly count: number }) => Promise<void>;
};

/** One line of a header: no line breaks, no runs of spaces. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** «Preventivo n. 2026-012: Beta Ristorazione Srl». */
export function quoteSubject(quote: Quote, company: Partial<Company>): string {
	const from = company.name === undefined ? "" : `: ${oneLine(company.name)}`;
	return `Preventivo n. ${quote.number}${from}`.slice(0, 300);
}

/** A short letter: the quote, its total and how long it holds; signed as the company. */
export function quoteBody(quote: Quote, company: Partial<Company>): string {
	const t = totalsOf(quote);
	const net = t.ritenuta > 0n ? ` (netto a pagare ${euros(t.net)})` : "";
	const sign = company.signature ?? company.name ?? "";
	return [
		`Gentile ${oneLine(quote.customer.name)},`,
		"",
		`in allegato il preventivo n. ${quote.number} del ${italianDate(quote.date)}, per un totale di ${euros(t.total)}${net}.`,
		`Il preventivo è valido fino al ${italianDate(validUntil(quote))}.`,
		"",
		"Resto a disposizione per qualsiasi chiarimento.",
		"",
		"Cordiali saluti",
		...(sign === "" ? [] : [sign]),
	].join("\n");
}

/** The answer to op send for one quote already picked. */
export async function sendQuote(quote: Quote, args: Record<string, unknown>, ctx: ToolContext, deps: QuoteSendDeps): Promise<string> {
	if (quote.status === "superseded") return `Errore: il preventivo ${quote.number} è stato sostituito da ${fenced(quote.replacedBy ?? "una revisione")}: manda quello.`;
	if (quote.file === undefined) return `Errore: ${PREPARING}.`;
	if (!quote.file.endsWith(".pdf") && !quote.file.endsWith(".docx")) return "Errore: il file del preventivo non è un PDF né un Word: rifallo con op revise.";
	const given = typeof args.email === "string" ? args.email.trim().toLowerCase() : undefined;
	if (given !== undefined && !validAddress(given)) return "Errore: email non è un indirizzo valido.";
	const to = given ?? quote.customer.email?.toLowerCase();
	if (to === undefined || !validAddress(to)) return `Errore: non ho l'indirizzo email di ${fenced(quote.customer.name)}. Chiedilo a chi ti scrive e richiama op send con email: lo salvo sul preventivo per le prossime volte.`;
	const subject = quoteSubject(quote, deps.company);
	const body = quoteBody(quote, deps.company);
	let attachments: MailAttachment[];
	try {
		attachments = await attachFiles(deps.workspace, [quote.file]);
	} catch (error) {
		if (error instanceof AttachmentError) return `Errore: ${error.message}. Se il file non c'è più, rifallo con op revise.`;
		throw error;
	}
	let saved = "";
	if (given !== undefined && given !== quote.customer.email) {
		await ctx.step("email", async () => {
			deps.store.setEmail(quote.number, given);
			return true;
		});
		saved = "Indirizzo salvato sul preventivo: lo riuso le prossime volte. ";
	}
	const late = shownStatus(quote, deps.today) === "expired" ? " È scaduto: se serve, rifallo con op revise e una nuova validità prima di mandarlo." : "";
	const unavailable = deps.mail === undefined ? "nessun account di posta è collegato" : await deps.mail.check(ctx.thread);
	if (unavailable !== undefined || deps.mail === undefined || ctx.thread === undefined) {
		const why = unavailable ?? "questa conversazione non ha un account di posta";
		return `${saved}Non posso inviare mail da qui (${why}): niente è stato inviato. Mandalo con file_send (File: ${quote.file}) e di' a chi ti scrive: «Da qui non posso mandare mail: l'allegato puoi mandarlo da qui con file_send, ecco il testo da copiare.» Poi il testo:${late}\n${fenced(`A: ${to}\nOggetto: ${subject}\n\n${body}`)}`;
	}
	const mail = deps.mail;
	const thread = ctx.thread;
	const made = await ctx.step("propose", async (): Promise<{ id: string } | { full: true }> => {
		try {
			return await mail.propose({ thread, to, subject, body, reason: oneLine(`Invio del preventivo ${quote.number} a ${quote.customer.name}`).slice(0, 300), attachments, key: ctx.callId });
		} catch (error) {
			if (error instanceof GoogleActionError) return { full: true };
			throw error;
		}
	});
	if (!("id" in made)) return `${saved}Errore: ci sono troppe richieste in attesa: falle decidere e riprova.`;
	await ctx.step("audit", async () => {
		await deps.record?.({ type: "quote.changed", op: "send", count: attachments.length });
		return true;
	});
	return `${saved}Richiesta ${made.id} pronta: inviare il preventivo ${quote.number} per mail, con ${quote.file.endsWith(".docx") ? "il Word" : "il PDF"} allegato. La persona la vede in una card qui in chat e decide lei (scade fra 24 ore): parte solo se la approva. Non dire che è inviato finché non arriva l'esito.${late}\n${fenced(`A: ${to}\nOggetto: ${subject}\n${attachmentsLine(attachments)}`)}`;
}
