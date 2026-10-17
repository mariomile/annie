import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { romeDayKey } from "../src/core/usage.ts";
import { proxyToken } from "../src/web/compare.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir, waitFor } from "./helpers.ts";

const running: RunningAnnie[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

/** Fake Telegram: queued updates in, every call recorded; bots told apart by their token. */
function fakeTelegram() {
	const queues = new Map<string, unknown[][]>();
	const queue = (token: string) => queues.get(token) ?? (queues.set(token, []).get(token) as unknown[][]);
	const sent: { token: string; chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
	const methods: string[] = [];
	const calls: { token: string; method: string }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const [, token = "", method = ""] = /\/bot([^/]+)\/(\w+)$/.exec(String(url)) ?? [];
		methods.push(method);
		calls.push({ token, method });
		if (token === "bad") return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
		if (method === "getMe") return Response.json({ ok: true, result: { username: `bot_${token.split(":")[0]}` } });
		if (method === "getUpdates") {
			const batch = queue(token).shift();
			if (batch === undefined) await new Promise((r) => setTimeout(r, 20));
			return Response.json({ ok: true, result: batch ?? [] });
		}
		if (method === "sendMessage") sent.push({ token, ...JSON.parse(String(init?.body)) });
		return Response.json({ ok: true, result: { message_id: 1 } });
	}) as typeof fetch;
	return { updates: queue("1:T"), queue, sent, methods, calls, fetch: fetchImpl };
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, 30));
	}
}

async function boot(dataDir: string, telegram = fakeTelegram(), env: Record<string, string> = {}) {
	const config = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", TELEGRAM_BOT_TOKEN: "1:T", ANNIE_TELEGRAM_ALLOWED_USERS: "7", ANNIE_TELEGRAM_APPROVERS: "9", ...env });
	const annie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { telegramFetch: telegram.fetch, schedulerIntervalMs: 60_000, log: process.env.DEBUG_APP ? console.error : () => {} });
	running.push(annie);
	const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
	return { annie, base, telegram };
}

