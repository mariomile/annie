import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelAdapter, InboundMessage, OutboundFile, OutboundMessage } from "../channels/types.ts";
import { writeFileAtomic } from "../core/atomic-file.ts";

export type WebThread = { readonly id: string; readonly personId: string; readonly title: string; readonly createdAt: string; readonly updatedAt: string };

export type WebEntry = {
	readonly id: string;
	readonly at: string;
	readonly from: "person" | "annie";
	readonly text?: string;
	/** A workspace file the instance sent. */
	readonly file?: { readonly path: string; readonly caption?: string };
};

export type WebEvent = { readonly instanceId: string; readonly threadId: string; readonly entry: WebEntry };

const THREAD_ID = /^p_[0-9a-f]{12}\.[0-9a-f]{12}$/;

/**
 * The web channel of one instance. A thread belongs to one person (its ID starts with the
 * person's ID); its transcript lives with the instance. Replies carry an idempotency key, so
 * a reply resent after a crash is shown once.
 */
export class WebChannel implements ChannelAdapter {
	readonly name = "web";
	readonly surfacesRefusals = true;
	readonly events = new EventEmitter();
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private readonly dir: string;

	constructor(
		private readonly instance: { readonly tenantId: string; readonly instanceId: string },
		instanceDir: string,
	) {
		this.dir = join(instanceDir, "web");
		this.events.setMaxListeners(1000);
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	static ownerOf(threadId: string): string | undefined {
		return THREAD_ID.test(threadId) ? threadId.split(".")[0] : undefined;
	}

	async createThread(personId: string, title = "Nuova chat"): Promise<WebThread> {
		const now = new Date().toISOString();
		const thread: WebThread = { id: `${personId}.${randomBytes(6).toString("hex")}`, personId, title: title.slice(0, 80), createdAt: now, updatedAt: now };
		await this.saveThread(thread);
		return thread;
	}

	async threads(personId: string): Promise<WebThread[]> {
		let names: string[];
		try {
			names = await readdir(join(this.dir, "threads"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const out: WebThread[] = [];
		for (const name of names) {
			if (!name.endsWith(".json") || !name.startsWith(`${personId}.`)) continue;
			out.push(JSON.parse(await readFile(join(this.dir, "threads", name), "utf8")) as WebThread);
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async thread(threadId: string): Promise<WebThread | undefined> {
		if (!THREAD_ID.test(threadId)) return undefined;
		try {
			return JSON.parse(await readFile(join(this.dir, "threads", `${threadId}.json`), "utf8")) as WebThread;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async transcript(threadId: string): Promise<WebEntry[]> {
		if (!THREAD_ID.test(threadId)) return [];
		try {
			const text = await readFile(join(this.dir, "messages", `${threadId}.jsonl`), "utf8");
			return text
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l) as WebEntry);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	/** A person writes in their thread. Rejects if the core does not admit it. */
	async post(threadId: string, personId: string, text: string, attachments?: InboundMessage["attachments"]): Promise<WebEntry> {
		const thread = await this.thread(threadId);
		if (thread === undefined || thread.personId !== personId) throw new Error("No such thread");
		if (this.handler === undefined) throw new Error("Web channel not connected");
		const entry: WebEntry = { id: `m_${randomBytes(8).toString("hex")}`, at: new Date().toISOString(), from: "person", text };
		await this.handler({
			tenantId: this.instance.tenantId,
			instanceId: this.instance.instanceId,
			channel: this.name,
			threadId,
			userId: personId,
			text,
			// A console thread belongs to one person.
			privateThread: true,
			messageId: entry.id,
			...(attachments === undefined ? {} : { attachments }),
		});
		await this.append(threadId, entry);
		const title = thread.title === "Nuova chat" && text.trim() !== "" ? text.trim().replace(/\s+/g, " ").slice(0, 60) : thread.title;
		await this.saveThread({ ...thread, title, updatedAt: entry.at });
		return entry;
	}

	async send(message: OutboundMessage): Promise<void> {
		await this.deliver(message.threadId, message.idempotencyKey, { text: message.text });
	}

	async sendFile(file: OutboundFile): Promise<void> {
		// The bytes stay in the workspace; the transcript links to them.
		await this.deliver(file.threadId, file.idempotencyKey, { file: { path: file.path ?? file.name, ...(file.caption === undefined ? {} : { caption: file.caption }) } });
	}

	private async deliver(threadId: string, key: string, body: { text?: string; file?: WebEntry["file"] }): Promise<void> {
		if (!THREAD_ID.test(threadId)) throw new Error(`Not a web thread: ${threadId}`);
		const id = `r_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
		if ((await this.transcript(threadId)).some((e) => e.id === id)) return; // resent after a crash
		const entry: WebEntry = { id, at: new Date().toISOString(), from: "annie", ...body };
		await this.append(threadId, entry);
		const thread = await this.thread(threadId);
		if (thread !== undefined) await this.saveThread({ ...thread, updatedAt: entry.at });
		this.events.emit(WebChannel.ownerOf(threadId) ?? "", { instanceId: this.instance.instanceId, threadId, entry } satisfies WebEvent);
	}

	private async append(threadId: string, entry: WebEntry): Promise<void> {
		await mkdir(join(this.dir, "messages"), { recursive: true });
		await appendFile(join(this.dir, "messages", `${threadId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	}

	private saveThread(thread: WebThread): Promise<void> {
		return writeFileAtomic(join(this.dir, "threads", `${thread.id}.json`), `${JSON.stringify(thread)}\n`);
	}
}
