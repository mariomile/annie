import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelAdapter, OutboundMessage } from "../src/channels/types.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { AnnieRuntime, type OutboxEntry } from "../src/core/index.ts";
import { connectChannel } from "../src/gateway.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";
import { kill9, spawnFixture, type Worker } from "./processes.ts";

const ANSWER = "Annie (modello locale di sviluppo): hai scritto «ciao»";
const outboxOf = (dataDir: string) => join(dataDir, "tenants", "acme", "instances", "ops", "outbox");

function outboxEntries(dataDir: string): OutboxEntry[] {
	const dir = outboxOf(dataDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as OutboxEntry);
}

/** A test channel: `send` runs the given behavior and records what it was asked to send. */
function testChannel(behavior: (message: OutboundMessage) => Promise<void>): ChannelAdapter & { sent: OutboundMessage[] } {
	const sent: OutboundMessage[] = [];
	return {
		name: "test",
		sent,
		start: async () => {},
		stop: async () => {},
		onInbound: () => {},
		send: async (message) => {
			sent.push(message);
			await behavior(message);
		},
	};
}

const hello = { tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text: "ciao", messageId: "m1" };

describe("reply outbox (in process)", () => {
	it("writes each reply to the outbox before the channel sends it, and marks it delivered after", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		let atSend: OutboxEntry[] = [];
		const channel = testChannel(async () => {
			atSend = outboxEntries(dataDir);
		});
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });

		await runtime.submit(hello);
		await waitFor(() => outboxEntries(dataDir).some((e) => e.deliveredAt !== undefined));

		expect(channel.sent).toHaveLength(1);
		const key = channel.sent[0]?.idempotencyKey;
		expect(key).toMatch(/^reply:/);
		// At send time: on disk, not yet delivered.
		expect(atSend).toEqual([expect.objectContaining({ key, channel: "test", threadId: "t1", attempts: 1, reply: { status: "answered", text: ANSWER } })]);
		expect(atSend[0]?.deliveredAt).toBeUndefined();
		// After the channel's ok: delivered.
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ key, attempts: 1, deliveredAt: expect.any(String) })]);
		const audit = await runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "reply.delivered", deliveryId: key, attempts: 1, possibleDuplicate: false }));
		expect(JSON.stringify(audit)).not.toContain("hai scritto");
		await runtime.close();
	});

	it("keeps a reply whose send failed and sends it once on the next resume", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		const failing = testChannel(async () => {
			throw new Error("channel down");
		});
		const logs: string[] = [];
		connectChannel(runtime, failing, { tenantId: "acme", instanceId: "ops" }, (line) => logs.push(line));
		await runtime.submit(hello);
		await waitFor(() => failing.sent.length === 1);
		await waitFor(() => logs.length === 1);
		expect(logs[0]).toContain("send failed, kept in the outbox: channel down");
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ attempts: 1 })]);
		expect(outboxEntries(dataDir)[0]?.deliveredAt).toBeUndefined();
		await runtime.close();

		const next = new AnnieRuntime({ dataDir, engine: piDurableEngine });
		const working = testChannel(async () => {});
		connectChannel(next, working, { tenantId: "acme", instanceId: "ops" });
		expect(await next.resume("acme", "ops")).toEqual({ pending: 0, undelivered: 1 });
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		// A second resume in the same process, and the engine's own replies, send nothing more.
		await next.resume("acme", "ops");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(working.sent).toEqual([expect.objectContaining({ threadId: "t1", text: ANSWER, idempotencyKey: failing.sent[0]?.idempotencyKey })]);
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ attempts: 2 })]);
		await next.close();
	});
});

describe("reply outbox across a SIGKILL (real child processes, fake Telegram)", () => {
	const workers: Worker[] = [];
	afterEach(async () => {
		await Promise.all(workers.splice(0).map(kill9));
	});
	const worker = (mode: "start" | "resume", dataDir: string, callsFile: string, send: "ok" | "hang-before" | "hang-after") => {
		const w = spawnFixture("outbox-worker.ts", [mode, dataDir, callsFile, send]);
		workers.push(w);
		return w;
	};
	const sendMessages = (callsFile: string) =>
		existsSync(callsFile)
			? readFileSync(callsFile, "utf8")
					.trim()
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => JSON.parse(line) as { pid: number; method: string; body: Record<string, unknown> })
			: [];

	it("killed after the outbox write and before the send: the next process sends exactly one sendMessage", async () => {
		const dataDir = tempDataDir();
		const callsFile = join(dataDir, "telegram-calls.jsonl");

		const first = worker("start", dataDir, callsFile, "hang-before");
		await first.waitForLine("SENDING");
		// The reply is on disk before the request leaves.
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ channel: "telegram", threadId: "42", attempts: 1, reply: { status: "answered", text: ANSWER } })]);
		await kill9(first);
		expect(sendMessages(callsFile)).toEqual([]);

		const second = worker("resume", dataDir, callsFile, "ok");
		expect(await second.waitForLine("RESUMED")).toBe('RESUMED {"pending":0,"undelivered":1}');
		await second.waitForLine("DELIVERED");
		expect(await second.exited).toBe(0);

		// A third start finds nothing to send.
		const third = worker("resume", dataDir, callsFile, "ok");
		expect(await third.waitForLine("RESUMED")).toBe('RESUMED {"pending":0,"undelivered":0}');
		expect(await third.exited).toBe(0);

		expect(sendMessages(callsFile)).toEqual([{ pid: second.child.pid, method: "sendMessage", body: { chat_id: "42", text: ANSWER } }]);
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ attempts: 2, deliveredAt: expect.any(String) })]);
	});

	it("killed after Telegram received it and before the outbox was marked: at-least-once, the user gets it twice", async () => {
		const dataDir = tempDataDir();
		const callsFile = join(dataDir, "telegram-calls.jsonl");

		const first = worker("start", dataDir, callsFile, "hang-after");
		await first.waitForLine("SENT");
		await kill9(first);
		expect(outboxEntries(dataDir)[0]?.deliveredAt).toBeUndefined();

		const second = worker("resume", dataDir, callsFile, "ok");
		expect(await second.waitForLine("RESUMED")).toBe('RESUMED {"pending":0,"undelivered":1}');
		await second.waitForLine("DELIVERED");
		expect(await second.exited).toBe(0);

		// Telegram has no idempotency key for sendMessage: the resend cannot be deduplicated there.
		const calls = sendMessages(callsFile);
		expect(calls.map((c) => [c.pid, c.body])).toEqual([
			[first.child.pid, { chat_id: "42", text: ANSWER }],
			[second.child.pid, { chat_id: "42", text: ANSWER }],
		]);
		// The possible duplicate is visible in the tenant's audit.
		const audit = readFileSync(join(dataDir, "tenants", "acme", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(audit).toContainEqual(expect.objectContaining({ type: "reply.delivered", attempts: 2, possibleDuplicate: true }));
	});
});
