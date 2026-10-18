import { mkdir } from "node:fs/promises";
import { AuditLog } from "./audit.ts";
import { ConnectorActionStore } from "./connector-actions.ts";
import type { AnnieTool, DurableEngine, EngineImage, EngineReply, EngineSession } from "./engine.ts";
import { IMAGE_LIMITS, imageProblem, imageType } from "./images.ts";
import { EgressDenied, NotFound, UserNotAllowed } from "./errors.ts";
import { type InstanceId, instanceId, type TenantId, tenantId } from "./ids.ts";
import { InstanceLock } from "./lock.ts";
import { Outbox, type OutboxEntry } from "./outbox.ts";
import { MemoryStore, memoryNote, Participants, SHARED, subjectOf } from "./memory.ts";
import { ListStore, listsLine } from "./lists.ts";
import { InvoiceStore } from "./invoice-store.ts";
import { QuoteStore } from "./quote-store.ts";
import { ExpenseStore } from "./expense-store.ts";
import { TimesheetStore } from "./timesheet-store.ts";
import { RenewalStore } from "./renewal-store.ts";
import { CashflowStore } from "./cashflow-store.ts";
import { TaxStore } from "./tax-store.ts";
import { connectorActionsDir, customToolsDir, engineDir, googleActionsDir, instanceDir, lockFile, outboxDir, proposalsDir, schedulesDir, watchesDir, webActionsDir, workspaceDir } from "./paths.ts";
import { GoogleActionStore } from "./google-actions.ts";
import { WebActionStore } from "./web-actions.ts";
import { ProposalStore } from "./proposals.ts";
import { ScheduleStore } from "./schedules.ts";
import { AutomationStore } from "./automations.ts";
import { WatchStore } from "./watches.ts";
import { Workspace } from "./workspace.ts";
import { assertChannelAllowed, assertModelProviderAllowed, assertUserAllowed, CHANNEL_PATTERN } from "./policy.ts";
import { DEV_PROVIDER } from "./model-providers.ts";
import { AGENT_CHANNEL } from "./agent-messages.ts";
import { withPersona } from "./persona.ts";
import { activateCommand, SkillError, SkillStore, skillCatalog, skillCommand, withSkill } from "./skills.ts";
import { type InstanceRecord, type ModelSelection, TenantRegistry } from "./registry.ts";
import { modelApiKeySecret, TenantSecrets } from "./secrets.ts";

/** A normalized inbound message as the core sees it. Channels translate to this shape. */
export type SubmitRequest = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly userId: string;
	readonly text: string;
	/** The thread is with this person alone; in a group nobody's memoria applies. */
	readonly privateThread?: boolean;
	/** Channel-native message ID; makes a redelivered message idempotent. */
	readonly messageId?: string;
	/** Pictures that came with the message, already in the workspace at `path`: the model sees them. */
	readonly images?: readonly { readonly path: string; readonly data: Uint8Array }[];
	/** The person's own words when `text` wraps them in more (a stanza, ADR 0063): skill commands are read from these. */
	readonly command?: string;
};

export type Reply = {
	readonly tenantId: TenantId;
	readonly instanceId: InstanceId;
	readonly channel: string;
	readonly threadId: string;
	/**
	 * Idempotency key of this reply, stable across restarts. Pass it to `markDelivered` once
	 * the channel has accepted the reply; until then it is sent again after a restart.
	 */
	readonly deliveryId: string;
	/**
	 * An earlier hand-off of this reply was never confirmed: the user may already have it.
	 * Same rule as `possibleDuplicate` in the audit (attempts > 1), so it also fires when the
	 * earlier try died before reaching the channel.
	 */
	readonly possibleDuplicate: boolean;
	/** Which hand-off of this reply this is (1 the first time). A failure report names it. */
	readonly attempt: number;
	/** The submission this reply answers; messages Annie sends by herself carry "message" or "file". */
	readonly submissionId: string;
} & (
	/** `model`: the one that wrote the answer, when the engine says. */
	| { readonly status: "answered"; readonly text: string; readonly model?: ModelSelection }
	| { readonly status: "unanswered"; readonly reason: string }
	/** A file of the instance's workspace to send to the thread. */
	| { readonly status: "file"; readonly path: string; readonly caption?: string }
);

/** Tools of an instance, with what to release when it closes (connector connections). */
export type ToolSet = readonly AnnieTool[] | { readonly tools: readonly AnnieTool[]; readonly close: () => Promise<void> };

export type RuntimeOptions = {
	readonly dataDir: string;
	readonly engine: DurableEngine;
	/**
	 * Tools of an instance: the same list for all, or computed from the instance's record
	 * when it is opened (connectors, approved tools). A changed list applies on `reopen`.
	 */
	readonly tools?: readonly AnnieTool[] | ((record: InstanceRecord) => Promise<ToolSet>);
	/**
	 * Waits before sending again a reply whose channel failed (network, timeout), one per
	 * attempt; the last repeats. A reply the channel refused is not retried in the process.
	 */
	readonly retryDelaysMs?: readonly number[];
	/** Retries in one process before the reply waits for the next resume. */
	readonly maxRetries?: number;
};

/** What happened to a send the channel did not confirm. */
export type DeliveryFailure = { readonly refused: boolean; readonly reason: string };

/** How long a delivered reply stays in the outbox. */
const OUTBOX_RETENTION_MS = 30 * 86_400_000;

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];
/** About two hours of tries with the default delays. */
export const DEFAULT_MAX_RETRIES = 14;

