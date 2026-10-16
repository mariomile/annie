import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";

/**
 * The memoria of an instance: facts and preferences it keeps across conversations, about one
 * person (`about` = "<channel>:<userId>") or shared by everyone who talks to it (`about` = "*").
 * The person it is about can see and delete it.
 */
export type Memory = {
	readonly id: string;
	readonly about: string;
	readonly text: string;
	readonly source: "annie" | "person";
	readonly createdAt: string;
};

export const SHARED = "*";
const MAX_TEXT = 500;
const MAX_PER_SUBJECT = 200;

export function subjectOf(channel: string, userId: string): string {
	return `${channel}:${userId}`;
}

export class MemoryStore {
	private readonly file: string;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "memory.json");
	}

	list(): Memory[] {
		return readJsonFile<Memory[]>(this.file, []);
	}

	/** What applies to this person: their own memories, then the shared ones. */
	forSubject(subject: string): Memory[] {
		const all = this.list();
		return [...all.filter((m) => m.about === subject), ...all.filter((m) => m.about === SHARED && subject !== SHARED)];
	}

	add(input: { about: string; text: string; source: Memory["source"] }): Memory {
		const text = input.text.trim().replace(/\s+/g, " ");
		if (text === "") throw new MemoryError("La memoria è vuota");
		if (text.length > MAX_TEXT) throw new MemoryError(`Al massimo ${MAX_TEXT} caratteri per memoria`);
		const memory: Memory = { id: randomBytes(5).toString("hex"), about: input.about, text, source: input.source, createdAt: new Date().toISOString() };
		updateJsonFile<Memory[]>(this.file, [], (all) => {
			if (all.filter((m) => m.about === input.about).length >= MAX_PER_SUBJECT) throw new MemoryError(`Al massimo ${MAX_PER_SUBJECT} memorie per persona: cancellane qualcuna`);
			return [...all, memory];
		});
		return memory;
	}

	/** Delete if `may` allows it; returns the deleted memory, or undefined. */
	remove(id: string, may: (memory: Memory) => boolean): Memory | undefined {
		let removed: Memory | undefined;
		updateJsonFile<Memory[]>(this.file, [], (all) => {
			const found = all.find((m) => m.id === id);
			if (found === undefined || !may(found)) return all;
			removed = found;
			return all.filter((m) => m !== found);
		});
		return removed;
	}
}

export class MemoryError extends Error {
	override readonly name = "MemoryError";
}

/** Who wrote last in each thread of an instance, so a tool knows whom a conversation is with. */
export class Participants {
	private readonly file: string;
	private cache: Record<string, string> | undefined;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "participants.json");
	}

	get(threadKey: string): string | undefined {
		this.cache ??= readJsonFile<Record<string, string>>(this.file, {});
		return this.cache[threadKey];
	}

	set(threadKey: string, subject: string): void {
		if (this.get(threadKey) === subject) return;
		this.cache = updateJsonFile<Record<string, string>>(this.file, {}, (all) => ({ ...all, [threadKey]: subject }));
	}
}

/** The block added after a person's message: what the instance remembers that applies to them. */
export function memoryNote(memories: readonly Memory[]): string {
	if (memories.length === 0) return "";
	const lines = memories.slice(0, 50).map((m) => `- ${m.text} (${m.about === SHARED ? "condivisa, " : ""}id ${m.id})`);
	return `\n\n[Memoria] Cose che ricordi di chi ti scrive; usale solo se servono, aggiornale con memory_remember e memory_forget:\n${lines.join("\n")}`;
}
