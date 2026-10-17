import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import type { EngineReply, EngineSession } from "../src/core/engine.ts";
import { modelApiKeySecret } from "../src/core/secrets.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const reply = (session: EngineSession) => new Promise<EngineReply>((resolve) => session.onReply(resolve));
const DEV = { provider: "faux", modelId: "annie-dev" };
const GROK = { provider: "xai", modelId: "grok-4.7" };

describe("a chat with its own model (engine)", () => {
	it("answers with the chat's model, keeps it across restarts, and goes back to the instance's when cleared", async () => {
		const storageDir = tempDataDir();
		// The instance runs on a provider without a key: on its own model a chat cannot answer.
		const open = () => piDurableEngine.open({ storageDir, model: GROK, apiKey: async () => undefined, tools: [] });
		let session = await open();
		expect(await session.threadModel("web:t1")).toBeUndefined();
		await session.setThreadModel("web:t1", DEV);
		expect(await session.threadModel("web:t1")).toEqual(DEV);
		let next = reply(session);
		await session.submit("web:t1", "ciao");
		expect(await next).toMatchObject({ status: "answered", text: expect.stringContaining("ciao") });
		// Another chat keeps the instance's model.
		next = reply(session);
		await session.submit("web:t2", "ciao");
		expect(await next).toMatchObject({ status: "unanswered", threadKey: "web:t2" });
		await session.close();

		session = await open();
		expect(await session.threadModel("web:t1")).toEqual(DEV);
		next = reply(session);
		await session.submit("web:t1", "ancora");
		expect(await next).toMatchObject({ status: "answered", text: expect.stringContaining("ancora") });
		await session.setThreadModel("web:t1", undefined);
		expect(await session.threadModel("web:t1")).toBeUndefined();
		next = reply(session);
		await session.submit("web:t1", "e ora?");
		expect(await next).toMatchObject({ status: "unanswered", threadKey: "web:t1" });
		await session.close();
	});

	it("reaches a provider the instance does not run on", async () => {
		const session = await piDurableEngine.open({ storageDir: tempDataDir(), model: DEV, apiKey: async () => undefined, tools: [] });
		await session.setThreadModel("web:t1", GROK);
		const next = reply(session);
		await session.submit("web:t1", "ciao");
		// Routed to xai, which has no key here: not the echo of the local model.
		expect(await next).toMatchObject({ status: "unanswered" });
		await session.close();
	});
});

const running: RunningAnnie[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

async function boot(env: Record<string, string> = {}) {
	const config = loadAnnieConfig({ ANNIE_DATA_DIR: tempDataDir(), ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ...env });
	const annie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {} });
	running.push(annie);
	const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
	return { annie, base, api: await client(base, annie.ownerLink as string) };
}

async function client(base: string, link: string) {
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	// biome-ignore lint: test
	return async (path: string, method = "GET", body?: unknown): Promise<any> => {
		const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, ...((await res.json()) as object) };
	};
}

/** Let a person write to the instance from the console. */
async function allow(annie: RunningAnnie, personId: string): Promise<void> {
	const record = await annie.runtime.registry.getInstance("default", "annie");
	await annie.runtime.registry.setAllowedUsers("default", "annie", "web", [...(record.allowedUsers.web ?? []), personId]);
}

