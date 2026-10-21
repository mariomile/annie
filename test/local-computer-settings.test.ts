import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startAnnie } from "../src/app.ts";
import { type DesktopPermissions, type DesktopProvider } from "../src/core/desktop.ts";
import { createDesktopTools } from "../src/core/tools/desktop-tools.ts";
import { loadAnnieConfig, loadDesktopConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

describe("the local Mac's separate permission boundary", () => {
	it("requires explicit local opt-in, a private server and an absolute helper path", () => {
		const env = { ANNIE_DESKTOP: "local", ANNIE_LOCAL_PROVIDERS: "1", ANNIE_LOCAL_DESKTOP_HELPER: "/Applications/Annie.app/Contents/MacOS/annie-computer" };
		expect(loadDesktopConfig(env)).toEqual({ kind: "local", helperPath: env.ANNIE_LOCAL_DESKTOP_HELPER });
		for (const patch of [{ ANNIE_LOCAL_PROVIDERS: "" }, { ANNIE_WEB_HOST: "0.0.0.0" }, { ANNIE_PUBLIC_URL: "https://annie.example" }, { ANNIE_CELL_SECRET: "cell" }, { ANNIE_LOCAL_DESKTOP_HELPER: "./helper" }]) {
			expect(() => loadDesktopConfig({ ...env, ...patch })).toThrow();
		}
	});

	it("remote-screen consent does not authorize a tool on the person's Mac", async () => {
		let calls = 0;
		const desktop: DesktopProvider = { kind: "local", shared: true, network: "internet", call: async () => { calls++; return { text: "", images: [] }; }, reset: async () => {}, check: async () => undefined, close: async () => {} };
		const tools = createDesktopTools({ desktop, key: "agent", policy: async () => ({ modelProviders: ["faux"], channels: ["web"], connectors: ["schermo"] }), record: async () => {} });
		const look = tools.find(t => t.name === "desktop_look")!;
		expect(look.description).toContain("person's Mac");
		expect(await look.execute({}, {} as never)).toContain("non ha abilitato Computer Use");
		expect(calls).toBe(0);
	});

	it("checks live permissions, opens only named panes for the owner and keeps the local grant separate", async () => {
		let permissions: DesktopPermissions = { kind: "local", supported: true, screenRecording: false, accessibility: false };
		let checks = 0;
		const requested: string[] = [];
		const desktop: DesktopProvider = {
			kind: "local", shared: true, network: "internet",
			call: async () => ({ text: "", images: [] }), reset: async () => {}, close: async () => {}, check: async () => undefined,
			permissions: async () => { checks++; return { ...permissions }; },
			requestPermission: async (permission) => { requested.push(permission); return { ...permissions }; },
		};
		const config = loadAnnieConfig({ ANNIE_DATA_DIR: tempDataDir(), ANNIE_MODEL_PROVIDER: "faux" });
		const running = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { desktop, log: () => {}, schedulerIntervalMs: 60_000 });
		closers.push(() => running.stop());
		const base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: running.ownerLink!.split("#")[1] }) });
		const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
		const api = async (path: string, method = "GET", body?: unknown, as = cookie): Promise<{ status: number; [key: string]: any }> => {
			const response = await fetch(`${base}${path}`, { method, headers: { cookie: as, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: response.status, ...(await response.json() as Record<string, any>) };
		};
		expect(await api("/api/desktop")).toMatchObject({ status: 200, kind: "local", connector: "computer-use", permissions });
		await api("/api/desktop");
		expect(checks).toBe(2); // Local checks never reuse the remote desktop's 30-second cache.
		expect((await api("/api/desktop/permissions", "POST", { permission: "accessibility" }, "")).status).toBe(401);
		expect((await api("/api/desktop/permissions", "POST", { permission: "shell" })).status).toBe(400);
		expect((await api("/api/desktop/permissions", "POST", { permission: "screenRecording" })).status).toBe(200);
		expect(requested).toEqual(["screenRecording"]);
		expect((await api("/api/instances/annie/desktop-allowed", "PUT", { allowed: true })).status).toBe(409);
		expect((await api("/api/instances/annie/setup")).setup).toMatchObject({ computerUse: false, can: { computerUse: true } });
		permissions = { ...permissions, screenRecording: true, accessibility: true };
		expect((await api("/api/instances/annie/desktop-allowed", "PUT", { allowed: true })).status).toBe(200);
		const on = (await api("/api/instances/annie/settings")).settings.egress.connectors;
		expect(on).toContain("computer-use");
		expect(on).not.toContain("schermo");
		expect((await api("/api/instances/annie/setup")).setup.computerUse).toBe(true);
		// Revoking OS permissions never prevents the owner from disabling the grant.
		permissions = { ...permissions, accessibility: false };
		expect((await api("/api/instances/annie/desktop-allowed", "PUT", { allowed: false })).status).toBe(200);
		expect((await api("/api/instances/annie/settings")).settings.egress.connectors).not.toContain("computer-use");
	});
});
