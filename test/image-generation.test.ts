import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { WhatsAppAdapter } from "../src/channels/whatsapp.ts";
import { ImageGenerationError, imageGenerator } from "../src/core/image-generation.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { JPEG, PNG, tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const KEY = "sk-image-test-key";

type Asked = { path: string; auth: string | undefined; json?: Record<string, unknown>; form?: { model: string; prompt: string; size: string; image: { name: string; type: string; size: number } } };

/** A stand-in for OpenAI's image API: what it was asked, and what it answers. */
async function fakeImages(answer: (asked: Asked) => { status?: number; body: unknown } = () => ({ body: { data: [{ b64_json: Buffer.from(PNG).toString("base64") }] } })) {
	const asked: Asked[] = [];
	const server: Server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks);
		const type = req.headers["content-type"] ?? "";
		const entry: Asked = { path: req.url ?? "", auth: req.headers.authorization };
		if (type.startsWith("multipart/form-data")) {
			const form = await new Response(raw, { headers: { "content-type": type } }).formData();
			const image = form.get("image") as File;
			entry.form = { model: String(form.get("model")), prompt: String(form.get("prompt")), size: String(form.get("size")), image: { name: image.name, type: image.type, size: image.size } };
		} else entry.json = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
		asked.push(entry);
		const { status, body } = answer(entry);
		res.writeHead(status ?? 200, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	closers.push(() => new Promise((r) => server.close(() => r())));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, asked };
}

const config = (url: string, model = "gpt-image-1") => ({ url, apiKey: KEY, model, maxPerDay: 10 });

describe("image generation service", () => {
	it("asks for one image of the chosen shape with the key in a header, and gives back its bytes", async () => {
		const service = await fakeImages();
		const generate = imageGenerator(config(service.url));
		expect(await generate("a lighthouse at dawn, watercolor", { shape: "portrait" })).toEqual(PNG);
		expect(service.asked[0]).toEqual({ path: "/v1/images/generations", auth: `Bearer ${KEY}`, json: { model: "gpt-image-1", prompt: "a lighthouse at dawn, watercolor", n: 1, size: "1024x1536" } });
		await generate("x y", { shape: "landscape" });
		expect(service.asked[1]?.json?.size).toBe("1536x1024");
		// DALL·E 3 has its own sizes and must be asked for the bytes.
		await imageGenerator(config(service.url, "dall-e-3"))("x y", { shape: "portrait" });
		expect(service.asked[2]?.json).toMatchObject({ size: "1024x1792", response_format: "b64_json" });
	});

	it("changes a picture: the picture goes as a file with the request", async () => {
		const service = await fakeImages();
		expect(await imageGenerator(config(service.url))("make the sky purple", { shape: "square", from: { data: JPEG, name: "foto.jpg" } })).toEqual(PNG);
		expect(service.asked[0]).toEqual({ path: "/v1/images/edits", auth: `Bearer ${KEY}`, form: { model: "gpt-image-1", prompt: "make the sky purple", size: "1024x1024", image: { name: "foto.jpg", type: "image/jpeg", size: JPEG.length } } });
	});

	it("says why it failed in plain words, never with the key or the request", async () => {
		const cases: [number, unknown, string][] = [
			[400, { error: { code: "moderation_blocked", message: "Your request was rejected: a secret prompt" } }, "limiti sui contenuti"],
			[400, { error: { code: "content_policy_violation", message: "a secret prompt" } }, "limiti sui contenuti"],
			[401, { error: { message: "Incorrect API key sk-image-test-key" } }, "rifiuta la chiave"],
			[429, { error: { message: "rate" } }, "troppe richieste"],
			[500, { error: { message: "boom" } }, "risponde 500"],
			[200, { data: [{ url: "https://files.example/image.png" }] }, "non ha dato un'immagine"],
			[200, { data: [{ b64_json: Buffer.from("not a picture").toString("base64") }] }, "non ha dato un'immagine"],
		];
		for (const [status, body, words] of cases) {
			const service = await fakeImages(() => ({ status, body }));
			const error = await imageGenerator(config(service.url))("a secret prompt", { shape: "square" }).catch((e: unknown) => e);
			expect(error, words).toBeInstanceOf(ImageGenerationError);
			expect(String(error)).toContain(words);
			expect(String(error)).not.toContain("secret");
			expect(String(error)).not.toContain(KEY);
		}
		await expect(imageGenerator(config("http://127.0.0.1:1/v1"))("x y", { shape: "square" })).rejects.toThrow("non risponde");
	});

	it("is configured with a key and an address; gpt-image-1 for OpenAI; cells of Annie Cloud get it", () => {
		const base = { ANNIE_DATA_DIR: tempDataDir(), ANNIE_MODEL_PROVIDER: "faux" };
		expect(loadAnnieConfig(base).images).toBeUndefined();
		expect(loadAnnieConfig({ ...base, ANNIE_IMAGE_URL: "https://api.openai.com/v1", ANNIE_IMAGE_API_KEY: KEY }).images).toEqual({ url: "https://api.openai.com/v1", apiKey: KEY, model: "gpt-image-1", maxPerDay: 100 });
		expect(() => loadAnnieConfig({ ...base, ANNIE_IMAGE_API_KEY: KEY })).toThrow("ANNIE_IMAGE_URL");
		expect(() => loadAnnieConfig({ ...base, ANNIE_IMAGE_URL: "http://evil.example/v1", ANNIE_IMAGE_API_KEY: KEY })).toThrow("ANNIE_IMAGE_URL");
		expect(() => loadAnnieConfig({ ...base, ANNIE_IMAGE_URL: "https://images.example/v1", ANNIE_IMAGE_API_KEY: KEY })).toThrow("ANNIE_IMAGE_MODEL");
		expect(() => loadAnnieConfig({ ...base, ANNIE_IMAGE_URL: "https://api.openai.com/v1", ANNIE_IMAGE_API_KEY: KEY, ANNIE_IMAGE_MAX_PER_DAY: "0" })).toThrow("ANNIE_IMAGE_MAX_PER_DAY");
		const passed = /const passed = \[([^\]]*)\]/.exec(readFileSync("src/main/cloud.ts", "utf8"))?.[1] ?? "";
		for (const name of ["ANNIE_IMAGE_URL", "ANNIE_IMAGE_API_KEY", "ANNIE_IMAGE_MODEL", "ANNIE_IMAGE_MAX_PER_DAY"]) expect(passed).toContain(`"${name}"`);
	});
});

