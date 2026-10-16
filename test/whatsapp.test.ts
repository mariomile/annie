import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { WhatsAppAdapter, type WhatsAppWebhook } from "../src/channels/whatsapp.ts";
import { ChannelRefused, type InboundAction, type InboundMessage } from "../src/channels/types.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const PHONE_ID = "1098765432101";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "EAAGtesttoken0123456789abcdef";

/** Meta's Graph API as Annie uses it: every call recorded; a number told apart by its id. */
async function fakeGraph(options: { refuse?: { code: number; message: string } } = {}) {
	const calls: { method: string; path: string; auth: string; body: any }[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const path = req.url ?? "";
			const json = (req.headers["content-type"] ?? "").includes("json");
			calls.push({ method: req.method ?? "", path, auth: String(req.headers.authorization ?? ""), body: json ? JSON.parse(raw) : raw });
			const reply = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { message: "Invalid OAuth access token", code: 190 } });
			if (options.refuse !== undefined && path.endsWith("/messages")) return reply(400, { error: options.refuse });
			if (path.startsWith(`/${PHONE_ID}?fields=`)) return reply(200, { display_phone_number: "+39 06 1234 5678", verified_name: "Studio Rossi" });
			if (path === `/${PHONE_ID}/messages`) return reply(200, { messages: [{ id: `wamid.out${calls.length}` }] });
			if (path === `/${PHONE_ID}/media`) return reply(200, { id: "media-up-1" });
			if (path === "/media-in-1") return reply(200, { url: `${base}/files/media-in-1`, file_size: 5 });
			if (path === "/files/media-in-1") {
				res.writeHead(200, { "content-type": "application/pdf" });
				return res.end("%PDF-");
			}
			reply(404, { error: { message: "Unknown path", code: 100 } });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	closers.push(() => new Promise((r) => server.close(() => r())));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { calls, base, sent: () => calls.filter((c) => c.path === `/${PHONE_ID}/messages`).map((c) => c.body) };
}

/** A webhook delivery as Meta sends it, for our number. */
function delivery(messages: unknown[], phoneNumberId = PHONE_ID): WhatsAppWebhook {
	const payload: unknown = { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, messages } }] }] };
	return payload as WhatsAppWebhook;
}
const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

