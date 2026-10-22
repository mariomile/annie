import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AgentDoc, type ConversationId, createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import type { AnnieTool, EngineOpenOptions, EngineReply } from "../src/core/engine.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { instanceFile } from "../src/core/paths.ts";
import { TenantRegistry } from "../src/core/registry.ts";
import { modelApiKeySecret, TenantSecrets } from "../src/core/secrets.ts";
import { tempDataDir, waitFor } from "./helpers.ts";

/** A folder's fsync the test can hold: a file renamed into it is visible, its write not finished. */
const fsync = vi.hoisted(() => ({ dir: undefined as string | undefined, reached: () => {}, held: Promise.resolve() }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (fsync.dir !== undefined && args[0] === fsync.dir) {
				const sync = handle.sync.bind(handle);
				handle.sync = async () => {
					fsync.reached();
					await fsync.held;
					return sync();
				};
			}
			return handle;
		},
	};
});

const DEV = { provider: "faux", modelId: "annie-dev" };
const GROK = { provider: "xai", modelId: "grok-4.7" };

/** A tool that holds the turn until the session closes, or answers at once. */
function hold(blocking: boolean, started: () => void = () => {}): AnnieTool {
	return {
		name: "hold",
		description: "Wait",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		execute: async (_args, { signal }) => {
			if (!blocking) return "ok";
			started();
			return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		},
	};
}

/**
 * Two chats left mid-turn on the local model; meanwhile t2 got its own model, which has no
 * key here: on it t2 cannot answer, on the old one it would.
 */
async function leftMidTurn(): Promise<{ storageDir: string; s1: string; s2: string }> {
	const storageDir = tempDataDir();
	let holding = 0;
	const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
	const { submissionId: s1 } = await first.submit("web:t1", "/tool hold {}");
	const { submissionId: s2 } = await first.submit("web:t2", "/tool hold {}");
	await waitFor(() => holding === 2);
	await first.setThreadModel("web:t2", GROK);
	await first.close();
	return { storageDir, s1, s2 };
}

/**
 * Chats left mid-turn on their own model, the local one, while the instance runs on a model
 * with no key here: back on the instance model, a chat cannot answer.
 */
