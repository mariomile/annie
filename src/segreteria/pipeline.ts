import type { CrmAdapter, InboundMail, MailAdapter } from "../connectors/types.ts";
import type { AuditLog } from "../core/audit.ts";
import {
	type FlowAction,
	type MailClassification,
	newPraticaId,
	type Pratica,
	PracticeStore,
	type TenantSegreteriaConfig,
	hashIdempotency,
} from "../core/practice.ts";
import type { UsageLedger } from "../core/usage.ts";
import { estimateUsd } from "../core/usage.ts";
import type { ModelRoles } from "../core/model-routing.ts";
import { classifyInbound, isValidSender } from "./classify.ts";
import { extractLead } from "./extract.ts";
import { buildDraft } from "./draft.ts";
import type { ModelClient } from "../core/completion.ts";
import type { ChecksConfig } from "./checks.ts";
import { analyzeMail, draftReply, type MailAnalysis, type ModelCall } from "./model.ts";
import * as copy from "./telegram-copy.ts";

export type PipelineDeps = {
	tenantId: string;
	instanceId: string;
	practices: PracticeStore;
	mail: MailAdapter;
	crm: CrmAdapter;
	audit: AuditLog;
	usage: UsageLedger;
	roles: ModelRoles;
	tenantConfig?: TenantSegreteriaConfig;
	/**
	 * Real model for extraction and drafting. Absent, or roles on the local "faux" model:
	 * the deterministic heuristics (CI, offline).
	 */
	model?: { client: ModelClient; checks: ChecksConfig };
	/** Optional: override classification (tests). */
	classify?: (mail: InboundMail) => MailClassification;
	/** Notify commercial via Telegram (tests capture this). */
	notify: (msg: {
		text: string;
		buttons: readonly string[];
		praticaId: string;
		draftVersion: number;
	}) => Promise<void>;
};

export type PipelineResult = {
	pratica: Pratica;
	action: FlowAction;
	crmUpserts: number;
	sends: number;
};

/**
 * Process one inbound mail into a pratica + Telegram proposal.
 * Never sends email. Human Approva is handled by handleCallback.
 */