describe("pictures in chats", () => {
	it("Telegram sends a JPEG or PNG as a photo, anything else as a document", async () => {
		const calls: { method: string; field: string; caption?: string }[] = [];
		const telegramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			const form = init?.body as FormData;
			calls.push({ method, field: form.has("photo") ? "photo" : "document", ...(form.has("caption") ? { caption: String(form.get("caption")) } : {}) });
			return Response.json({ ok: true, result: { message_id: 1 } });
		}) as typeof fetch;
		const adapter = new TelegramAdapter({ token: "1:T", tenantId: "default", instanceId: "annie", fetch: telegramFetch });
		const base = { tenantId: "default", instanceId: "annie", channel: "telegram", threadId: "7", idempotencyKey: "k" };
		await adapter.sendFile({ ...base, name: "faro.png", data: PNG, caption: "Il faro" });
		await adapter.sendFile({ ...base, name: "report.pdf", data: Uint8Array.from([1, 2, 3]) });
		// A name that says picture is not enough: the bytes decide.
		await adapter.sendFile({ ...base, name: "finta.png", data: Uint8Array.from([1, 2, 3]) });
		expect(calls).toEqual([
			{ method: "sendPhoto", field: "photo", caption: "Il faro" },
			{ method: "sendDocument", field: "document" },
			{ method: "sendDocument", field: "document" },
		]);
	});

	it("WhatsApp sends a JPEG or PNG as an image", async () => {
		const sent: Record<string, unknown>[] = [];
		const graphFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).endsWith("/media")) return Response.json({ id: "media-1" });
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({ messages: [{ id: "wamid.x" }] });
		}) as typeof fetch;
		const wa = new WhatsAppAdapter({ accessToken: "EAAGtoken0123456789", phoneNumberId: "123", appSecret: "s", verifyToken: "v", tenantId: "default", instanceId: "annie", fetch: graphFetch });
		const base = { tenantId: "default", instanceId: "annie", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k" };
		await wa.sendFile({ ...base, name: "faro.png", data: PNG, caption: "Il faro" });
		expect(sent.at(-1)).toMatchObject({ type: "image", image: { id: "media-1", caption: "Il faro" } });
	});
});

