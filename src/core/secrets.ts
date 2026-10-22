import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TenantId } from "./ids.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { secretsFile } from "./paths.ts";

/**
 * Secrets of one tenant. A store is bound to a single tenant at construction and can
 * only reach that tenant's file: there is no API that takes another tenant's ID.
 *
 * Week 1: a JSON file with mode 0600, not encrypted at rest. See docs/architettura.md.
 */
export class TenantSecrets {
	private readonly file: string;

	constructor(
		dataDir: string,
		readonly tenantId: TenantId,
	) {
		this.file = secretsFile(dataDir, tenantId);
	}

	async get(name: string): Promise<string | undefined> {
		return this.readAll()[name];
	}

	/** The names there now, in one synchronous read; never the values. */
	namesNow(): Set<string> {
		return new Set(Object.keys(this.readAll()));
	}

	async set(name: string, value: string): Promise<void> {
		this.update((all) => ({ ...all, [name]: value }));
	}

	async delete(name: string): Promise<void> {
		this.update(({ [name]: _gone, ...rest }) => rest);
	}

	/** Read, change and write under a lock: two writers at once never lose each other's secret. */
	private update(change: (all: Record<string, string>) => Record<string, string>): void {
		mkdirSync(dirname(this.file), { recursive: true });
		updateJsonFile<Record<string, string>>(this.file, {}, change);
		chmodSync(this.file, 0o600);
	}

	/** Secret names only, never values. */
	async names(): Promise<string[]> {
		return Object.keys(this.readAll());
	}

	private readAll(): Record<string, string> {
		return readJsonFile<Record<string, string>>(this.file, {});
	}
}

/** Name under which a tenant stores the API key of a model provider. */
export function modelApiKeySecret(provider: string): string {
	return `model.${provider}.apiKey`;
}

/** The providers whose key the operator gave last time, so a key taken out of the environment leaves too. */
const SERVER_MODEL_KEYS = "model.serverKeys";

/**
 * Store the operator's model keys (provider → key) at start, and delete the ones the operator
 * took away since: those keys are the operator's, and an owner must not keep using them.
 * A key the owner saved for a provider the operator never gave is left alone.
 */
export async function syncServerModelKeys(secrets: TenantSecrets, keys: Readonly<Record<string, string>>): Promise<void> {
	const before = (await secrets.get(SERVER_MODEL_KEYS))?.split(",").filter(Boolean) ?? [];
	for (const provider of before) if (!Object.hasOwn(keys, provider)) await secrets.delete(modelApiKeySecret(provider));
	for (const [provider, key] of Object.entries(keys)) await secrets.set(modelApiKeySecret(provider), key);
	await secrets.set(SERVER_MODEL_KEYS, Object.keys(keys).join(","));
}
