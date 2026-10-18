/**
 * A quote sent by mail (quotes op send) at the moment of approval: still the current version, or
 * nothing is sent; once sent, the day recorded and the address the person gave kept on it.
 */
import type { QuoteStore } from "./quote-store.ts";
import type { QuoteMailRef } from "./mail-requests.ts";

/** Why the mail must not go now (the card reads it), or undefined: replaced by a revision, or declined since (unless the person asked to send it anyway). */
export function quoteMailProblem(store: QuoteStore, ref: QuoteMailRef): string | undefined {
	const book = store.read();
	if (book.broken) return "Non inviata: l'archivio dei preventivi non si legge, quindi non so se il preventivo è ancora quello giusto.";
	const quote = book.quotes.find((q) => q.number === ref.number);
	if (quote === undefined) return `Non inviata: il preventivo ${ref.number} non c'è più.`;
	if (quote.status === "superseded") return `Non inviata: il preventivo ${ref.number} è stato sostituito da ${quote.replacedBy ?? "una revisione"}.`;
	if (quote.status === "declined" && ref.confirmedDeclined !== true) return `Non inviata: il preventivo ${ref.number} è stato segnato rifiutato dal cliente dopo la richiesta.`;
	return undefined;
}

/** Record the sending: false when it could not be written (the mail is sent either way). */
export function recordQuoteMail(store: QuoteStore, ref: QuoteMailRef, at: string): boolean {
	try {
		store.markSent(ref.number, at, ref.email);
		return true;
	} catch {
		return false;
	}
}
