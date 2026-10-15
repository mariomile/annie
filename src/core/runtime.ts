import { mkdir } from "node:fs/promises";
import { AuditLog } from "./audit.ts";
import type { AnnieTool, DurableEngine, EngineReply, EngineSession } from "./engine.ts";
import { EgressDenied, NotFound, UserNotAllowed } from "./errors.ts";
import { type InstanceId, instanceId, type TenantId, tenantId } from "./ids.ts";
import { InstanceLock } from "./lock.ts";
import { Outbox, type OutboxEntry } from "./outbox.ts";
import { engineDir, lockFile, outboxDir } from "./paths.ts";
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
} & ({ readonly status: "answered"; readonly text: string } | { readonly status: "unanswered"; readonly reason: string });

export type RuntimeOptions = {
	readonly dataDir: string;
	readonly engine: DurableEngine;
	/** Tools every instance gets. */
	readonly tools?: readonly AnnieTool[];
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
	async resume(tenant: string, instance: string): Promise<{ pending: number; undelivered: number }> {
		return (await this.openInstance(tenant, instance)).resume();
	}

	/** The channel accepted `reply`: record it in the outbox so it is never sent again. */
	async markDelivered(reply: Pick<Reply, "tenantId" | "instanceId" | "deliveryId">): Promise<void> {
		await (await this.openInstance(reply.tenantId, reply.instanceId)).markDelivered(reply.deliveryId);
	}

	onReply(listener: (reply: Reply) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		const opened = await Promise.allSettled(this.instances.values());
		this.instances.clear();
		for (const result of opened) if (result.status === "fulfilled") await result.value.close();
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
				tools: this.options.tools ?? [],
				...(record.instructions === undefined ? {} : { instructions: record.instructions }),
			});
		} catch (error) {
			lock.release();
			throw error;
		}
		await audit.append({ type: "instance.opened", instanceId: record.id, modelProvider: record.model.provider });
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
	/** Outbox keys handed to the channels by this process and not yet confirmed. */
	private readonly inFlight = new Set<string>();

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
		return this.session.submit(threadKey(request.channel, request.threadId), request.text, requestId);
	}

	async resume(): Promise<{ pending: number; undelivered: number }> {
		// Replies first: they were answered before anything the engine is about to resume.
		const undelivered = await this.outbox.undelivered();
		for (const entry of undelivered) await this.handOff(entry);
		const { pending } = await this.session.resume();
		await this.audit.append({ type: "instance.resumed", instanceId: this.record.id, pending, undelivered: undelivered.length });
		return { pending, undelivered: undelivered.length };
	}

	async markDelivered(deliveryId: string): Promise<void> {
		const entry = await this.outbox.get(deliveryId);
		if (entry === undefined) throw new NotFound(`No outbox entry "${deliveryId}" in ${this.record.tenantId}/${this.record.id}`);
		if (entry.deliveredAt !== undefined) return;
		await this.outbox.put({ ...entry, deliveredAt: new Date().toISOString() });
		this.inFlight.delete(deliveryId);
		await this.audit.append({
			type: "reply.delivered",
			instanceId: this.record.id,
			channel: entry.channel,
			threadId: entry.threadId,
			deliveryId,
			attempts: entry.attempts,
			possibleDuplicate: entry.attempts > 1,
		});
	}

	/** Replies not yet confirmed by their channel, oldest first. */
	undelivered(): Promise<OutboxEntry[]> {
		return this.outbox.undelivered();
	}

	idle(): Promise<void> {
		return this.session.idle();
	}

	async close(): Promise<void> {
		try {
			await this.session.close();
		} finally {
			this.lock.release();
		}
	}

	private async deliver(engineReply: EngineReply): Promise<void> {
		const { channel, threadId } = parseThreadKey(engineReply.threadKey);
		// One outbox entry per submission: the idempotency key of the reply.
		const key = `reply:${engineReply.submissionId}`;
		const existing = await this.outbox.get(key);
		if (existing?.deliveredAt !== undefined) return;
		await this.handOff(
			existing ?? {
				key,
				channel,
				threadId,
				reply: engineReply.status === "answered" ? { status: "answered", text: engineReply.text } : { status: "unanswered", reason: engineReply.reason },
				createdAt: new Date().toISOString(),
				attempts: 0,
			},
		);
	}

	/** Write the entry to the outbox, durably, then give it to the channels. At most once per process. */
	private async handOff(entry: OutboxEntry): Promise<void> {
		if (this.inFlight.has(entry.key)) return;
		// Replies leave through a channel: check egress again, the policy is the last word.
		if (!this.record.egress.channels.includes(entry.channel)) {
			await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: "channel", target: entry.channel });
			return;
		}
		this.inFlight.add(entry.key);
		const attempts = entry.attempts + 1;
		try {
			await this.outbox.put({ ...entry, attempts });
		} catch (error) {
			this.inFlight.delete(entry.key);
			throw error;
		}
		const { channel, threadId, reply } = entry;
		await this.audit.append({
			type: "reply.emitted",
			instanceId: this.record.id,
			channel,
			threadId,
			deliveryId: entry.key,
			attempts,
			status: reply.status,
			...(reply.status === "answered" ? { chars: reply.text.length } : { reason: reply.reason }),
		});
		const base = { tenantId: this.record.tenantId, instanceId: this.record.id, channel, threadId, deliveryId: entry.key };
		this.emit(reply.status === "answered" ? { ...base, status: "answered", text: reply.text } : { ...base, status: "unanswered", reason: reply.reason });
	}
}

function threadKey(channel: string, threadId: string): string {
	return `${channel}:${threadId}`;
}

function parseThreadKey(key: string): { channel: string; threadId: string } {
	const at = key.indexOf(":");
	return { channel: key.slice(0, at), threadId: key.slice(at + 1) };
}
