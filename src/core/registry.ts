import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuditLog } from "./audit.ts";
import { NotFound } from "./errors.ts";
import { type InstanceId, instanceId, type TenantId, tenantId } from "./ids.ts";
import { instanceFile, tenantDir, tenantFile } from "./paths.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import { type AllowedUsers, CHANNEL_PATTERN, DENY_ALL, type EgressPolicy } from "./policy.ts";

export type ModelSelection = {
	/** pi-ai provider ID, e.g. "anthropic". Must also be allowed by the egress policy. */
	readonly provider: string;
	readonly modelId: string;
};

export type TenantRecord = {
	readonly id: TenantId;
	readonly name: string;
	readonly createdAt: string;
};

export type InstanceRecord = {
	readonly id: InstanceId;
	readonly tenantId: TenantId;
	readonly name: string;
	readonly model: ModelSelection;
	readonly egress: EgressPolicy;
	/** Channel → user IDs allowed to talk to this instance. Missing channel: nobody. */
	readonly allowedUsers: AllowedUsers;
	/** Channel → user IDs who may approve this instance's actions (tools proposti). Missing: nobody. */
	readonly approvers?: AllowedUsers;
	readonly instructions?: string;
	readonly createdAt: string;
};

export type CreateInstanceInput = {
	readonly id: string;
	readonly name: string;
	readonly model: ModelSelection;
	/** Omitted: deny everything. */
	readonly egress?: EgressPolicy;
	/** Omitted: nobody may talk to the instance on any channel. */
	readonly allowedUsers?: AllowedUsers;
	readonly approvers?: AllowedUsers;
	readonly instructions?: string;
};

/**
 * The owner's view of all tenants and their instances, stored as JSON files under the
 * data directory. This is what a future owner dashboard reads and writes.
 */
export class TenantRegistry {
	constructor(readonly dataDir: string) {}

	async createTenant(input: { id: string; name: string }): Promise<TenantRecord> {
		const id = tenantId(input.id);
		const record: TenantRecord = { id, name: input.name, createdAt: new Date().toISOString() };
		await writeJsonExclusive(tenantFile(this.dataDir, id), record);
		await new AuditLog(this.dataDir, id).append({ type: "tenant.created" });
		return record;
	}

	async getTenant(id: string): Promise<TenantRecord> {
		const tenant = tenantId(id);
		const record = await readJson<TenantRecord>(tenantFile(this.dataDir, tenant));
		if (record === undefined) throw new NotFound(`Tenant "${tenant}" not found`);
		return record;
	}

	async listTenants(): Promise<TenantRecord[]> {
		const ids = await listDirs(join(this.dataDir, "tenants"));
		return Promise.all(ids.map((id) => this.getTenant(id)));
	}

	async createInstance(tenant: string, input: CreateInstanceInput): Promise<InstanceRecord> {
		const owner = await this.getTenant(tenant);
		const id = instanceId(input.id);
		const record: InstanceRecord = {
			id,
			tenantId: owner.id,
			name: input.name,
			model: input.model,
			egress: input.egress ?? DENY_ALL,
			allowedUsers: input.allowedUsers ?? {},
			...(input.approvers === undefined ? {} : { approvers: input.approvers }),
			...(input.instructions === undefined ? {} : { instructions: input.instructions }),
			createdAt: new Date().toISOString(),
		};
		await writeJsonExclusive(instanceFile(this.dataDir, owner.id, id), record);
		await new AuditLog(this.dataDir, owner.id).append({
			type: "instance.created",
			instanceId: id,
			modelProvider: input.model.provider,
			allowedModelProviders: record.egress.modelProviders.join(","),
			allowedChannels: record.egress.channels.join(","),
		});
		return record;
	}

	async getInstance(tenant: string, id: string): Promise<InstanceRecord> {
		const t = tenantId(tenant);
		const i = instanceId(id);
		const record = await readJson<InstanceRecord>(instanceFile(this.dataDir, t, i));
		if (record === undefined) throw new NotFound(`Instance "${i}" not found in tenant "${t}"`);
		return record;
	}

	/** Replace the users allowed on one channel. Takes effect the next time the instance is opened. */
	async setAllowedUsers(tenant: string, id: string, channel: string, userIds: readonly string[]): Promise<InstanceRecord> {
		if (!CHANNEL_PATTERN.test(channel)) throw new Error(`Invalid channel name "${channel}"`);
		const current = await this.getInstance(tenant, id);
		const record: InstanceRecord = { ...current, allowedUsers: { ...current.allowedUsers, [channel]: [...new Set(userIds)] } };
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({
			type: "instance.allowlist.updated",
			instanceId: record.id,
			channel,
			users: record.allowedUsers[channel]?.length ?? 0,
		});
		return record;
	}

	/** Change name, instructions or approvers. Takes effect the next time the instance is opened. */
	async updateInstance(tenant: string, id: string, change: { name?: string; instructions?: string | null; approvers?: AllowedUsers }): Promise<InstanceRecord> {
		const current = await this.getInstance(tenant, id);
		const { instructions: _old, ...rest } = current;
		const instructions = change.instructions === undefined ? current.instructions : change.instructions ?? undefined;
		const record: InstanceRecord = {
			...rest,
			...(change.name === undefined ? {} : { name: change.name }),
			...(change.approvers === undefined ? {} : { approvers: change.approvers }),
			...(instructions === undefined ? {} : { instructions }),
		};
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({ type: "instance.updated", instanceId: record.id, fields: Object.keys(change).join(",") });
		return record;
	}

	/**
	 * Run the instance on another model, and allow its provider: added to the providers the
	 * owner already allowed, never in their place. Takes effect the next time the instance is opened.
	 */
	async setModel(tenant: string, id: string, model: ModelSelection): Promise<InstanceRecord> {
		const current = await this.getInstance(tenant, id);
		const modelProviders = current.egress.modelProviders.includes(model.provider) ? current.egress.modelProviders : [...current.egress.modelProviders, model.provider];
		const record: InstanceRecord = { ...current, model: { provider: model.provider, modelId: model.modelId }, egress: { ...current.egress, modelProviders } };
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({ type: "instance.model.updated", instanceId: record.id, modelProvider: model.provider, modelId: model.modelId });
		return record;
	}

	/** Replace the egress policy. Takes effect the next time the instance is opened. */
	async setEgress(tenant: string, id: string, egress: EgressPolicy): Promise<InstanceRecord> {
		const current = await this.getInstance(tenant, id);
		const record: InstanceRecord = { ...current, egress };
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({
			type: "instance.egress.updated",
			instanceId: record.id,
			modelProviders: egress.modelProviders.join(","),
			channels: egress.channels.join(","),
			connectors: (egress.connectors ?? []).join(","),
		});
		return record;
	}

	async listInstances(tenant: string): Promise<InstanceRecord[]> {
		const t = tenantId(tenant);
		const ids = await listDirs(join(tenantDir(this.dataDir, t), "instances"));
		return Promise.all(ids.map((id) => this.getInstance(t, id)));
	}
}

async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	try {
		await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Already exists: ${file}`);
		throw error;
	}
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function listDirs(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