/**
 * Annie's core. Knows tenants, instances, secrets, audit and egress policy; runs each
 * instance on its own durable engine session and storage. Knows nothing about channels
 * beyond their names.
 */
export class AnnieRuntime {
	readonly registry: TenantRegistry;
	private readonly instances = new Map<string, Promise<AnnieInstance>>();
	private readonly listeners = new Set<(reply: Reply) => void>();
	private readonly participantStores = new Map<string, Participants>();
	/** Instances being deleted: nothing opens them meanwhile. */
	private readonly removing = new Set<string>();

	constructor(private readonly options: RuntimeOptions) {
		this.registry = new TenantRegistry(options.dataDir);
	}

	secrets(tenant: string): TenantSecrets {
		return new TenantSecrets(this.options.dataDir, tenantId(tenant));
	}

	/** The forms an instance asked to send (web_submit). */
	webActions(tenant: string, instance: string): WebActionStore {
		return new WebActionStore(webActionsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Writes to people's Google accounts waiting for (or past) their decision (ADR 0021). */
	googleActions(tenant: string, instance: string): GoogleActionStore {
		return new GoogleActionStore(googleActionsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Calls of connector tools that change something, waiting for (or past) a decision (ADR 0025). */
	connectorActions(tenant: string, instance: string): ConnectorActionStore {
		return new ConnectorActionStore(connectorActionsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The tools proposti of an instance. */
	proposals(tenant: string, instance: string): ProposalStore {
		return new ProposalStore(proposalsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Folder of an instance's approved tools (one subfolder each) and of the sandbox runner. */
	customToolsDir(tenant: string, instance: string): string {
		return customToolsDir(this.options.dataDir, tenantId(tenant), instanceId(instance));
	}

	/**
	 * A message from the instance to a thread that is not a reply (a decision, a notice),
	 * through the outbox like a reply. The same `key` is sent once.
	 */
	async sendMessage(tenant: string, instance: string, message: { channel: string; threadId: string; text: string; key: string; secret?: boolean }): Promise<void> {
		await (await this.openInstance(tenant, instance)).sendMessage(message);
	}

	/** The memoria of an instance: what it remembers about each person, and shared facts. */
	memory(tenant: string, instance: string): MemoryStore {
		return new MemoryStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The automazioni of an instance (ADR 0060): addresses other services call to make it work. */
	automations(tenant: string, instance: string): AutomationStore {
		return new AutomationStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The skills of an instance (ADR 0059): procedures its people saved, shared by all of them. */
	skills(tenant: string, instance: string): SkillStore {
		return new SkillStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The liste of an instance: each person's and the shared ones. */
	lists(tenant: string, instance: string): ListStore {
		return new ListStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The scadenzario of an instance: which invoices are paid, and the owner's company. */
	invoices(tenant: string, instance: string): InvoiceStore {
		return new InvoiceStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The preventivi of an instance. */
	quotes(tenant: string, instance: string): QuoteStore {
		return new QuoteStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The spese of an instance. */
	expenses(tenant: string, instance: string): ExpenseStore {
		return new ExpenseStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The ore di lavoro of an instance: entries, timers and rates. */
	timesheet(tenant: string, instance: string): TimesheetStore {
		// A to_quote reservation whose quote was made is billed with it, never dropped.
		const quotes = this.quotes(tenant, instance);
		return new TimesheetStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)), { finishedQuote: (callId) => quotes.finished(callId) });
	}

	/** The rinnovi e abbonamenti of an instance. */
	renewals(tenant: string, instance: string): RenewalStore {
		return new RenewalStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** La previsione di cassa of an instance: the balances said and the voci added by hand. */
	cashflow(tenant: string, instance: string): CashflowStore {
		return new CashflowStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Le tasse del forfettario of an instance: the profile and the figures said per year. */
	taxes(tenant: string, instance: string): TaxStore {
		return new TaxStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Whom a private thread is with, as "<channel>:<userId>"; undefined for a group or unknown thread. */
	participant(tenant: string, instance: string, thread: { channel: string; threadId: string }): string | undefined {
		return this.participants(tenant, instance).get(threadKey(thread.channel, thread.threadId));
	}

	private participants(tenant: string, instance: string): Participants {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		let store = this.participantStores.get(key);
		if (store === undefined) {
			store = new Participants(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
			this.participantStores.set(key, store);
		}
		return store;
	}

	/** The tasks programmati of an instance. */
	schedules(tenant: string, instance: string): ScheduleStore {
		return new ScheduleStore(schedulesDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The sentinelle of an instance: pages it checks by itself (ADR 0018). */
	watches(tenant: string, instance: string): WatchStore {
		return new WatchStore(watchesDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The files of an instance. Reading them needs no open instance. */
	workspace(tenant: string, instance: string): Workspace {
		return new Workspace(workspaceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/**
	 * Send a workspace file to a thread, through the outbox like a reply: at least once,
	 * the same `key` at most once per process and never again after the channel accepted it.
	 */
	async sendFile(tenant: string, instance: string, file: { channel: string; threadId: string; path: string; caption?: string; key: string }): Promise<void> {
		const opened = await this.openInstance(tenant, instance);
		if ((await this.workspace(tenant, instance).stat(file.path)) === undefined) throw new Error(`File not found in the workspace: ${file.path}`);
		await opened.sendFile(file);
	}

	audit(tenant: string): AuditLog {
		return new AuditLog(this.options.dataDir, tenantId(tenant));
	}

	/** Open an instance's engine session once per process; later calls share it. */
	openInstance(tenant: string, instance: string): Promise<AnnieInstance> {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		if (this.removing.has(key)) return Promise.reject(new NotFound(`Instance "${instanceId(instance)}" is being deleted`));
		let opening = this.instances.get(key);
		if (opening === undefined) {
			opening = this.open(tenant, instance);
			opening.catch(() => this.instances.delete(key));
			this.instances.set(key, opening);
		}
		return opening;
	}

	async submit(request: SubmitRequest): Promise<{ submissionId: string }> {
		return (await this.openInstance(request.tenantId, request.instanceId)).submit(request);
	}

	async chatModel(tenant: string, instance: string, channel: string, threadId: string): Promise<ModelSelection | undefined> {
		return (await this.openInstance(tenant, instance)).chatModel(channel, threadId);
	}

	async setChatModel(tenant: string, instance: string, chat: { channel: string; threadId: string }, model: ModelSelection | undefined, by: string): Promise<void> {
		await (await this.openInstance(tenant, instance)).setChatModel(chat.channel, chat.threadId, model, by);
	}

	async submitScheduled(
		tenant: string,
		instance: string,
		request: { channel: string; threadId: string; text: string; messageId: string; scheduleId: string; onBehalfOf: { channel: string; userId: string } | undefined; kind?: "brief" | "watch" | "automation" },
	): Promise<{ submissionId: string }> {
		return (await this.openInstance(tenant, instance)).submitScheduled(request);
	}

	/** Something that happened for a conversation (the outcome of an approved action), for the instance to report there. */
	async submitNotice(tenant: string, instance: string, request: { channel: string; threadId: string; text: string; messageId: string; event: Record<string, string | number | boolean> }): Promise<{ submissionId: string }> {
		return (await this.openInstance(tenant, instance)).submitNotice(request);
	}

	/**
	 * Resume one instance: hand undelivered replies of earlier processes to the channels
	 * again, then continue unfinished engine work. Connect channels before calling it.
	 */
	async resume(tenant: string, instance: string): Promise<{ pending: number; undelivered: number; reattached: number }> {
		return (await this.openInstance(tenant, instance)).resume();
	}

	/**
	 * The channel accepted `reply`: record it in the outbox so it is never sent again. Never
	 * opens the instance: after close() the reply stays in the outbox for the next process.
	 */
	async markDelivered(reply: Pick<Reply, "tenantId" | "instanceId" | "deliveryId">): Promise<void> {
		const opening = this.instances.get(`${reply.tenantId}/${reply.instanceId}`);
		if (opening === undefined) throw new Error(`Instance ${reply.tenantId}/${reply.instanceId} is not open; the reply stays in the outbox`);
		await (await opening).markDelivered(reply.deliveryId);
	}

	/**
	 * The channel did not take `reply`. A failure is sent again later in this process, with
	 * backoff; a refusal (the channel said no) waits for the next resume. Never opens the instance.
	 */
	async deliveryFailed(reply: Pick<Reply, "tenantId" | "instanceId" | "deliveryId" | "attempt">, failure: DeliveryFailure): Promise<void> {
		const opening = this.instances.get(`${reply.tenantId}/${reply.instanceId}`);
		if (opening === undefined) return;
		await (await opening).deliveryFailed(reply.deliveryId, reply.attempt, failure);
	}

	/**
	 * Close an open instance and open it again, so a changed record or tool list applies.
	 * Work in flight resumes as after a restart: unsent replies go out from the outbox.
	 */
	async reopen(tenant: string, instance: string): Promise<{ pending: number; undelivered: number; reattached: number }> {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		if (this.removing.has(key)) throw new NotFound(`Instance "${instanceId(instance)}" is being deleted`);
		const previous = this.instances.get(key);
		// The map holds the reopening at once: a submit meanwhile waits for the new instance
		// instead of hitting the old one's lock, and a second reopen queues behind this one.
		const next = (async () => {
			await (await previous?.catch(() => undefined))?.close();
			if (this.removing.has(key)) throw new NotFound(`Instance "${instanceId(instance)}" is being deleted`);
			return this.open(tenant, instance);
		})();
		next.catch(() => {
			if (this.instances.get(key) === next) this.instances.delete(key);
		});
		this.instances.set(key, next);
		await next;
		// A later reopen may already have replaced this one: resume the current instance.
		return this.resume(tenant, instance);
	}

	/**
	 * Delete an instance (ADR 0046): close it if open, without resuming it, and remove its record
	 * and everything it kept. Work in flight is dropped with it. Channels, bots and the rest that
	 * live outside the core are the caller's to stop first.
	 */
	async removeInstance(tenant: string, instance: string): Promise<void> {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		if (this.removing.has(key)) throw new NotFound(`Instance "${instanceId(instance)}" is being deleted`);
		this.removing.add(key);
		try {
			const record = await this.registry.getInstance(tenant, instance);
			const open = this.instances.get(key);
			this.instances.delete(key);
			await (await open?.catch(() => undefined))?.close();
			this.participantStores.delete(key);
			// Another process with the instance open (the CLI, a bot run on its own) stops the deletion here.
			const lock = InstanceLock.acquire(lockFile(this.options.dataDir, record.tenantId, record.id), `${record.tenantId}/${record.id}`);
			try {
				await this.registry.deleteInstance(tenant, instance);
			} finally {
				lock.release();
			}
		} finally {
			this.removing.delete(key);
		}
	}

	/**
	 * Work under way in a tenant's open instances: submissions still waiting for their reply,
	 * and replies with a retry pending. A process that may be stopped (a cell) waits for zero.
	 * Replies that only wait for a restart do not count: the next resume sends them.
	 */
	async activity(tenant: string): Promise<{ working: number; retrying: number }> {
		const prefix = `${tenantId(tenant)}/`;
		let working = 0;
		let retrying = 0;
		for (const [key, opening] of this.instances) {
			if (!key.startsWith(prefix)) continue;
			const instance = await opening.catch(() => undefined);
			if (instance === undefined) continue;
			const a = await instance.activity();
			working += a.working;
			retrying += a.retrying;
		}
		return { working, retrying };
	}

	onReply(listener: (reply: Reply) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		const opened = await Promise.allSettled(this.instances.values());
		this.instances.clear();
		const closed = await Promise.allSettled(opened.map((result) => (result.status === "fulfilled" ? result.value.close() : undefined)));
		const failed = closed.find((result) => result.status === "rejected");
		if (failed !== undefined) throw failed.reason;
	}

	private async open(tenant: string, instance: string): Promise<AnnieInstance> {
		const record = await this.registry.getInstance(tenant, instance);
		const audit = this.audit(record.tenantId);
		try {
			assertModelProviderAllowed(record.egress, record.model.provider);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await audit.append({ type: "egress.denied", instanceId: record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		const secrets = this.secrets(record.tenantId);
		const fresh = () => this.registry.getInstance(record.tenantId, record.id);
		// A model can answer: its provider allowed by the policy now, and a key for it (none for the local one).
		const reachable = async (provider: string) => {
			try {
				return (await fresh()).egress.modelProviders.includes(provider) && (provider === DEV_PROVIDER || (await secrets.get(modelApiKeySecret(provider))) !== undefined);
			} catch {
				return false;
			}
		};
		const storageDir = engineDir(this.options.dataDir, record.tenantId, record.id);
		await mkdir(storageDir, { recursive: true });
		// Before anything touches the instance's storage: one process per instance.
		const lock = InstanceLock.acquire(lockFile(this.options.dataDir, record.tenantId, record.id), `${record.tenantId}/${record.id}`);
		let session: EngineSession;
		let toolSet: ToolSet = [];
		// Its own instructions, then who it is (ADR 0041), then its skills as they are now (ADR 0059).
		const own = withPersona(record.instructions, record.name, record.persona);
		const skills = this.skills(record.tenantId, record.id);
		const instructions = () => `${own === undefined || own === "" ? "" : `${own}\n\n`}${skillCatalog(skills.list())}`;
		try {
			toolSet = typeof this.options.tools === "function" ? await this.options.tools(record) : (this.options.tools ?? []);
			session = await this.options.engine.open({
				storageDir,
				model: record.model,
				// Only this tenant's secrets, and only for providers the policy allows now.
				apiKey: async (provider) => ((await fresh()).egress.modelProviders.includes(provider) ? secrets.get(modelApiKeySecret(provider)) : undefined),
				modelUsable: reachable,
				tools: "tools" in toolSet ? toolSet.tools : toolSet,
				instructions,
			});
		} catch (error) {
			if ("close" in toolSet) await toolSet.close().catch(() => {});
			lock.release();
			throw error;
		}
		try {
			await audit.append({ type: "instance.opened", instanceId: record.id, modelProvider: record.model.provider });
		} catch (error) {
			await session
				.close()
				.then(() => ("close" in toolSet ? toolSet.close() : undefined))
				.finally(() => lock.release());
			throw error;
		}
		const outbox = new Outbox(outboxDir(this.options.dataDir, record.tenantId, record.id));
		const releaseTools = "close" in toolSet ? toolSet.close : async () => {};
		return new AnnieInstance(record, session, lock, outbox, audit, releaseTools, fresh, reachable, { delaysMs: this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS, max: this.options.maxRetries ?? DEFAULT_MAX_RETRIES }, { store: this.memory(record.tenantId, record.id), participants: this.participants(record.tenantId, record.id), lists: this.lists(record.tenantId, record.id), skills }, (reply) => {
			for (const listener of this.listeners) {
				try {
					listener(reply);
				} catch (error) {
					console.error(`annie: reply listener failed: ${String(error)}`);
				}
			}
		});
	}
}

/** Outbox keys of messages whose text goes once delivered. */
const SECRET_KEY = "secret:";

export class AnnieInstance {
	/** Outbox keys this process has handed to the channels. Each at most once per process. */
	private readonly handedOff = new Set<string>();
	/** Outbox operations on the same key run one after the other. */
	private readonly chains = new Map<string, Promise<void>>();
	/** Pending in-process retries, cleared on close. */
	private readonly retries = new Map<string, NodeJS.Timeout>();
	private closed = false;

	constructor(
		readonly record: InstanceRecord,
		private readonly session: EngineSession,
		private readonly lock: InstanceLock,
		private readonly outbox: Outbox,
		private readonly audit: AuditLog,
		private readonly releaseTools: () => Promise<void>,
		/** The record as stored now: allowlist and channel changes apply without a reopen. */
		private readonly fresh: () => Promise<InstanceRecord>,
		/** The provider is allowed now and has a key: a chat's own model on it can answer. Never throws. */
		private readonly reachable: (provider: string) => Promise<boolean>,
		private readonly retry: { readonly delaysMs: readonly number[]; readonly max: number },
		private readonly memory: { readonly store: MemoryStore; readonly participants: Participants; readonly lists: ListStore; readonly skills: SkillStore },
		private readonly emit: (reply: Reply) => void,
	) {
		session.onReply((engineReply) => {
			this.deliver(engineReply).catch((error: unknown) => {
				console.error(`annie: delivering a reply of ${record.tenantId}/${record.id} failed: ${String(error)}`);
			});
		});
	}

	async submit(request: Omit<SubmitRequest, "tenantId" | "instanceId">): Promise<{ submissionId: string }> {
		if (!CHANNEL_PATTERN.test(request.channel)) throw new Error(`Invalid channel name "${request.channel}"`);
		const record = await this.fresh();
		try {
			assertChannelAllowed(record.egress, request.channel);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		// Who may talk to the instance is decided here, in the core, for every channel: a
		// rejected message never reaches the engine or the model, and gets no reply.
		try {
			assertUserAllowed(record.allowedUsers, request);
		} catch (error) {
			if (error instanceof UserNotAllowed) {
				await this.audit.append({
					type: "user.denied",
					instanceId: this.record.id,
					channel: error.channel,
					userId: error.userId,
					threadId: error.threadId,
					reason: error.reason,
				});
			}
			throw error;
		}
		const { images, skipped } = checkedImages(request.images ?? []);
		await this.audit.append({
			type: "message.received",
			instanceId: this.record.id,
			channel: request.channel,
			threadId: request.threadId,
			userId: request.userId,
			chars: request.text.length,
			...(images.length === 0 ? {} : { images: images.length }),
		});
		// In a private thread the instance learns whom it is with and gets what it remembers about
		// them; in a group, only the shared memories, so one person's never reach the others.
		const key = threadKey(request.channel, request.threadId);
		const { privateThread, images: _given, command: _command, ...message } = request;
		let note: string;
		if (privateThread === true) {
			const subject = subjectOf(request.channel, request.userId);
			this.memory.participants.set(key, subject);
			note = memoryNote(this.memory.store.forSubject(subject), listsLine(this.memory.lists.visible(subject)), this.memory.store.archivedFor(subject));
		} else {
			this.memory.participants.clear(key);
			note = memoryNote(this.memory.store.forSubject(SHARED), listsLine(this.memory.lists.visible(undefined)), this.memory.store.archivedFor(SHARED));
		}
		const text = await this.withSkills(request, privateThread === true);
		return this.admit({ ...message, text: `${text}${skipped}${note}` }, images);
	}

	/**
	 * The skills in a person's message (ADR 0059). «/nome» of one: its steps go with their words.
	 * «/attiva-skill nome»: the draft they had the agente write becomes a skill. Only here, from a
	 * message the person wrote in a chat with them alone; never from a scheduled run, a notice or
	 * another agente, so a page or a mail the agente read cannot turn a draft on.
	 */
	private async withSkills(request: Omit<SubmitRequest, "tenantId" | "instanceId">, alone: boolean): Promise<string> {
		const skills = this.memory.skills;
		// In a stanza the text carries the stanza around the person's words: only theirs can be a command.
		const said = request.command ?? request.text;
		const activating = activateCommand(said);
		if (activating !== undefined) {
			if (!alone || request.channel === AGENT_CHANNEL) return `${request.text}\n\n[Le skill si attivano solo in una conversazione con una persona sola: dillo in una riga.]`;
			const by = subjectOf(request.channel, request.userId);
			const mine = skills.drafts().filter((d) => d.createdBy === by);
			const name = activating === "" && mine.length === 1 ? (mine[0] as { name: string }).name : activating;
			if (name === "") return `${request.text}\n\n[Ha scritto il comando senza il nome. Le sue bozze: ${mine.map((d) => d.name).join(", ") || "nessuna"}. Diglielo in una riga.]`;
			let result: { skill: { name: string }; replaced: boolean } | undefined;
			try {
				result = skills.activate(name, by);
			} catch (error) {
				if (!(error instanceof SkillError)) throw error;
				return `${request.text}\n\n[La skill non si è attivata: ${error.message}. Diglielo in una riga.]`;
			}
			if (result === undefined) {
				const active = skills.get(name);
				return `${request.text}\n\n[${active !== undefined ? `La skill «${active.name}» è già attiva.` : `Non c'è una sua bozza «${name}» da attivare; le sue bozze: ${mine.map((d) => d.name).join(", ") || "nessuna"}.`} Diglielo in una riga.]`;
			}
			await this.audit.append({ type: "skill.activated", instanceId: this.record.id, channel: request.channel, threadId: request.threadId, userId: request.userId, skill: result.skill.name, replaced: result.replaced });
			return `${request.text}\n\n[La persona ha attivato la skill «${result.skill.name}»${result.replaced ? " (nuova versione)" : ""}: da ora la vedi fra le tue skill e si lancia con /${result.skill.name}. Confermalo in una riga.]`;
		}
		const command = skillCommand(said, skills.list());
		if (command === undefined) return request.text;
		await this.audit.append({ type: "skill.used", instanceId: this.record.id, channel: request.channel, threadId: request.threadId, skill: command.skill.name });
		return withSkill(request.text, command.skill, command.rest);
	}

	/**
	 * A task programmato firing: it comes from the instance's own schedule, not from a person,
	 * so the allowlist does not apply (only allowed users can create schedules). The channel
	 * must still be allowed. `messageId` makes a refire after a crash idempotent.
	 */
	async submitScheduled(request: {
		channel: string;
		threadId: string;
		text: string;
		messageId: string;
		scheduleId: string;
		/** The person it acts for: must still be allowed, or the run is refused. */
		onBehalfOf: { channel: string; userId: string } | undefined;
		/** brief: a brief del mattino; watch: a sentinella that saw a change, scheduleId is its ID; automation: an automazione called (ADR 0060), likewise. */
		kind?: "brief" | "watch" | "automation";
	}): Promise<{ submissionId: string }> {
		if (!CHANNEL_PATTERN.test(request.channel)) throw new Error(`Invalid channel name "${request.channel}"`);
		const record = await this.fresh();
		const person = request.onBehalfOf;
		const allowed = person !== undefined && (record.allowedUsers[person.channel] ?? []).includes(person.userId);
		if (!allowed) {
			await this.audit.append({ type: "user.denied", instanceId: this.record.id, channel: person?.channel ?? request.channel, userId: person?.userId ?? "(none)", threadId: request.threadId, reason: "schedule_person_not_allowed", scheduleId: request.scheduleId });
			throw new UserNotAllowed(person?.channel ?? request.channel, person?.userId ?? "(none)", request.threadId, "user_not_in_allowlist");
		}
		try {
			assertChannelAllowed(record.egress, request.channel);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		if (request.kind === "watch") await this.audit.append({ type: "watch.fired", instanceId: this.record.id, watchId: request.scheduleId, channel: request.channel, threadId: request.threadId });
		else if (request.kind === "automation") await this.audit.append({ type: "automation.fired", instanceId: this.record.id, automationId: request.scheduleId, channel: request.channel, threadId: request.threadId });
		else await this.audit.append({ type: "schedule.fired", instanceId: this.record.id, scheduleId: request.scheduleId, channel: request.channel, threadId: request.threadId, ...(request.kind === undefined ? {} : { kind: request.kind }) });
		// The person's own memories only in a thread with them alone: a console thread, or a
		// private chat (whose ID is the person's own on Telegram); a group gets the shared ones.
		const alone = person !== undefined && person.channel === request.channel && (request.channel === "web" || request.threadId === person.userId);
		const subject = alone ? subjectOf(person.channel, person.userId) : undefined;
		// So the tools know whom the thread is with even before the person writes in it (a brief's).
		if (subject !== undefined) this.memory.participants.set(threadKey(request.channel, request.threadId), subject);
		const note = memoryNote(this.memory.store.forSubject(subject ?? SHARED), listsLine(this.memory.lists.visible(subject)), this.memory.store.archivedFor(subject ?? SHARED));
		return this.admit({ ...request, text: `${request.text}${note}` });
	}

	/**
	 * A notice for a conversation from the instance's own work (the outcome of an action a person
	 * approved): not from a person, so no allowlist, but the channel must still be allowed.
	 * `messageId` makes it idempotent.
	 */
	async submitNotice(request: { channel: string; threadId: string; text: string; messageId: string; event: Record<string, string | number | boolean> }): Promise<{ submissionId: string }> {
		if (!CHANNEL_PATTERN.test(request.channel)) throw new Error(`Invalid channel name "${request.channel}"`);
		const record = await this.fresh();
		try {
			assertChannelAllowed(record.egress, request.channel);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		await this.audit.append({ ...request.event, type: "notice.submitted", instanceId: this.record.id, channel: request.channel, threadId: request.threadId });
		return this.admit(request);
	}

	/**
	 * The model a chat answers with instead of the instance's (ADR 0036), when it has one that can
	 * answer now: one whose provider was disallowed or lost its key leaves the instance's answering.
	 */
	async chatModel(channel: string, threadId: string): Promise<ModelSelection | undefined> {
		const own = await this.session.threadModel(threadKey(channel, threadId));
		return own !== undefined && (await this.reachable(own.provider)) ? own : undefined;
	}

	/** Give a chat its own model, from its next message; undefined: the instance's again. */
	async setChatModel(channel: string, threadId: string, model: ModelSelection | undefined, by: string): Promise<void> {
		if (model !== undefined && !(await this.reachable(model.provider))) throw new EgressDenied("model_provider", model.provider);
		await this.session.setThreadModel(threadKey(channel, threadId), model);
		await this.audit.append({ type: "chat.model.updated", instanceId: this.record.id, channel, threadId, by, ...(model === undefined ? {} : { modelProvider: model.provider, modelId: model.modelId }) });
	}

	private async admit(request: { channel: string; threadId: string; text: string; messageId?: string }, images: readonly EngineImage[] = []): Promise<{ submissionId: string }> {
		const requestId = request.messageId === undefined ? undefined : `${request.channel}:${request.messageId}`;
		const { submissionId } = await this.session.submit(threadKey(request.channel, request.threadId), request.text, requestId, images);
		// Record the admitted submission in the outbox: if the process dies after the engine
		// has answered and before the reply is in the outbox, resume() reattaches it by ID.
		const key = this.replyKey(submissionId);
		await this.serial(key, async () => {
			if ((await this.outbox.get(key)) !== undefined) return;
			await this.outbox.put({ key, submissionId, channel: request.channel, threadId: request.threadId, createdAt: new Date().toISOString(), attempts: 0 });
		});
		return { submissionId };
	}

	/**
	 * Hand undelivered replies to the channels again, reattach admitted submissions that have
	 * no reply in the outbox yet, then continue unfinished engine work.
	 */
	async resume(): Promise<{ pending: number; undelivered: number; reattached: number }> {
		// Delivered replies are kept a while (idempotency, audit by key), then dropped: each
		// resume reads the whole outbox.
		// Only replies to people: the keys of the instance's own messages (approval notices)
		// are what stops a notice from going out twice, so they stay.
		const removed = await this.outbox.prune(new Date(Date.now() - OUTBOX_RETENTION_MS), "reply:");
		if (removed > 0) await this.audit.append({ type: "outbox.pruned", instanceId: this.record.id, removed });
		let undelivered = 0;
		let reattached = 0;
		for (const entry of await this.outbox.list()) {
			if (entry.deliveredAt !== undefined) continue;
			if (entry.reply === undefined) {
				if (await this.session.reattach(entry.submissionId, threadKey(entry.channel, entry.threadId))) reattached++;
				continue;
			}
			undelivered++;
			await this.serial(entry.key, async () => {
				// Re-read under the key's chain: the snapshot above may be stale by now.
				const current = await this.outbox.get(entry.key);
				if (current?.reply !== undefined && current.deliveredAt === undefined) await this.handOff(current);
			});
		}
		const { pending } = await this.session.resume();
		await this.audit.append({ type: "instance.resumed", instanceId: this.record.id, pending, undelivered, reattached });
		return { pending, undelivered, reattached };
	}

	async markDelivered(deliveryId: string): Promise<void> {
		if (this.closed) throw new Error(`Instance ${this.record.tenantId}/${this.record.id} is closed; the reply stays in the outbox`);
		await this.serial(deliveryId, async () => {
			const entry = await this.outbox.get(deliveryId);
			if (entry === undefined) throw new NotFound(`No outbox entry "${deliveryId}" in ${this.record.tenantId}/${this.record.id}`);
			if (entry.deliveredAt !== undefined) return;
			// A message with a secret (an automazione's token) keeps its key, not its text, once delivered.
			const scrubbed = entry.key.includes(`/${SECRET_KEY}`) && entry.reply?.status === "answered" ? { reply: { status: "answered" as const, text: "[tolto dopo la consegna: conteneva un segreto]" } } : {};
			await this.outbox.put({ ...entry, ...scrubbed, deliveredAt: new Date().toISOString() });
			await this.audit.append({
				type: "reply.delivered",
				instanceId: this.record.id,
				channel: entry.channel,
				threadId: entry.threadId,
				deliveryId,
				attempts: entry.attempts,
				possibleDuplicate: entry.attempts > 1,
			});
		});
	}

	/**
	 * The channel did not confirm hand-off number `attempt` of a reply. Ignored when a later
	 * hand-off already exists (a reopen sent it again) or a retry is already pending.
	 */
	async deliveryFailed(deliveryId: string, attempt: number, failure: DeliveryFailure): Promise<void> {
		await this.serial(deliveryId, async () => {
			if (this.closed || this.retries.has(deliveryId)) return;
			const entry = await this.outbox.get(deliveryId);
			if (entry === undefined || entry.deliveredAt !== undefined || entry.attempts !== attempt) return;
			const event = { instanceId: this.record.id, channel: entry.channel, threadId: entry.threadId, deliveryId, attempts: entry.attempts, reason: failure.reason.slice(0, 200) };
			if (failure.refused) return void (await this.audit.append({ type: "reply.refused", ...event }));
			if (entry.attempts - 1 >= this.retry.max) return void (await this.audit.append({ type: "reply.retries_exhausted", ...event }));
			const delays = this.retry.delaysMs;
			const delay = delays[Math.min(entry.attempts, delays.length) - 1] ?? DEFAULT_RETRY_DELAYS_MS[0];
			const timer = setTimeout(() => {
				this.serial(deliveryId, async () => {
					this.retries.delete(deliveryId);
					const current = await this.outbox.get(deliveryId);
					if (this.closed || current?.reply === undefined || current.deliveredAt !== undefined) return;
					this.handedOff.delete(deliveryId);
					await this.handOff(current);
				}).catch((error: unknown) => console.error(`annie: retrying a reply of ${this.record.tenantId}/${this.record.id} failed: ${String(error)}`));
			}, delay);
			timer.unref();
			this.retries.set(deliveryId, timer);
			await this.audit.append({ type: "reply.retry_scheduled", ...event, inMs: delay });
		});
	}

	/** `secret`: the text is dropped from the outbox once the channel has it (ADR 0060). */
	async sendMessage(message: { channel: string; threadId: string; text: string; key: string; secret?: boolean }): Promise<void> {
		assertChannelAllowed(this.record.egress, message.channel);
		const key = `msg:${this.record.tenantId}/${this.record.id}/${message.secret === true ? SECRET_KEY : ""}${message.key}`;
		await this.serial(key, async () => {
			const existing = await this.outbox.get(key);
			if (existing?.deliveredAt !== undefined) return;
			await this.handOff(
				existing ?? { key, submissionId: "message", channel: message.channel, threadId: message.threadId, reply: { status: "answered", text: message.text }, createdAt: new Date().toISOString(), attempts: 0 },
			);
		});
	}

	async sendFile(file: { channel: string; threadId: string; path: string; caption?: string; key: string }): Promise<void> {
		assertChannelAllowed(this.record.egress, file.channel);
		const key = `file:${this.record.tenantId}/${this.record.id}/${file.key}`;
		await this.serial(key, async () => {
			const existing = await this.outbox.get(key);
			if (existing?.deliveredAt !== undefined) return;
			await this.handOff(
				existing ?? {
					key,
					submissionId: "file",
					channel: file.channel,
					threadId: file.threadId,
					reply: { status: "file", path: file.path, ...(file.caption === undefined ? {} : { caption: file.caption }) },
					createdAt: new Date().toISOString(),
					attempts: 0,
				},
			);
		});
	}

	async activity(): Promise<{ working: number; retrying: number }> {
		const waiting = (await this.outbox.list()).filter((entry) => entry.reply === undefined && entry.deliveredAt === undefined);
		return { working: waiting.length, retrying: this.retries.size };
	}

	/** Replies not yet confirmed by their channel, oldest first. */
	async undelivered(): Promise<OutboxEntry[]> {
		return (await this.outbox.list()).filter((entry) => entry.reply !== undefined && entry.deliveredAt === undefined);
	}

	idle(): Promise<void> {
		return this.session.idle();
	}

	async close(): Promise<void> {
		// Replies that settle from now on are left to the next process (resume() reattaches them).
		this.closed = true;
		for (const timer of this.retries.values()) clearTimeout(timer);
		this.retries.clear();
		try {
			await this.session.close();
			await Promise.allSettled(this.chains.values());
			await this.releaseTools().catch((error: unknown) => console.error(`annie: releasing tools of ${this.record.tenantId}/${this.record.id} failed: ${String(error)}`));
		} finally {
			this.lock.release();
		}
	}

	private async deliver(engineReply: EngineReply): Promise<void> {
		if (this.closed) return;
		const { channel, threadId } = parseThreadKey(engineReply.threadKey);
		const key = this.replyKey(engineReply.submissionId);
		const reply: OutboxEntry["reply"] =
			engineReply.status === "answered"
				? { status: "answered", text: engineReply.text, ...(engineReply.model === undefined ? {} : { model: engineReply.model }) }
				: { status: "unanswered", reason: engineReply.reason };
		await this.serial(key, async () => {
			const existing = await this.outbox.get(key);
			if (existing?.deliveredAt !== undefined) return;
			await this.handOff(
				existing === undefined
					? { key, submissionId: engineReply.submissionId, channel, threadId, reply, createdAt: new Date().toISOString(), attempts: 0 }
					: { ...existing, reply: existing.reply ?? reply },
			);
		});
	}

	/**
	 * Write the entry to the outbox, durably, then give it to the channels. Call only inside
	 * `serial(entry.key)`, with an entry just read or built there.
	 */
	private async handOff(entry: OutboxEntry): Promise<void> {
		const reply = entry.reply;
		if (reply === undefined || this.handedOff.has(entry.key)) return;
		// Replies leave through a channel: check egress again, the policy as stored now is the last word.
		if (!(await this.fresh()).egress.channels.includes(entry.channel)) {
			await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: "channel", target: entry.channel });
			return;
		}
		this.handedOff.add(entry.key);
		const attempts = entry.attempts + 1;
		try {
			await this.outbox.put({ ...entry, attempts });
		} catch (error) {
			this.handedOff.delete(entry.key);
			throw error;
		}
		const { channel, threadId } = entry;
		await this.audit.append({
			type: "reply.emitted",
			instanceId: this.record.id,
			channel,
			threadId,
			deliveryId: entry.key,
			attempts,
			status: reply.status,
			...(reply.status === "answered" ? { chars: reply.text.length } : reply.status === "unanswered" ? { reason: reply.reason } : {}),
		});
		const base = { tenantId: this.record.tenantId, instanceId: this.record.id, channel, threadId, deliveryId: entry.key, possibleDuplicate: attempts > 1, attempt: attempts, submissionId: entry.submissionId };
		this.emit({ ...base, ...reply });
	}

	/** Idempotency key of a submission's reply; unique across tenants and instances. */
	private replyKey(submissionId: string): string {
		return `reply:${this.record.tenantId}/${this.record.id}/${submissionId}`;
	}

	private serial(key: string, work: () => Promise<void>): Promise<void> {
		const run = (this.chains.get(key) ?? Promise.resolve()).then(work);
		const tail = run.catch(() => {});
		this.chains.set(key, tail);
		void tail.then(() => {
			if (this.chains.get(key) === tail) this.chains.delete(key);
		});
		return run;
	}
}

function threadKey(channel: string, threadId: string): string {
	return `${channel}:${threadId}`;
}

function parseThreadKey(key: string): { channel: string; threadId: string } {
	const at = key.indexOf(":");
	return { channel: key.slice(0, at), threadId: key.slice(at + 1) };
}

/**
 * The pictures of a message the model may see: real images within the size limit, at most
 * IMAGE_LIMITS.perMessage. The rest are named in a note, so the model can tell the person.
 */
function checkedImages(given: readonly { readonly path: string; readonly data: Uint8Array }[]): { images: EngineImage[]; skipped: string } {
	const images: EngineImage[] = [];
	const extra: string[] = [];
	const refused: string[] = [];
	for (const image of given) {
		const problem = imageProblem(image.data);
		if (problem !== undefined) refused.push(`${image.path} (${problem})`);
		else if (images.length >= IMAGE_LIMITS.perMessage) extra.push(image.path);
		else images.push({ mimeType: imageType(image.data) as string, data: image.data });
	}
	const parts = [...(extra.length === 0 ? [] : [`${extra.join(", ")} (al massimo ${IMAGE_LIMITS.perMessage} per messaggio)`]), ...refused];
	return { images, skipped: parts.length === 0 ? "" : `\n\n[Immagini non mostrate: ${parts.join("; ")}]` };
}
