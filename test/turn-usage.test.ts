import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { turnUsage } from "../src/core/adapters/pi-durable.ts";
import { tenantId } from "../src/core/ids.ts";
import { tenantDir } from "../src/core/paths.ts";
import { turnStats, type UsageRecord } from "../src/core/usage.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

type FakeEntry = { id: number; kind?: string; model?: unknown[] };
const said = (cost: number, ...tools: string[]) => ({
	role: "assistant",
	content: tools.length === 0 ? [{ type: "text", text: "ok" }] : tools.map((name) => ({ type: "toolCall", id: name, name, arguments: {} })),
	stopReason: tools.length === 0 ? "stop" : "toolUse",
	usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, totalTokens: 165, cost: { total: cost } },
});
/** A request that failed: Pi writes it down, then retries, compacts, or gives up. */
const failed = (cost: number, stopReason: "error" | "aborted" = "error") => ({ ...said(cost), content: [], stopReason, errorMessage: "529 overloaded" });
const asked = { role: "user", content: "fai" };
const input = (id: number): FakeEntry => ({ id, kind: "annie.input", model: [asked] });
const assistant = (id: number, message: unknown): FakeEntry => ({ id, kind: "pi.assistant", model: [message] });
const ledger = (cost: number, input = 0) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });

/**
 * Entries newest first, read in pages of `size` in either order; `models` is the conversation's
 * `pi.usage`, and the docs Annie writes live in `docs`.
 */
function fakeTx(entries: FakeEntry[], size = 2, models?: Record<string, ReturnType<typeof ledger>>, docs: Record<string, unknown> = {}) {
	return {
		async scanEntries(query: { order?: string; maxEntryId?: number; minEntryId?: number }, _limit: number, cursor?: unknown) {
			const list = query.order === "ascending" ? [...entries].reverse().filter((e) => e.id >= (query.minEntryId ?? 0)) : entries.filter((e) => query.maxEntryId === undefined || e.id <= query.maxEntryId);
			const start = (cursor as number | undefined) ?? 0;
			return { items: list.slice(start, start + size), next: start + size < list.length ? start + size : undefined };
		},
		async doc(token: { definition: { kind: string; initial: () => unknown } }) {
			if (token.definition.kind === "pi.usage") return { models: models ?? {}, tools: {} };
			return (docs[token.definition.kind] ??= token.definition.initial());
		},
	} as never;
}

