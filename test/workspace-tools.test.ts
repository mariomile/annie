import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { AnnieRuntime } from "../src/core/index.ts";
import { createWorkspaceTools } from "../src/core/tools/workspace-tools.ts";
import { connectChannel } from "../src/gateway.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

/** Fake Bot API that records text messages and documents. */
function fakeTelegram(updates: unknown[][] = []) {
	const texts: string[] = [];
	const documents: { chat: string; name: string; content: string; caption: string | null }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const method = String(url).slice(String(url).lastIndexOf("/") + 1);
		if (method === "sendDocument") {
			const form = init?.body as FormData;
			const file = form.get("document") as File;
			documents.push({ chat: String(form.get("chat_id")), name: file.name, content: await file.text(), caption: form.get("caption") as string | null });
			return Response.json({ ok: true, result: { message_id: 1 } });
		}
		if (String(url).includes("/file/bot")) return new Response("listino,prezzo\nA,10\n");
		if (method === "getFile") return Response.json({ ok: true, result: { file_path: "documents/file_1.csv" } });
		if (method === "sendMessage") texts.push(String(JSON.parse(String(init?.body)).text));
		return Response.json({ ok: true, result: method === "getUpdates" ? (updates.shift() ?? []) : { message_id: 1 } });
	}) as typeof fetch;
	return { texts, documents, fetch: fetchImpl };
}

describe("workspace tools (faux model, fake Telegram)", () => {
	it("the instance writes a file, lists it and sends it to the person as a document, once", async () => {
		const dataDir = tempDataDir();
		const runtime: AnnieRuntime = new AnnieRuntime({
			dataDir,
			engine: piDurableEngine,
			tools: async (record) => createWorkspaceTools({ workspace: runtime.workspace(record.tenantId, record.id), sendFile: (f) => runtime.sendFile(record.tenantId, record.id, f) }),
		});
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["telegram"] }, allowedUsers: { telegram: ["7"] } });
		const api = fakeTelegram();
		connectChannel(runtime, new TelegramAdapter({ token: "1:T", tenantId: "acme", instanceId: "ops", fetch: api.fetch }), { tenantId: "acme", instanceId: "ops" });
		const say = (text: string, id: string) => runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", userId: "7", text, messageId: id });

		await say('/tool file_write {"path":"report/ottobre.md","content":"# Ottobre\\nTutto ok."}', "1");
		await waitFor(() => api.texts.length === 1);
		expect(api.texts[0]).toBe("Fatto. Salvato report/ottobre.md (19 byte).");
		await say('/tool file_list {}', "2");
		await waitFor(() => api.texts.length === 2);
		expect(api.texts[1]).toMatch(/^Fatto\. report\/ottobre\.md\t19 byte\t/);
		await say('/tool file_send {"path":"report/ottobre.md","caption":"Il report"}', "3");
		await waitFor(() => api.texts.length === 3);
		expect(api.documents).toEqual([{ chat: "42", name: "ottobre.md", content: "# Ottobre\nTutto ok.", caption: "Il report" }]);
		expect(api.texts[2]).toBe("Fatto. Inviato report/ottobre.md.");
		await say('/tool file_read {"path":"../../secrets.json"}', "4");
		await waitFor(() => api.texts.length === 4);
		expect(api.texts[3]).toContain('Errore: Paths cannot go up with ".."');
		await runtime.close();
	});
});

describe("files people send on Telegram", () => {
	it("an allowed user's document lands in uploads/ and the instance is told where; a stranger's never touches the disk", async () => {
		const dataDir = tempDataDir();
		const runtime = new AnnieRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["telegram"] }, allowedUsers: { telegram: ["7"] } });
		const doc = (updateId: number, from: number, caption?: string) => ({
			update_id: updateId,
			message: { message_id: updateId, chat: { id: from }, from: { id: from }, ...(caption === undefined ? {} : { caption }), document: { file_id: "F", file_name: "listino ottobre.csv", file_size: 20 } },
		});
		const api = fakeTelegram([[doc(1, 7, "Ecco il listino"), doc(2, 66)]]);
		const bot = new TelegramAdapter({ token: "1:T", tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		connectChannel(runtime, bot, { tenantId: "acme", instanceId: "ops" });
		await bot.pollOnce();
		await waitFor(() => api.texts.length === 1);
		expect(api.texts[0]).toBe("Annie (modello locale di sviluppo): hai scritto «Ecco il listino\n\n[File caricato nel workspace: uploads/7_1-listino ottobre.csv]»");
		const files = await runtime.workspace("acme", "ops").list();
		expect(files.map((f) => f.path)).toEqual(["uploads/7_1-listino ottobre.csv"]);
		expect((await runtime.workspace("acme", "ops").read(files[0]!.path)).toString()).toBe("listino,prezzo\nA,10\n");
		await runtime.close();
	});
});
