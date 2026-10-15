import type { AnnieTool } from "../engine.ts";
import type { PracticeStore } from "../practice.ts";

/**
 * Durable approval gate: writes approval state on the pratica before any send.
 * The model (or flow) must call request_approval; send_email checks maySend.
 */
export function createApprovalTools(options: { practices: PracticeStore }): AnnieTool[] {
	const { practices } = options;

	const requestApproval: AnnieTool = {
		name: "request_approval",
		description: "Mark a pratica as awaiting human approval (Telegram Approva/Modifica/Scarta).",
		parameters: {
			type: "object",
			properties: { praticaId: { type: "string" } },
			required: ["praticaId"],
			additionalProperties: false,
		},
		replaySafe: true,
		async execute(args, ctx) {
			const praticaId = String(args.praticaId);
			return ctx.step(`request_approval:${praticaId}`, async () => {
				const pratica = await practices.get(praticaId);
				if (!pratica) return JSON.stringify({ ok: false, error: "pratica_not_found" });
				if (pratica.status !== "approved" && pratica.status !== "sent" && pratica.status !== "discarded") {
					pratica.status = "draft_ready";
					await practices.save(pratica);
				}
				return JSON.stringify({ ok: true, status: pratica.status, draftVersion: pratica.draftVersion });
			});
		},
	};

	const recordApproval: AnnieTool = {
		name: "record_approval",
		description: "Record human Approva on a pratica (durable). Does not send mail.",
		parameters: {
			type: "object",
			properties: {
				praticaId: { type: "string" },
				approvedBy: { type: "string" },
				draftVersion: { type: "number" },
			},
			required: ["praticaId", "approvedBy", "draftVersion"],
			additionalProperties: false,
		},
		replaySafe: true,
		async execute(args, ctx) {
			const praticaId = String(args.praticaId);
			const draftVersion = Number(args.draftVersion);
			return ctx.step(`record_approval:${praticaId}:v${draftVersion}`, async () => {
				const pratica = await practices.get(praticaId);
				if (!pratica) return JSON.stringify({ ok: false, error: "pratica_not_found" });
				if (pratica.sentMessageId) {
					return JSON.stringify({ ok: true, alreadySent: true, sentMessageId: pratica.sentMessageId });
				}
				if (pratica.draftVersion !== draftVersion) {
					return JSON.stringify({ ok: false, error: "stale_draft_version" });
				}
				pratica.status = "approved";
				pratica.approvedBy = String(args.approvedBy);
				pratica.approvedAt = new Date().toISOString();
				await practices.save(pratica);
				return JSON.stringify({ ok: true, status: "approved" });
			});
		},
	};

	return [requestApproval, recordApproval];
}
