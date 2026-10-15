import type { CrmAdapter, MailAdapter } from "../connectors/types.ts";
import type { AuditLog } from "../core/audit.ts";
import {
	parseCallbackData,
	PracticeStore,
	type Pratica,
} from "../core/practice.ts";
import { applyEdit, buildDraft } from "./draft.ts";
import * as copy from "./telegram-copy.ts";

export type CallbackDeps = {
	tenantId: string;
	instanceId: string;
	practices: PracticeStore;
	mail: MailAdapter;
	crm: CrmAdapter;
	audit: AuditLog;
	/** Allowlisted Telegram user IDs for this instance. */
	allowedUserIds: ReadonlySet<string>;
	notify: (msg: {
		text: string;
		buttons: readonly string[];
		praticaId: string;
		draftVersion: number;
	}) => Promise<void>;
	/** Optional: re-run extract+draft when forcing spam → quote. */
	forceExtract?: (pratica: Pratica) => Promise<void>;
};

export type CallbackResult =
	| { kind: "ignored"; reason: "not_allowlisted" | "unknown_callback" | "stale_version" }
	| { kind: "handled"; pratica: Pratica; sent: boolean };

/**
 * Handle Telegram callback Approva | Modifica | Scarta.
 * Non-allowlisted taps are ignored silently and audited (A8), including closed pratiche.
 */
