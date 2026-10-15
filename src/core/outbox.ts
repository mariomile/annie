import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

/**
 * A reply waiting to be delivered, or already delivered. `key` is the idempotency key:
 * one entry per engine submission, so the same answer is never queued twice.
 */
export type OutboxEntry = {
	readonly key: string;
	readonly channel: string;
	readonly threadId: string;
	readonly reply: { readonly status: "answered"; readonly text: string } | { readonly status: "unanswered"; readonly reason: string };
	readonly createdAt: string;
	/** Times the entry was handed to a channel. Above 1, the user may have received it before. */
	readonly attempts: number;
	readonly deliveredAt?: string;
};

/**
 * Durable outbox of one instance: one JSON file per entry under `<instanceDir>/outbox/`,
 * each written atomically and fsynced. Holds reply text, so it lives with the instance's
 * storage (same tenant directory, files mode 0600), never in the audit log.
 * Only the process holding the instance lock writes to it.
 */
export class Outbox {
	constructor(private readonly dir: string) {}

	async get(key: string): Promise<OutboxEntry | undefined> {
		try {
			return JSON.parse(await readFile(this.file(key), "utf8")) as OutboxEntry;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	put(entry: OutboxEntry): Promise<void> {
		return writeFileAtomic(this.file(entry.key), `${JSON.stringify(entry)}\n`);
	}

	/** Entries not yet delivered, oldest first. */
	async undelivered(): Promise<OutboxEntry[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const entries = await Promise.all(
			names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).map(async (name) => JSON.parse(await readFile(join(this.dir, name), "utf8")) as OutboxEntry),
		);
		return entries.filter((entry) => entry.deliveredAt === undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	private file(key: string): string {
		return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
	}
}
