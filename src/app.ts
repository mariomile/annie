/**
 * Annie as one process for one tenant: the general instance with its tools (workspace,
 * tasks programmati, MCP connectors, tools proposti), Telegram and the web console as
 * channels, the scheduler, and the segreteria when configured. `src/main/annie.ts` reads the
 * environment and calls startAnnie; tests call it directly.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { writeFileAtomic } from "./core/atomic-file.ts";
import { TelegramAdapter, type TelegramUpdate } from "./channels/telegram.ts";
import type { InboundAction } from "./channels/types.ts";
import { ConnectorStore, McpConnections } from "./connectors/mcp.ts";
import { piDurableEngine } from "./core/adapters/pi-durable.ts";
import { decideToolProposal, NotAnApprover } from "./core/approvals.ts";
import type { DurableEngine } from "./core/engine.ts";
import { NotFound } from "./core/errors.ts";
import { instanceId as toInstanceId, tenantId as toTenantId } from "./core/ids.ts";
import { instanceDir, tenantDir } from "./core/paths.ts";
import { customToolName, type ToolProposal } from "./core/proposals.ts";
import type { InstanceRecord } from "./core/registry.ts";
import { AnnieRuntime, type ToolSet } from "./core/runtime.ts";
import { Scheduler } from "./core/scheduler.ts";
import { modelApiKeySecret } from "./core/secrets.ts";
import { createCustomTools } from "./core/tools/custom-tools.ts";
import { createScheduleTools } from "./core/tools/schedule-tools.ts";
import { createWorkspaceTools } from "./core/tools/workspace-tools.ts";
import { UsageLedger } from "./core/usage.ts";
import { connectChannel } from "./gateway.ts";
import type { AnnieConfig } from "./main/config.ts";
import { type RunningSegreteria, startSegreteria } from "./segreteria/boot.ts";
import { PeopleStore, SessionStore } from "./web/auth.ts";
import { WebChannel } from "./web/channel.ts";
import { createWebApp } from "./web/server.ts";

export const DEFAULT_INSTRUCTIONS = `Sei Annie, l'assistente sempre attiva di un'azienda italiana. Rispondi nella lingua di chi ti scrive, in modo diretto e cortese.
Puoi: creare, leggere e inviare file nel tuo workspace (file_*); programmare compiti per te stessa, una volta o a ripetizione (schedule_*); usare i tool dei connettori configurati; e, quando nessun tool basta, scrivere un nuovo tool con tool_propose, che resta inattivo finché un approvatore non lo approva.
Non inventare dati: se non sai, dillo o usa un tool. Non compiere azioni irreversibili verso l'esterno senza che una persona lo chieda esplicitamente.`;

export type AnnieOptions = {
	readonly engine?: DurableEngine;
	/** Telegram Bot API fetch (tests). */
	readonly telegramFetch?: typeof fetch;
	readonly uiDir?: string;
	readonly schedulerIntervalMs?: number;
	readonly log?: (message: string) => void;
};

export type RunningAnnie = {
	readonly runtime: AnnieRuntime;
	readonly server: Server;
	readonly scheduler: Scheduler;
	readonly segreteria: RunningSegreteria | undefined;
	/** The owner's login link, when this start created the owner. */
	readonly ownerLink: string | undefined;
	stop(): Promise<void>;
};