export async function handleTelegramCallback(
	deps: CallbackDeps,
	args: { userId: string; callbackData: string },
): Promise<CallbackResult> {
	const parsed = parseCallbackData(args.callbackData);
	if (!parsed) return { kind: "ignored", reason: "unknown_callback" };

	if (!deps.allowedUserIds.has(args.userId)) {
		await deps.audit.append({
			type: "user.denied",
			instanceId: deps.instanceId,
			channel: "telegram",
			userId: args.userId,
			praticaId: parsed.praticaId,
			action: parsed.action,
		});
		return { kind: "ignored", reason: "not_allowlisted" };
	}

	const pratica = await deps.practices.get(parsed.praticaId);
	if (!pratica) return { kind: "ignored", reason: "unknown_callback" };

	if (pratica.status === "sent" || pratica.status === "discarded") {
		await deps.notify({
			text: copy.alreadyClosed(pratica.status),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { kind: "handled", pratica, sent: false };
	}

	if (parsed.action !== "edit" && pratica.draftVersion !== parsed.draftVersion && pratica.draftVersion > 0) {
		return { kind: "ignored", reason: "stale_version" };
	}

	if (parsed.action === "discard") {
		pratica.status = "discarded";
		await deps.practices.save(pratica);
		if (pratica.crmLeadId) {
			await deps.crm.updateLeadStatus(deps.tenantId, pratica.crmLeadId, "discarded", "scartata da commerciale");
		}
		await deps.notify({
			text: copy.discardedNotice(pratica),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { kind: "handled", pratica, sent: false };
	}

	if (parsed.action === "edit") {
		pratica.status = "awaiting_edit";
		await deps.practices.save(pratica);
		await deps.notify({
			text: copy.editPrompt(pratica),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { kind: "handled", pratica, sent: false };
	}

	// Approva
	if (pratica.status === "classified_skip" && pratica.classification === "spam") {
		// Force as quote: extract + draft (tests may inject)
		if (deps.forceExtract) await deps.forceExtract(pratica);
		else {
			pratica.status = "draft_ready";
			pratica.draftVersion = Math.max(1, pratica.draftVersion);
			if (!pratica.draftBody) {
				const d = buildDraft(pratica.lead);
				pratica.draftSubject = d.subject;
				pratica.draftBody = d.body;
			}
			await deps.practices.save(pratica);
		}
	}

	if (pratica.sentMessageId) {
		await deps.notify({
			text: copy.alreadyClosed("sent"),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { kind: "handled", pratica, sent: false };
	}

	pratica.status = "approved";
	pratica.approvedBy = args.userId;
	pratica.approvedAt = new Date().toISOString();
	await deps.practices.save(pratica);

	await deps.notify({
		text: copy.sendingNotice(pratica),
		buttons: [],
		praticaId: pratica.praticaId,
		draftVersion: pratica.draftVersion,
	});

	const to = pratica.lead.email;
	if (!to) {
		pratica.status = "failed";
		pratica.lastError = { code: "no_recipient", message: "missing email", at: new Date().toISOString() };
		await deps.practices.save(pratica);
		return { kind: "handled", pratica, sent: false };
	}

	try {
		const { hashIdempotency } = await import("../core/practice.ts");
		const idempotencyKey = hashIdempotency("send", pratica.praticaId, String(pratica.draftVersion));
		const result = await deps.mail.sendReply(deps.tenantId, {
			to,
			subject: pratica.draftSubject,
			bodyText: pratica.draftBody,
			inReplyToMessageId: pratica.mailMessageId,
			idempotencyKey,
		});
		pratica.sentMessageId = result.sentMessageId;
		pratica.status = "sent";
		await deps.practices.save(pratica);
		if (pratica.crmLeadId) {
			await deps.crm.updateLeadStatus(deps.tenantId, pratica.crmLeadId, "replied");
		}
		await deps.notify({
			text: copy.sentNotice(pratica),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { kind: "handled", pratica, sent: true };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		pratica.status = "failed";
		pratica.lastError = { code: "mail_send_failed", message: reason, at: new Date().toISOString() };
		await deps.practices.save(pratica);
		await deps.notify({
			text: copy.sendFailedNotice(pratica, reason),
			buttons: [...copy.BUTTONS],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { kind: "handled", pratica, sent: false };
	}
}

/**
 * After Modifica, commercial sends free text. `annulla modifica` restores buttons without bumping version.
 */
export async function handleEditMessage(
	deps: CallbackDeps,
	args: { userId: string; praticaId: string; text: string },
): Promise<CallbackResult> {
	if (!deps.allowedUserIds.has(args.userId)) {
		await deps.audit.append({
			type: "user.denied",
			instanceId: deps.instanceId,
			channel: "telegram",
			userId: args.userId,
			praticaId: args.praticaId,
			action: "edit_text",
		});
		return { kind: "ignored", reason: "not_allowlisted" };
	}

	const pratica = await deps.practices.get(args.praticaId);
	if (!pratica || pratica.status !== "awaiting_edit") {
		return { kind: "ignored", reason: "unknown_callback" };
	}

	const trimmed = args.text.trim();
	if (/^annulla modifica$/i.test(trimmed)) {
		pratica.status = "draft_ready";
		await deps.practices.save(pratica);
		await deps.notify({
			text: copy.leadCardAndDraft(pratica),
			buttons: [...copy.BUTTONS],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { kind: "handled", pratica, sent: false };
	}

	const prev = { subject: pratica.draftSubject, body: pratica.draftBody, language: "it" as const };
	const next = applyEdit(prev, trimmed);
	pratica.draftBody = next.body;
	pratica.draftSubject = next.subject;
	pratica.draftVersion += 1;
	pratica.status = "draft_ready";
	await deps.practices.save(pratica);
	await deps.notify({
		text: copy.leadCardAndDraft(pratica),
		buttons: [...copy.BUTTONS],
		praticaId: pratica.praticaId,
		draftVersion: pratica.draftVersion,
	});
	return { kind: "handled", pratica, sent: false };
}

/** Re-propose Approva/Modifica/Scarta after crash between approve and send (no silent send). */
export async function recoverAfterCrash(deps: CallbackDeps, praticaId: string): Promise<void> {
	const pratica = await deps.practices.get(praticaId);
	if (!pratica) return;
	if (pratica.status === "approved" && !pratica.sentMessageId) {
		await deps.notify({
			text: copy.crashAfterApproveNotice(pratica),
			buttons: [...copy.BUTTONS],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
	}
}

export { callbackData as makeCallbackData } from "../core/practice.ts";
