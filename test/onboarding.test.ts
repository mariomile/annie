import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const running: RunningAnnie[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

async function boot() {
	const config = loadAnnieConfig({ ANNIE_DATA_DIR: tempDataDir(), ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1" });
	const annie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {} });
	running.push(annie);
	const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
	return { annie, base, api: await client(base, annie.ownerLink as string) };
}

async function client(base: string, link: string) {
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	// biome-ignore lint: test
	return async (path: string, method = "GET", body?: unknown): Promise<any> => {
		const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, ...((await res.json()) as object) };
	};
}

describe("primi passi", () => {
	it("each step is checked from the real settings, and only the owner sees them", async () => {
		const { annie, base, api } = await boot();
		expect((await api("/api/instances/annie/setup")).setup).toEqual({ model: false, instructions: false, tried: false, channel: false, web: false, people: false });
		await api("/api/instances/annie/settings", "PUT", { about: "Sei l'assistente di Studio Rossi." });
		const instructions = (await api("/api/instances/annie/settings")).settings.instructions as string;
		// Added to what Annie can do, not in its place.
		expect(instructions).toContain("watch_");
		expect(instructions.endsWith("Chi ti usa e come:\nSei l'assistente di Studio Rossi.")).toBe(true);
		const thread = (await api("/api/instances/annie/threads", "POST", {})).thread;
		await api(`/api/instances/annie/threads/${thread.id}/messages`, "POST", { text: "Ciao" });
		for (let i = 0; i < 200 && !(await api("/api/instances/annie/setup")).setup.tried; i++) await new Promise((r) => setTimeout(r, 30));
		const record = await annie.runtime.registry.getInstance("default", "annie");
		await annie.runtime.registry.setEgress("default", "annie", { ...record.egress, web: ["comune.roma.it"] });
		const added = await api("/api/people", "POST", { name: "Giulia" });
		expect((await api("/api/instances/annie/setup")).setup).toEqual({ model: false, instructions: true, tried: true, channel: false, web: true, people: true });
		const giulia = await client(base, added.link);
		expect((await giulia("/api/instances/annie/setup")).status).toBe(403);
	});
});

describe("console as an app", () => {
	it("serves a manifest whose icons exist, a service worker that is always rechecked, and allows both in the CSP", async () => {
		const { base } = await boot();
		const manifest = await fetch(`${base}/manifest.webmanifest`);
		expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
		const m = (await manifest.json()) as { start_url: string; display: string; icons: { src: string; type: string; sizes: string; purpose?: string }[] };
		expect(m).toMatchObject({ start_url: "/", display: "standalone" });
		expect(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
		for (const icon of m.icons) {
			const res = await fetch(`${base}${icon.src}`);
			expect(res.status, icon.src).toBe(200);
			expect(res.headers.get("content-type")).toBe(icon.type);
		}
		const sw = await fetch(`${base}/sw.js`);
		expect(sw.headers.get("content-type")).toContain("text/javascript");
		expect(sw.headers.get("cache-control")).toBe("no-cache");
		const page = await fetch(`${base}/`);
		expect(await page.text()).toContain('<link rel="manifest" href="/manifest.webmanifest">');
		expect(page.headers.get("content-security-policy")).toContain("manifest-src 'self'; worker-src 'self'");
		expect((await fetch(`${base}/apple-touch-icon.png`)).status).toBe(200);
	});

	it("the service worker keeps only the shell: never /api, other sites or uploads; offline, the page comes from the cache", async () => {
		const code = readFileSync(join(import.meta.dirname, "..", "src", "web", "ui", "sw.js"), "utf8");
		const handlers: Record<string, (event: unknown) => void> = {};
		const cached = new Map<string, string>([["/", "shell page"]]);
		const put: string[] = [];
		let online = true;
		const self = {
			location: { origin: "https://annie.example" },
			addEventListener: (type: string, fn: (event: unknown) => void) => (handlers[type] = fn),
			skipWaiting: async () => {},
			clients: { claim: async () => {} },
		};
		const caches = {
			open: async () => ({ addAll: async () => {}, put: async (req: { url: string }) => put.push(new URL(req.url).pathname) }),
			keys: async () => [],
			match: async (key: string | { url: string }) => {
				const path = typeof key === "string" ? key : new URL(key.url).pathname;
				return cached.has(path) ? { body: cached.get(path) } : undefined;
			},
		};
		const fetch = async (req: { url: string }) => {
			if (!online) throw new TypeError("offline");
			return { ok: true, body: `net ${new URL(req.url).pathname}`, clone: () => ({}) };
		};
		runInNewContext(code, { self, caches, fetch, URL, Response: { error: () => ({ error: true }) }, Promise });
		const request = async (path: string, mode = "cors", method = "GET", origin = "https://annie.example") => {
			let answer: Promise<unknown> | undefined;
			handlers.fetch?.({ request: { url: `${origin}${path}`, mode, method }, respondWith: (p: Promise<unknown>) => (answer = p) });
			return answer === undefined ? "not handled" : await answer;
		};
		expect(await request("/api/me")).toBe("not handled");
		expect(await request("/api/instances/annie/files/raw?path=a.pdf")).toBe("not handled");
		expect(await request("/app.js", "cors", "POST")).toBe("not handled");
		expect(await request("/app.js", "cors", "GET", "https://cdn.example")).toBe("not handled");
		expect(await request("/app.js")).toMatchObject({ body: "net /app.js" });
		await new Promise((r) => setTimeout(r, 0));
		expect(put).toEqual(["/app.js"]);
		online = false;
		expect(await request("/qualsiasi", "navigate")).toMatchObject({ body: "shell page" });
		expect(await request("/app.css")).toMatchObject({ error: true });
	});
});
