/**
 * Child process for test/outbox.test.ts: Annie with a Telegram bot whose Bot API is a fake
 * fetch. Every sendMessage that "reaches Telegram" is appended to callsFile, so the parent
 * can count them across processes.
 *
 *   outbox-worker.ts start  <dataDir> <callsFile> <send>   create the instance, submit one message
 *   outbox-worker.ts resume <dataDir> <callsFile> <send>   reopen, resume, exit once the outbox is empty
 *
 * <send>: "ok"          Telegram accepts the message
 *         "hang-before" print SENDING and hang before the request reaches Telegram
 *         "hang-after"  Telegram receives the message, print SENT, the answer never comes back
 *
 * stdout: SENDING, SENT, RESUMED <json>, DELIVERED.
 */
import { appendFileSync } from "node:fs";
import { TelegramAdapter } from "../../src/channels/telegram.ts";
import { piDurableEngine } from "../../src/core/adapters/pi-durable.ts";
import { AnnieRuntime } from "../../src/core/index.ts";
import { connectChannel } from "../../src/gateway.ts";

const [mode, dataDir, callsFile, send] = process.argv.slice(2) as [string, string, string, string];

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
	const method = String(url).slice(String(url).lastIndexOf("/") + 1);
	if (method !== "sendMessage") return Response.json({ ok: true, result: [] });
	if (send === "hang-before") {
		console.log("SENDING");
		return new Promise<never>(() => {});
	}
	appendFileSync(callsFile, `${JSON.stringify({ pid: process.pid, method, body: JSON.parse(String(init?.body)) })}\n`);
	if (send === "hang-after") {
		console.log("SENT");
		return new Promise<never>(() => {});
	}
	return Response.json({ ok: true, result: { message_id: 1 } });
}) as typeof fetch;

const runtime = new AnnieRuntime({ dataDir, engine: piDurableEngine });
const adapter = new TelegramAdapter({ token: "123:TEST", tenantId: "acme", instanceId: "ops", fetch: fakeFetch });
connectChannel(runtime, adapter, { tenantId: "acme", instanceId: "ops" });

if (mode === "start") {
	await runtime.registry.createTenant({ id: "acme", name: "Acme" });
	await runtime.registry.createInstance("acme", {
		id: "ops",
		name: "Ops",
		model: { provider: "faux", modelId: "annie-dev" },
		egress: { modelProviders: ["faux"], channels: ["telegram"] },
		allowedUsers: { telegram: ["7"] },
	});
	await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", userId: "7", text: "ciao", messageId: "42:1" });
} else {
	console.log(`RESUMED ${JSON.stringify(await runtime.resume("acme", "ops"))}`);
	const instance = await runtime.openInstance("acme", "ops");
	while ((await instance.undelivered()).length > 0) await new Promise((resolve) => setTimeout(resolve, 20));
	console.log("DELIVERED");
	await runtime.close();
	process.exit(0);
}
setInterval(() => {}, 1000);
