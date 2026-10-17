import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { SpeechRefused, speakable, speaker, VoiceThreads } from "../src/channels/speech.ts";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { WhatsAppAdapter } from "../src/channels/whatsapp.ts";
import { ConfigError, loadAnnieConfig } from "../src/main/config.ts";
import { runChecks } from "../src/main/check.ts";
import { tempDataDir } from "./helpers.ts";

const KEY = "speech-key-0123456789";
/** The first bytes of an OGG file, and a little more: what a speech service answers. */
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 1, 2, 3]);

/** A speech service: what it was asked, recorded; what it answers set per test. */
function fakeSpeech(answer: () => Response = () => new Response(OGG, { headers: { "content-type": "audio/ogg" } })) {
	const asked: { url: string; auth: string; body: { model: string; input: string; voice: string; response_format: string } }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		asked.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) });
		return answer();
	}) as typeof fetch;
	return { asked, fetch: fetchImpl };
}

const config = { url: "https://api.openai.com/v1", apiKey: KEY, model: "gpt-4o-mini-tts", voice: "nova", maxChars: 200 };

describe("replies as voice notes", () => {
	it("asks the service for Opus with the spoken text, and returns the audio", async () => {
		const service = fakeSpeech();
		const audio = await speaker(config, service.fetch)("**Ciao!** Ecco il [sito](https://comune.roma.it) e https://x.it/a?b=1");
		expect(audio).toEqual(OGG);
		expect(service.asked).toEqual([{ url: "https://api.openai.com/v1/audio/speech", auth: `Bearer ${KEY}`, body: { model: "gpt-4o-mini-tts", input: "Ciao! Ecco il sito e link", voice: "nova", response_format: "opus" } }]);
	});

	it("refuses what would not play or should not be read, and never puts the key in an error", async () => {
		await expect(speaker(config, fakeSpeech().fetch)("x".repeat(201))).rejects.toBeInstanceOf(SpeechRefused);
		await expect(speaker(config, fakeSpeech().fetch)("```\ncodice\n```")).rejects.toBeInstanceOf(SpeechRefused);
		await expect(speaker(config, fakeSpeech(() => new Response("<html>")).fetch)("Ciao")).rejects.toThrow(/not OGG/);
		await expect(speaker(config, fakeSpeech(() => new Response(new Uint8Array())).fetch)("Ciao")).rejects.toThrow(/no usable audio/);
		const error = await speaker(config, fakeSpeech(() => Response.json({ error: { message: `Incorrect API key ${KEY}` } }, { status: 401 })).fetch)("Ciao").catch((e: Error) => e);
		expect(String(error)).toMatch(/401/);
		expect(String(error)).not.toContain(KEY);
	});

	it("reads lists, headings and quotes as plain sentences", () => {
		expect(speakable("# Orari\n\n- Lunedì: 9-13\n- Martedì: _chiuso_\n> nota\n1. primo\n`codice`")).toBe("Orari\nLunedì: 9-13\nMartedì: chiuso\nnota\nprimo\ncodice");
		expect(speakable("Prezzo: 5 * 3 = 15")).toBe("Prezzo: 5 * 3 = 15");
	});

	it("a voice note asks for a spoken reply for a while; a written message after it does not", () => {
		let now = 0;
		const threads = new VoiceThreads(1000, () => now);
		threads.heard("7", true);
		expect(threads.wantsVoice("7")).toBe(true);
		now = 1001;
		expect(threads.wantsVoice("7")).toBe(false);
		threads.heard("7", true);
		threads.heard("7", false);
		expect(threads.wantsVoice("7")).toBe(false);
	});

	it("Telegram: the voice note with the text as caption; a long text follows as a message", async () => {
		const calls: { method: string; caption?: string; text?: string; type?: string }[] = [];
		const telegramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			if (init?.body instanceof FormData) {
				const voice = init.body.get("voice") as File;
				calls.push({ method, caption: (init.body.get("caption") as string | null) ?? undefined, type: voice.type });
			} else calls.push({ method, text: JSON.parse(String(init?.body)).text });
			return Response.json({ ok: true, result: { message_id: 1 } });
		}) as typeof fetch;
		const adapter = new TelegramAdapter({ token: "1:T", tenantId: "default", instanceId: "annie", fetch: telegramFetch });
		const base = { tenantId: "default", instanceId: "annie", channel: "telegram", threadId: "7", idempotencyKey: "k", audio: OGG };
		await adapter.sendVoice({ ...base, text: "Ciao" });
		await adapter.sendVoice({ ...base, text: "a".repeat(1100) });
		expect(calls).toEqual([
			{ method: "sendVoice", caption: "Ciao", type: "audio/ogg" },
			{ method: "sendVoice", type: "audio/ogg" },
			{ method: "sendMessage", text: "a".repeat(1100) },
		]);
	});

	it("WhatsApp: the audio, then the text; outside the 24-hour window only the text, kept for later", async () => {
		const calls: string[] = [];
		const whatsappFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (init?.body instanceof FormData) {
				calls.push(`upload ${(init.body.get("file") as File).type}`);
				return Response.json({ id: "media-1" });
			}
			const body = JSON.parse(String(init?.body));
			calls.push(`${path} ${body.type} ${body.type === "audio" ? body.audio.id : body.text.body}`);
			return Response.json({ messages: [{ id: "x" }] });
		}) as typeof fetch;
		let last = Date.now();
		const parked: string[] = [];
		const adapter = new WhatsAppAdapter({
			accessToken: "EAAGtoken",
			phoneNumberId: "1110001",
			appSecret: "a".repeat(32),
			verifyToken: "v",
			tenantId: "default",
			instanceId: "annie",
			fetch: whatsappFetch,
			apiBase: "https://graph.example",
			window: { lastInbound: async () => last, seen: async () => {}, park: async (_n, m) => (parked.push(m.text), { notify: false, dropped: 0 }), waiting: async () => [], delivered: async () => {}, failed: async () => {} },
		});
		const base = { tenantId: "default", instanceId: "annie", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k", audio: OGG };
		await adapter.sendVoice({ ...base, text: "Ciao" });
		expect(calls).toEqual(["upload audio/ogg", "/1110001/messages audio media-1", "/1110001/messages text Ciao"]);
		calls.length = 0;
		last = Date.now() - 25 * 3600_000;
		await adapter.sendVoice({ ...base, text: "Più tardi" });
		expect(calls).toEqual([]);
		expect(parked).toEqual(["Più tardi"]);
	});

	it("configuration: both or neither; OpenAI's model and voice by default; pnpm annie check asks the service", async () => {
		const base = { ANNIE_DATA_DIR: "/tmp/x", ANNIE_MODEL_PROVIDER: "faux" };
		expect(loadAnnieConfig(base).speech).toBeUndefined();
		expect(() => loadAnnieConfig({ ...base, ANNIE_SPEECH_URL: "https://api.openai.com/v1" })).toThrow(ConfigError);
		expect(() => loadAnnieConfig({ ...base, ANNIE_SPEECH_URL: "http://example.com/v1", ANNIE_SPEECH_API_KEY: KEY })).toThrow(/https/);
		expect(() => loadAnnieConfig({ ...base, ANNIE_SPEECH_URL: "https://tts.example.com/v1", ANNIE_SPEECH_API_KEY: KEY })).toThrow(/ANNIE_SPEECH_MODEL/);
		expect(() => loadAnnieConfig({ ...base, ANNIE_SPEECH_URL: "https://tts.example.com/v1", ANNIE_SPEECH_API_KEY: KEY, ANNIE_SPEECH_MODEL: "kokoro" })).toThrow(/ANNIE_SPEECH_VOICE/);
		expect(() => loadAnnieConfig({ ...base, ANNIE_SPEECH_URL: "https://api.openai.com/v1", ANNIE_SPEECH_API_KEY: KEY, ANNIE_SPEECH_MAX_CHARS: "5" })).toThrow(/MAX_CHARS/);
		const loaded = loadAnnieConfig({ ...base, ANNIE_SPEECH_URL: "https://api.openai.com/v1/", ANNIE_SPEECH_API_KEY: KEY });
		expect(loaded.speech).toEqual({ url: "https://api.openai.com/v1", apiKey: KEY, model: "gpt-4o-mini-tts", voice: "nova", maxChars: 1500 });
		const asked: string[] = [];
		const results = await runChecks(loaded, (async (url: string | URL | Request) => {
			asked.push(String(url));
			return Response.json({ data: [] });
		}) as typeof fetch);
		expect(results.find((r) => r.name === "Risposte a voce")).toEqual({ name: "Risposte a voce", ok: true, detail: "chiave valida, modello gpt-4o-mini-tts, voce nova" });
		expect(asked).toContain("https://api.openai.com/v1/models");
	});
});

