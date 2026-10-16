import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic-file.ts";
import { generateTotpSecret, verifyTotp } from "./totp.ts";

/**
 * A person who uses the web interface. The owner manages Annie; a member uses the
 * instances whose web allowlist names them. Only token hashes are stored.
 */
export type Person = {
	readonly id: string;
	readonly name: string;
	readonly role: "owner" | "member";
	readonly tokenHash: string;
	readonly createdAt: string;
	/** Two-factor login (TOTP): on once `secret` is set; `lastStep` stops a code being reused. */
	readonly totp?: { readonly secret: string; readonly lastStep: number };
	/** A secret shown to the person and not yet confirmed with a code. */
	readonly totpPending?: string;
};

export type PublicPerson = Omit<Person, "tokenHash" | "totp" | "totpPending"> & { readonly twoFactor: boolean };

export function publicPerson(p: Person): PublicPerson {
	const { tokenHash: _hash, totp, totpPending: _pending, ...rest } = p;
	return { ...rest, twoFactor: totp !== undefined };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function sameHash(a: string, b: string): boolean {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && timingSafeEqual(x, y);
}

/** The people of a tenant, in one file. */
export class PeopleStore {
	private readonly file: string;
	constructor(tenantDir: string) {
		this.file = join(tenantDir, "people.json");
	}

	async list(): Promise<Person[]> {
		try {
			return JSON.parse(await readFile(this.file, "utf8")) as Person[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async get(id: string): Promise<Person | undefined> {
		return (await this.list()).find((p) => p.id === id);
	}

	/** Create a person; returns their login token, shown once. */
	async add(name: string, role: Person["role"]): Promise<{ person: Person; token: string }> {
		if (name.trim() === "" || name.length > 80) throw new Error("Name: 1 to 80 characters");
		const token = randomBytes(32).toString("base64url");
		const person: Person = { id: `p_${randomBytes(6).toString("hex")}`, name: name.trim(), role, tokenHash: hash(token), createdAt: new Date().toISOString() };
		await this.mutate((all) => [...all, person]);
		return { person, token };
	}

	/** A new login token; the old one stops working. Existing sessions are ended by the caller. */
	async rotate(id: string): Promise<string> {
		const token = randomBytes(32).toString("base64url");
		await this.update(id, (p) => ({ ...p, tokenHash: hash(token) }));
		return token;
	}

	async remove(id: string): Promise<boolean> {
		let removed = false;
		await this.mutate((all) => {
			const kept = all.filter((p) => p.id !== id);
			removed = kept.length !== all.length;
			return kept;
		});
		return removed;
	}

	/** Start turning on 2FA: a new secret, active only once confirmed with `enableTotp`. */
	async startTotp(id: string): Promise<string> {
		const secret = generateTotpSecret();
		await this.update(id, (p) => ({ ...p, totpPending: secret }));
		return secret;
	}

	/** Turn on 2FA if `code` matches the pending secret. */
	async enableTotp(id: string, code: string, now = Date.now()): Promise<boolean> {
		let ok = false;
		await this.update(id, (p) => {
			if (p.totpPending === undefined) return p;
			const step = verifyTotp(p.totpPending, code, now);
			if (step === undefined) return p;
			ok = true;
			const { totpPending: _pending, ...rest } = p;
			return { ...rest, totp: { secret: p.totpPending, lastStep: step } };
		});
		return ok;
	}

	/** Check a code for a person with 2FA on, and use it up. */
	async useTotp(id: string, code: string, now = Date.now()): Promise<boolean> {
		let ok = false;
		await this.update(id, (p) => {
			if (p.totp === undefined) return p;
			const step = verifyTotp(p.totp.secret, code, now, p.totp.lastStep);
			if (step === undefined) return p;
			ok = true;
			return { ...p, totp: { ...p.totp, lastStep: step } };
		});
		return ok;
	}

	/** Turn 2FA off (after a code from the person, or a reset by the owner). */
	async clearTotp(id: string): Promise<void> {
		await this.update(id, (p) => {
			const { totp: _totp, totpPending: _pending, ...rest } = p;
			return rest;
		});
	}

	async byToken(token: string): Promise<Person | undefined> {
		if (typeof token !== "string" || token.length < 20 || token.length > 200) return undefined;
		const h = hash(token);
		return (await this.list()).find((p) => sameHash(p.tokenHash, h));
	}

	/** Read, change, write: one change at a time in this process. */
	private mutate(change: (all: Person[]) => Person[]): Promise<void> {
		const next = this.queue.then(async () => this.write(change(await this.list())));
		this.queue = next.catch(() => {});
		return next;
	}

	private update(id: string, change: (p: Person) => Person): Promise<void> {
		return this.mutate((all) => {
			if (!all.some((p) => p.id === id)) throw new Error(`No person ${id}`);
			return all.map((p) => (p.id === id ? change(p) : p));
		});
	}

	private queue: Promise<void> = Promise.resolve();

	private write(people: Person[]): Promise<void> {
		return writeFileAtomic(this.file, `${JSON.stringify(people, null, 2)}\n`);
	}
}

type Session = { readonly idHash: string; readonly personId: string; readonly expiresAt: number };

/** Web sessions, persisted so a restart does not log everyone out. */
export class SessionStore {
	private readonly file: string;

	constructor(
		tenantDir: string,
		private readonly ttlMs = 30 * 24 * 60 * 60 * 1000,
	) {
		this.file = join(tenantDir, "sessions.json");
	}

	async create(personId: string, now = Date.now()): Promise<string> {
		const id = randomBytes(32).toString("base64url");
		const all = (await this.load()).filter((s) => s.expiresAt > now);
		all.push({ idHash: hash(id), personId, expiresAt: now + this.ttlMs });
		await this.save(all);
		return id;
	}

	async personOf(sessionId: string | undefined, now = Date.now()): Promise<string | undefined> {
		if (sessionId === undefined || sessionId.length < 20 || sessionId.length > 200) return undefined;
		const h = hash(sessionId);
		return (await this.load()).find((s) => s.expiresAt > now && sameHash(s.idHash, h))?.personId;
	}

	async end(sessionId: string): Promise<void> {
		const h = hash(sessionId);
		await this.save((await this.load()).filter((s) => !sameHash(s.idHash, h)));
	}

	async endAllOf(personId: string): Promise<void> {
		await this.save((await this.load()).filter((s) => s.personId !== personId));
	}

	/** Read every time: the CLI revokes sessions from another process. */
	private async load(): Promise<Session[]> {
		try {
			return JSON.parse(await readFile(this.file, "utf8")) as Session[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return [];
		}
	}

	private async save(sessions: Session[]): Promise<void> {
		await writeFileAtomic(this.file, `${JSON.stringify(sessions)}\n`);
	}
}
