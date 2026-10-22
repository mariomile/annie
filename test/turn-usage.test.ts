import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { turnUsage } from "../src/core/adapters/pi-durable.ts";
import { AuditLog } from "../src/core/audit.ts";
import { tenantId } from "../src/core/ids.ts";
import { tenantDir } from "../src/core/paths.ts";
import { turnStats } from "../src/core/usage.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

type FakeEntry = { id: string; model?: unknown[] };
const said = (cost: number, ...tools: string[]) => ({
	role: "assistant",
	content: tools.length === 0 ? [{ type: "text", text: "ok" }] : tools.map((name) => ({ type: "toolCall", id: name, name, arguments: {} })),
	usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, totalTokens: 165, cost: { total: cost } },
});
const asked = { role: "user", content: "fai" };

/** Entries newest first, as a descending scan returns them, in pages of `size`. */
function fakeTx(entries: FakeEntry[], size = 2) {
	return {
		async scanEntries(query: { maxEntryId?: unknown }, _limit: number, cursor?: unknown) {
			const from = cursor === undefined ? entries.findIndex((e) => e.id === query.maxEntryId) : (cursor as number);
			const start = from < 0 ? entries.length : from;
			const items = entries.slice(start, start + size);
			return { items, next: start + size < entries.length ? start + size : undefined };
		},
	} as never;
}

describe("quanto costa un turno (ADR 0098)", () => {
	it("adds every model call from the answer back to the end of the previous turn, with the tools in order", async () => {
		const entries: FakeEntry[] = [
			{ id: "6", model: [said(0.003)] },
			{ id: "5", model: [{ role: "toolResult" }] },
			{ id: "4", model: [said(0.002, "web_search")] },
			{ id: "3", model: [{ role: "toolResult" }, { role: "toolResult" }] },
			{ id: "2", model: [said(0.001, "memory_recall", "calendar_list")] },
			{ id: "1", model: [asked] },
			{ id: "0", model: [said(9)] },
		];
		const usage = await turnUsage(fakeTx(entries), "c" as never, "6" as never);
		expect(usage).toEqual({ modelCalls: 3, inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 15, costUsd: expect.closeTo(0.006, 9), tools: ["memory_recall", "calendar_list", "web_search"] });
	});

	it("knows nothing when the answer is not where it should be", async () => {
		expect(await turnUsage(fakeTx([{ id: "1", model: [said(1)] }]), "c" as never, "9" as never)).toBeUndefined();
	});

	it("a turn with a tool writes its usage in the audit and the tenant's spend, once", async () => {
		const { runtime, dataDir, replies } = await runtimeWithInstance({});
		const from = (text: string, messageId: string) => ({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text, messageId });
		await runtime.submit(from("conta fino a 2", "1"));
		await waitFor(() => replies.length === 1);
		await runtime.submit(from("ciao", "2"));
		await waitFor(() => replies.length === 2);
		await runtime.close();
		const turns = (await new AuditLog(dataDir, tenantId("acme")).read()).filter((r) => r.type === "turn.usage");
		expect(turns).toHaveLength(2);
		expect(turns[0]).toMatchObject({ instanceId: "ops", channel: "test", threadId: "t1", provider: "faux", model: "annie-dev", modelCalls: 2, toolCalls: 1, tools: "slow_counter" });
		expect(turns[1]).toMatchObject({ modelCalls: 1, toolCalls: 0, tools: "" });
		const ledger = (await readFile(join(tenantDir(dataDir, tenantId("acme")), "usage.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { role: string; submissionId: string });
		expect(ledger.map((r) => r.role)).toEqual(["agent", "agent"]);
		expect(new Set(ledger.map((r) => r.submissionId)).size).toBe(2);
	});

	it("sums the last 7 days per agente, with the tools called most", () => {
		const turn = (ts: string, instanceId: string, costUsd: number, tools: string) => ({ ts, tenantId: "acme", type: "turn.usage", instanceId, inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 10, costUsd, tools });
		const stats = turnStats([turn("2026-10-21T10:00:00Z", "ops", 0.01, "web_search,web_search"), turn("2026-10-22T10:00:00Z", "casa", 0.03, "memory_recall,web_search"), turn("2026-10-01T10:00:00Z", "ops", 5, "old"), { ts: "2026-10-22T10:00:00Z", tenantId: "acme", type: "message.received" }], new Date("2026-10-22T12:00:00Z"));
		expect(stats).toEqual({
			turns: 2,
			inputTokens: 300,
			outputTokens: 20,
			costUsd: expect.closeTo(0.04, 9),
			instances: [
				{ instanceId: "casa", turns: 1, costUsd: 0.03 },
				{ instanceId: "ops", turns: 1, costUsd: 0.01 },
			],
			tools: [
				{ name: "web_search", calls: 3 },
				{ name: "memory_recall", calls: 1 },
			],
		});
	});
});
