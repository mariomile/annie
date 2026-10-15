import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { InstanceLocked } from "./errors.ts";

type Owner = { pid: number; host: string; since: string };

/**
 * Exclusive lock on one instance's storage, held for as long as the instance is open.
 *
 * The lock is an exclusive SQLite transaction on `<instanceDir>/instance.lock`, that is a
 * POSIX advisory lock owned by the kernel: it is released when the process closes it or
 * dies in any way (SIGKILL, OOM, crash), so a dead owner never leaves a stale lock and
 * there is no PID check that a reused PID could fool. `instance.lock.owner` records who
 * holds it, for the error message only. Local filesystems only: advisory locks over NFS
 * and similar are not reliable.
 */
export class InstanceLock {
	private constructor(private readonly db: DatabaseSync) {}

	static acquire(file: string, label: string): InstanceLock {
		// timeout 0: fail at once instead of waiting for the owner.
		const db = new DatabaseSync(file, { timeout: 0 });
		try {
			db.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			db.close();
			if ((error as { errcode?: number }).errcode === 5 /* SQLITE_BUSY */) throw new InstanceLocked(label, readOwner(file));
			throw error;
		}
		const owner: Owner = { pid: process.pid, host: hostname(), since: new Date().toISOString() };
		try {
			writeFileSync(ownerFile(file), `${JSON.stringify(owner)}\n`);
		} catch (error) {
			db.close();
			throw error;
		}
		return new InstanceLock(db);
	}

	release(): void {
		if (!this.db.isOpen) return;
		this.db.close(); // closing rolls back the transaction and drops the lock
	}
}

function ownerFile(file: string): string {
	return `${file}.owner`;
}

function readOwner(file: string): string | undefined {
	try {
		const owner = JSON.parse(readFileSync(ownerFile(file), "utf8")) as Owner;
		return `pid ${owner.pid} on ${owner.host}, since ${owner.since}`;
	} catch {
		return undefined;
	}
}
