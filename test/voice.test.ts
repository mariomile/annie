import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { WhatsAppAdapter, type WhatsAppWebhook } from "../src/channels/whatsapp.ts";
import { transcriber, voiceText } from "../src/connectors/transcriber.ts";
import { ConfigError, loadAnnieConfig } from "../src/main/config.ts";
import { runChecks } from "../src/main/check.ts";

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
		const service = fakeTranscriber(() => Response.json({ error: { message: `Unauthorized: ${KEY}`.replace(KEY, "***") } }, { status: 401 }));
		const transcribe = transcriber(config, service.fetch);
		expect(await voiceText({ data: new Uint8Array(10), name: "v.ogg", mimeType: "audio/ogg", seconds: 61 }, transcribe)).toMatch(/troppo lungo/);
		expect(service.received).toHaveLength(0);
		const logs: string[] = [];
		expect(await voiceText({ data: new Uint8Array(10), name: "v.ogg", mimeType: "audio/ogg" }, transcribe, (m) => void logs.push(m))).toMatch(/non è riuscita/);
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
		const inbound: InboundMessage[] = [];
		adapter.onInbound(async (m) => void inbound.push(m));
		await adapter.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, voice: { file_id: "v1", duration: 4, mime_type: "audio/ogg" } } });
		await adapter.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 8, type: "private" }, from: { id: 8 }, voice: { file_id: "v2", duration: 4 } } });
		expect(inbound.map((m) => [m.userId, m.text])).toEqual([
			["7", "[Messaggio vocale, trascritto] Ciao, richiamami domani"],
			["8", "[Messaggio vocale]"],
		]);
		expect(downloads).toEqual(["v1.oga"]);
		expect(service.received).toHaveLength(1);
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
});
