/**
 * Sending payment reminders (invoices op reminder with send): each letter that may go on an
 * approval card of its own (mail-requests.ts), with the invoice files when asked; the others said
 * with why. Recorded in the scadenzario only once sent (decideGoogleAction).
 */
import { createHash } from "node:crypto";
import type { ToolContext } from "../engine.ts";
import { GOOGLE_ACTION_LIMITS } from "../google-actions.ts";
import type { MailAttachment } from "../mail-attachments.ts";
import { type MailRequests, type MailThread, proposeMail } from "../mail-requests.ts";
import { oneLine } from "../plain-text.ts";
import type { Workspace } from "../workspace.ts";
import { fenced } from "./invoice-fence.ts";
import type { ReminderArgs } from "./reminder-args.ts";
import { letterAttachments, pdfBudget, type ReadText } from "./reminder-attachments.ts";
import { invoicesOf, lastFormal, remindedOn } from "./reminder-debtors.ts";
import { customerName, draftsBlock } from "./reminder-drafts.ts";
import type { ReminderDraft, ReminderTerms } from "./reminder-text.ts";

type QueueDeps = {
	readonly record?: (event: { readonly type: "invoice.reminder"; readonly op: "queue"; readonly count: number }) => Promise<void>;
	readonly workspace?: Workspace;
	readonly readText?: ReadText;
	readonly pdfBudgetMs?: number;
};

/** Why a draft is not sent now, if it is not. */
function skipReason(draft: ReminderDraft, terms: ReminderTerms, pending: ReadonlySet<string>, context: { today: string; dayOf: (at: string) => string }): string | undefined {
	if (remindedOn(draft.debtor, context.today, context.dayOf).length > 0) return "già sollecitato oggi";
	if (draft.items.some((i) => pending.has(i.invoice))) return "c'è già una richiesta di invio in attesa di decisione";
	if (terms.level === undefined && draft.level === 3 && lastFormal(draft.debtor) !== undefined) return "il sollecito formale per queste fatture è già stato mandato: per rimandarlo serve che chi ti scrive lo chieda, con level 3";
	if (draft.body.length > GOOGLE_ACTION_LIMITS.maxBody) return `testo troppo lungo per una mail (più di ${GOOGLE_ACTION_LIMITS.maxBody} caratteri): sollecita una fattura alla volta con number, e regola a parte le note di credito del cliente, che così non vengono scalate`;
	return undefined;
}

/** A short id of a letter, from its invoices: the same letter in a rerun has the same one. */
function letterId(draft: ReminderDraft): string {
	return createHash("sha256")
		.update(draft.items.map((i) => i.invoice).join("\n"))
		.digest("hex")
		.slice(0, 16);
}

/** What the card says, after the letter: where the address comes from when not the person's. */
function cardReason(draft: ReminderDraft): string {
	const from = draft.toFrom === "file" || draft.toFrom === "pec" ? " · indirizzo preso dalla fattura" : "";
	return oneLine(`Sollecito di pagamento (livello ${draft.level}) a ${customerName(draft.debtor)}${from}`, 300);
}

/** Each draft that may go, on an approval card of its own; the others said with why. */
export async function queueReminders(drafts: readonly ReminderDraft[], extra: readonly string[], a: ReminderArgs, ctx: ToolContext, deps: QueueDeps, env: { today: string; dayOf: (at: string) => string; thread: MailThread; mail: MailRequests }): Promise<string> {
	// In a step: a replay after a crash finds the call's own cards asked, not ones more waiting.
	const pending = new Set(await ctx.step("pending", async () => [...(await env.mail.pending()).invoices]));
	const skipped: string[] = [];
	const missing: ReminderDraft[] = [];
	const asked: { draft: ReminderDraft; id: string; notes: readonly string[] }[] = [];
	let full = 0;
	const budget = pdfBudget(Date.now(), undefined, deps.pdfBudgetMs);
	for (const draft of drafts) {
		const reason = skipReason(draft, a.terms, pending, env);
		if (reason !== undefined) {
			skipped.push(`• ${customerName(draft.debtor)} (livello ${draft.level}): non preparato, ${reason}.`);
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
		let attachments: readonly MailAttachment[] = [];
		let notes: readonly string[] = [];
		if (a.attach) {
			const files = deps.workspace === undefined ? { problem: "qui non posso allegare file" } : await letterAttachments(deps.workspace, invoicesOf(draft.debtor), budget, deps.readText);
			if ("problem" in files) {
				skipped.push(`• ${customerName(draft.debtor)} (livello ${draft.level}): non preparato, ${files.problem}.`);
				continue;
			}
			attachments = files.attachments;
			notes = files.notes;
		}
		// Each request in a step of its own, keyed by the call and the letter: a rerun finds the same request, never a second one.
		const id = letterId(draft);
		const to = draft.to;
		const made = await ctx.step(`propose:${id}`, async () =>
			proposeMail(env.mail, { thread: env.thread, to, subject: draft.subject, body: draft.body, reason: cardReason(draft), reminders: draft.items, ...(attachments.length === 0 ? {} : { attachments }), key: `${ctx.callId}:${id}` }),
		);
		if ("id" in made) asked.push({ draft, id: made.id, notes });
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
		parts.push(`${lead}${a.attach ? " Le fatture sono allegate: la card mostra i file e le loro dimensioni." : ""} Parte solo ciò che approva, e il sollecito si annota allora. Non dire che è inviato finché non arriva l'esito. Riferisci in breve le note.`);
	}
	if (full > 0) parts.push(`${asked.length > 0 ? `Per gli altri ${full}` : `Per ${full === 1 ? "questo cliente" : `questi ${full} clienti`}`} ci sono troppe richieste in attesa: falle decidere e riprova.`);
	const lines = asked.flatMap(({ draft, id, notes }) => [`• ${customerName(draft.debtor)}, livello ${draft.level}, indirizzo: ${draft.to} (richiesta ${id})`, ...[...draft.notes, ...notes].map((n) => `  Nota: ${n}.`)]);
	const data = [...lines, ...skipped, ...extra];
	if (data.length > 0) parts.push(fenced(data.join("\n")));
	if (missing.length > 0) {
		parts.push(`Per ${missing.length === 1 ? "un sollecito" : `${missing.length} solleciti`} manca l'indirizzo: chiedilo a chi ti scrive e richiama con party ed email (lo salvo per le prossime volte). Le bozze:`, draftsBlock(missing, []));
	}
	if (asked.length === 0 && full === 0 && missing.length === 0) parts.unshift("Nessuna richiesta preparata.");
	return parts.join("\n");
}
