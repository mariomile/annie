import { describe, expect, it, vi } from "vitest";
import { splitText, TELEGRAM_MAX_TEXT, TelegramAdapter } from "../src/channels/telegram.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { connectChannel } from "../src/gateway.ts";
import { ConfigError, loadTelegramConfig } from "../src/main/config.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

const TOKEN = "123456:TEST-TOKEN";

type Call = { method: string; body: Record<string, unknown> };

/** A fake Telegram Bot API: queued getUpdates batches, recorded calls. Never touches the network. */
function fakeTelegram(batches: unknown[][]) {
	const calls: Call[] = [];
	const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		expect(href.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
		const method = href.slice(href.lastIndexOf("/") + 1);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		calls.push({ method, body });
		if (method === "getUpdates") {
			const batch = batches.shift();
			// Like real long polling: with nothing to deliver, the request waits before answering.
			if (batch === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
			init?.signal?.throwIfAborted();
			return Response.json({ ok: true, result: batch ?? [] });
		}
		if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: calls.length } });
		return Response.json({ ok: false, error_code: 404, description: "Not Found" });
	});
	return { calls, fetch: fetchMock as unknown as typeof fetch };
}

function textUpdate(updateId: number, chatId: number, messageId: number, text: string) {
	return { update_id: updateId, message: { message_id: messageId, chat: { id: chatId }, from: { id: 7 }, text } };
}

describe("Telegram adapter (mocked fetch)", () => {
	it("normalizes updates into InboundMessage and advances the offset", async () => {
		const api = fakeTelegram([[textUpdate(10, 42, 1, "ciao"), { update_id: 11 }], []]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		const inbound: InboundMessage[] = [];
		adapter.onInbound(async (message) => {
			inbound.push(message);
		});

		expect(await adapter.pollOnce()).toBe(2);
		await adapter.pollOnce();

		expect(inbound).toEqual([
			{ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", userId: "7", text: "ciao", messageId: "42:1" },
		]);
		expect(api.calls[0]).toMatchObject({ method: "getUpdates", body: { allowed_updates: ["message"] } });
		expect(api.calls[0]?.body.offset).toBeUndefined();
		expect(api.calls[1]?.body.offset).toBe(12);
	});

	it("sends replies with sendMessage, split at Telegram's length limit", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		await adapter.send({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", text: "x".repeat(TELEGRAM_MAX_TEXT + 1) });
		expect(api.calls.map((c) => [c.method, c.body.chat_id, String(c.body.text).length])).toEqual([
			["sendMessage", "42", TELEGRAM_MAX_TEXT],
			["sendMessage", "42", 1],
		]);
		expect(splitText("")).toEqual(["(risposta vuota)"]);
	});

	it("reports API errors without leaking the bot token", async () => {
		const fetchMock = vi.fn(async () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 }));
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: fetchMock as unknown as typeof fetch });
		const error = await adapter.pollOnce().catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Telegram getUpdates failed: 401 Unauthorized");
		expect((error as Error).message).not.toContain(TOKEN);
	});

	it("start/stop runs the long-polling loop until stopped", async () => {
		const api = fakeTelegram([[textUpdate(1, 42, 1, "uno")]]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch, retryDelayMs: 1 });
		const inbound: InboundMessage[] = [];
		adapter.onInbound(async (message) => {
			inbound.push(message);
		});
		await adapter.start();
		await waitFor(() => inbound.length === 1 && api.calls.length >= 2);
		await adapter.stop();
		const callsAfterStop = api.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(api.calls.length).toBe(callsAfterStop);
	});

	it("end to end: a Telegram message reaches the core and the reply goes back to the same chat, once", async () => {
		const { runtime } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["telegram"] } });
		// The same message delivered twice (as Telegram does after a crash before the offset is confirmed).
		const api = fakeTelegram([[textUpdate(1, 42, 5, "ciao annie")], [textUpdate(1, 42, 5, "ciao annie")]]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		connectChannel(runtime, adapter);

		await adapter.pollOnce();
		await waitFor(() => api.calls.some((c) => c.method === "sendMessage"));
		await adapter.pollOnce();
		await (await runtime.openInstance("acme", "ops")).idle();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const sent = api.calls.filter((c) => c.method === "sendMessage");
		expect(sent).toEqual([{ method: "sendMessage", body: { chat_id: "42", text: "Annie (modello locale di sviluppo): hai scritto «ciao annie»" } }]);
		await runtime.close();
	});
});

describe("dev:telegram configuration", () => {
	it("names every missing variable exactly", () => {
		expect(() => loadTelegramConfig({})).toThrow(new ConfigError("Missing environment variables: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY. Set them in .env (see .env.example)."));
		expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t" })).toThrow("Missing environment variable: ANTHROPIC_API_KEY.");
		expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t", ANNIE_MODEL_PROVIDER: "openai" })).toThrow("Missing environment variable: OPENAI_API_KEY.");
		expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: " ", ANTHROPIC_API_KEY: "k" })).toThrow("Missing environment variable: TELEGRAM_BOT_TOKEN.");
	});

	it("defaults to Anthropic Claude Sonnet 5.5 and needs no key for the local model", () => {
		expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toMatchObject({
			modelProvider: "anthropic",
			modelId: "claude-sonnet-5-5",
			modelApiKey: "k",
			dataDir: "data",
			tenantId: "default",
			instanceId: "telegram",
		});
		expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t", ANNIE_MODEL_PROVIDER: "faux" })).toMatchObject({ modelProvider: "faux", modelId: "annie-dev", modelApiKey: undefined });
	});
});