async function leftOnOwnModel(threadKeys: readonly string[] = ["web:t1"]): Promise<{ storageDir: string; ids: string[] }> {
	const storageDir = tempDataDir();
	let holding = 0;
	const first = await piDurableEngine.open({ storageDir, model: GROK, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
	const ids: string[] = [];
	for (const threadKey of threadKeys) {
		await first.setThreadModel(threadKey, DEV);
		ids.push((await first.submit(threadKey, "/tool hold {}")).submissionId);
	}
	await waitFor(() => holding === threadKeys.length);
	await first.close();
	return { storageDir, ids };
}

/**
 * Chats left mid-turn on the local model, each then given its own model, xAI's: whether they
 * answer after the restart depends on xAI being usable while they are aligned.
 */
async function leftForGrok(threadKeys: readonly string[]): Promise<{ storageDir: string; ids: string[] }> {
	const storageDir = tempDataDir();
	let holding = 0;
	const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
	const ids: string[] = [];
	for (const threadKey of threadKeys) ids.push((await first.submit(threadKey, "/tool hold {}")).submissionId);
	await waitFor(() => holding === threadKeys.length);
	for (const threadKey of threadKeys) await first.setThreadModel(threadKey, GROK);
	await first.close();
	return { storageDir, ids };
}

/** The instructions each chat's conversation holds, read from a closed session's storage. */
async function storedInstructions(storageDir: string): Promise<Record<string, string | undefined>> {
	const ThreadsDoc = defineDoc<{ threads: Record<string, number> }>({ kind: "annie.threads", version: 1, scope: "session", initial: () => ({ threads: {} }) });
	const models = createModels({
		credentials: { read: async () => undefined, list: async () => [], modify: async () => {}, delete: async () => {} },
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const storage = await openNodeSqliteStorage(join(storageDir, "pi-durable.sqlite"));
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	const threads = (await harness.snapshot(ThreadsDoc, BACKGROUND_CONTEXT))?.threads ?? {};
	const result: Record<string, string | undefined> = {};
	for (const [threadKey, id] of Object.entries(threads)) result[threadKey] = (await harness.snapshot(AgentDoc, id as ConversationId, BACKGROUND_CONTEXT))?.instructions;
	await harness.close(BACKGROUND_CONTEXT);
	return result;
}

const reopenOnGrok = (storageDir: string, modelUsable?: EngineOpenOptions["modelUsable"]) =>
	piDurableEngine.open({ storageDir, model: GROK, apiKey: async () => undefined, tools: [hold(false)], ...(modelUsable === undefined ? {} : { modelUsable }) });

const reopen = (storageDir: string, modelUsable?: EngineOpenOptions["modelUsable"]) =>
	piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(false)], ...(modelUsable === undefined ? {} : { modelUsable }) });

describe("restart after the configuration changed", () => {
	it("resume(): every pending conversation is aligned before any of them runs again", async () => {
		const { storageDir } = await leftMidTurn();
		const replies: EngineReply[] = [];
		let resuming = false;
		// Checking t2's model during resume() is held until t1 has answered (or a second, when
		// nothing runs yet): had the scheduler started before t2 was aligned, t2 would answer on
		// the old model meanwhile.
		const session = await reopen(storageDir, async () => {
			if (resuming) await waitFor(() => replies.length > 0, 1_000).catch(() => {});
			return true;
		});
		session.onReply((reply) => replies.push(reply));
		resuming = true;
		expect(await session.resume()).toEqual({ pending: 2 });
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "unanswered" });
		await session.close();
	});

	it("reattach() before resume(), the runtime's order: the work goes on with the configuration of now", async () => {
		const { storageDir, s1, s2 } = await leftMidTurn();
		const session = await reopen(storageDir);
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		expect(await session.reattach(s1, "web:t1")).toBe(true);
		expect(await session.reattach(s2, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "unanswered" });
		expect(await session.resume()).toEqual({ pending: 0 });
		await session.close();
	});

	it("a chat model cleared after open() and before resume() still counts", async () => {
		const { storageDir } = await leftOnOwnModel();
		const session = await reopenOnGrok(storageDir);
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		await session.setThreadModel("web:t1", undefined);
		expect(await session.resume()).toEqual({ pending: 1 });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadKey: "web:t1", status: "unanswered" });
		await session.close();
	});

	it("a chat model that stops being usable after open() and before reattach() still counts", async () => {
		const {
			storageDir,
			ids: [s1],
		} = await leftOnOwnModel();
		let usable = true;
		const session = await reopenOnGrok(storageDir, async () => usable);
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		usable = false;
		expect(await session.reattach(s1!, "web:t1")).toBe(true);
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadKey: "web:t1", status: "unanswered" });
		await session.close();
	});

	it("a preparation that fails is tried again by the next call, and the work goes on", async () => {
		const { storageDir, ids } = await leftOnOwnModel();
		let checks = 0;
		const session = await reopenOnGrok(storageDir, async () => {
			if (++checks <= 2) throw new Error("provider check down");
			return true;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		await expect(session.reattach(ids[0]!, "web:t1")).rejects.toThrow("provider check down");
		await expect(session.resume()).rejects.toThrow("provider check down");
		expect(await session.resume()).toEqual({ pending: 1 });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadKey: "web:t1", status: "answered" });
		// Two that failed, the one that aligned, the one that found nothing changed since.
		expect(checks).toBe(4);
		await session.close();
	});

	it("a chat model cleared while the others are still being aligned counts too", async () => {
		const { storageDir, ids } = await leftOnOwnModel(["web:t1", "web:t2"]);
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// t1 is checked and aligned first; t2's check waits for the test.
		const session = await reopenOnGrok(storageDir, async () => {
			if (++checks === 2) await held;
			return true;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		await session.setThreadModel("web:t1", undefined);
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "unanswered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});

	it("a provider key removed while the others are still being aligned counts too", async () => {
		const { storageDir, ids } = await leftForGrok(["web:t1", "web:t2"]);
		const secrets = new TenantSecrets(tempDataDir(), tenantId("acme"));
		await secrets.set(modelApiKeySecret("xai"), "xai-key");
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// The runtime's check, on a real secret store; t2's first check waits for the test.
		const session = await reopen(storageDir, async (provider) => {
			if (++checks === 2) await held;
			return provider === "faux" || (await secrets.get(modelApiKeySecret(provider))) !== undefined;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		await secrets.delete(modelApiKeySecret("xai"));
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});

	it("instructions changed while the others are still being aligned count too", async () => {
		const { storageDir, ids } = await leftOnOwnModel(["web:t1", "web:t2"]);
		let instructions = "Skills: none";
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// t1 is aligned first; t2's check waits for the test.
		const session = await piDurableEngine.open({
			storageDir,
			model: GROK,
			apiKey: async () => undefined,
			tools: [hold(false)],
			instructions: () => instructions,
			modelUsable: async () => {
				if (++checks === 2) await held;
				return true;
			},
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		instructions = "Skills: invoices";
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		await session.close();
		expect(await storedInstructions(storageDir)).toEqual({ "web:t1": "Skills: invoices", "web:t2": "Skills: invoices" });
	});

	it("an instance policy already on disk while its write is still being flushed counts too", async () => {
		const { storageDir, ids } = await leftForGrok(["web:t1", "web:t2"]);
		const registry = new TenantRegistry(tempDataDir());
		await registry.createTenant({ id: "acme", name: "Acme" });
		await registry.createInstance("acme", { id: "ops", name: "Ops", model: DEV, egress: { modelProviders: ["faux", "xai"], channels: ["web"] } });
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// The runtime's policy check, on a real registry; t2's first check waits for the test.
		const session = await reopen(storageDir, async (provider) => {
			if (++checks === 2) await held;
			return (await registry.getInstance("acme", "ops")).egress.modelProviders.includes(provider);
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		let flush = () => {};
		fsync.held = new Promise<void>((resolve) => (flush = resolve));
		const renamed = new Promise<void>((resolve) => (fsync.reached = resolve));
		fsync.dir = dirname(instanceFile(registry.dataDir, tenantId("acme"), instanceId("ops")));
		const written = registry.setEgress("acme", "ops", { modelProviders: ["faux"], channels: ["web"] });
		await renamed;
		release();
		expect(await reattached).toBe(true);
		fsync.dir = undefined;
		flush();
		await written;
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});

	it("a provider key removed by another process counts too", async () => {
		const { storageDir, ids } = await leftForGrok(["web:t1", "web:t2"]);
		const dataDir = tempDataDir();
		const secrets = new TenantSecrets(dataDir, tenantId("acme"));
		await secrets.set(modelApiKeySecret("xai"), "xai-key");
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const session = await reopen(storageDir, async (provider) => {
			if (++checks === 2) await held;
			return provider === "faux" || (await secrets.get(modelApiKeySecret(provider))) !== undefined;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		const url = (file: string) => pathToFileURL(join(process.cwd(), file)).href;
		const script = [
			`import { TenantSecrets, modelApiKeySecret } from ${JSON.stringify(url("src/core/secrets.ts"))};`,
			`import { tenantId } from ${JSON.stringify(url("src/core/ids.ts"))};`,
			`await new TenantSecrets(${JSON.stringify(dataDir)}, tenantId("acme")).delete(modelApiKeySecret("xai"));`,
		].join("\n");
		await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});
});
