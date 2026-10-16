import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir, waitFor } from "./helpers.ts";

const running: RunningAnnie[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

/** Fake Telegram: queued updates in, every sendMessage recorded. */
function fakeTelegram() {
	const updates: unknown[][] = [];
	const sent: { chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const method = String(url).slice(String(url).lastIndexOf("/") + 1);
		if (method === "getUpdates") {
			const batch = updates.shift();
			if (batch === undefined) await new Promise((r) => setTimeout(r, 20));
			return Response.json({ ok: true, result: batch ?? [] });
		}
		if (method === "sendMessage") sent.push(JSON.parse(String(init?.body)));
		return Response.json({ ok: true, result: { message_id: 1 } });
	}) as typeof fetch;
	return { updates, sent, fetch: fetchImpl };
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, 30));
	}
}

async function boot(dataDir: string, telegram = fakeTelegram()) {
	const config = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", TELEGRAM_BOT_TOKEN: "1:T", ANNIE_TELEGRAM_ALLOWED_USERS: "7", ANNIE_TELEGRAM_APPROVERS: "9" });
	const annie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { telegramFetch: telegram.fetch, schedulerIntervalMs: 60_000, log: () => {} });
	running.push(annie);
	const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
	return { annie, base, telegram };
}

async function client(base: string, link: string) {
	const token = link.split("#")[1] as string;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token }) });
	expect(login.status).toBe(200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	return async (path: string, body?: unknown) => {
		const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		// biome-ignore lint: test
		return (await res.json()) as any;
	};
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
		expect(settings.instructions).toBe("Rispondi sulle offerte.");
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

	it("only the owner creates instances", async () => {
		const { annie, base } = await boot(tempDataDir());
		const owner = await client(base, annie.ownerLink as string);
		const { link } = await owner("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		expect((await member("/api/instances", { id: "mia", name: "Mia" })).error).toBeDefined();
		expect((await owner("/api/instances")).instances.map((i: { id: string }) => i.id)).toEqual(["annie"]);
	});
});