export async function startAnnie(config: AnnieConfig, options: AnnieOptions = {}): Promise<RunningAnnie> {
	const log = options.log ?? ((message: string) => console.error(message));
	const tenant = config.tenantId;
	const connections = new Map<string, McpConnections>();
	const telegrams = new Map<string, TelegramAdapter>();
	const segreteriaId = config.segreteria?.instanceId;
	const connectorStore = (id: string) => new ConnectorStore(instanceDir(config.dataDir, toTenantId(tenant), toInstanceId(id)));
	const policyOf = (record: InstanceRecord) => async () => (await runtime.registry.getInstance(record.tenantId, record.id)).egress;

	const runtime: AnnieRuntime = new AnnieRuntime({
		dataDir: config.dataDir,
		engine: options.engine ?? piDurableEngine,
		tools: async (record): Promise<ToolSet> => {
			const mcp = new McpConnections({ instanceId: record.id, secrets: runtime.secrets(record.tenantId), policy: policyOf(record), audit: runtime.audit(record.tenantId), log });
			connections.set(record.id, mcp);
			const tools = [
				...createWorkspaceTools({ workspace: runtime.workspace(record.tenantId, record.id), sendFile: (f) => runtime.sendFile(record.tenantId, record.id, f) }),
				...createScheduleTools({ store: runtime.schedules(record.tenantId, record.id), defaultTimeZone: config.timeZone }),
				...(await createCustomTools({
					store: runtime.proposals(record.tenantId, record.id),
					toolsDir: runtime.customToolsDir(record.tenantId, record.id),
					policy: policyOf(record),
					onProposed: (proposal) => notifyApprovers(record.id, proposal),
				})),
				...(await mcp.connect(await connectorStore(record.id).list())),
			];
			return { tools, close: () => mcp.close() };
		},
	});

	// --- bootstrap: tenant, general instance, owner ---
	try {
		await runtime.registry.getTenant(tenant);
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createTenant({ id: tenant, name: tenant });
	}
	try {
		const existing = await runtime.registry.getInstance(tenant, config.instanceId);
		if (existing.model.provider !== config.modelProvider || existing.model.modelId !== config.modelId) {
			log(`annie: instance ${config.instanceId} keeps its model ${existing.model.provider}/${existing.model.modelId}; ANNIE_MODEL_* apply to new instances only.`);
		}
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createInstance(tenant, {
			id: config.instanceId,
			name: config.instanceName,
			model: { provider: config.modelProvider, modelId: config.modelId },
			egress: { modelProviders: [config.modelProvider], channels: ["web", ...(config.telegram === undefined ? [] : ["telegram"])] },
			instructions: DEFAULT_INSTRUCTIONS,
		});
	}
	if (config.telegram !== undefined) {
		const record = await runtime.registry.getInstance(tenant, config.instanceId);
		if (!record.egress.channels.includes("telegram")) log(`annie: instance ${config.instanceId} does not allow the telegram channel; add it to its egress policy to use the bot.`);
		if (config.telegram.allowedUsers !== undefined) await runtime.registry.setAllowedUsers(tenant, config.instanceId, "telegram", config.telegram.allowedUsers);
		if (config.telegram.approvers !== undefined) await runtime.registry.updateInstance(tenant, config.instanceId, { approvers: { ...(record.approvers ?? {}), telegram: [...config.telegram.approvers] } });
	}
	if (config.modelApiKey !== undefined) await runtime.secrets(tenant).set(modelApiKeySecret(config.modelProvider), config.modelApiKey);
	const people = new PeopleStore(tenantDir(config.dataDir, toTenantId(tenant)));
	let ownerLink: string | undefined;
	if ((await people.list()).length === 0) {
		const { person, token } = await people.add("Owner", "owner");
		// The owner can chat with the general instance and approve its actions.
		const record = await runtime.registry.getInstance(tenant, config.instanceId);
		await runtime.registry.setAllowedUsers(tenant, config.instanceId, "web", [...(record.allowedUsers.web ?? []), person.id]);
		ownerLink = `${config.web.publicUrl ?? `http://${config.web.host === "0.0.0.0" ? "localhost" : config.web.host}:${config.web.port}`}/login#${token}`;
		// Kept out of the logs: in a 0600 file the owner reads once and deletes.
		await writeFileAtomic(join(config.dataDir, "owner-login-link.txt"), `${ownerLink}\n`);
	}

	// --- channels ---
	const conversational = (await runtime.registry.listInstances(tenant)).filter((r) => r.id !== segreteriaId);
	const webChannels = new Map<string, WebChannel>();
	const attachWebChannel = (record: InstanceRecord) => {
		const channel = new WebChannel({ tenantId: tenant, instanceId: record.id }, instanceDir(config.dataDir, record.tenantId, record.id));
		connectChannel(runtime, channel, { tenantId: tenant, instanceId: record.id }, log);
		webChannels.set(record.id, channel);
	};
	for (const record of conversational) attachWebChannel(record);
	if (config.telegram !== undefined) {
		const bot = new TelegramAdapter({
			token: config.telegram.token,
			tenantId: tenant,
			instanceId: config.instanceId,
			log,
			// Files from strangers are never downloaded.
			mayDownload: async (userId) => ((await runtime.registry.getInstance(tenant, config.instanceId)).allowedUsers.telegram ?? []).includes(userId),
			...(options.telegramFetch === undefined ? {} : { fetch: options.telegramFetch }),
			...(config.telegram.webhookSecret === undefined
				? {}
				: { webhook: { url: `${config.web.publicUrl}/hooks/telegram/${config.instanceId}`, secretToken: config.telegram.webhookSecret } }),
		});
		connectChannel(runtime, bot, { tenantId: tenant, instanceId: config.instanceId }, log, (action) => onTelegramTap(config.instanceId, bot, action));
		telegrams.set(config.instanceId, bot);
	}

	async function notifyApprovers(instance: string, proposal: ToolProposal): Promise<void> {
		const bot = telegrams.get(instance);
		const record = await runtime.registry.getInstance(tenant, instance);
		if (bot === undefined) return;
		for (const chat of record.approvers?.telegram ?? []) {
			if ((proposal.notified ?? []).includes(`telegram:${chat}`)) continue;
			// An approver approves what they read: with the code cut, no button, only the console.
			const truncated = proposal.code.length > 1500;
			const code = truncated ? `${proposal.code.slice(0, 1500)}\n[...]` : proposal.code;
			try {
				await bot.send({
					tenantId: tenant,
					instanceId: instance,
					channel: "telegram",
					threadId: chat,
					idempotencyKey: `proposal:${proposal.id}:${chat}`,
					text: `Nuovo tool da approvare · ${customToolName(proposal.name)}\n\n${proposal.description}\n\nHost raggiungibili: ${proposal.hosts.length > 0 ? proposal.hosts.join(", ") : "nessuno"}\n\nCodice:\n${code}${truncated ? `\n\nIl codice è lungo ${proposal.code.length} caratteri: leggilo tutto e decidi nella console web (Approvazioni).` : ""}`,
					buttons: truncated
						? [{ label: "Rifiuta", data: `tool:${proposal.id}:rejected` }]
						: [
								{ label: "Approva", data: `tool:${proposal.id}:approved` },
								{ label: "Rifiuta", data: `tool:${proposal.id}:rejected` },
							],
				});
				await runtime.proposals(tenant, instance).markNotified(proposal.id, `telegram:${chat}`);
			} catch (error) {
				log(`annie: approval card for ${proposal.id} to ${chat} not sent: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	async function onTelegramTap(instance: string, bot: TelegramAdapter, action: InboundAction): Promise<void> {
		const m = /^tool:([0-9a-f]{12}):(approved|rejected)$/.exec(action.data);
		if (m === null) return;
		if (m[2] === "approved" && ((await runtime.proposals(tenant, instance).get(m[1] as string))?.code.length ?? 0) > 1500) return; // only from the console
		try {
			const proposal = await decideToolProposal(runtime, tenant, instance, m[1] as string, m[2] as "approved" | "rejected", { channel: "telegram", userId: action.userId });
			await bot.send({
				tenantId: tenant,
				instanceId: instance,
				channel: "telegram",
				threadId: action.threadId,
				idempotencyKey: `decision:${action.actionId}`,
				text: `${customToolName(proposal.name)}: ${proposal.status === "approved" ? "approvato" : "rifiutato"}${proposal.decidedBy?.userId === action.userId ? "" : " (deciso in precedenza)"}.`,
			});
		} catch (error) {
			// Not an approver: silence (audited in decideToolProposal).
			if (!(error instanceof NotAnApprover)) throw error;
		}
	}

	// --- resume, scheduler, segreteria, web ---
	for (const record of conversational) await runtime.resume(tenant, record.id);
	for (const record of conversational) {
		for (const proposal of await runtime.proposals(tenant, record.id).list()) if (proposal.status === "pending") await notifyApprovers(record.id, proposal);
	}
	const scheduler = new Scheduler(
		// Read each tick: instances created from the console join without a restart.
		async () =>
			[...webChannels.keys()].map((id) => ({
				tenantId: tenant,
				instanceId: id,
				store: runtime.schedules(tenant, id),
				submit: (req) => runtime.submitScheduled(tenant, id, req),
			})),
		log,
	);
	scheduler.start(options.schedulerIntervalMs ?? 30_000);
	const segreteria = config.segreteria === undefined ? undefined : await startSegreteria(runtime, config.segreteria, log);
	for (const bot of telegrams.values()) await bot.start();

	const server = createWebApp({
		runtime,
		tenantId: tenant,
		people,
		sessions: new SessionStore(tenantDir(config.dataDir, toTenantId(tenant))),
		channels: webChannels,
		connectors: connectorStore,
		connectorStatus: (id) => connections.get(id)?.status() ?? [],
		...(segreteria === undefined ? {} : { segreterie: new Map([[segreteria.instanceId, segreteria.service]]) }),
		usage: new UsageLedger(tenantDir(config.dataDir, toTenantId(tenant))),
		uiDir: options.uiDir ?? join(import.meta.dirname, "web", "ui"),
		secureCookies: config.web.publicUrl?.startsWith("https://") ?? false,
		defaultTimeZone: config.timeZone,
		// Same model as the general instance; web only, open to the owner who creates it.
		telegramHooks: new Map(
			config.telegram?.webhookSecret === undefined
				? []
				: [...telegrams].map(([id, bot]) => [id, { secret: config.telegram?.webhookSecret as string, handle: (update: unknown) => bot.handleUpdate(update as TelegramUpdate) }]),
		),
		createInstance: async ({ id, name, instructions, ownerId }) => {
			const general = await runtime.registry.getInstance(tenant, config.instanceId);
			const record = await runtime.registry.createInstance(tenant, {
				id,
				name,
				model: general.model,
				egress: { modelProviders: [general.model.provider], channels: ["web"] },
				allowedUsers: { web: [ownerId] },
				instructions: instructions ?? DEFAULT_INSTRUCTIONS,
			});
			attachWebChannel(record);
			await runtime.resume(tenant, record.id);
		},
		log,
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.web.port, config.web.host, () => resolve());
	});

	return {
		runtime,
		server,
		scheduler,
		segreteria,
		ownerLink,
		async stop() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			await scheduler.stop();
			for (const bot of telegrams.values()) await bot.stop();
			await segreteria?.stop();
			await runtime.close();
		},
	};
}