describe("WhatsApp adapter", () => {
	const adapterFor = (apiBase: string) => new WhatsAppAdapter({ accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "verify-me-123", tenantId: "default", instanceId: "annie", apiBase });

	it("answers Meta's check only with our token, and takes only deliveries Meta signed", () => {
		const wa = adapterFor("http://unused");
		expect(wa.verify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me-123", "hub.challenge": "1158201444" }))).toBe("1158201444");
		expect(wa.verify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }))).toBeUndefined();
		const raw = JSON.stringify(delivery([]));
		expect(wa.signed(Buffer.from(raw), sign(raw))).toBe(true);
		expect(wa.signed(Buffer.from(raw), sign(raw, "ffffffffffffffffffffffffffffffff"))).toBe(false);
		expect(wa.signed(Buffer.from(`${raw} `), sign(raw))).toBe(false);
		expect(wa.signed(Buffer.from(raw), undefined)).toBe(false);
	});

	it("passes on text, documents (downloaded) and button taps; skips other numbers and what it cannot read", async () => {
		const graph = await fakeGraph();
		const wa = adapterFor(graph.base);
		const inbound: InboundMessage[] = [];
		const taps: InboundAction[] = [];
		wa.onInbound(async (m) => void inbound.push(m));
		wa.onAction(async (a) => void taps.push(a));
		await wa.handleWebhook(
			delivery([
				{ from: "393331234567", id: "wamid.1", type: "text", text: { body: "Ciao Annie" } },
				{ from: "393331234567", id: "wamid.2", type: "document", document: { id: "media-in-1", filename: "preventivo.pdf", caption: "Guarda qui" } },
				{ from: "393331234567", id: "wamid.3", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "tool:0123456789ab:approved", title: "Approva" } } },
				{ from: "393331234567", id: "wamid.4", type: "sticker", sticker: { id: "x" } },
			]),
		);
		await wa.handleWebhook(delivery([{ from: "393331234567", id: "wamid.5", type: "text", text: { body: "altro numero" } }], "999"));
		expect(inbound.map((m) => [m.text, m.threadId, m.privateThread, m.messageId])).toEqual([
			["Ciao Annie", "393331234567", true, "wamid.1"],
			["Guarda qui", "393331234567", true, "wamid.2"],
		]);
		expect(inbound[1]?.attachments?.[0]?.name).toBe("preventivo.pdf");
		expect(Buffer.from(inbound[1]?.attachments?.[0]?.data ?? []).toString()).toBe("%PDF-");
		expect(taps).toEqual([expect.objectContaining({ channel: "whatsapp", userId: "393331234567", data: "tool:0123456789ab:approved", actionId: "wamid.3" })]);
		// The media download carries the token; nothing else leaves.
		expect(graph.calls.find((c) => c.path === "/files/media-in-1")?.auth).toBe(`Bearer ${TOKEN}`);
	});

	it("sends long text in pieces, buttons under the last 1024 characters, files as documents", async () => {
		const graph = await fakeGraph();
		const wa = adapterFor(graph.base);
		const base = { tenantId: "default", instanceId: "annie", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k" };
		await wa.send({ ...base, text: "x".repeat(5000) });
		expect(graph.sent().map((b) => [b.type, b.text.body.length, b.to])).toEqual([
			["text", 4096, "393331234567"],
			["text", 904, "393331234567"],
		]);
		await wa.send({ ...base, text: `${"a".repeat(1500)}${"b".repeat(1024)}`, buttons: [{ label: "Approva", data: "tool:0123456789ab:approved" }] });
		const [plain, card] = graph.sent().slice(2);
		expect(plain.text.body).toBe("a".repeat(1500));
		expect(card.interactive.body.text).toBe("b".repeat(1024));
		expect(card.interactive.action.buttons).toEqual([{ type: "reply", reply: { id: "tool:0123456789ab:approved", title: "Approva" } }]);
		await wa.sendFile({ ...base, name: "report.pdf", data: new Uint8Array([1, 2, 3]), caption: "Ecco" });
		expect(graph.sent().at(-1)).toMatchObject({ type: "document", document: { id: "media-up-1", filename: "report.pdf", caption: "Ecco" } });
		expect(graph.calls.some((c) => c.path === `/${PHONE_ID}/media` && c.method === "POST")).toBe(true);
	});

	it("outside the 24-hour window Meta's refusal says so, final; errors never carry the token", async () => {
		const graph = await fakeGraph({ refuse: { code: 131047, message: "Re-engagement message" } });
		const wa = adapterFor(graph.base);
		const error = await wa.send({ tenantId: "default", instanceId: "annie", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k", text: "Promemoria" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ChannelRefused);
		expect((error as ChannelRefused).retryable).toBe(false);
		expect((error as Error).message).toContain("24 ore");
		const wrong = new WhatsAppAdapter({ accessToken: "EAAGwrongtoken0123456789", phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "v", tenantId: "default", instanceId: "annie", apiBase: graph.base });
		const refused = await wrong.me().catch((e: Error) => e);
		expect((refused as Error).message).not.toContain("EAAG");
	});
});

describe("WhatsApp in an instance", () => {
	async function boot(apiBase: string) {
		const dataDir = tempDataDir();
		const config = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ANNIE_PUBLIC_URL: "https://annie.example.it" });
		const annie: RunningAnnie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { whatsappApiBase: apiBase, schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => annie.stop());
		const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown, method?: string) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, ...((await res.json()) as any) };
		};
		const hook = (body: unknown, signature?: string) => {
			const raw = JSON.stringify(body);
			return fetch(`${base}/hooks/whatsapp/annie`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw) }, body: raw });
		};
		return { annie, api, hook, base, dataDir };
	}

	it("the owner connects a number from the console; allowed people get answers, strangers silence, forged deliveries nothing", async () => {
		const graph = await fakeGraph();
		const { api, hook, base } = await boot(graph.base);
		expect((await api("/api/instances/annie/whatsapp")).whatsapp).toMatchObject({ connected: false, webhookUrl: "https://annie.example.it/hooks/whatsapp/annie" });
		// The first time needs all three values; Meta checks token and number id.
		expect((await api("/api/instances/annie/whatsapp", { accessToken: TOKEN }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/annie/whatsapp", { accessToken: "EAAGwrongtoken0123456789", phoneNumberId: PHONE_ID, appSecret: APP_SECRET }, "PUT")).status).toBe(400);
		const connected = await api("/api/instances/annie/whatsapp", { accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, allowedUsers: ["393331234567"] }, "PUT");
		expect(connected.whatsapp).toMatchObject({ connected: true, number: "+39 06 1234 5678", allowedUsers: ["393331234567"], verifyToken: expect.stringMatching(/^[\w-]{20,}$/) });
		// Token and app secret never come back.
		expect(JSON.stringify(connected)).not.toContain(TOKEN);
		expect(JSON.stringify(connected)).not.toContain(APP_SECRET);
		// Meta's check of the address.
		const challenge = await fetch(`${base}/hooks/whatsapp/annie?hub.mode=subscribe&hub.verify_token=${connected.whatsapp.verifyToken}&hub.challenge=42`);
		expect([challenge.status, await challenge.text()]).toEqual([200, "42"]);
		expect((await fetch(`${base}/hooks/whatsapp/annie?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42`)).status).toBe(403);
		// A forged delivery is refused; a stranger gets no answer; an allowed person does.
		expect((await hook(delivery([{ from: "393331234567", id: "wamid.f", type: "text", text: { body: "falso" } }]), sign("{}"))).status).toBe(401);
		expect((await hook(delivery([{ from: "390000000000", id: "wamid.s", type: "text", text: { body: "sono un estraneo" } }]))).status).toBe(200);
		expect((await hook(delivery([{ from: "393331234567", id: "wamid.a", type: "text", text: { body: "ciao da WhatsApp" } }]))).status).toBe(200);
		for (const start = Date.now(); !graph.sent().some((b) => b.to === "393331234567") && Date.now() - start < 10_000; ) await new Promise((r) => setTimeout(r, 30));
		expect(graph.sent().filter((b) => b.to === "393331234567").map((b) => b.text.body).join(" ")).toContain("ciao da WhatsApp");
		expect(graph.sent().some((b) => b.to === "390000000000")).toBe(false);
		// The same delivery again (Meta retries) does not answer twice.
		const answers = graph.sent().length;
		await hook(delivery([{ from: "393331234567", id: "wamid.a", type: "text", text: { body: "ciao da WhatsApp" } }]));
		await new Promise((r) => setTimeout(r, 300));
		expect(graph.sent()).toHaveLength(answers);
		// Disconnected: the address answers nothing.
		expect((await api("/api/instances/annie/whatsapp", undefined, "DELETE")).status).toBe(200);
		expect((await hook(delivery([]))).status).toBe(404);
	}, 30_000);
});
