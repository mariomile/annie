import { randomBytes } from "node:crypto";
import { access, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic-file.ts";

/** A message for the sales people, with the pratica it belongs to. */
export type Notification = {
	readonly text: string;
	readonly buttons: readonly string[];
	readonly praticaId: string;
	readonly draftVersion: number;
};

export type NotificationEntry = Notification & {
	readonly id: string;
	readonly createdAt: string;
	/** Chats still to reach. */
	readonly pending: readonly string[];
	/** Sends started per chat. */
	readonly attempts: Readonly<Record<string, number>>;
	/** Sends per chat that Telegram explicitly refused: those never reached the chat. */
	readonly refused?: Readonly<Record<string, number>>;
};

/** Could the chat already have this message? Only if a send started and did not end in a refusal. */
export function maybeDelivered(entry: NotificationEntry, chat: string): boolean {
	return (entry.attempts[chat] ?? 0) - (entry.refused?.[chat] ?? 0) > 0;
}

/**
 * Durable outbox of the segreteria's Telegram messages: each one is on disk before it
 * leaves and removed once every chat has it, so a crash never loses a card. Like the
 * core's outbox it is at-least-once: a card resent after a crash may arrive twice.
 */
export class NotificationOutbox {
	constructor(private readonly dir: string) {}

	async add(notification: Notification, chats: readonly string[]): Promise<NotificationEntry> {
		// Time-ordered IDs, so resume() resends in the original order.
		const id = `${Date.now().toString(36).padStart(10, "0")}-${randomBytes(4).toString("hex")}`;
		const entry: NotificationEntry = { ...notification, id, createdAt: new Date().toISOString(), pending: [...chats], attempts: {} };
		await this.write(entry);
		// A card (a message with buttons) leaves a mark that outlives the entry: see hasCard.
		if (notification.buttons.length > 0) await writeFileAtomic(this.cardMark(notification.praticaId, notification.draftVersion), `${id}\n`);
		return entry;
	}

	/** Has a card for this pratica and draft version ever been put in the outbox? */
	async hasCard(praticaId: string, draftVersion: number): Promise<boolean> {
		return access(this.cardMark(praticaId, draftVersion)).then(
			() => true,
			() => false,
		);
	}

	/** Record a send to `chat` as started; returns the attempt number. */
	async attempt(entry: NotificationEntry, chat: string): Promise<{ entry: NotificationEntry; attempt: number }> {
		const attempt = (entry.attempts[chat] ?? 0) + 1;
		const next = { ...entry, attempts: { ...entry.attempts, [chat]: attempt } };
		await this.write(next);
		return { entry: next, attempt };
	}

	/** Telegram answered with an error: the message did not reach the chat. */
	async refused(entry: NotificationEntry, chat: string): Promise<NotificationEntry> {
		const next = { ...entry, refused: { ...entry.refused, [chat]: (entry.refused?.[chat] ?? 0) + 1 } };
		await this.write(next);
		return next;
	}

	async delivered(entry: NotificationEntry, chat: string): Promise<NotificationEntry> {
		const next = { ...entry, pending: entry.pending.filter((c) => c !== chat) };
		if (next.pending.length === 0) await unlink(this.file(entry.id)).catch(() => {});
		else await this.write(next);
		return next;
	}

	async list(): Promise<NotificationEntry[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const files = names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
		return Promise.all(files.map(async (n) => JSON.parse(await readFile(join(this.dir, n), "utf8")) as NotificationEntry));
	}

	private write(entry: NotificationEntry): Promise<void> {
		return writeFileAtomic(this.file(entry.id), `${JSON.stringify(entry)}\n`);
	}

	private cardMark(praticaId: string, draftVersion: number): string {
		return join(this.dir, "cards", `${praticaId.replace(/[^\w-]/g, "_")}.${draftVersion}`);
	}

	private file(id: string): string {
		return join(this.dir, `${id}.json`);
	}
}
