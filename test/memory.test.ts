import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/core/memory.ts";
import { createMemoryTools } from "../src/core/tools/memory-tools.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const from = (userId: string, threadId: string, text: string, messageId: string) => ({ tenantId: "acme", instanceId: "ops", channel: "test", threadId, userId, text, messageId });

async function withMemory() {
	const { runtime, replies } = await runtimeWithInstance({
		allowedUsers: { test: ["anna", "luca"] },
		toolsFor: (rt) => createMemoryTools({ store: rt.memory("acme", "ops"), whoIs: (thread) => rt.participant("acme", "ops", thread) }),
	});
	const lastReply = (threadId: string) => replies.filter((r) => r.threadId === threadId).at(-1) as { text?: string } | undefined;
	return { runtime, replies, lastReply };
}

describe("memoria della persona", () => {
	it("what Annie remembers about a person reaches her with that person's next messages, in any thread", async () => {
		const { runtime, replies, lastReply } = await withMemory();
		await runtime.submit(from("anna", "t1", '/tool memory_remember {"text":"Preferisce risposte brevi"}', "1"));
		await waitFor(() => replies.length === 1);
		expect(lastReply("t1")?.text).toMatch(/^Fatto\. Ricordato/);
		await runtime.submit(from("anna", "t2", "ciao di nuovo", "2"));
		await waitFor(() => replies.length === 2);
		const echoed = lastReply("t2")?.text ?? "";
		expect(echoed).toContain("ciao di nuovo");
		expect(echoed).toContain("Preferisce risposte brevi");
		await runtime.close();
	});

	it("one person's memory is not shown to another; a shared one is shown to everyone", async () => {
		const { runtime, replies, lastReply } = await withMemory();
		await runtime.submit(from("anna", "ta", '/tool memory_remember {"text":"Allergica alle noci"}', "1"));
		await runtime.submit(from("anna", "ta2", '/tool memory_remember {"text":"L\'ufficio chiude ad agosto","shared":true}', "2"));
		await waitFor(() => replies.length === 2);
		await runtime.submit(from("luca", "tl", "buongiorno", "3"));
		await waitFor(() => replies.length === 3);
		const forLuca = lastReply("tl")?.text ?? "";
		expect(forLuca).toContain("L'ufficio chiude ad agosto");
		expect(forLuca).not.toContain("Allergica");
		await runtime.close();
	});

	it("a memory is forgotten on request, and only by the person it is about", async () => {
		const { runtime, replies, lastReply } = await withMemory();
		await runtime.submit(from("anna", "t1", '/tool memory_remember {"text":"Usa il lei con i clienti"}', "1"));
		await waitFor(() => replies.length === 1);
		const [memory] = runtime.memory("acme", "ops").list();
		await runtime.submit(from("luca", "t9", `/tool memory_forget {"id":"${memory?.id}"}`, "2"));
		await waitFor(() => replies.length === 2);
		expect(lastReply("t9")?.text).toContain("Non trovo");
		await runtime.submit(from("anna", "t1", `/tool memory_forget {"id":"${memory?.id}"}`, "3"));
		await waitFor(() => replies.length === 3);
		expect(runtime.memory("acme", "ops").list()).toEqual([]);
		await runtime.close();
	});
});

describe("MemoryStore", () => {
	it("keeps memories across restarts and refuses empty, too long or too many", () => {
		const dir = tempDataDir();
		const store = new MemoryStore(dir);
		const m = store.add({ about: "test:anna", text: "  Lavora da Roma  ", source: "annie" });
		expect(m.text).toBe("Lavora da Roma");
		expect(new MemoryStore(dir).list()).toEqual([m]);
		expect(() => store.add({ about: "test:anna", text: " ", source: "annie" })).toThrow();
		expect(() => store.add({ about: "test:anna", text: "x".repeat(501), source: "annie" })).toThrow();
		for (let i = 1; i < 200; i++) store.add({ about: "test:anna", text: `fatto ${i}`, source: "annie" });
		expect(() => store.add({ about: "test:anna", text: "uno di troppo", source: "annie" })).toThrow(/200/);
		expect(store.forSubject("test:luca")).toEqual([]);
	});
});