describe("image generation in an instance", () => {
	it("is off until the owner turns it on; then it makes the picture, saves it and sends it; the audit never has the request", async () => {
		const service = await fakeImages();
		const { annie, api, reply, entries, dataDir, base } = await boot(tempDataDir(), { ANNIE_IMAGE_URL: service.url, ANNIE_IMAGE_API_KEY: KEY, ANNIE_IMAGE_MODEL: "gpt-image-1", ANNIE_IMAGE_MAX_PER_DAY: "2" });
		expect(await api("/api/images")).toMatchObject({ available: true, host: new URL(service.url).host });
		const ask = '/tool image_generate {"prompt":"a red fox reading a newspaper, flat illustration","shape":"square"}';
		expect(await reply(ask)).toContain("la generazione di immagini non è attiva per questa istanza");
		expect(service.asked).toHaveLength(0);
		expect((await api("/api/instances/annie/images", { allowed: "si" }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/annie/images", { allowed: true }, "PUT")).allowed).toBe(true);

		const made = await reply(ask);
		expect(made).toMatch(/^Fatto\. Immagine creata e inviata in questa conversazione: immagini\/a-red-fox-reading-a-newspaper-flat-[\w-]+\.png/);
		const path = /immagini\/[\w-]+\.png/.exec(made)?.[0] as string;
		expect(await annie.runtime.workspace("default", "annie").read(path)).toEqual(Buffer.from(PNG));
		expect((await entries()).some((e) => e.file?.path === path)).toBe(true);

		// A picture of the workspace to change.
		await annie.runtime.workspace("default", "annie").write("uploads/foto.jpg", JPEG);
		expect(await reply('/tool image_generate {"prompt":"same photo, sky at sunset","from":"uploads/foto.jpg"}')).toMatch(/Immagine creata/);
		expect(service.asked[1]?.path).toBe("/v1/images/edits");
		expect(service.asked[1]?.form?.image.name).toBe("foto.jpg");
		await annie.runtime.workspace("default", "annie").write("note.txt", "testo");
		expect(await reply('/tool image_generate {"prompt":"change it","from":"note.txt"}')).toContain("Errore: note.txt non è un'immagine");
		expect(await reply('/tool image_generate {"prompt":"change it","from":"manca.png"}')).toContain("Errore");
		expect(service.asked).toHaveLength(2);

		// The day's pictures are counted for the account.
		expect(await reply('/tool image_generate {"prompt":"one more picture"}')).toContain("per oggi le immagini di questo account sono finite");
		expect(service.asked).toHaveLength(2);

		const audit = readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8");
		expect(audit).toContain('"type":"images.allowed"');
		expect(audit).toMatch(/"type":"image.generated","changed":false/);
		expect(audit).toMatch(/"type":"image.generated","changed":true/);
		expect(audit).not.toContain("fox");
		expect(audit).not.toContain(KEY);

		// Only the owner turns it on.
		const { link } = await api("/api/people", { name: "Luca" });
		const member = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: String(link).split("#")[1] }) });
		const cookie = (member.headers.get("set-cookie") ?? "").split(";")[0] as string;
		expect((await fetch(`${base}/api/instances/annie/images`, { method: "PUT", headers: { cookie, "x-annie": "1" }, body: JSON.stringify({ allowed: true }) })).status).toBe(403);
	});

	it("a refusal of the service reaches the model in plain words", async () => {
		const service = await fakeImages(() => ({ status: 400, body: { error: { code: "moderation_blocked", message: "no" } } }));
		const { api, reply } = await boot(tempDataDir(), { ANNIE_IMAGE_URL: service.url, ANNIE_IMAGE_API_KEY: KEY, ANNIE_IMAGE_MODEL: "gpt-image-1" });
		await api("/api/instances/annie/images", { allowed: true }, "PUT");
		expect(await reply('/tool image_generate {"prompt":"something"}')).toMatch(/Errore: il servizio di immagini ha rifiutato la richiesta per i suoi limiti sui contenuti/);
	});

	it("is not offered by a server without an image service", async () => {
		const { api, reply } = await boot(tempDataDir());
		expect(await api("/api/images")).toMatchObject({ available: false });
		expect((await api("/api/instances/annie/images", { allowed: true }, "PUT")).status).toBe(501);
		expect(await reply('/tool image_generate {"prompt":"a cat"}')).toContain("Tool image_generate is not available");
	});
});

async function boot(dataDir: string, env: Record<string, string> = {}) {
	const loaded = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ...env });
	const annie: RunningAnnie = await startAnnie({ ...loaded, web: { ...loaded.web, port: 0 } }, { schedulerIntervalMs: 60_000, log: () => {} });
	closers.push(() => annie.stop());
	const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const api = async (path: string, body?: unknown, method?: string) => {
		const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		// biome-ignore lint: test
		return { status: res.status, ...((await res.json()) as any) };
	};
	const thread = (await api("/api/instances/annie/threads", {})).thread;
	const entries = async () => (await api(`/api/instances/annie/threads/${thread.id}`)).entries as { from: string; text?: string; file?: { path: string } }[];
	const reply = async (text: string): Promise<string> => {
		const answers = async () => (await entries()).filter((e) => e.from === "annie" && e.text !== undefined);
		const before = (await answers()).length;
		await api(`/api/instances/annie/threads/${thread.id}/messages`, { text });
		for (const start = Date.now(); Date.now() - start < 20_000; ) {
			const now = await answers();
			if (now.length > before) return now.at(-1)?.text ?? "";
			await new Promise((r) => setTimeout(r, 30));
		}
		throw new Error("no reply");
	};
	return { annie, api, reply, entries, dataDir, base };
}