describe("in an instance", () => {
	const running: RunningAnnie[] = [];
	afterEach(async () => {
		for (const a of running.splice(0)) await a.stop();
	});

	it("off until the owner allows it; then a voice note gets a voice note back, a written message gets text; a failure leaves the text", async () => {
		const updates: unknown[][] = [];
		const sent: { method: string; text?: string; caption?: string }[] = [];
		const telegramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const href = String(url);
			if (href.includes("/file/bot")) return new Response(new Uint8Array([9, 9]));
			const method = href.slice(href.lastIndexOf("/") + 1);
			if (method === "getMe") return Response.json({ ok: true, result: { username: "annie_bot" } });
			if (method === "getUpdates") {
				const batch = updates.shift();
				if (batch === undefined) await new Promise((r) => setTimeout(r, 20));
				return Response.json({ ok: true, result: batch ?? [] });
			}
			if (method === "getFile") return Response.json({ ok: true, result: { file_path: "voice/v.oga" } });
			if (init?.body instanceof FormData) sent.push({ method, caption: (init.body.get("caption") as string | null) ?? undefined });
			else if (method === "sendMessage") sent.push({ method, text: JSON.parse(String(init?.body)).text });
			return Response.json({ ok: true, result: { message_id: 1 } });
		}) as typeof fetch;
		let failing = false;
		const speech = fakeSpeech(() => (failing ? Response.json({ error: "busy" }, { status: 503 }) : new Response(OGG)));
		const transcribeFetch = (async () => Response.json({ text: "che ore sono" })) as typeof fetch;
		const dataDir = tempDataDir();
		const loaded = loadAnnieConfig({
			ANNIE_DATA_DIR: dataDir,
			ANNIE_MODEL_PROVIDER: "faux",
			ANNIE_WEB_PORT: "1",
			TELEGRAM_BOT_TOKEN: "1:T",
			ANNIE_TELEGRAM_ALLOWED_USERS: "7",
			ANNIE_TRANSCRIBE_URL: "https://api.mistral.ai/v1",
			ANNIE_TRANSCRIBE_API_KEY: "transcribe-key-0123456789",
			ANNIE_SPEECH_URL: "https://api.openai.com/v1",
			ANNIE_SPEECH_API_KEY: KEY,
		});
		const annie = await startAnnie({ ...loaded, web: { ...loaded.web, port: 0 } }, { telegramFetch, transcribeFetch, speechFetch: speech.fetch, schedulerIntervalMs: 60_000, log: () => {} });
		running.push(annie);
		const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		// biome-ignore lint: test
		const api = async (path: string, body?: unknown): Promise<any> => (await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "PUT", headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
		expect(await api("/api/speech")).toEqual({ available: true, host: "api.openai.com", voice: "nova" });
		expect(await api("/api/instances/annie/voice", { allowed: true })).toEqual({ allowed: true });
		let id = 0;
		const voiceNote = () => updates.push([{ update_id: ++id, message: { message_id: id, chat: { id: 7, type: "private" }, from: { id: 7 }, voice: { file_id: `v${id}`, duration: 3, mime_type: "audio/ogg" } } }]);
		const written = (text: string) => updates.push([{ update_id: ++id, message: { message_id: id, chat: { id: 7, type: "private" }, from: { id: 7 }, text } }]);
		const replies = async (n: number) => {
			for (const start = Date.now(); sent.length < n && Date.now() - start < 10_000; ) await new Promise((r) => setTimeout(r, 30));
			return sent.splice(0);
		};
		// Off: a voice note gets text, and nothing goes to the speech service.
		voiceNote();
		expect((await replies(1)).map((s) => s.method)).toEqual(["sendMessage"]);
		expect(speech.asked).toHaveLength(0);
		expect(await api("/api/instances/annie/speech", { allowed: true })).toEqual({ allowed: true });
		voiceNote();
		const spoken = await replies(1);
		expect(spoken).toEqual([{ method: "sendVoice", caption: expect.stringContaining("che ore sono") }]);
		expect(speech.asked).toHaveLength(1);
		expect(speech.asked[0]?.body.input).toContain("che ore sono");
		written("Grazie");
		expect((await replies(1)).map((s) => s.method)).toEqual(["sendMessage"]);
		failing = true;
		voiceNote();
		expect(await replies(1)).toEqual([{ method: "sendMessage", text: expect.stringContaining("che ore sono") }]);
		expect(readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8")).toContain('"type":"speech.allowed"');
	}, 30_000);
});
