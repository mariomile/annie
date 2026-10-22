import { describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { connectChannel } from "../src/gateway.ts";
import type { Skill } from "../src/core/skills.ts";
import { MODEL_COMMAND } from "../src/model-command.ts";
import { skillCommandName, skillMenu } from "../src/skill-commands.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

const TOKEN = "123456:TEST-TOKEN";
const AT = "2026-10-22T00:00:00.000Z";
const skill = (name: string, description = "Quando serve"): Skill => ({ name, description, body: "passi", createdBy: "web:1", createdAt: AT, updatedAt: AT });

describe("skill commands in the Telegram menu", () => {
	it("maps a skill name to a command: dashes become underscores", () => {
		expect(skillCommandName("chiusura-del-mese")).toBe("chiusura_del_mese");
		expect(skillCommandName("verbale")).toBe("verbale");
	});

	it("puts each skill after the commands that are already there, with its line", () => {
		const menu = skillMenu([skill("chiusura-del-mese", "Quando chiedono di chiudere il mese"), skill("verbale")], [MODEL_COMMAND]);
		expect(menu).toEqual([MODEL_COMMAND, { command: "chiusura_del_mese", description: "Quando chiedono di chiudere il mese" }, { command: "verbale", description: "Quando serve" }]);
	});

	it("leaves out, and logs, a name that cannot be a command", () => {
		const logs: string[] = [];
		// Names are lowercase a-z, 0-9 and dashes by construction; anything else (a stored file edited by hand) is skipped.
		const menu = skillMenu([skill("Chiusura mese"), skill("è-qui"), skill("a".repeat(33)), skill("buono")], [], (line) => logs.push(line));
		expect(menu).toEqual([{ command: "buono", description: "Quando serve" }]);
		expect(logs).toHaveLength(3);
		expect(logs[0]).toContain("not a valid Telegram command");
	});

	it("accepts a 32 character name, and cuts a long line to 256 characters", () => {
		const menu = skillMenu([skill("a".repeat(32), "x".repeat(1024))], []);
		expect(menu[0]?.command).toBe("a".repeat(32));
		expect(menu[0]?.description).toHaveLength(256);
		expect(menu[0]?.description.endsWith("…")).toBe(true);
	});

	it("leaves out a skill with no line", () => {
		const logs: string[] = [];
		expect(skillMenu([skill("vuota", "")], [], (line) => logs.push(line))).toEqual([]);
		expect(logs[0]).toContain("no description");
	});

	it("leaves out a command that is already in the menu, and one that repeats another", () => {
		const logs: string[] = [];
		const menu = skillMenu([skill("modello"), skill("uno"), skill("uno")], [MODEL_COMMAND], (line) => logs.push(line));
		expect(menu.map((c) => c.command)).toEqual(["modello", "uno"]);
		expect(menu[0]).toBe(MODEL_COMMAND);
		expect(logs).toHaveLength(2);
		expect(logs[0]).toContain("already in the menu");
	});

	it("stops at 100 commands, the base ones included", () => {
		const logs: string[] = [];
		const many = Array.from({ length: 120 }, (_, i) => skill(`s${i}`));
		const menu = skillMenu(many, [MODEL_COMMAND], (line) => logs.push(line));
		expect(menu).toHaveLength(100);
		expect(menu[99]?.command).toBe("s98");
		expect(logs).toHaveLength(21);
		expect(logs[0]).toContain("menu is full");
	});

	it("is what setMyCommands receives when the bot starts", async () => {
		const calls: { method: string; body: Record<string, unknown> }[] = [];
		const api = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			if (method === "getUpdates") await new Promise((resolve) => setTimeout(resolve, 10));
			return Response.json({ ok: true, result: method === "getUpdates" ? [] : true });
		}) as unknown as typeof fetch;
		const commands = skillMenu([skill("chiusura-del-mese", "Quando chiedono di chiudere il mese")], [MODEL_COMMAND]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api, retryDelayMs: 1, commands });
		await adapter.start();
		await adapter.stop();
		expect(calls[0]).toEqual({
			method: "setMyCommands",
			body: { commands: [MODEL_COMMAND, { command: "chiusura_del_mese", description: "Quando chiedono di chiudere il mese" }] },
		});
	});

	it("a tapped command reaches the agent as a request to use that skill", async () => {
		const { runtime } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["telegram"] } });
		runtime.skills("acme", "ops").save({ name: "Chiusura del mese", description: "Quando chiedono di chiudere il mese", body: "1. Fatture scadute\n2. Spese del mese", by: "web:1" }, () => true);
		const sentTexts: string[] = [];
		const updates = [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 7 }, text: "/chiusura_del_mese@AnnieBot ottobre" } }];
		const api = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			const body = JSON.parse(String(init?.body)) as { text?: string };
			if (method === "sendMessage") {
				sentTexts.push(body.text ?? "");
				return Response.json({ ok: true, result: { message_id: sentTexts.length } });
			}
			return Response.json({ ok: true, result: method === "getUpdates" ? updates.splice(0) : true });
		}) as unknown as typeof fetch;
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api });
		connectChannel(runtime, adapter, { tenantId: "acme", instanceId: "ops" });
		await adapter.pollOnce();
		await waitFor(() => sentTexts.length > 0);
		expect(sentTexts[0]).toContain("/chiusura_del_mese@AnnieBot ottobre");
		expect(sentTexts[0]).toContain("[Skill «chiusura-del-mese»]");
		expect(sentTexts[0]).toContain("2. Spese del mese");
		await runtime.close();
	});
});
