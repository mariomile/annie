import type { InboundMail } from "../connectors/types.ts";
import type { MailClassification } from "../core/practice.ts";

const SPAM_HINTS = [/newsletter/i, /unsubscribe/i, /-?\d+%\s*(questo|this)/i, /phishing/i, /click here/i];
const NON_COMM_HINTS = [
	/fattura/i,
	/assistenza/i,
	/candidato|candidatura|curriculum|cv\b/i,
	/fornitore|offerta commerciale da/i,
	/problema con la fattura/i,
];

/** Deterministic classifier for tests/CI (no model). Spec A4 / spam. */
export function classifyInbound(mail: InboundMail): MailClassification {
	const blob = `${mail.subject}\n${mail.bodyText}\n${mail.from}`;
	if (!extractEmailAddress(mail.from)) return "richiesta_preventivo"; // pipeline handles invalid separately
	if (SPAM_HINTS.some((r) => r.test(blob))) return "spam";
	if (NON_COMM_HINTS.some((r) => r.test(blob))) return "non_commerciale";
	if (/^re:/i.test(mail.subject) && mail.inReplyTo) return "risposta_thread";
	return "richiesta_preventivo";
}

export function extractEmailAddress(from: string): string | undefined {
	const angle = /<([^>]+)>/.exec(from);
	const raw = (angle?.[1] ?? from).trim();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return undefined;
	return raw.toLowerCase();
}

export function isValidSender(mail: InboundMail): boolean {
	return extractEmailAddress(mail.from) !== undefined;
}
