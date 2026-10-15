import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { AnnieRuntime } from "../src/core/index.ts";
import { instanceDir } from "../src/core/paths.ts";
import { tenantId, instanceId } from "../src/core/ids.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { connectChannel } from "../src/gateway.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { createWebApp } from "../src/web/server.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

async function setup() {
	const dataDir = tempDataDir();
	const runtime = new AnnieRuntime({ dataDir, engine: piDurableEngine });
	await runtime.registry.createTenant({ id: "acme", name: "acme" });
	const tenantDir = join(dataDir, "tenants", "acme");
	const people = new PeopleStore(tenantDir);
	const owner = await people.add("Mario", "owner");
	const anna = await people.add("Anna", "member");
	const luca = await people.add("Luca", "member");
	await runtime.registry.createInstance("acme", {
		id: "ops",
		name: "Ops",
		model: FAUX_MODEL,
		egress: { modelProviders: ["faux"], channels: ["web"] },
		allowedUsers: { web: [anna.person.id, luca.person.id] },
		approvers: { web: [anna.person.id] },
	});
	await runtime.registry.createInstance("acme", { id: "secret", name: "Secret", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["web"] } });
	const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, instanceDir(dataDir, tenantId("acme"), instanceId("ops")));
	connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
	const server = createWebApp({
		runtime,
		tenantId: "acme",
		people,
		sessions: new SessionStore(tenantDir),
		channels: new Map([["ops", channel]]),
		connectors: (id) => new ConnectorStore(instanceDir(dataDir, tenantId("acme"), instanceId(id))),
		connectorStatus: () => [],
		usage: new UsageLedger(tenantDir),
		uiDir: join(import.meta.dirname, "..", "src", "web", "ui"),
		secureCookies: false,
		defaultTimeZone: "Europe/Rome",
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closers.push(async () => {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
		await runtime.close();
	});
	/** A logged-in client. */
	const as = async (token: string) => {
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1", "content-type": "application/json" }, body: JSON.stringify({ token }) });
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		return async (path: string, init: RequestInit = {}) => {
			const res = await fetch(`${base}${path}`, { ...init, headers: { cookie, "x-annie": "1", "content-type": "application/json", ...(init.headers ?? {}) } });
			const type = res.headers.get("content-type") ?? "";
			const body: any = type.includes("json") ? await res.json() : await res.text();
			return { status: res.status, body, headers: res.headers };
		};
	};
	return { runtime, base, people, owner, anna, luca, as, channel, dataDir };
}

describe("web console", () => {
	it("needs a valid link to log in, and a session for everything else", async () => {
		const h = await setup();
		expect((await fetch(`${h.base}/api/me`)).status).toBe(401);
		const bad = await fetch(`${h.base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: "x".repeat(43) }) });
		expect(bad.status).toBe(401);
		const login = await fetch(`${h.base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: h.anna.token }) });
		expect(login.headers.get("set-cookie")).toMatch(/^annie_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\//);
		const anna = await h.as(h.anna.token);
		expect((await anna("/api/me")).body.person).toMatchObject({ name: "Anna", role: "member" });
		expect(JSON.stringify((await anna("/api/me")).body)).not.toContain("tokenHash");
	});

	it("a link revoked from another process ends its sessions at once; a person removed from the allowlist is refused", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const thread = (await anna("/api/instances/ops/threads", { method: "POST", body: "{}" })).body.thread;
		await h.runtime.registry.setAllowedUsers("acme", "ops", "web", [h.luca.person.id]);
		const refused = await anna(`/api/instances/ops/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ciao" }) });
		// No longer a member: the instance is invisible to her, and nothing reached the transcript.
		expect(refused.status).toBe(404);
		expect(await h.channel.transcript(thread.id)).toEqual([]);
		// The CLI, in another process, rotates Anna's link.
		const { PeopleStore: People, SessionStore: Sessions } = await import("../src/web/auth.ts");
		const dir = join(h.dataDir, "tenants", "acme");
		await new People(dir).rotate(h.anna.person.id);
		await new Sessions(dir).endAllOf(h.anna.person.id);
		expect((await anna("/api/me")).status).toBe(401);
	});

	it("refuses changes without the X-Annie header (cross-site requests)", async () => {
		const h = await setup();
		const res = await fetch(`${h.base}/api/login`, { method: "POST", body: JSON.stringify({ token: h.anna.token }) });
		expect(res.status).toBe(403);
	});

	it("a member chats with the instance; replies land in their thread, which others cannot see", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const thread = (await anna("/api/instances/ops/threads", { method: "POST", body: "{}" })).body.thread;
		expect((await anna(`/api/instances/ops/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ciao annie" }) })).status).toBe(200);
		let entries: any[] = [];
		await waitFor(() => entries.length === 2 || (void anna(`/api/instances/ops/threads/${thread.id}`).then((r) => (entries = r.body.entries ?? [])), false));
		expect(entries.map((e) => [e.from, e.text])).toEqual([
			["person", "ciao annie"],
			["annie", "Annie (modello locale di sviluppo): hai scritto «ciao annie»"],
		]);
		expect((await anna("/api/instances/ops/threads")).body.threads[0].title).toBe("ciao annie");
		const luca = await h.as(h.luca.token);
		expect((await luca(`/api/instances/ops/threads/${thread.id}`)).status).toBe(404);
		expect((await luca(`/api/instances/ops/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({ text: "intruso" }) })).status).toBe(400);
	});

	it("members see only their instances and no owner pages; the owner sees everything", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		expect((await anna("/api/instances")).body.instances.map((i: any) => [i.id, i.canChat, i.isApprover])).toEqual([["ops", true, true]]);
		expect((await anna("/api/instances/secret/files")).status).toBe(404);
		expect((await anna("/api/audit")).status).toBe(403);
		expect((await anna("/api/people")).status).toBe(403);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances")).body.instances.map((i: any) => i.id).sort()).toEqual(["ops", "secret"]);
		expect((await owner("/api/people")).body.people).toHaveLength(3);
		const created = (await owner("/api/people", { method: "POST", body: JSON.stringify({ name: "Sara" }) })).body;
		expect(created.link).toMatch(/^\/login#[\w-]{40,}$/);
		expect((await owner("/api/audit?limit=5")).body.events.length).toBeGreaterThan(0);
	});

	it("uploads and downloads workspace files, never outside the workspace", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const up = await anna("/api/instances/ops/files/raw?name=../../listino.csv", { method: "PUT", body: "a,b\n1,2\n", headers: { "content-type": "application/octet-stream" } });
		// Slashes and leading dots are neutralised: it stays in uploads/.
		expect(up.body.file.path).toBe("uploads/_.._listino.csv");
		const files = (await anna("/api/instances/ops/files")).body.files;
		expect(files).toHaveLength(1);
		const down = await anna(`/api/instances/ops/files/raw?path=${encodeURIComponent(files[0].path)}`);
		expect(down.body).toBe("a,b\n1,2\n");
		expect(down.headers.get("content-disposition")).toMatch(/^attachment;/);
		expect((await anna("/api/instances/ops/files/raw?path=../../people.json")).status).toBe(400);
	});

	it("a member sees and deletes only the tasks that act for them", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const luca = await h.as(h.luca.token);
		const thread = (await anna("/api/instances/ops/threads", { method: "POST", body: "{}" })).body.thread;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		const task = (await anna("/api/instances/ops/schedules", { method: "POST", body: JSON.stringify({ instruction: "Privato di Anna", at, threadId: thread.id }) })).body.schedule;
		expect((await luca("/api/instances/ops/schedules")).body.schedules).toEqual([]);
		expect((await luca(`/api/instances/ops/schedules/${task.id}`, { method: "DELETE" })).status).toBe(404);
		expect((await anna("/api/instances/ops/schedules")).body.schedules.map((s: { id: string }) => s.id)).toEqual([task.id]);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances/ops/schedules")).body.schedules).toHaveLength(1);
	});

	it("only approvers decide on tools proposti", async () => {
		const h = await setup();
		const p = await h.runtime.proposals("acme", "ops").propose({ name: "double", description: "x2", parameters: { type: "object" }, code: "export default async () => 1", hosts: [] });
		const luca = await h.as(h.luca.token);
		expect((await luca(`/api/instances/ops/proposals/${p.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) })).status).toBe(403);
		const anna = await h.as(h.anna.token);
		const ok = await anna(`/api/instances/ops/proposals/${p.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) });
		expect(ok.body.proposal.status).toBe("approved");
	});

	it("serves the page with a strict content security policy", async () => {
		const h = await setup();
		const page = await fetch(`${h.base}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		expect((await fetch(`${h.base}/../package.json`)).status).toBe(404);
	});
});
