import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

/**
 * The life of an action that waits for a person and is done at most once: forms to send (ADR
 * 0011), writes to a Google account (ADR 0021). One JSON file per action. The status is
 * "running" on disk before the work starts, so a crash in between leaves it "uncertain", never
 * done twice; a pending action expires; settled ones are deleted after a while, since they can
 * hold what a person wrote.
 */
export type QueuedStatus = "pending" | "rejected" | "expired" | "running" | "done" | "failed" | "uncertain";

export type Queued = { readonly id: string; readonly status: QueuedStatus; readonly proposedAt: string; readonly decidedAt?: string };

/** Why the work did not happen (failed), or that it is not known (uncertain). */
export type QueuedError = { readonly error: string; readonly uncertain?: true };

export type QueueLimits = { readonly maxPending: number; readonly ttlMs: number; readonly keepMs: number };

const DECIDING = new Map<string, Promise<unknown>>();

export class ActionQueue<T extends Queued> {
	constructor(
		readonly dir: string,
		private readonly limits: QueueLimits,
		/** Errors that mean the work may have happened. */
		private readonly isUncertain: (error: unknown) => boolean,
		/** The refusal for a full queue, in the caller's words. */
		private readonly full: () => Error,
	) {}

	/** The id of a new action; from `key` (the tool call's), so a rerun finds the same one. */
	idFor(key?: string, salt = ""): string {
		return key === undefined ? randomBytes(6).toString("hex") : createHash("sha256").update(`${salt}${key}`).digest("hex").slice(0, 12);
	}

	/** Store a new pending action, unless too many wait already. */
	async add(action: T, now = new Date()): Promise<T> {
		await this.prune(now);
		const pending = (await this.list(now)).filter((a) => a.status === "pending");
		if (pending.length >= this.limits.maxPending) throw this.full();
		await this.save(action);
		return action;
	}

	async get(id: string, now = new Date()): Promise<T | undefined> {
		if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
		let action: T;
		try {
			action = JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return action.status === "pending" && now.getTime() - Date.parse(action.proposedAt) > this.limits.ttlMs ? { ...action, status: "expired" } : action;
	}

	async list(now = new Date()): Promise<T[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const all: (T | undefined)[] = await Promise.all(names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => this.get(n.slice(0, -5), now)));
		return all.filter((a): a is T => a !== undefined).sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
	}

	/**
	 * Decide a pending action; the first decision wins. `check` refuses who may not decide (by
	 * throwing). Approving marks it running with `stamp`, does `run`, stores the result.
	 */
	decide<R extends object>(id: string, decision: "approved" | "rejected", check: (current: T) => void, stamp: Partial<T>, run: (running: T) => Promise<R>, now = new Date()): Promise<{ action: T; changed: boolean; missing?: true }> {
		return this.serial(id, async () => {
			const current = await this.get(id, now);
			if (current === undefined) return { action: undefined as unknown as T, changed: false, missing: true as const };
			check(current);
			if (current.status !== "pending") return { action: current, changed: false };
			const decided = { ...current, ...stamp, decidedAt: now.toISOString() } as T;
			if (decision === "rejected") {
				const action = { ...decided, status: "rejected" } as T;
				await this.save(action);
				return { action, changed: true };
			}
			const running = { ...decided, status: "running" } as T;
			await this.save(running);
			const result: R | QueuedError = await run(running).catch((error: unknown): QueuedError => ({ error: error instanceof Error ? error.message : String(error), ...(this.isUncertain(error) ? { uncertain: true as const } : {}) }));
			const failed = "error" in result && typeof result.error === "string";
			const action = { ...running, status: failed ? ((result as QueuedError).uncertain === true ? "uncertain" : "failed") : "done", result } as T;
			await this.save(action);
			return { action, changed: true };
		});
	}

	/** Change an action (card bookkeeping), one read-modify-write at a time with decisions. */
	update(id: string, change: (current: T) => T): Promise<void> {
		return this.serial(id, async () => {
			const current = await this.get(id);
			if (current !== undefined) await this.save(change(current));
		});
	}

	/** At start: an action left running by a dead process may or may not have happened. */
	async settleInterrupted(mark: (action: T) => T = (a) => ({ ...a, status: "uncertain" })): Promise<T[]> {
		const settled: T[] = [];
		for (const action of await this.list()) {
			if (action.status !== "running") continue;
			const next = mark(action);
			await this.save(next);
			settled.push(next);
		}
		return settled;
	}

	/** Settled actions decided (or proposed) longer ago than `keepMs` are deleted. */
	private async prune(now: Date): Promise<void> {
		for (const action of await this.list(now)) {
			if (action.status === "pending" || action.status === "running") continue;
			const at = Date.parse(action.decidedAt ?? action.proposedAt) + (action.status === "expired" ? this.limits.ttlMs : 0);
			if (now.getTime() - at > this.limits.keepMs) await rm(join(this.dir, `${action.id}.json`), { force: true });
		}
	}

	private serial<R>(id: string, work: () => Promise<R>): Promise<R> {
		const key = `${this.dir}/${id}`;
		const run = (DECIDING.get(key) ?? Promise.resolve()).then(work);
		const tail = run.catch(() => {});
		DECIDING.set(key, tail);
		void tail.then(() => {
			if (DECIDING.get(key) === tail) DECIDING.delete(key);
		});
		return run;
	}

	private save(action: T): Promise<void> {
		// "expired" is computed on read, never stored over a pending action.
		const stored = action.status === "expired" ? { ...action, status: "pending" as const } : action;
		return writeFileAtomic(join(this.dir, `${action.id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
	}
}
