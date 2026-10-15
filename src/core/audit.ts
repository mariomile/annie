import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TenantId } from "./ids.ts";
import { auditFile } from "./paths.ts";

/**
 * Audit events carry metadata only: who, where, what kind, sizes. Never message text,
 * model output, or secret values.
 */
export type AuditEvent = {
	readonly type: string;
	readonly instanceId?: string;
	readonly [field: string]: string | number | boolean | undefined;
};

export type AuditRecord = AuditEvent & { readonly ts: string; readonly tenantId: string };

/** Append-only JSONL audit log of one tenant. Bound to that tenant at construction. */
export class AuditLog {
	private readonly file: string;

	constructor(
		dataDir: string,
		readonly tenantId: TenantId,
	) {
		this.file = auditFile(dataDir, tenantId);
	}

	async append(event: AuditEvent): Promise<void> {
		const record: AuditRecord = { ts: new Date().toISOString(), tenantId: this.tenantId, ...event };
		await mkdir(dirname(this.file), { recursive: true });
		// "a" opens with O_APPEND: writes only ever go to the end of the file.
		await appendFile(this.file, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
	}

	async read(): Promise<AuditRecord[]> {
		let text: string;
		try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return text
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as AuditRecord);
	}
}