/** Write in a console chat and wait for Annie's answer. */
// biome-ignore lint: test
async function ask(api: (path: string, method?: string, body?: unknown) => Promise<any>, thread: string, text: string): Promise<string> {
	const path = `/api/instances/annie/threads/${thread}`;
	const before = (await api(path)).entries.length;
	expect((await api(`${path}/messages`, "POST", { text })).status).toBe(200);
	for (let i = 0; i < 200; i++) {
		const { entries } = await api(path);
		const answer = entries.slice(before).find((e: { from: string }) => e.from === "annie");
		if (answer !== undefined) return answer.text;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("no answer");
}

describe("choosing a chat's model from the console", () => {
	it("lists the providers a chat may use: with a key and allowed, and for the owner those still to allow", async () => {
		const { annie, api, base } = await boot({ GEMINI_API_KEY: "server-key-0001" });
		const listed = await api("/api/instances/annie/chat-models");
		expect(listed.instanceModel).toEqual(DEV);
		expect(listed.providers).toEqual([
			{ id: "google", label: "Google (Gemini)", defaultModel: "gemini-3.5-flash", allowed: false },
			{ id: "faux", label: "Modello di prova", defaultModel: "annie-dev", allowed: true },
		]);
		const { models } = await api("/api/instances/annie/chat-models/google");
		expect(models.map((m: { id: string }) => m.id)).toContain("gemini-3.5-flash");
		expect((await api("/api/instances/annie/chat-models/xai")).status).toBe(404);
		// A member sees only what the owner allowed.
		const added = await api("/api/people", "POST", { name: "Giulia" });
		await allow(annie, added.person.id);
		const giulia = await client(base, added.link);
		expect((await giulia("/api/instances/annie/chat-models")).providers.map((p: { id: string }) => p.id)).toEqual(["faux"]);
		expect((await giulia("/api/instances/annie/chat-models/google")).status).toBe(404);
	});

	it("a chat answers with its own model; the owner's choice allows the provider; clearing goes back", async () => {
		const { annie, api } = await boot();
		const { thread } = await api("/api/instances/annie/threads", "POST", {});
		const other = (await api("/api/instances/annie/threads", "POST", {})).thread;
		const path = `/api/instances/annie/threads/${thread.id}`;
		expect((await api(path)).model).toBeUndefined();
		await annie.runtime.secrets("default").set(modelApiKeySecret("xai"), "xai-key-0001");
		expect(await api(`${path}/model`, "PUT", { provider: "xai", modelId: "grok-4.7" })).toMatchObject({ status: 200, model: GROK });
		expect((await api(path)).model).toEqual(GROK);
		expect((await annie.runtime.registry.getInstance("default", "annie")).egress.modelProviders).toEqual(["faux", "xai"]);
		// The other chat still answers with the instance's model.
		expect(await ask(api, other.id, "ciao")).toContain("ciao");
		expect(await annie.runtime.chatModel("default", "annie", "web", other.id)).toBeUndefined();
		expect((await api(`${path}/model`, "PUT", {})).status).toBe(200);
		expect((await api(path)).model).toBeUndefined();
		expect(await ask(api, thread.id, "eccomi")).toContain("eccomi");
		const audit = JSON.stringify(await annie.runtime.audit("default").read());
		expect(audit).toContain("chat.model.updated");
		expect(audit).not.toContain("xai-key-0001");
	});

	it("refuses a model the provider lacks, a provider without a key, another person's chat, and a member allowing a provider", async () => {
		const { annie, api, base } = await boot();
		const { thread } = await api("/api/instances/annie/threads", "POST", {});
		const path = `/api/instances/annie/threads/${thread.id}/model`;
		expect((await api(path, "PUT", { provider: "xai", modelId: "grok-4.7" })).status).toBe(400);
		await annie.runtime.secrets("default").set(modelApiKeySecret("xai"), "xai-key-0001");
		expect((await api(path, "PUT", { provider: "xai", modelId: "grok-99" })).status).toBe(400);
		expect((await api(path, "PUT", { provider: "nope", modelId: "x" })).status).toBe(400);
		const added = await api("/api/people", "POST", { name: "Giulia" });
		await allow(annie, added.person.id);
		const giulia = await client(base, added.link);
		expect((await giulia(path, "PUT", { provider: "faux", modelId: "annie-dev" })).status).toBe(404);
		const mine = (await giulia("/api/instances/annie/threads", "POST", {})).thread;
		expect((await giulia(`/api/instances/annie/threads/${mine.id}/model`, "PUT", { provider: "xai", modelId: "grok-4.7" })).status).toBe(400);
		expect((await annie.runtime.registry.getInstance("default", "annie")).egress.modelProviders).toEqual(["faux"]);
		expect((await giulia(`/api/instances/annie/threads/${mine.id}/model`, "PUT", { provider: "faux", modelId: "annie-dev" })).status).toBe(200);
	});

	it("a chat whose provider lost its key answers with the instance's model again", async () => {
		const { annie, api } = await boot();
		const { thread } = await api("/api/instances/annie/threads", "POST", {});
		await annie.runtime.secrets("default").set(modelApiKeySecret("xai"), "xai-key-0001");
		await api(`/api/instances/annie/threads/${thread.id}/model`, "PUT", { provider: "xai", modelId: "grok-4.7" });
		await annie.runtime.secrets("default").delete(modelApiKeySecret("xai"));
		expect(await ask(api, thread.id, "ci sei?")).toContain("ci sei?");
		expect((await api(`/api/instances/annie/threads/${thread.id}`)).model).toBeUndefined();
		expect(JSON.stringify(await annie.runtime.audit("default").read())).toContain("chat.model.reset");
	});
});