async function client(base: string, link: string, extra: Record<string, string> = {}) {
	const token = link.split("#")[1] as string;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1", ...extra }, body: JSON.stringify({ token }) });
	expect(login.status).toBe(200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const call = async (path: string, body?: unknown) => {
		const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-annie": "1", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		// biome-ignore lint: test
		return (await res.json()) as any;
	};
	return Object.assign(call, { cookie });
}

describe("pnpm start (startAnnie)", () => {
	it("first start: owner link, web chat, a tool proposed in the chat and approved with a Telegram tap", async () => {
		const dataDir = tempDataDir();
		const { annie, base, telegram } = await boot(dataDir);
		expect(annie.ownerLink).toMatch(/^http:\/\/127\.0\.0\.1:0\/login#[\w-]{40,}$/);
		const api = await client(base, annie.ownerLink as string);
		const instances = (await api("/api/instances")).instances;
		expect(instances).toEqual([{ id: "annie", name: "Annie", canChat: true, isApprover: true, hasSegreteria: false }]);
		const thread = (await api("/api/instances/annie/threads", {})).thread;
		const proposal = { name: "double", description: "Raddoppia", parameters: { type: "object", properties: { x: { type: "number" } } }, code: "export default async (a) => String(a.x * 2)", hosts: [] };
		await api(`/api/instances/annie/threads/${thread.id}/messages`, { text: `/tool tool_propose ${JSON.stringify(proposal)}` });
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "9" && m.text.startsWith("Nuovo tool da approvare")));
		const card = telegram.sent.find((m) => m.chat_id === "9");
		const approve = card?.reply_markup?.inline_keyboard[0]?.find((b) => b.text === "Approva")?.callback_data as string;
		telegram.updates.push([{ update_id: 1, callback_query: { id: "cq1", from: { id: 9 }, message: { message_id: 5, chat: { id: 9 } }, data: approve } }]);
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "9" && m.text === "custom_double: approvato."));
		const entries = async () => (await api(`/api/instances/annie/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		await until(async () => (await entries()).some((e) => e.text?.includes("è stato approvato")));
		await api(`/api/instances/annie/threads/${thread.id}/messages`, { text: '/tool custom_double {"x":21}' });
		await until(async () => (await entries()).some((e) => e.text === "Fatto. 42"));
	});

	it("a proposal whose code does not fit the Telegram card can only be approved from the console", async () => {
		const { annie, base, telegram } = await boot(tempDataDir());
		const api = await client(base, annie.ownerLink as string);
		const thread = (await api("/api/instances/annie/threads", {})).thread;
		const code = `// ${"riempitivo innocuo ".repeat(120)}\nexport default async () => "payload"`;
		const proposal = { name: "lungo", description: "Codice lungo", parameters: { type: "object" }, code, hosts: [] };
		await api(`/api/instances/annie/threads/${thread.id}/messages`, { text: `/tool tool_propose ${JSON.stringify(proposal)}` });
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "9"));
		const card = telegram.sent.find((m) => m.chat_id === "9");
		expect(card?.text).toContain("leggilo tutto e decidi nella console web");
		expect(card?.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(["Rifiuta"]);
		// A forged approve tap is ignored.
		const id = (await annie.runtime.proposals("default", "annie").list())[0]!.id;
		telegram.updates.push([{ update_id: 2, callback_query: { id: "cq2", from: { id: 9 }, message: { message_id: 5, chat: { id: 9 } }, data: `tool:${id}:approved` } }]);
		await new Promise((r) => setTimeout(r, 300));
		expect((await annie.runtime.proposals("default", "annie").get(id))?.status).toBe("pending");
	});

	it("a task programmato created from the web delivers into its web thread; a restart keeps the owner", async () => {
		const dataDir = tempDataDir();
		const first = await boot(dataDir);
		const api = await client(first.base, first.annie.ownerLink as string);
		const thread = (await api("/api/instances/annie/threads", {})).thread;
		const at = new Date(Date.now() + 60_000).toISOString();
		const created = await api("/api/instances/annie/schedules", { instruction: "Promemoria riunione", at, threadId: thread.id });
		expect(created.schedule.nextRunAt).toBe(at);
		expect(await first.annie.scheduler.tick(new Date(Date.now() + 120_000))).toBe(1);
		await until(async () => ((await api(`/api/instances/annie/threads/${thread.id}`)).entries as { from: string; text?: string }[]).some((e) => e.from === "annie" && e.text?.includes("Promemoria riunione")));
		await first.annie.stop();
		running.splice(running.indexOf(first.annie), 1);
		const second = await boot(dataDir);
		expect(second.annie.ownerLink).toBeUndefined();
		const again = await client(second.base, first.annie.ownerLink as string);
		expect((await again("/api/me")).person.role).toBe("owner");
	});

	it("agenti (ADR 0041): created with a face and a tone, listed with what they do, changed in Impostazioni", async () => {
		const { annie, base } = await boot(tempDataDir());
		const api = await client(base, annie.ownerLink as string);
		const created = await api("/api/instances", { id: "ricerca", name: "Ricercatore", persona: { emoji: "🔎", tagline: "Cerca e confronta fornitori", tone: "conciso" } });
		expect(created.instance).toMatchObject({ id: "ricerca", name: "Ricercatore", emoji: "🔎", tagline: "Cerca e confronta fornitori" });
		expect((await api("/api/instances", { id: "brutta", name: "Brutta", persona: { emoji: "ciao" } })).error).toMatch(/emoji/);
		expect((await annie.runtime.registry.listInstances("default")).map((r) => r.id)).not.toContain("brutta");
		// biome-ignore lint: test
		const { agents } = (await api("/api/agents")) as { agents: any[] };
		expect(agents.map((a) => a.id)).toEqual(["annie", "ricerca"]);
		expect(agents[1]).toMatchObject({ emoji: "🔎", tone: "conciso", channels: ["web"], schedules: 0, watches: 0, memories: 0 });
		expect(agents[1].model).toMatchObject({ provider: "faux" });
		const put = (body: unknown) => fetch(`${base}/api/instances/ricerca/settings`, { method: "PUT", headers: { "x-annie": "1", "content-type": "application/json", cookie: api.cookie }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ ok?: boolean; error?: string }>);
		expect((await put({ persona: { tone: "arrogante" } })).error).toMatch(/Tono/);
		expect((await put({ name: "  ", persona: { emoji: "🧭", tone: "formale" } })).ok).toBe(true);
		// A member sees only the agenti they may write to, and only the tasks that act for them.
		const { link, person } = await api("/api/people", { name: "Anna", role: "member" });
		await put({ webPeople: [person.id] });
		await annie.runtime.schedules("default", "ricerca").create({ instruction: "Del owner", when: { at: new Date(Date.now() + 3_600_000).toISOString() }, channel: "web", threadId: "t-owner", createdBy: { kind: "person", channel: "web", userId: "owner-x" } });
		const member = await client(base, link);
		const seen = (await member("/api/agents")).agents as { id: string; schedules: number }[];
		expect(seen.map((a) => a.id)).toEqual(["ricerca"]);
		expect(seen[0]?.schedules).toBe(0);
		expect((await api("/api/agents")).agents[1].schedules).toBe(1);
		const settings = (await api("/api/instances/ricerca/settings")).settings;
		expect(settings.name).toBe("Ricercatore");
		expect(settings.persona).toEqual({ emoji: "🧭", tone: "formale", named: true });
	});

	it("agenti write to each other (ADR 0042): only those allowed, and the answer comes back to the conversation", async () => {
		const { annie, base } = await boot(tempDataDir());
		const api = await client(base, annie.ownerLink as string);
		await api("/api/instances", { id: "ricerca", name: "Ricercatore", persona: { emoji: "🔎", tagline: "Cerca fornitori" } });
		const thread = (await api("/api/instances/annie/threads", {})).thread;
		const entries = async () => (await api(`/api/instances/annie/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		const say = (text: string) => api(`/api/instances/annie/threads/${thread.id}/messages`, { text });
		await say("/tool agent_list {}");
		await until(async () => (await entries()).some((e) => e.text?.includes("Nessun altro agente accetta i tuoi messaggi")));
		await say('/tool agent_message {"agent":"ricerca","message":"Trova tre fornitori di carta"}');
		await until(async () => (await entries()).some((e) => e.text?.includes("Errore: nessun altro agente accetta")));
		const put = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "PUT", headers: { "x-annie": "1", "content-type": "application/json", cookie: api.cookie }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ from?: string[] }>);
		expect((await put("/api/instances/ricerca/agents", { from: ["annie", "ricerca", "ignoto"] })).from).toEqual(["annie"]);
		expect((await annie.runtime.registry.getInstance("default", "ricerca")).egress.channels).toContain("agente");
		expect((await api("/api/agents")).agents[1].acceptsFrom).toEqual(["annie"]);
		await say("/tool agent_list {}");
		await until(async () => (await entries()).some((e) => e.text?.includes("- Ricercatore (ricerca): Cerca fornitori")));
		await say('/tool agent_message {"agent":"Ricercatore","message":"Trova tre fornitori di carta"}');
		await until(async () => (await entries()).some((e) => e.text?.includes("Messaggio mandato a «Ricercatore»")));
		// Ricercatore got it in a conversation of its own, and its answer came back here as a notice.
		await until(async () => (await entries()).some((e) => e.from === "annie" && e.text?.includes("[Risposta dell'agente «Ricercatore» (ricerca)]")));
		const audit = await annie.runtime.audit("default").read();
		expect(audit.some((e) => e.type === "message.received" && e.instanceId === "ricerca" && e.channel === "agente" && e.userId === "annie")).toBe(true);
		expect(audit.some((e) => e.type === "notice.submitted" && e.instanceId === "annie" && e.source === "agent" && e.from === "ricerca")).toBe(true);
		// Taken back: the next message is refused, and nothing reaches Ricercatore.
		await put("/api/instances/ricerca/agents", { from: [] });
		expect((await annie.runtime.registry.getInstance("default", "ricerca")).egress.channels).not.toContain("agente");
		await say('/tool agent_message {"agent":"ricerca","message":"Ancora"}');
		await until(async () => (await entries()).filter((e) => e.text?.includes("Errore: nessun altro agente accetta")).length === 2);
	});

	it("the owner creates an instance from the console: chat works at once and after a restart", async () => {
		const dataDir = tempDataDir();
		const first = await boot(dataDir);
		const api = await client(first.base, first.annie.ownerLink as string);
		const created = await api("/api/instances", { id: "vendite", name: "Vendite", instructions: "Rispondi sulle offerte." });
		expect(created.instance).toEqual({ id: "vendite", name: "Vendite", canChat: true, isApprover: true, hasSegreteria: false });
		expect((await api("/api/instances", { id: "vendite", name: "Doppia" })).error).toMatch(/esiste già/);
		expect((await api("/api/instances", { id: "../x", name: "X" })).error).toMatch(/ID/);
		expect((await api("/api/instances", { id: "vuota", name: "  " })).error).toMatch(/nome/);
		const settings = (await api("/api/instances/vendite/settings")).settings;
		// The owner's words go after what Annie can do (ADR 0019), not in its place.
		expect(settings.instructions.startsWith("Sei Annie")).toBe(true);
		expect(settings.instructions.endsWith("Informazioni su chi ti usa:\nRispondi sulle offerte.")).toBe(true);
		expect(settings.egress).toEqual({ modelProviders: ["faux"], channels: ["web"] });
		const thread = (await api("/api/instances/vendite/threads", {})).thread;
		await api(`/api/instances/vendite/threads/${thread.id}/messages`, { text: "ciao vendite" });
		const replied = async (a: typeof api, id: string) => ((await a(`/api/instances/vendite/threads/${id}`)).entries as { from: string }[]).some((e) => e.from === "annie");
		await until(() => replied(api, thread.id));
		await first.annie.stop();
		running.splice(running.indexOf(first.annie), 1);
		const second = await boot(dataDir);
		const again = await client(second.base, first.annie.ownerLink as string);
		expect((await again("/api/instances")).instances.map((i: { id: string }) => i.id).sort()).toEqual(["annie", "vendite"]);
		const t2 = (await again("/api/instances/vendite/threads", {})).thread;
		await again(`/api/instances/vendite/threads/${t2.id}/messages`, { text: "di nuovo" });
		await until(() => replied(again, t2.id));
	});

	it("a task programmato of an instance created from the console runs without a restart", async () => {
		const { annie, base } = await boot(tempDataDir());
		const api = await client(base, annie.ownerLink as string);
		await api("/api/instances", { id: "vendite", name: "Vendite" });
		const thread = (await api("/api/instances/vendite/threads", {})).thread;
		const at = new Date(Date.now() + 60_000).toISOString();
		await api("/api/instances/vendite/schedules", { instruction: "Controlla le offerte", at, threadId: thread.id });
		expect(await annie.scheduler.tick(new Date(Date.now() + 120_000))).toBe(1);
		await until(async () => ((await api(`/api/instances/vendite/threads/${thread.id}`)).entries as { from: string; text?: string }[]).some((e) => e.from === "annie" && e.text?.includes("Controlla le offerte")));
	});

	it("an events stream opened before the instance existed gets its replies live", async () => {
		const { annie, base } = await boot(tempDataDir());
		const token = (annie.ownerLink as string).split("#")[1] as string;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const abort = new AbortController();
		const stream = await fetch(`${base}/api/events`, { headers: { cookie }, signal: abort.signal });
		const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
		let received = "";
		const reading = (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					received += new TextDecoder().decode(value);
				}
			} catch {
				/* aborted */
			}
		})();
		const api = await client(base, annie.ownerLink as string);
		await api("/api/instances", { id: "vendite", name: "Vendite" });
		const thread = (await api("/api/instances/vendite/threads", {})).thread;
		await api(`/api/instances/vendite/threads/${thread.id}/messages`, { text: "ciao" });
		await until(async () => received.includes(`"threadId":"${thread.id}"`));
		abort.abort();
		await reading;
	});

	it("two owners creating the same id at once: one wins, the other gets a message", async () => {
		const { annie, base } = await boot(tempDataDir());
		const api = await client(base, annie.ownerLink as string);
		const results = await Promise.all([1, 2, 3].map(() => api("/api/instances", { id: "doppia", name: "Doppia" })));
		expect(results.filter((r) => r.instance !== undefined)).toHaveLength(1);
		for (const r of results.filter((r) => r.instance === undefined)) expect(r.error).toMatch(/esiste già/);
	});

	it("Telegram via webhook: the bot is registered, a pushed update with the right secret gets a reply, a wrong secret gets nothing", async () => {
		const telegram = fakeTelegram();
		const { base } = await boot(tempDataDir(), telegram, { ANNIE_PUBLIC_URL: "https://annie.example", ANNIE_TELEGRAM_WEBHOOK_SECRET: "hook_secret-123" });
		await until(async () => telegram.methods.includes("setWebhook"));
		expect(telegram.methods).not.toContain("getUpdates");
		const push = (secret: string, update: unknown) => fetch(`${base}/hooks/telegram/annie`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) });
		const update = { update_id: 1, message: { message_id: 3, chat: { id: 7 }, from: { id: 7 }, text: "ciao dal webhook" } };
		expect((await push("wrong", update)).status).toBe(401);
		expect((await fetch(`${base}/hooks/telegram/altra`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hook_secret-123" }, body: "{}" })).status).toBe(404);
		expect((await push("hook_secret-123", update)).status).toBe(200);
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "7" && m.text.includes("ciao dal webhook")));
		// The same update delivered again (Telegram retries) is answered once.
		expect((await push("hook_secret-123", update)).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(telegram.sent.filter((m) => m.chat_id === "7" && m.text.includes("ciao dal webhook"))).toHaveLength(1);
	});

	it("a cell: no owner link on disk, the control plane asks for one; the cell tells when it may sleep and when to wake it", async () => {
		const dataDir = tempDataDir();
		const { annie, base } = await boot(dataDir, fakeTelegram(), { ANNIE_CELL_SECRET: "cell-secret-xyz-0001" });
		expect(annie.ownerLink).toBeUndefined();
		expect(existsSync(join(dataDir, "owner-login-link.txt"))).toBe(false);
		const { token: ownerToken } = (await (await fetch(`${base}/internal/owner-link`, { method: "POST", headers: { authorization: "Bearer cell-secret-xyz-0001" } })).json()) as { token: string };
		// Only through the control plane: without its header the cell knows nothing.
		expect((await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: ownerToken }) })).status).toBe(404);
		expect((await fetch(`${base}/`)).status).toBe(404);
		const api = await client(base, `${base}/login#${ownerToken}`, { "x-annie-proxy": proxyToken("cell-secret-xyz-0001") });
		expect((await api("/api/me")).person.role).toBe("owner");
		const state = (secret?: string) => fetch(`${base}/internal/cell`, { headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` } });
		expect((await state()).status).toBe(401);
		expect((await state("wrong")).status).toBe(401);
		expect(await (await state("cell-secret-xyz-0001")).json()).toEqual({ busy: false, nextWakeAt: null, usage: { day: romeDayKey(), todayUsd: 0, months: {} } });
		const thread = (await api("/api/instances/annie/threads", {})).thread;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		await api("/api/instances/annie/schedules", { instruction: "Promemoria", at, threadId: thread.id });
		expect(await (await state("cell-secret-xyz-0001")).json()).toEqual({ busy: false, nextWakeAt: at, usage: { day: romeDayKey(), todayUsd: 0, months: {} } });
	});

	it("a cell gives the control plane a fresh owner link on request; the old link stops working", async () => {
		const { base } = await boot(tempDataDir(), fakeTelegram(), { ANNIE_CELL_SECRET: "cell-secret-xyz-0001" });
		const ask = (secret: string) => fetch(`${base}/internal/owner-link`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
		expect((await ask("wrong-secret-000000")).status).toBe(401);
		const { token: ownerToken } = (await (await ask("cell-secret-xyz-0001")).json()) as { token: string };
		const { token } = (await (await ask("cell-secret-xyz-0001")).json()) as { token: string };
		expect(token).toMatch(/^[\w-]{40,}$/);
		const login = (t: string) => fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1", "x-annie-proxy": proxyToken("cell-secret-xyz-0001") }, body: JSON.stringify({ token: t }) });
		expect((await login(ownerToken)).status).toBe(401);
		expect((await login(token)).status).toBe(200);
	});

	it("without a cell secret there is no cell endpoint", async () => {
		const { base } = await boot(tempDataDir());
		expect((await fetch(`${base}/internal/cell`, { headers: { authorization: "Bearer x" } })).status).toBe(404);
	});

	it("the owner connects a Telegram bot to an instance from the console; it answers, survives a restart, and can be disconnected", async () => {
		const dataDir = tempDataDir();
		const telegram = fakeTelegram();
		const first = await boot(dataDir, telegram);
		const owner = await client(first.base, first.annie.ownerLink as string);
		await owner("/api/instances", { id: "vendite", name: "Vendite" });
		const put = (body: unknown) =>
			fetch(`${first.base}/api/instances/vendite/telegram`, { method: "PUT", headers: { "x-annie": "1", "content-type": "application/json", cookie: owner.cookie }, body: JSON.stringify(body) });
		expect((await put({ token: "bad", allowedUsers: ["8"] })).status).toBe(400);
		expect((await put({ token: "2:V", allowedUsers: ["8", "nope"] })).status).toBe(400);
		const connected = await put({ token: "2:V", allowedUsers: ["8"], approvers: ["8"] });
		expect(connected.status).toBe(200);
		const status = await owner("/api/instances/vendite/telegram");
		expect(status).toEqual({ telegram: { connected: true, username: "bot_2", mode: "polling", allowedUsers: ["8"], approvers: ["8"] } });
		expect(JSON.stringify(status)).not.toContain("2:V");
		telegram.queue("2:V").push([{ update_id: 1, message: { message_id: 4, chat: { id: 8 }, from: { id: 8 }, text: "ciao bot vendite" } }]);
		await waitFor(() => telegram.sent.some((m) => m.token === "2:V" && m.chat_id === "8" && m.text.includes("ciao bot vendite")));
		await first.annie.stop();
		running.splice(running.indexOf(first.annie), 1);

		const second = await boot(dataDir, telegram);
		const again = await client(second.base, first.annie.ownerLink as string);
		expect((await again("/api/instances/vendite/telegram")).telegram.connected).toBe(true);
		telegram.queue("2:V").push([{ update_id: 2, message: { message_id: 5, chat: { id: 8 }, from: { id: 8 }, text: "dopo il riavvio" } }]);
		await waitFor(() => telegram.sent.some((m) => m.token === "2:V" && m.text.includes("dopo il riavvio")));
		const off = await fetch(`${second.base}/api/instances/vendite/telegram`, { method: "DELETE", headers: { "x-annie": "1", cookie: again.cookie } });
		expect(off.status).toBe(200);
		expect((await again("/api/instances/vendite/telegram")).telegram.connected).toBe(false);
		const polls = telegram.calls.filter((c) => c.token === "2:V" && c.method === "getUpdates").length;
		await new Promise((r) => setTimeout(r, 200));
		expect(telegram.calls.filter((c) => c.token === "2:V" && c.method === "getUpdates").length).toBeLessThanOrEqual(polls + 1);
	});

	it("only the owner sees and changes an instance's Telegram bot", async () => {
		const { annie, base } = await boot(tempDataDir());
		const owner = await client(base, annie.ownerLink as string);
		const { link } = await owner("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		expect((await member("/api/instances/annie/telegram")).error).toBeDefined();
	});

	it("only the owner creates instances", async () => {
		const { annie, base } = await boot(tempDataDir());
		const owner = await client(base, annie.ownerLink as string);
		const { link } = await owner("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		expect((await member("/api/instances", { id: "mia", name: "Mia" })).error).toBeDefined();
		expect((await owner("/api/instances")).instances.map((i: { id: string }) => i.id)).toEqual(["annie"]);
	});
});
