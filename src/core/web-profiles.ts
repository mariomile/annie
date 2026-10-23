import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { instanceId, tenantId } from "./ids.ts";
import { instanceDir } from "./paths.ts";
import { CookieJar } from "./web-fetch.ts";

let counter = 0;

/**
 * Saved sign-ins of one person in one instance: the cookies of their browser, kept between
 * browsers and restarts in `<instance>/browser/<sha256(person)>.json` (0600, folder 0700), so they
 * go with the instance's folder (ADR 0046). Storage only: the browser sessions keep the live jar
 * and run one save or clear at a time per person. Never typed values, never page storage.
 */
export class BrowserProfiles {
	constructor(private readonly dataDir: string) {}

	/** Nothing saved, or a file that is not cookies: an empty jar, no sign-ins rather than wrong ones. */
	async load(scope: string, person: string): Promise<CookieJar> {
		let text: string;
		try {
			text = await readFile(this.file(scope, person), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new CookieJar();
			throw error;
		}
		try {
			return new CookieJar(JSON.parse(text));
		} catch {
			return new CookieJar();
		}
	}

	/**
	 * Replace the saved cookies with the jar's live ones, atomically and durably (as
	 * `writeFileAtomic`). An instance deleted meanwhile stays deleted: its folder is never made
	 * again, the save is dropped.
	 */
	async save(scope: string, person: string, jar: CookieJar): Promise<void> {
		const dir = this.dir(scope);
		const file = this.file(scope, person);
		try {
			// Not recursive: only inside an instance folder that still exists.
			await mkdir(dir, { mode: 0o700 });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (code !== "EEXIST") throw error;
		}
		const tmp = join(dir, `.${this.name(person)}.${process.pid}.${counter++}.tmp`);
		try {
			const handle = await open(tmp, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(jar.snapshot())}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(tmp, file);
		} catch (error) {
			// The folder went with the instance (moved aside whole): nothing left to write into.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			await rm(tmp, { force: true });
			throw error;
		}
		await syncDir(dir);
	}

	/** Forget the saved sign-ins, a half-written save included; the removal survives a crash. */
	async clear(scope: string, person: string): Promise<void> {
		const dir = this.dir(scope);
		const name = this.name(person);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const ours = entries.filter((entry) => entry === name || (entry.startsWith(`.${name}.`) && entry.endsWith(".tmp")));
		for (const entry of ours) await rm(join(dir, entry), { force: true });
		if (ours.length > 0) await syncDir(dir);
	}

	private dir(scope: string): string {
		const [tenant = "", instance = "", ...rest] = scope.split("/");
		if (rest.length > 0) throw new Error(`Invalid browser scope "${scope}"`);
		return join(instanceDir(this.dataDir, tenantId(tenant), instanceId(instance)), "browser");
	}

	private file(scope: string, person: string): string {
		return join(this.dir(scope), this.name(person));
	}

	/** The person's file name: their ID never appears on disk. */
	private name(person: string): string {
		if (person === "") throw new Error("Invalid browser profile person");
		return `${createHash("sha256").update(person).digest("hex")}.json`;
	}
}

async function syncDir(dir: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(dir, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
