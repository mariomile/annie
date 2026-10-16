import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlane } from "../src/cloud/control-plane.ts";
import { DockerCellProvider } from "../src/cloud/docker-provider.ts";
import { MemoryMailer } from "../src/cloud/mailer.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A fake Docker Engine API on a unix socket: records every call, keeps containers in memory. */
async function fakeDocker() {
	const calls: { method: string; path: string; body: any }[] = [];
	const containers = new Map<string, { running: boolean; labels: Record<string, string> }>();
	const socketPath = join(mkdtempSync(join(tmpdir(), "docker-")), "docker.sock");
	const server = createServer((req, res) => {
		let text = "";
		req.on("data", (c) => (text += c));
		req.on("end", () => {
			const path = (req.url ?? "").replace(/^\/v1\.43/, "");
			const body = text === "" ? undefined : JSON.parse(text);
			calls.push({ method: req.method ?? "", path, body });
			const send = (status: number, value?: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(value === undefined ? "" : JSON.stringify(value));
			};
			const name = /\/containers\/([^/?]+)/.exec(path)?.[1] ?? "";
			if (path.startsWith("/networks/create")) return send(201, { Id: "n" });
			if (path.startsWith("/containers/create")) {
				containers.set(new URL(path, "http://x").searchParams.get("name") ?? "", { running: false, labels: body.Labels });
				return send(201, { Id: "c" });
			}
			if (path.startsWith("/containers/json")) return send(200, [...containers.values()].map((c) => ({ Labels: c.labels })));
			const c = containers.get(name);
			if (path.endsWith("/json")) return c === undefined ? send(404, { message: "No such container" }) : send(200, { State: { Running: c.running, ExitCode: 0 }, NetworkSettings: { Ports: { "8080/tcp": c.running ? [{ HostIp: "127.0.0.1", HostPort: String(cellPort) }] : null } } });
			if (path.endsWith("/start") && c) return (c.running = true), send(204);
			if (path.includes("/stop") && c) return (c.running = false), send(204);
			if (req.method === "DELETE") return containers.delete(name), send(204);
			send(404, { message: "not found" });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
	// The "cell" answers /healthz.
	const cell = createServer((_req, res) => res.end('{"ok":true}'));
	await new Promise<void>((resolve) => cell.listen(0, "127.0.0.1", () => resolve()));
	const cellPort = (cell.address() as AddressInfo).port;
	closers.push(() => new Promise((r) => server.close(() => r())), () => new Promise((r) => cell.close(() => r())));
	return { socketPath, calls, containers };
}

describe("Docker cell provider", () => {
	it("creates each cell locked down, on its own network and volume, reachable only from this host", async () => {
		const docker = await fakeDocker();
		const provider = new DockerCellProvider({ image: "annie:local", socketPath: docker.socketPath });
		await provider.create("a1", { ANNIE_TENANT_ID: "a1", ANNIE_CELL_SECRET: "s".repeat(32) });
		const create = docker.calls.find((c) => c.path.startsWith("/containers/create"))?.body;
		expect(create.Env).toEqual(expect.arrayContaining(["ANNIE_TENANT_ID=a1", "ANNIE_DATA_DIR=/data", "ANNIE_WEB_HOST=0.0.0.0"]));
		expect(create.HostConfig).toMatchObject({
			Binds: ["annie-cell-a1:/data"],
			NetworkMode: "annie-cell-a1",
			PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
			ReadonlyRootfs: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges:true"],
			PidsLimit: 256,
		});
		expect(create.HostConfig.Memory).toBe(512 * 1024 * 1024);
		expect(docker.calls.find((c) => c.path.startsWith("/networks/create"))?.body).toMatchObject({ Name: "annie-cell-a1", Driver: "bridge" });
		expect(await provider.status("a1")).toBe("stopped");
		await provider.start("a1");
		expect(await provider.status("a1")).toBe("running");
		expect(await provider.baseUrl("a1")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await provider.list()).toEqual(["a1"]);
		await provider.stop("a1");
		expect(await provider.status("a1")).toBe("stopped");
		await provider.destroy("a1");
		expect(await provider.status("a1")).toBe("missing");
		expect(docker.calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("?")[0])).toEqual(["/containers/annie-cell-a1", "/volumes/annie-cell-a1", "/networks/annie-cell-a1"]);
		await expect(provider.create("../x", {})).rejects.toThrow(/Invalid cell id/);
	});
});

// With a Docker daemon and the Annie image: ANNIE_TEST_DOCKER_IMAGE=annie:local pnpm vitest run test/docker-provider.test.ts
const image = process.env.ANNIE_TEST_DOCKER_IMAGE;
describe.skipIf(image === undefined)("Docker cell provider, real daemon", () => {
	it("sign up through the control plane into a container cell, sleep, wake with the data still there", async () => {
		const dataDir = tempDataDir();
		const provider = new DockerCellProvider({ image: image as string });
		const mailer = new MemoryMailer();
		const cp = await startControlPlane({ dataDir, domain: "annie.test", publicScheme: "http", provider, mailer, cellEnv: { ANNIE_MODEL_PROVIDER: "faux" }, idleMs: 0, web: { host: "127.0.0.1", port: 0 }, tickMs: 0, log: () => {} });
		closers.push(async () => {
			await cp.stop();
			for (const id of await provider.list()) await provider.destroy(id);
		});
		const port = (cp.server.address() as AddressInfo).port;
		const call = (host: string, path: string, body?: unknown, cookie?: string) =>
			new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
				const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { host, "x-annie": "1", ...(cookie ? { cookie } : {}) } }, (res) => {
					let text = "";
					res.on("data", (c) => (text += c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text.startsWith("{") ? JSON.parse(text) : text, cookie: String(res.headers["set-cookie"] ?? "").split(";")[0] as string }));
				});
				req.on("error", reject);
				req.end(body === undefined ? undefined : JSON.stringify(body));
			});
		expect((await call("annie.test", "/api/signup", { email: "anna@example.com" })).status).toBe(200);
		const token = /#([\w-]+)/.exec(mailer.sent[0]?.text ?? "")?.[1];
		const started = Date.now();
		const verified = await call("annie.test", "/api/verify", { token });
		expect(verified.status).toBe(200);
		const url = new URL(verified.body.loginUrl);
		const login = await call(url.host, "/api/login", { token: url.hash.slice(1) });
		expect(login.status).toBe(200);
		const thread = (await call(url.host, "/api/instances/annie/threads", {}, login.cookie)).body.thread;
		await call(url.host, `/api/instances/annie/threads/${thread.id}/messages`, { text: "ciao dal container" }, login.cookie);
		const answered = async () => ((await call(url.host, `/api/instances/annie/threads/${thread.id}`, undefined, login.cookie)).body.entries as { from: string }[]).some((e) => e.from === "annie");
		while (!(await answered())) await new Promise((r) => setTimeout(r, 100));
		console.log(`docker cell: sign-up to first answer in ${((Date.now() - started) / 1000).toFixed(1)} s`);
		// Idle: stopped. The next request with a session wakes it, and the conversation is still there.
		const tenant = url.host.split(".")[0] as string;
		await cp.tick(new Date());
		expect(await provider.status(tenant)).toBe("stopped");
		const woke = Date.now();
		const again = await call(url.host, `/api/instances/annie/threads/${thread.id}`, undefined, login.cookie);
		console.log(`docker cell: wake in ${((Date.now() - woke) / 1000).toFixed(1)} s`);
		expect(again.body.entries.some((e: { text?: string }) => e.text === "ciao dal container")).toBe(true);
	}, 180_000);
});
