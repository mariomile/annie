import { mkdir } from "node:fs/promises";
import { AuditLog } from "./audit.ts";
import type { AnnieTool, DurableEngine, EngineReply, EngineSession } from "./engine.ts";
import { EgressDenied } from "./errors.ts";
import { type InstanceId, instanceId, type TenantId, tenantId } from "./ids.ts";
import { engineDir } from "./paths.ts";
import { assertChannelAllowed, assertModelProviderAllowed } from "./policy.ts";
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
} & ({ readonly status: "answered"; readonly text: string } | { readonly status: "unanswered"; readonly reason: string });

export type RuntimeOptions = {
	readonly dataDir: string;
	readonly engine: DurableEngine;
	/** Tools every instance gets. */
	readonly tools?: readonly AnnieTool[];
};

const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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

	/** Resume unfinished work of one instance. */
	async resume(tenant: string, instance: string): Promise<{ pending: number }> {
		return (await this.openInstance(tenant, instance)).resume();
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
		const session = await this.options.engine.open({
			storageDir,
			model: record.model,
			// Only this tenant's secrets, and only for providers the policy allows.
			apiKey: async (provider) =>
				record.egress.modelProviders.includes(provider) ? secrets.get(modelApiKeySecret(provider)) : undefined,
			tools: this.options.tools ?? [],
			...(record.instructions === undefined ? {} : { instructions: record.instructions }),
		});
		await audit.append({ type: "instance.opened", instanceId: record.id, modelProvider: record.model.provider });
		return new AnnieInstance(record, session, audit, (reply) => {
			for (const listener of this.listeners) listener(reply);
		});
	}
}

export class AnnieInstance {
	constructor(
		readonly record: InstanceRecord,
		private readonly session: EngineSession,
		private readonly audit: AuditLog,
		emit: (reply: Reply) => void,
	) {
		session.onReply((engineReply) => {
			void this.deliver(engineReply, emit);
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

	async resume(): Promise<{ pending: number }> {
		const result = await this.session.resume();
		await this.audit.append({ type: "instance.resumed", instanceId: this.record.id, pending: result.pending });
		return result;
	}

	idle(): Promise<void> {
		return this.session.idle();
	}

	close(): Promise<void> {
		return this.session.close();
	}

	private async deliver(engineReply: EngineReply, emit: (reply: Reply) => void): Promise<void> {
		const { channel, threadId } = parseThreadKey(engineReply.threadKey);
		// Replies leave through a channel: check egress again, the policy is the last word.
		if (!this.record.egress.channels.includes(channel)) {
			await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: "channel", target: channel });
			return;
		}
		const base = { tenantId: this.record.tenantId, instanceId: this.record.id, channel, threadId };
		await this.audit.append({
			type: "reply.emitted",
			instanceId: this.record.id,
			channel,
			threadId,
			status: engineReply.status,
			...(engineReply.status === "answered" ? { chars: engineReply.text.length } : { reason: engineReply.reason }),
		});
		emit(
			engineReply.status === "answered"
				? { ...base, status: "answered", text: engineReply.text }
				: { ...base, status: "unanswered", reason: engineReply.reason },
		);
	}
}

function threadKey(channel: string, threadId: string): string {
	return `${channel}:${threadId}`;
}

function parseThreadKey(key: string): { channel: string; threadId: string } {
	const at = key.indexOf(":");
	return { channel: key.slice(0, at), threadId: key.slice(at + 1) };
}
