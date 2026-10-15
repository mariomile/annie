import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic-file.ts";

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
};

export type PublicPerson = Omit<Person, "tokenHash">;

export function publicPerson(p: Person): PublicPerson {
	const { tokenHash: _hash, ...rest } = p;
	return rest;
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
		await this.write([...(await this.list()), person]);
		return { person, token };
	}

	/** A new login token; the old one stops working. Existing sessions are ended by the caller. */
	async rotate(id: string): Promise<string> {
		const all = await this.list();
		const person = all.find((p) => p.id === id);
		if (person === undefined) throw new Error(`No person ${id}`);
		const token = randomBytes(32).toString("base64url");
		await this.write(all.map((p) => (p.id === id ? { ...p, tokenHash: hash(token) } : p)));
		return token;
	}

	async remove(id: string): Promise<boolean> {
		const all = await this.list();
		const kept = all.filter((p) => p.id !== id);
		if (kept.length === all.length) return false;
		await this.write(kept);
		return true;
	}

	async byToken(token: string): Promise<Person | undefined> {
		if (typeof token !== "string" || token.length < 20 || token.length > 200) return undefined;
		const h = hash(token);
		return (await this.list()).find((p) => sameHash(p.tokenHash, h));
	}

	private write(people: Person[]): Promise<void> {
		return writeFileAtomic(this.file, `${JSON.stringify(people, null, 2)}\n`);
	}
}

type Session = { readonly idHash: string; readonly personId: string; readonly expiresAt: number };

/** Web sessions, persisted so a restart does not log everyone out. */
export class SessionStore {
	private readonly file: string;
	private sessions: Session[] | undefined;

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

	private async load(): Promise<Session[]> {
		if (this.sessions === undefined) {
			try {
				this.sessions = JSON.parse(await readFile(this.file, "utf8")) as Session[];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				this.sessions = [];
			}
		}
		return this.sessions;
	}

	private async save(sessions: Session[]): Promise<void> {
		this.sessions = sessions;
		await writeFileAtomic(this.file, `${JSON.stringify(sessions)}\n`);
	}
}
