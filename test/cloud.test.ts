import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ControlPlane, startControlPlane } from "../src/cloud/control-plane.ts";
import { LocalCellProvider } from "../src/cloud/local-provider.ts";
import { MemoryMailer } from "../src/cloud/mailer.ts";
import { tempDataDir } from "./helpers.ts";

const DOMAIN = "annie.test";
const running: ControlPlane[] = [];
afterEach(async () => {
	for (const cp of running.splice(0)) await cp.stop();
});

async function cloud(options: { idleMs?: number } = {}) {
	const dataDir = tempDataDir();
	const mailer = new MemoryMailer();
	const provider = new LocalCellProvider({ root: join(dataDir, "cells"), repoRoot: join(import.meta.dirname, "..") });
	const cp = await startControlPlane({
		dataDir,
		domain: DOMAIN,
		publicScheme: "http",
		provider,
		mailer,
		cellEnv: { ANNIE_MODEL_PROVIDER: "faux" },
		idleMs: options.idleMs ?? 60_000,
		web: { host: "127.0.0.1", port: 0 },
		tickMs: 0,
		log: () => {},
	});
	running.push(cp);
	const port = (cp.server.address() as AddressInfo).port;
	/** A request to the control plane as the browser would send it, by host name. */
	const at = (host: string) => (path: string, init: { method?: string; body?: string; cookie?: string } = {}) =>
		new Promise<{ status: number; headers: Headers; body: any }>((resolve, reject) => {
			// fetch() cannot set Host; the control plane routes by it, as behind a real domain.
			const req = request(
				{ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host, "x-annie": "1", "content-type": "application/json", ...(init.cookie === undefined ? {} : { cookie: init.cookie }) } },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						const headers = new Headers();
						for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
						resolve({ status: res.statusCode ?? 0, headers, body: (res.headers["content-type"] ?? "").includes("json") ? JSON.parse(text) : text });
					});
				},
			);
			req.on("error", reject);
			req.end(init.body);
		});
	return { cp, mailer, provider, at, port };
}

/** Sign up through the control plane and land, logged in, in the new cell. */
async function signUp(c: Awaited<ReturnType<typeof cloud>>, email: string) {
	const home = c.at(DOMAIN);
	expect((await home("/api/signup", { method: "POST", body: JSON.stringify({ email }) })).status).toBe(200);
	const mail = c.mailer.sent.findLast((m) => m.to === email.toLowerCase());
	const token = /#([\w-]+)/.exec(mail?.text ?? "")?.[1] as string;
	const verified = await home("/api/verify", { method: "POST", body: JSON.stringify({ token }) });
	expect(verified.status).toBe(200);
	const url = new URL(verified.body.loginUrl as string);
	const cell = c.at(url.host);
	const login = await cell("/api/login", { method: "POST", body: JSON.stringify({ token: url.hash.slice(1) }) });
	expect(login.status).toBe(200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const api = (path: string, body?: unknown) => cell(path, { method: body === undefined ? "GET" : "POST", cookie, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { url, host: url.host, api, cell, token };
}

async function until(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe("Annie Cloud control plane (cells as local processes)", () => {
	it("sign up by email, land in your own cell, get an answer", async () => {
		const c = await cloud();
		const started = Date.now();
		const anna = await signUp(c, "anna@studio.example");
		expect(anna.url.host).toMatch(new RegExp(`^[a-z0-9-]+\\.${DOMAIN.replace(".", "\\.")}$`));
		const thread = (await anna.api("/api/instances/annie/threads", {})).body.thread;
		await anna.api(`/api/instances/annie/threads/${thread.id}/messages`, { text: "ciao dal cloud" });
		await until(async () => ((await anna.api(`/api/instances/annie/threads/${thread.id}`)).body.entries as { from: string }[]).some((e) => e.from === "annie"));
		// The measure of Fase 1: from signup to first answer.
		expect(Date.now() - started).toBeLessThan(120_000);
	}, 180_000);

	it("each person gets their own cell; signing in again does not make a second one", async () => {
		const c = await cloud();
		const anna = await signUp(c, "anna@studio.example");
		const luca = await signUp(c, "luca@altro.example");
		expect(anna.host).not.toBe(luca.host);
		const again = await signUp(c, "Anna@Studio.example");
		expect(again.host).toBe(anna.host);
		expect(await c.provider.list()).toHaveLength(2);
		// Anna's session does not open Luca's cell.
		expect((await luca.cell("/api/me", { cookie: "annie_session=nothing" })).status).toBe(401);
	}, 180_000);

	it("a login link from the email works once, and not after it expires", async () => {
		const c = await cloud();
		const home = c.at(DOMAIN);
		await home("/api/signup", { method: "POST", body: JSON.stringify({ email: "anna@studio.example" }) });
		const token = /#([\w-]+)/.exec(c.mailer.sent[0]?.text ?? "")?.[1] as string;
		expect((await home("/api/verify", { method: "POST", body: JSON.stringify({ token }) })).status).toBe(200);
		expect((await home("/api/verify", { method: "POST", body: JSON.stringify({ token }) })).status).toBe(400);
		expect((await home("/api/signup", { method: "POST", body: JSON.stringify({ email: "non è una mail" }) })).status).toBe(400);
		expect((await c.at(`nessuno.${DOMAIN}`)("/api/me")).status).toBe(404);
	}, 180_000);

	it("an idle cell is stopped, and the next request wakes it with everything still there", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		const thread = (await anna.api("/api/instances/annie/threads", {})).body.thread;
		await anna.api(`/api/instances/annie/threads/${thread.id}/messages`, { text: "ricordati di me" });
		await until(async () => ((await anna.api(`/api/instances/annie/threads/${thread.id}`)).body.entries as { from: string }[]).some((e) => e.from === "annie"));
		await c.cp.tick(new Date());
		expect(await c.provider.status((await c.provider.list())[0] as string)).toBe("stopped");
		const entries = (await anna.api(`/api/instances/annie/threads/${thread.id}`)).body.entries as { from: string }[];
		expect(entries.length).toBeGreaterThanOrEqual(2);
		expect(await c.provider.status((await c.provider.list())[0] as string)).toBe("running");
	}, 180_000);

	it("a sleeping cell is woken for its next task programmato", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		const thread = (await anna.api("/api/instances/annie/threads", {})).body.thread;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		await anna.api("/api/instances/annie/schedules", { instruction: "Promemoria", at, threadId: thread.id });
		const cell = (await c.provider.list())[0] as string;
		await c.cp.tick(new Date());
		expect(await c.provider.status(cell)).toBe("stopped");
		await c.cp.tick(new Date(Date.now() + 1_800_000));
		expect(await c.provider.status(cell)).toBe("stopped");
		await c.cp.tick(new Date(Date.parse(at) + 1000));
		expect(await c.provider.status(cell)).toBe("running");
	}, 180_000);
});