export async function processInboundMail(deps: PipelineDeps, mail: InboundMail): Promise<PipelineResult> {
	const existing = await deps.practices.findByMailMessageId(mail.messageId);
	if (existing) {
		return { pratica: existing, action: "noop_duplicate", crmUpserts: 0, sends: 0 };
	}

	// Same-thread new request (A5): find by threadId an open/sent pratica and update lead + new draft.
	let attach: Pratica | undefined;
	if (mail.threadId) {
		const all = await deps.practices.list();
		attach = all.find((p) => p.mailThreadId === mail.threadId && (p.status === "sent" || p.status === "draft_ready" || p.status === "approved"));
	}

	if (!isValidSender(mail)) {
		const pratica = await createSkeleton(deps, mail, "failed", "log_only");
		pratica.classification = "richiesta_preventivo";
		pratica.flowAction = "log_only";
		pratica.lead = { ...pratica.lead, email: null, missingFields: ["email"] };
		pratica.missingFields = ["email"];
		await deps.practices.save(pratica);
		await deps.audit.append({
			type: "mail.invalid_sender",
			instanceId: deps.instanceId,
			mailMessageId: mail.messageId,
		});
		await deps.notify({
			text: copy.invalidSenderNotice(pratica),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { pratica, action: "log_only", crmUpserts: 0, sends: 0 };
	}

	if (await deps.usage.isHardCapped()) {
		await deps.audit.append({ type: "cost.denied", instanceId: deps.instanceId });
		throw new Error("hard_cap");
	}

	const analysis = await analyzeWithModel(deps, mail);
	const classification = deps.classify?.(mail) ?? analysis?.classification ?? classifyInbound(mail);

	if (classification === "non_commerciale") {
		const pratica = await createSkeleton(deps, mail, "classified_skip", "notify_only");
		pratica.classification = "non_commerciale";
		pratica.flowAction = "notify_only";
		await deps.practices.save(pratica);
		if (analysis === undefined) await recordUsage(deps, "classify", 200, 50);
		await deps.notify({
			text: copy.nonCommercialeNotice(pratica),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: 0,
		});
		return { pratica, action: "notify_only", crmUpserts: 0, sends: 0 };
	}

	if (classification === "spam") {
		const pratica = await createSkeleton(deps, mail, "classified_skip", "create_skip");
		pratica.classification = "spam";
		pratica.flowAction = "create_skip";
		await deps.practices.save(pratica);
		if (analysis === undefined) await recordUsage(deps, "classify", 200, 50);
		await deps.notify({
			text: copy.spamNotice(pratica),
			buttons: [...copy.BUTTONS],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
		return { pratica, action: "create_skip", crmUpserts: 0, sends: 0 };
	}

	// Quote / thread reply
	if (analysis === undefined) await recordUsage(deps, "classify", 200, 50);
	if (await deps.usage.isSoftCapped()) {
		await deps.notify({
			text: (await import("../core/usage.ts")).TELEGRAM_SOFT_CAP,
			buttons: [],
			praticaId: "soft-cap",
			draftVersion: 0,
		});
	}

	let lead = analysis?.lead ?? extractLead(mail, deps.tenantConfig);
	if (analysis === undefined) await recordUsage(deps, "extract", 800, 200);

	let pratica: Pratica;
	let action: FlowAction;
	if (attach) {
		action = "attach_to_existing";
		pratica = {
			...attach,
			lead: {
				...lead,
				productOrService: [attach.lead.productOrService, lead.productOrService].filter(Boolean).join("; ") || null,
			},
			missingFields: [...lead.missingFields],
			mailMessageId: mail.messageId, // index latest message too
			status: "received",
			flowAction: action,
			classification,
		};
	} else {
		action = "create";
		pratica = await createSkeleton(deps, mail, "received", "create");
		pratica.lead = lead;
		pratica.missingFields = [...lead.missingFields];
		pratica.classification = classification;
		pratica.flowAction = action;
	}

	let crmUpserts = 0;
	try {
		const key = hashIdempotency("crm", pratica.mailMessageId);
		const result = await deps.crm.upsertLead(
			deps.tenantId,
			{
				fullName: lead.fullName,
				title: lead.title,
				company: lead.company,
				email: lead.email,
				phone: lead.phone,
				productOrService: lead.productOrService,
				vatNumber: lead.vatNumber,
				originalLanguage: lead.originalLanguage,
				missingFields: lead.missingFields,
				rawSubject: lead.rawSubject,
				mailMessageId: pratica.mailMessageId,
			},
			key,
		);
		pratica.crmLeadId = result.crmLeadId;
		pratica.status = "lead_upserted";
		crmUpserts = 1;
	} catch {
		// CRM down: still draft (spec)
		await deps.notify({
			text: copy.crmDownNotice(pratica),
			buttons: [],
			praticaId: pratica.praticaId,
			draftVersion: pratica.draftVersion,
		});
	}

	const draft = await draftWithModel(deps, mail, lead, analysis);
	if (draft.note !== undefined) {
		lead = { ...lead, notes: [lead.notes, draft.note].filter(Boolean).join(" ") };
		pratica.lead = { ...pratica.lead, notes: lead.notes };
	}
	pratica.draftSubject = draft.subject;
	pratica.draftBody = draft.body;
	pratica.draftVersion = attach ? pratica.draftVersion + 1 : 1;
	pratica.status = "draft_ready";
	await deps.practices.save(pratica);

	const card = copy.leadCardAndDraft(pratica);
	const header =
		action === "attach_to_existing"
			? copy.threadNewRequestNotice(pratica, lead.fullName ?? lead.company ?? "cliente")
			: copy.newRequestNotice(pratica);
	await deps.notify({
		text: `${header}\n\n${card}`,
		buttons: [...copy.BUTTONS],
		praticaId: pratica.praticaId,
		draftVersion: pratica.draftVersion,
	});

	return { pratica, action, crmUpserts, sends: 0 };
}

async function createSkeleton(
	deps: PipelineDeps,
	mail: InboundMail,
	status: Pratica["status"],
	flowAction: FlowAction,
): Promise<Pratica> {
	const now = new Date().toISOString();
	const pratica: Pratica = {
		praticaId: newPraticaId(),
		tenantId: deps.tenantId,
		instanceId: deps.instanceId,
		status,
		mailMessageId: mail.messageId,
		mailThreadId: mail.threadId,
		lead: {
			fullName: mail.fromName ?? null,
			email: null,
			productOrService: null,
			missingFields: [],
			source: "email",
			rawSubject: mail.subject,
			rawSnippet: mail.bodyText.slice(0, 200),
			receivedAt: mail.receivedAt,
			mailMessageId: mail.messageId,
		},
		missingFields: [],
		draftSubject: "",
		draftBody: "",
		draftVersion: 0,
		flowAction,
		createdAt: now,
		updatedAt: now,
	};
	await deps.practices.save(pratica);
	return pratica;
}

function modelEnabled(deps: PipelineDeps): deps is PipelineDeps & { model: NonNullable<PipelineDeps["model"]> } {
	return deps.model !== undefined && deps.roles.extract.provider !== "faux";
}

/** Model analysis, or undefined for the heuristics (no model, or the model failed). */
async function analyzeWithModel(deps: PipelineDeps, mail: InboundMail): Promise<MailAnalysis | undefined> {
	if (!modelEnabled(deps)) return undefined;
	try {
		return await analyzeMail(deps.model.client, deps.roles.extract, mail, deps.tenantConfig, (call) => recordModelCall(deps, call));
	} catch (error) {
		await deps.audit.append({ type: "model.failed", instanceId: deps.instanceId, role: "extract", mailMessageId: mail.messageId, error: errorText(error) });
		return undefined;
	}
}

async function draftWithModel(
	deps: PipelineDeps,
	mail: InboundMail,
	lead: Pratica["lead"],
	analysis: MailAnalysis | undefined,
): Promise<{ subject: string; body: string; note?: string }> {
	if (!modelEnabled(deps)) {
		const draft = buildDraft(lead);
		await recordUsage(deps, "draft", 1200, 600);
		return draft;
	}
	const requests = analysis?.requests ?? [];
	try {
		const draft = await draftReply(deps.model.client, deps.roles.draft, { mail, lead, requests, checks: deps.model.checks }, (call) => recordModelCall(deps, call));
		if (draft.source === "model") return draft;
		await deps.audit.append({ type: "draft.fallback", instanceId: deps.instanceId, mailMessageId: mail.messageId, failures: [...new Set(draft.failures.map((f) => f.check))].join(",") });
		return { ...draft, note: "Bozza standard: quella del modello non passava i controlli (prezzi, tono o dati)." };
	} catch (error) {
		await deps.audit.append({ type: "model.failed", instanceId: deps.instanceId, role: "draft", mailMessageId: mail.messageId, error: errorText(error) });
		return { ...buildDraft(lead, { requests }), note: "Bozza standard: il modello non ha risposto." };
	}
}

async function recordModelCall(deps: PipelineDeps, call: ModelCall): Promise<void> {
	await deps.usage.record(
		{
			at: new Date().toISOString(),
			provider: call.model.provider,
			model: call.model.modelId,
			role: call.role,
			inputTokens: call.result.inputTokens,
			outputTokens: call.result.outputTokens,
			estimatedUsd: call.result.costUsd ?? estimateUsd(call.model.modelId, call.result.inputTokens, call.result.outputTokens),
		},
		deps.audit,
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function recordUsage(deps: PipelineDeps, role: "extract" | "draft" | "classify", input: number, output: number): Promise<void> {
	const model = role === "draft" ? deps.roles.draft : deps.roles.extract;
	await deps.usage.record(
		{
			at: new Date().toISOString(),
			provider: model.provider,
			model: model.modelId,
			role,
			inputTokens: input,
			outputTokens: output,
			estimatedUsd: estimateUsd(model.modelId, input, output),
		},
		deps.audit,
	);
}
