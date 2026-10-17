import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { IMAGE_LIMITS, imageProblem, imageType } from "../src/core/images.ts";
import { AnnieRuntime } from "../src/core/index.ts";
import { createWorkspaceTools } from "../src/core/tools/workspace-tools.ts";
import { connectChannel } from "../src/gateway.ts";
import { FAUX_MODEL, JPEG, PNG, runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0x24, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);

describe("images: what counts as one", () => {
	it("is told by its bytes, not by its name, and must fit what the model takes", () => {
		expect([PNG, JPEG, GIF, WEBP].map(imageType)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
		expect(imageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
		expect(imageType(new TextEncoder().encode("%PDF-1.7"))).toBeUndefined();
		expect(imageType(new Uint8Array())).toBeUndefined();
		expect(imageProblem(PNG)).toBeUndefined();
		expect(imageProblem(new TextEncoder().encode("ciao"))).toContain("non è un'immagine");
		const big = new Uint8Array(IMAGE_LIMITS.maxBytes + 1);
		big.set(JPEG);
		expect(imageProblem(big)).toContain("più grande di 3,75 MB");
	});
});

describe("images reach the model", () => {
	it("with a person's message: the model sees them, up to four, and only real images", async () => {
		const { runtime, replies } = await runtimeWithInstance({});
		const say = (text: string, images: { path: string; data: Uint8Array }[], id: string) =>
			runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text, messageId: id, images });
		await say("Cosa vedi?", [{ path: "uploads/a.png", data: PNG }], "1");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "answered", text: "Annie (modello locale di sviluppo): hai scritto «Cosa vedi?» e mandato 1 immagine (image/png, 20 byte)" });
		const many = Array.from({ length: 6 }, (_, i) => ({ path: `uploads/${i}.jpg`, data: JPEG }));
		await say("Tante", [...many, { path: "uploads/finta.png", data: new TextEncoder().encode("non sono un png") }], "2");
		await waitFor(() => replies.length === 2);
		const text = (replies[1] as { text: string }).text;
		expect(text).toContain("mandato 4 immagini");
		// What was left out is said, so the model can tell the person.
		expect(text).toContain("[Immagini non mostrate: uploads/4.jpg, uploads/5.jpg (al massimo 4 per messaggio); uploads/finta.png (non è un'immagine JPEG, PNG, GIF o WebP)]");
		const events = await runtime.audit("acme").read();
		// The audit counts them; it never holds them.
		expect(events.filter((e) => e.type === "message.received").map((e) => e.images)).toEqual([1, 4]);
		expect(JSON.stringify(events)).not.toContain(Buffer.from(PNG).toString("base64"));
		await runtime.close();
	});

	it("from Telegram: a photo, in its largest size, lands in uploads/ and the model sees it; a stranger's is never downloaded", async () => {
		const dataDir = tempDataDir();
		const runtime = new AnnieRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["telegram"] }, allowedUsers: { telegram: ["7"] } });
		const texts: string[] = [];
		const asked: string[] = [];
		const photo = (updateId: number, from: number) => ({
			update_id: updateId,
			message: { message_id: updateId, chat: { id: from, type: "private" }, from: { id: from }, caption: "Che pianta è?", photo: [{ file_id: "small", file_size: 900, width: 90, height: 90 }, { file_id: "big", file_size: 20, width: 1280, height: 960 }] },
		});
		const updates = [[photo(1, 7), photo(2, 66)]];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			if (String(url).includes("/file/bot")) return new Response(PNG);
			if (method === "getFile") {
				asked.push(String(JSON.parse(String(init?.body)).file_id));
				return Response.json({ ok: true, result: { file_path: "photos/file_9.jpg" } });
			}
			if (method === "sendMessage") texts.push(String(JSON.parse(String(init?.body)).text));
			return Response.json({ ok: true, result: method === "getUpdates" ? (updates.shift() ?? []) : { message_id: 1 } });
		}) as typeof fetch;
		const bot = new TelegramAdapter({ token: "1:T", tenantId: "acme", instanceId: "ops", fetch: fetchImpl, mayDownload: async (id) => id === "7" });
		connectChannel(runtime, bot, { tenantId: "acme", instanceId: "ops" });
		await bot.pollOnce();
		await waitFor(() => texts.length === 1);
		expect(asked).toEqual(["big"]);
		expect(texts[0]).toBe("Annie (modello locale di sviluppo): hai scritto «Che pianta è?\n\n[Immagine nel workspace: uploads/7_1-foto.png]» e mandato 1 immagine (image/png, 20 byte)");
		expect((await runtime.workspace("acme", "ops").list()).map((f) => f.path)).toEqual(["uploads/7_1-foto.png"]);
		await runtime.close();
	});

	it("from the workspace: image_view shows the model a picture there, and refuses what is not one", async () => {
		const { runtime, replies } = await runtimeWithInstance({ toolsFor: (rt) => createWorkspaceTools({ workspace: rt.workspace("acme", "ops"), sendFile: async () => {} }) });
		await runtime.workspace("acme", "ops").write("grafici/vendite.png", PNG);
		await runtime.workspace("acme", "ops").write("note.txt", new TextEncoder().encode("ciao"));
		const say = (text: string, id: string) => runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text, messageId: id });
		await say('/tool image_view {"path":"grafici/vendite.png"}', "1");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ text: "Fatto. Ecco grafici/vendite.png (image/png, 20 byte). [1 immagine]" });
		await say('/tool image_view {"path":"note.txt"}', "2");
		await waitFor(() => replies.length === 2);
		expect(replies[1]).toMatchObject({ text: "Fatto. Errore: note.txt non è un'immagine JPEG, PNG, GIF o WebP." });
		await say('/tool image_view {"path":"../fuori.png"}', "3");
		await waitFor(() => replies.length === 3);
		expect((replies[2] as { text: string }).text).toContain("Errore:");
		await runtime.close();
	});
});
