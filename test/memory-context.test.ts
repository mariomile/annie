import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { type Memory, MemoryStore } from "../src/core/memory.ts";
import { instanceDir } from "../src/core/paths.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const memory = (id: string, about = "test:anna", archived = false): Memory => ({ id, about, text: `Synthetic memory ${id}`, source: "person", createdAt: "2026-01-01T00:00:00.000Z", ...(archived ? { archived: true } : {}) });
function replace(file: string, memories: Memory[]) {
	writeFileSync(`${file}.external`, JSON.stringify(memories));
	renameSync(`${file}.external`, file);
}

describe("memory context snapshots", () => {
	it("uses one parsed snapshot across repeated model requests", async () => {
		const { runtime, dataDir, replies } = await runtimeWithInstance({ allowedUsers: { test: ["anna"] } });
		const file = join(instanceDir(dataDir, tenantId("acme"), instanceId("ops")), "memory.json");
		replace(file, [memory("essential"), memory("archive", "test:anna", true)]);
		const stored = readFileSync(file, "utf8");
		const parse = vi.spyOn(JSON, "parse");
		try {
			for (let i = 0; i < 2; i++) {
				await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "anna", messageId: String(i), text: "Hello", privateThread: true });
				await waitFor(() => replies.length === i + 1);
				expect(replies[i]).toMatchObject({ text: expect.stringContaining("Synthetic memory essential") });
				expect(replies[i]).toMatchObject({ text: expect.stringContaining("Altre 1 in archivio") });
			}
			expect(parse.mock.calls.filter(([text]) => text === stored)).toHaveLength(1);
		} finally { parse.mockRestore(); await runtime.close(); }
	});
	it("the next request sees an external atomic replacement and store corrections", async () => {
		const { runtime, dataDir, replies } = await runtimeWithInstance({ allowedUsers: { test: ["anna"] } });
		const dir = instanceDir(dataDir, tenantId("acme"), instanceId("ops"));
		const file = join(dir, "memory.json");
		replace(file, [memory("old"), memory("archive", "test:anna", true)]);
		const say = async () => {
			const n = replies.length;
			await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "anna", messageId: String(n), text: "Hello", privateThread: true });
			await waitFor(() => replies.length === n + 1);
			const reply = replies.at(-1);
			return reply?.status === "answered" ? reply.text : undefined;
		};
		try {
			expect(await say()).toContain("Synthetic memory old");
			// An independent process replaces the file, retaining its byte length and mtime.
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { readFileSync, writeFileSync, statSync, utimesSync, renameSync } from 'node:fs'; const file = process.argv[1]; const before = statSync(file); writeFileSync(file + '.external', readFileSync(file, 'utf8').replace('Synthetic memory old', 'Synthetic memory new')); utimesSync(file + '.external', before.atime, before.mtime); renameSync(file + '.external', file);`, file], { encoding: "utf8" });
			expect(child.status, child.stderr).toBe(0);
			const next = await say();
			expect(next).toContain("Synthetic memory new");
			expect(next).not.toContain("Synthetic memory old");
			const writer = new MemoryStore(dir);
			writer.remove("old", () => true);
			writer.remove("archive", () => true);
			writer.add({ about: "test:anna", text: "Corrected fact", source: "person" });
			const corrected = await say();
			expect(corrected).toContain("Corrected fact");
			expect(corrected).not.toContain("Synthetic memory new");
			expect(corrected).not.toContain("in archivio");
		} finally { await runtime.close(); }
	});
	it("keeps subject order, shared scope, and archive counts in the same snapshot", () => {
		const dir = tempDataDir();
		replace(join(dir, "memory.json"), [memory("shared", "*"), memory("own"), memory("private", "test:luca"), memory("own-archive", "test:anna", true), memory("shared-archive", "*", true), memory("private-archive", "test:luca", true)]);
		const store = new MemoryStore(dir);
		expect(store.contextFor("test:anna")).toEqual({ memories: [memory("own"), memory("shared", "*")], archived: 2 });
		expect(store.contextFor("*")).toEqual({ memories: [memory("shared", "*")], archived: 1 });
	});
	it("does not retain caller mutations, deleted files, or failed parses", () => {
		const dir = tempDataDir();
		const file = join(dir, "memory.json");
		const store = new MemoryStore(dir);
		replace(file, [memory("original")]);
		const result = store.contextFor("test:anna");
		Object.assign(result.memories[0]!, { text: "Mutated by caller" });
		result.memories.pop();
		expect(store.contextFor("test:anna").memories).toEqual([memory("original")]);
		writeFileSync(file, "invalid JSON");
		expect(() => store.contextFor("test:anna")).toThrow();
		unlinkSync(file);
		expect(store.contextFor("test:anna")).toEqual({ memories: [], archived: 0 });
		replace(file, [memory("replacement")]);
		expect(store.contextFor("test:anna").memories).toEqual([memory("replacement")]);
	});
	it("detects in-place edits even if size and modification time are restored", () => {
		const dir = tempDataDir();
		const file = join(dir, "memory.json");
		replace(file, [memory("old")]);
		const store = new MemoryStore(dir);
		expect(store.contextFor("test:anna").memories).toEqual([memory("old")]);
		const before = statSync(file);
		writeFileSync(file, JSON.stringify([memory("new")]));
		utimesSync(file, before.atime, before.mtime);
		expect(store.contextFor("test:anna").memories).toEqual([memory("new")]);
	});
	it("writes read current disk state under the existing lock instead of a cached snapshot", () => {
		const dir = tempDataDir();
		const first = new MemoryStore(dir);
		const second = new MemoryStore(dir);
		const a = first.add({ about: "test:anna", text: "First", source: "person" });
		first.contextFor("test:anna");
		const b = second.add({ about: "test:anna", text: "Second", source: "person" });
		first.add({ about: "test:anna", text: "Third", source: "person" });
		second.remove(a.id, () => true);
		expect(first.contextFor("test:anna").memories.map((m) => m.text)).toEqual(["Second", "Third"]);
		expect(first.remove(b.id, () => true)?.text).toBe("Second");
		expect(second.contextFor("test:anna").memories.map((m) => m.text)).toEqual(["Third"]);
	});
	it("does not cache an old read under an atomic replacement's identity", () => {
		const dir = tempDataDir();
		const file = join(dir, "memory.json");
		replace(file, [memory("old")]);
		const store = new MemoryStore(dir);
		vi.spyOn(store, "list").mockImplementationOnce(() => {
			const old = JSON.parse(readFileSync(file, "utf8")) as Memory[];
			replace(file, [memory("new")]);
			return old;
		});
		expect(store.contextFor("test:anna").memories).toEqual([memory("old")]);
		expect(store.contextFor("test:anna").memories).toEqual([memory("new")]);
	});
	it("reads an oversized archive once per request without retaining it", () => {
		const dir = tempDataDir();
		const file = join(dir, "memory.json");
		const records = Array.from({ length: 20_000 }, (_, i) => ({ ...memory(String(i), `test:person-${Math.floor(i / 1000)}`, true), text: "Synthetic fixture ".repeat(27) }));
		replace(file, records);
		expect(statSync(file).size).toBeGreaterThan(8 * 1024 * 1024);
		const store = new MemoryStore(dir);
		const read = vi.spyOn(store, "list");
		for (let i = 0; i < 2; i++) expect(store.contextFor("test:person-0")).toEqual({ memories: [], archived: 1000 });
		expect(read).toHaveBeenCalledTimes(2);
	});
});
