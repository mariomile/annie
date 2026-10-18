/**
 * Mails other tools ask for (payment reminders, quotes): each one an approval card of the person's
 * own Google account (google-actions.ts, ADR 0021), sent only once they approve it. What they
 * share: the request, what is waiting, the full queue, and what to say where no mail can go.
 */
import { GoogleActionError } from "./google-actions.ts";
import type { MailAttachment } from "./mail-attachments.ts";
import type { ReminderItem } from "./reminder-book.ts";

/** A conversation: where a card is shown and the outcome told. */
export type MailThread = { readonly channel: string; readonly threadId: string };

/** The quote a mail sends: re-checked at approval; once sent, its address saved (if given) and the day recorded. */
export type QuoteMailRef = { readonly number: string; readonly base: string; readonly email?: string };

/** A mail asked for: what the approval card shows, and what to record once it is sent. */
export type MailProposal = {
	readonly thread: MailThread;
	readonly to: string;
	readonly subject: string;
	readonly body: string;
	readonly reason: string;
	/** The tool call's, with what tells this mail apart: a rerun finds the same request. */
	readonly key: string;
	readonly reminders?: readonly ReminderItem[];
	readonly attachments?: readonly MailAttachment[];
	readonly quote?: QuoteMailRef;
};

/** What waits for a decision: the invoices of reminder cards, the quotes (by first number) of quote cards. */
export type PendingMail = { readonly invoices: ReadonlySet<string>; readonly quotes: ReadonlySet<string> };

/**
 * How tools send mail: `check` says why this conversation cannot (not a console thread, no account,
 * read only); `pending` what waits; `propose` asks, throwing GoogleActionError when too many wait.
 */
export type MailRequests = {
	readonly check: (thread: MailThread | undefined) => Promise<string | undefined>;
	readonly pending: () => Promise<PendingMail>;
	readonly propose: (proposal: MailProposal) => Promise<{ readonly id: string }>;
};

/** A request asked, or the queue was full (nothing asked). */
export type Proposed = { readonly id: string } | { readonly full: true };

/** Ask, with a full queue as an answer rather than an error. */
export async function proposeMail(mail: MailRequests, proposal: MailProposal): Promise<Proposed> {
	try {
		return await mail.propose(proposal);
	} catch (error) {
		if (error instanceof GoogleActionError) return { full: true };
		throw error;
	}
}

/** The first words the person reads where no mail can go (a phone, an account not linked). */
export const NO_MAIL_HERE = "Da qui non posso mandare mail.";

/** What Annie is told first where no mail can go: why, and that nothing left. */
export function noMailFor(why: string, recorded = false): string {
	return `Non posso inviare mail da qui (${why}): niente è stato inviato${recorded ? " né annotato" : ""}.`;
}
