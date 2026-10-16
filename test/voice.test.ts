import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startAnnie } from "../src/app.ts";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { WhatsAppAdapter, type WhatsAppWebhook } from "../src/channels/whatsapp.ts";
import { transcriber, voiceText } from "../src/channels/voice.ts";
import { ConfigError, loadAnnieConfig } from "../src/main/config.ts";
import { runChecks } from "../src/main/check.ts";
import { tempDataDir } from "./helpers.ts";

const KEY = "voice-key-0123456789";

/** A transcription service: the audio and the fields received, recorded; what it answers set per test. */
function fakeTranscriber(answer: () => Response = () => Response.json({ text: " Ciao, richiamami domani " })) {
	const received: { url: string; auth: string; model: string; name: string; type: string; size: number }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const form = init?.body as FormData;
		const file = form.get("file") as File;
		received.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), model: String(form.get("model")), name: file.name, type: file.type, size: file.size });
		return answer();
	}) as typeof fetch;
	return { received, fetch: fetchImpl };
}

const config = { url: "https://api.mistral.ai/v1/", apiKey: KEY, model: "voxtral-mini-latest", maxSeconds: 60 };

describe("voice messages", () => {
	it("sends the audio to the chosen service and passes the words on, marked as transcribed", async () => {
		const service = fakeTranscriber();
		const transcribe = transcriber(config, service.fetch);
		const text = await voiceText({ data: new Uint8Array([1, 2, 3]), name: "vocale.ogg", mimeType: "audio/ogg", seconds: 4 }, transcribe);
		expect(text).toBe("[Messaggio vocale, trascritto] Ciao, richiamami domani");
		expect(service.received).toEqual([{ url: "https://api.mistral.ai/v1/audio/transcriptions", auth: `Bearer ${KEY}`, model: "voxtral-mini-latest", name: "vocale.ogg", type: "audio/ogg", size: 3 }]);
	});

	it("too long is never sent; a failing service or none at all is said plainly, never as words; the key stays out of logs", async () => {
		// A service that echoes the key back in its error (Mistral's shape, message at the top).
		const service = fakeTranscriber(() => Response.json({ message: `Invalid key ${KEY}` }, { status: 401 }));
		const transcribe = transcriber(config, service.fetch);
		expect(await voiceText({ data: new Uint8Array(10), name: "v.ogg", mimeType: "audio/ogg", seconds: 61 }, transcribe)).toMatch(/troppo lungo/);
		expect(service.received).toHaveLength(0);
		const logs: string[] = [];
		expect(await voiceText({ data: new Uint8Array(10), name: "v.ogg", mimeType: "audio/ogg" }, transcribe, (m) => void logs.push(m))).toMatch(/non è riuscita/);
		expect(logs.join(" ")).toContain("401 Invalid key [chiave]");
		expect(logs.join(" ")).not.toContain(KEY);
		expect(await voiceText({ data: new Uint8Array(10), name: "v.ogg", mimeType: "audio/ogg" }, undefined)).toMatch(/trascrizione non è attiva/);
		const silent = transcriber(config, fakeTranscriber(() => Response.json({ text: "  " })).fetch);
		expect(await voiceText({ data: new Uint8Array(10), name: "v.ogg", mimeType: "audio/ogg" }, silent)).toMatch(/senza parole/);
	});

	it("Telegram: a voice from someone allowed is downloaded and transcribed; a stranger's is never fetched", async () => {
		const service = fakeTranscriber();
		const downloads: string[] = [];
		const telegramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const href = String(url);
			if (href.includes("/file/bot")) {
				downloads.push(href.split("/").at(-1) as string);
				return new Response(new Uint8Array([9, 9]));
			}
			const method = href.slice(href.lastIndexOf("/") + 1);
			if (method === "getFile") return Response.json({ ok: true, result: { file_path: `voice/${JSON.parse(String(init?.body)).file_id}.oga` } });
			return Response.json({ ok: true, result: true });
		}) as typeof fetch;
		const adapter = new TelegramAdapter({ token: "1:T", tenantId: "default", instanceId: "annie", fetch: telegramFetch, transcribe: transcriber(config, service.fetch), mayDownload: async (userId) => userId === "7" });
		adapter.onAction(async () => {});
		const inbound: InboundMessage[] = [];
		adapter.onInbound(async (m) => void inbound.push(m));
		await adapter.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, voice: { file_id: "v1", duration: 4, mime_type: "audio/ogg" } } });
		await adapter.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 8, type: "private" }, from: { id: 8 }, voice: { file_id: "v2", duration: 4 } } });
		// An audio file keeps its name; one too long is refused before downloading; one too big is said, not dropped.
		await adapter.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: 7, type: "private" }, from: { id: 7 }, audio: { file_id: "a1", duration: 30, mime_type: "audio/mpeg", file_name: "nota.mp3" } } });
		await adapter.handleUpdate({ update_id: 4, message: { message_id: 4, chat: { id: 7, type: "private" }, from: { id: 7 }, voice: { file_id: "long", duration: 61 } } });
		await adapter.handleUpdate({ update_id: 5, message: { message_id: 5, chat: { id: 7, type: "private" }, from: { id: 7 }, audio: { file_id: "huge", duration: 20, file_size: 30 * 1024 * 1024 } } });
		expect(inbound.map((m) => [m.userId, m.text])).toEqual([
			["7", "[Messaggio vocale, trascritto] Ciao, richiamami domani"],
			["8", "[Messaggio vocale]"],
			["7", "[Messaggio vocale, trascritto] Ciao, richiamami domani"],
			["7", "[Messaggio vocale troppo lungo da trascrivere. Chiedi di dividerlo o di scriverlo.]"],
			["7", "[Messaggio vocale troppo grande o non disponibile.]"],
		]);
		expect(downloads).toEqual(["v1.oga", "a1.oga"]);
		expect(service.received.map((r) => [r.name, r.type])).toEqual([
			["vocale.ogg", "audio/ogg"],
			["nota.mp3", "audio/mpeg"],
		]);
	});

	it("WhatsApp: a voice note from someone allowed is transcribed; a stranger's is never fetched", async () => {
		const service = fakeTranscriber();
		const graph: string[] = [];
		const graphFetch = (async (url: string | URL | Request) => {
			const href = String(url);
			graph.push(new URL(href).pathname);
			if (href.endsWith("/audio-1")) return Response.json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=audio-1", file_size: 2 });
			if (href.startsWith("https://lookaside.fbsbx.com/")) return new Response(new Uint8Array([7, 7]));
			return Response.json({ error: { message: "unknown", code: 100 } }, { status: 404 });
		}) as typeof fetch;
		const wa = new WhatsAppAdapter({ accessToken: "EAAGtoken0123456789abcdef", phoneNumberId: "111", appSecret: "a".repeat(32), verifyToken: "v", tenantId: "default", instanceId: "annie", apiBase: "https://graph.facebook.com/v26.0", fetch: graphFetch, transcribe: transcriber(config, service.fetch), mayDownload: async (n) => n === "393331234567" });
		const inbound: InboundMessage[] = [];
		wa.onInbound(async (m) => void inbound.push(m));
		const payload: unknown = {
			entry: [
				{
					changes: [
						{
							field: "messages",
							value: {
								metadata: { phone_number_id: "111" },
								messages: [
									{ from: "393331234567", id: "wamid.v1", type: "audio", audio: { id: "audio-1", mime_type: "audio/ogg; codecs=opus", voice: true } },
									{ from: "390000000000", id: "wamid.v2", type: "audio", audio: { id: "audio-2", mime_type: "audio/ogg", voice: true } },
								],
							},
						},
					],
				},
			],
		};
		await wa.handleWebhook(payload as WhatsAppWebhook);
		expect(inbound.map((m) => [m.userId, m.text])).toEqual([
			["393331234567", "[Messaggio vocale, trascritto] Ciao, richiamami domani"],
			["390000000000", "[Messaggio vocale]"],
		]);
		expect(service.received[0]?.type).toBe("audio/ogg");
		expect(graph.some((p) => p.endsWith("audio-2"))).toBe(false);
	});

	it("configuration: both or neither; Mistral's model by default; pnpm annie check asks the service", async () => {
		const base = { ANNIE_DATA_DIR: "/tmp/x", ANNIE_MODEL_PROVIDER: "faux" };
		expect(loadAnnieConfig(base).transcription).toBeUndefined();
		expect(() => loadAnnieConfig({ ...base, ANNIE_TRANSCRIBE_URL: "https://api.mistral.ai/v1" })).toThrow(ConfigError);
		expect(() => loadAnnieConfig({ ...base, ANNIE_TRANSCRIBE_URL: "http://example.com/v1", ANNIE_TRANSCRIBE_API_KEY: KEY })).toThrow(/https/);
		expect(() => loadAnnieConfig({ ...base, ANNIE_TRANSCRIBE_URL: "https://stt.example.com/v1", ANNIE_TRANSCRIBE_API_KEY: KEY })).toThrow(/ANNIE_TRANSCRIBE_MODEL/);
		const loaded = loadAnnieConfig({ ...base, ANNIE_TRANSCRIBE_URL: "https://api.mistral.ai/v1", ANNIE_TRANSCRIBE_API_KEY: KEY });
		expect(loaded.transcription).toEqual({ url: "https://api.mistral.ai/v1", apiKey: KEY, model: "voxtral-mini-latest", maxSeconds: 300 });
		const asked: string[] = [];
		const results = await runChecks(loaded, (async (url: string | URL | Request) => {
			asked.push(String(url));
			return Response.json({ data: [{ id: "voxtral-mini-latest" }] });
		}) as typeof fetch);
		expect(results.find((r) => r.name === "Trascrizione dei vocali")).toEqual({ name: "Trascrizione dei vocali", ok: true, detail: "chiave valida, modello voxtral-mini-latest" });
		expect(asked).toContain("https://api.mistral.ai/v1/models");
	});

	it("in an instance: off until the owner allows it, then on; the switch is audited", async () => {
		const graph = createServer((req, res) => {
			const path = req.url ?? "";
			res.writeHead(200, { "content-type": "application/json" });
			if (path.startsWith("/1110001?fields=")) return res.end(JSON.stringify({ display_phone_number: "+39 06 0000" }));
			if (path === "/audio-1") return res.end(JSON.stringify({ url: `http://127.0.0.1:${(graph.address() as AddressInfo).port}/files/audio-1` }));
			if (path === "/files/audio-1") return res.end("ogg");
			if (path === "/1110001/messages") {
				let raw = "";
				req.on("data", (c: Buffer) => (raw += c.toString()));
				return req.on("end", () => {
					replies.push(JSON.parse(raw).text?.body ?? "");
					res.end(JSON.stringify({ messages: [{ id: "x" }] }));
				});
			}
			res.end("{}");
		});
		const replies: string[] = [];
		await new Promise<void>((resolve) => graph.listen(0, "127.0.0.1", () => resolve()));
		const service = fakeTranscriber();
		const dataDir = tempDataDir();
		const loaded = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ANNIE_PUBLIC_URL: "https://annie.example.it", ANNIE_TRANSCRIBE_URL: "https://api.mistral.ai/v1", ANNIE_TRANSCRIBE_API_KEY: KEY });
		const annie = await startAnnie({ ...loaded, web: { ...loaded.web, port: 0 } }, { whatsappApiBase: `http://127.0.0.1:${(graph.address() as AddressInfo).port}`, transcribeFetch: service.fetch, schedulerIntervalMs: 60_000, log: () => {} });
		try {
			const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
			const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
			const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
			const api = async (path: string, body?: unknown, method = "PUT") => (await fetch(`${base}${path}`, { method: body === undefined ? "GET" : method, headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<any>;
			expect(await api("/api/voice")).toEqual({ available: true, host: "api.mistral.ai" });
			const connected = await api("/api/instances/annie/whatsapp", { accessToken: "EAAGtoken0123456789abcdef", phoneNumberId: "1110001", appSecret: "a".repeat(32), allowedUsers: ["393331234567"] });
			expect(connected.whatsapp?.connected, JSON.stringify(connected)).toBe(true);
			const voiceNote = (id: string) => {
				const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1110001" }, messages: [{ from: "393331234567", id, type: "audio", audio: { id: "audio-1", mime_type: "audio/ogg", voice: true } }] } }] }] });
				return fetch(`${base}/hooks/whatsapp/annie`, { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "a".repeat(32)).update(raw).digest("hex")}` }, body: raw });
			};
			const answered = async (n: number) => {
				for (const start = Date.now(); replies.length < n && Date.now() - start < 10_000; ) await new Promise((r) => setTimeout(r, 30));
				return replies.join(" ");
			};
			// Off by default: nothing goes to the service, Annie is told.
			expect((await voiceNote("wamid.1")).status).toBe(200);
			expect(await answered(1)).toContain("non è attiva per questa istanza");
			expect(service.received).toHaveLength(0);
			expect(await api("/api/instances/annie/voice", { allowed: true })).toEqual({ allowed: true });
			expect((await voiceNote("wamid.2")).status).toBe(200);
			expect(await answered(2)).toContain("Ciao, richiamami domani");
			expect(service.received).toHaveLength(1);
			expect(readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8")).toContain('"type":"voice.allowed"');
		} finally {
			await annie.stop();
			await new Promise((r) => graph.close(() => r(undefined)));
		}
	}, 30_000);
});
