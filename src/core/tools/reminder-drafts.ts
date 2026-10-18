/** How reminder drafts read in an answer: for the model, and inside the fence (what comes from the files). */
import { sumsText } from "../invoice-sums.ts";
import { fenced } from "./invoice-fence.ts";
import type { Debtor } from "./reminder-debtors.ts";
import { mailtoLink } from "./letter-shared.ts";
import { LEVEL_NAMES, MAX_REMINDERS, type ReminderDraft } from "./reminder-text.ts";

/** Full drafts in one answer; the other customers get one line each. */
const MAX_FULL = 3;

export function customerName(debtor: Debtor): string {
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
export function leftOver(covered: readonly Debtor[], more: number, remarks: readonly string[]): string[] {
	return [
		...(covered.length === 0 ? [] : [`Le note di credito coprono già quanto dovuto da: ${covered.map(customerName).join(", ")}.`]),
		...(more > 0 ? [`E altri ${more} clienti in ritardo, non preparati: al più ${MAX_REMINDERS} per volta.`] : []),
		...remarks,
	];
}

/** The drafts as the person reads them: the first MAX_FULL in full, the others in a line each with how to ask for them. */
export function draftsBlock(drafts: readonly ReminderDraft[], extra: readonly string[], link = false): string {
	const full = drafts.slice(0, MAX_FULL).map((d) => draftText(d, link));
	const rest = drafts.slice(MAX_FULL);
	const lines = rest.length === 0 ? [] : ["", `Per gli altri chiedimi "sollecito per <nome>":`, ...rest.map(draftLine)];
	return fenced([full.join("\n\n"), ...lines, ...(extra.length === 0 ? [] : ["", ...extra])].join("\n"));
}
