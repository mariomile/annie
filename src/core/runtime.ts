import { mkdir } from "node:fs/promises";
import { AuditLog } from "./audit.ts";
import type { AnnieTool, DurableEngine, EngineReply, EngineSession } from "./engine.ts";
import { EgressDenied, NotFound, UserNotAllowed } from "./errors.ts";
import { type InstanceId, instanceId, type TenantId, tenantId } from "./ids.ts";
import { InstanceLock } from "./lock.ts";
import { Outbox, type OutboxEntry } from "./outbox.ts";
import { engineDir, lockFile, outboxDir, workspaceDir } from "./paths.ts";
import { Workspace } from "./workspace.ts";
import { assertChannelAllowed, assertModelProviderAllowed, assertUserAllowed, CHANNEL_PATTERN } from "./policy.ts";
import { type InstanceRecord, TenantRegistry } from "./registry.ts";
import { modelApiKeySecret, TenantSecrets } from "./secrets.ts";

/** A normalized inbound message as the core sees it. Channels translate to this shape. */
export type SubmitRequest = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly userId: string;
	readonly text: string;
	/** Channel-native message ID; makes a redelivered message idempotent. */
	readonly messageId?: string;
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
} & (
	| { readonly status: "answered"; readonly text: string }
	| { readonly status: "unanswered"; readonly reason: string }
	/** A file of the instance's workspace to send to the thread. */
	| { readonly status: "file"; readonly path: string; readonly caption?: string }
);

export type RuntimeOptions = {
	readonly dataDir: string;
	readonly engine: DurableEngine;
	/**
	 * Tools of an instance: the same list for all, or computed from the instance's record
	 * when it is opened (connectors, approved tools). A changed list applies on `reopen`.
	 */
	readonly tools?: readonly AnnieTool[] | ((record: InstanceRecord) => Promise<readonly AnnieTool[]>);
};

/**
 * Annie's core. Knows tenants, instances, secrets, audit and egress policy; runs each
 * instance on its own durable engine session and storage. Knows nothing about channels
 * beyond their names.
 */
export class AnnieRuntime {
	readonly registry: TenantRegistry;
	private readonly instances = new Map<string, Promise<AnnieInstance>>();
	private readonly listeners = new Set<(reply: Reply) => void>();

	constructor(private readonly options: RuntimeOptions) {
		this.registry = new TenantRegistry(options.dataDir);
	}

	secrets(tenant: string): TenantSecrets {
		return new TenantSecrets(this.options.dataDir, tenantId(tenant));
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
	 * Close an open instance and open it again, so a changed record or tool list applies.
	 * Work in flight resumes as after a restart: unsent replies go out from the outbox.
	 */
	async reopen(tenant: string, instance: string): Promise<{ pending: number; undelivered: number; reattached: number }> {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		const opening = this.instances.get(key);
		if (opening !== undefined) {
			this.instances.delete(key);
			await (await opening.catch(() => undefined))?.close();
		}
		return this.resume(tenant, instance);
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
		const storageDir = engineDir(this.options.dataDir, record.tenantId, record.id);
		await mkdir(storageDir, { recursive: true });
		// Before anything touches the instance's storage: one process per instance.
		const lock = InstanceLock.acquire(lockFile(this.options.dataDir, record.tenantId, record.id), `${record.tenantId}/${record.id}`);
		let session: EngineSession;
		try {
			session = await this.options.engine.open({
				storageDir,
				model: record.model,
				// Only this tenant's secrets, and only for providers the policy allows.
				apiKey: async (provider) =>
					record.egress.modelProviders.includes(provider) ? secrets.get(modelApiKeySecret(provider)) : undefined,
				tools: typeof this.options.tools === "function" ? await this.options.tools(record) : (this.options.tools ?? []),
				...(record.instructions === undefined ? {} : { instructions: record.instructions }),
			});
		} catch (error) {
			lock.release();
			throw error;
		}
		try {
			await audit.append({ type: "instance.opened", instanceId: record.id, modelProvider: record.model.provider });
		} catch (error) {
			await session.close().finally(() => lock.release());
			throw error;
		}
		const outbox = new Outbox(outboxDir(this.options.dataDir, record.tenantId, record.id));
		return new AnnieInstance(record, session, lock, outbox, audit, (reply) => {
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

export class AnnieInstance {
	/** Outbox keys this process has handed to the channels. Each at most once per process. */
	private readonly handedOff = new Set<string>();
	/** Outbox operations on the same key run one after the other. */
	private readonly chains = new Map<string, Promise<void>>();
	private closed = false;

	constructor(
		readonly record: InstanceRecord,
		private readonly session: EngineSession,
		private readonly lock: InstanceLock,
		private readonly outbox: Outbox,
		private readonly audit: AuditLog,
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
		try {
			assertChannelAllowed(this.record.egress, request.channel);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		// Who may talk to the instance is decided here, in the core, for every channel: a
		// rejected message never reaches the engine or the model, and gets no reply.
		try {
			assertUserAllowed(this.record.allowedUsers, request);
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
		await this.audit.append({
			type: "message.received",
			instanceId: this.record.id,
			channel: request.channel,
			threadId: request.threadId,
			userId: request.userId,
			chars: request.text.length,
		});
		const requestId = request.messageId === undefined ? undefined : `${request.channel}:${request.messageId}`;
		const { submissionId } = await this.session.submit(threadKey(request.channel, request.threadId), request.text, requestId);
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
			await this.outbox.put({ ...entry, deliveredAt: new Date().toISOString() });
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
		try {
			await this.session.close();
			await Promise.allSettled(this.chains.values());
		} finally {
			this.lock.release();
		}
	}

	private async deliver(engineReply: EngineReply): Promise<void> {
		if (this.closed) return;
		const { channel, threadId } = parseThreadKey(engineReply.threadKey);
		const key = this.replyKey(engineReply.submissionId);
		const reply: OutboxEntry["reply"] =
			engineReply.status === "answered" ? { status: "answered", text: engineReply.text } : { status: "unanswered", reason: engineReply.reason };
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
		// Replies leave through a channel: check egress again, the policy is the last word.
		if (!this.record.egress.channels.includes(entry.channel)) {
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
		const base = { tenantId: this.record.tenantId, instanceId: this.record.id, channel, threadId, deliveryId: entry.key, possibleDuplicate: attempts > 1 };
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
