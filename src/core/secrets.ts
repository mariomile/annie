import { chmodSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TenantId } from "./ids.ts";
import { updateJsonFile } from "./locked-json.ts";
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
		return (await this.readAll())[name];
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
		return Object.keys(await this.readAll());
	}

	private async readAll(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await readFile(this.file, "utf8")) as Record<string, string>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}
}

/** Name under which a tenant stores the API key of a model provider. */
export function modelApiKeySecret(provider: string): string {
	return `model.${provider}.apiKey`;
}