describe("quanto costa un turno (ADR 0098)", () => {
	it("adds every model call from the answer back to the end of the previous turn, with the tools in order", async () => {
		const entries: FakeEntry[] = [
			assistant(6, said(0.003)),
			{ id: 5, model: [{ role: "toolResult" }] },
			assistant(4, said(0.002, "web_search")),
			{ id: 3, model: [{ role: "toolResult" }, { role: "toolResult" }] },
			assistant(2, said(0.001, "memory_recall", "calendar_list")),
			input(1),
			assistant(0, said(9)),
		];
		const usage = await turnUsage(fakeTx(entries), 1 as never, 6 as never);
		expect(usage).toEqual({ modelCalls: 3, inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 15, costUsd: expect.closeTo(0.006, 9), tools: ["memory_recall", "calendar_list", "web_search"] });
	});

	it("knows nothing when the answer is not where it should be", async () => {
		expect(await turnUsage(fakeTx([assistant(1, said(1))]), 1 as never, 9 as never)).toBeUndefined();
	});

	it("says it when the run is longer than the scan, and still gives what it found", async () => {
		const entries: FakeEntry[] = Array.from({ length: 1100 }, (_, i) => assistant(1100 - i, said(0.001, "web_search")));
		const said_: string[] = [];
		const usage = await turnUsage(fakeTx(entries, 50), 1 as never, 1100 as never, (m) => said_.push(m));
		expect(said_).toHaveLength(1);
		expect(usage?.modelCalls).toBe(1000);
	});

	it("a request that failed and was retried, or was cut short, does not end the run: the run's every call is counted", async () => {
		const entries: FakeEntry[] = [
			assistant(6, said(0.3)),
			{ id: 5, model: [{ role: "toolResult" }] },
			assistant(4, said(0.2, "web_search")),
			assistant(3, failed(0.05, "aborted")),
			assistant(2, failed(0.05)),
			input(1),
			assistant(0, said(9)),
		];
		const usage = await turnUsage(fakeTx(entries), 1 as never, 6 as never);
		expect(usage).toMatchObject({ modelCalls: 4, costUsd: expect.closeTo(0.6, 9), tools: ["web_search"] });
	});

	it("a compaction's summary is billed to the run it happened in, from Pi's own ledger, and a turn is billed once", async () => {
		const docs: Record<string, unknown> = {};
		// The previous turn: billed by what its run called.
		const first: FakeEntry[] = [assistant(2, said(0.1)), input(1)];
		expect(await turnUsage(fakeTx(first, 2, { "p/m": ledger(0.1, 100) }, docs), 1 as never, 2 as never)).toMatchObject({ modelCalls: 1, costUsd: expect.closeTo(0.1, 9) });
		// This turn overflowed: Pi compacted (a summary costing 0.25, in pi.usage only) and answered.
		const entries: FakeEntry[] = [assistant(6, said(0.3)), { id: 5, kind: "pi.compaction", model: [asked] }, assistant(4, failed(0.05)), input(3), ...first];
		const models = { "p/m": ledger(0.1 + 0.05 + 0.25 + 0.3, 1000) };
		const billedBefore = structuredClone(docs);
		const usage = await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 6 as never);
		expect(usage).toMatchObject({ modelCalls: 3, inputTokens: 900, costUsd: expect.closeTo(0.6, 9), tools: [] });
		// Answered again after a crash: the same bill, not a second one.
		expect(await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 6 as never)).toEqual(usage);
		// What the next run has called already is its own.
		const later: FakeEntry[] = [assistant(8, said(0.4, "web_search")), input(7), ...entries];
		const next = await turnUsage(fakeTx(later, 2, { "p/m": ledger(0.7 + 0.4, 1100) }, billedBefore), 1 as never, 6 as never);
		expect(next?.costUsd).toBeCloseTo(0.6, 9);
	});

	it("a turn with a tool writes its usage in the tenant's spend, once, and nothing in the audit", async () => {
		const { runtime, dataDir, replies } = await runtimeWithInstance({});
		const from = (text: string, messageId: string) => ({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text, messageId });
		await runtime.submit(from("conta fino a 2", "1"));
		await waitFor(() => replies.length === 1);
		await runtime.submit(from("ciao", "2"));
		await waitFor(() => replies.length === 2);
		await runtime.close();
		const ledger = (await readFile(join(tenantDir(dataDir, tenantId("acme")), "usage.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as UsageRecord);
		expect(ledger.map((r) => r.role)).toEqual(["agent", "agent"]);
		expect(ledger[0]).toMatchObject({ instanceId: "ops", threadId: "t1", provider: "faux", model: "annie-dev", modelCalls: 2, tools: ["slow_counter"] });
		expect(ledger[1]).toMatchObject({ modelCalls: 1, tools: [] });
		expect(new Set(ledger.map((r) => r.submissionId)).size).toBe(2);
		expect(await readFile(join(tenantDir(dataDir, tenantId("acme")), "audit.jsonl"), "utf8").catch(() => "")).not.toContain("turn.usage");
	});

	it("sums the last 7 days per agente, with the tools called most", () => {
		const turn = (at: string, instanceId: string, estimatedUsd: number, tools: string[]): UsageRecord => ({ at, provider: "p", model: "m", role: "agent", inputTokens: 150, outputTokens: 10, estimatedUsd, instanceId, tools });
		const stats = turnStats([turn("2026-10-21T10:00:00Z", "ops", 0.01, ["web_search", "web_search"]), turn("2026-10-22T10:00:00Z", "casa", 0.03, ["memory_recall", "web_search"]), turn("2026-10-01T10:00:00Z", "ops", 5, ["old"]), { ...turn("2026-10-22T10:00:00Z", "ops", 7, []), role: "extract" }], new Date("2026-10-22T12:00:00Z"));
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
