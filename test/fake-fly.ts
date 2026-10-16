import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** What runs an exec on a machine: annie-run with these arguments and this input. */
export type Backend = {
	boot(app: string, config: Record<string, unknown>): Promise<void>;
	exec(app: string, command: readonly string[], stdin: string): Promise<{ exit_code: number; stdout: string; stderr: string }>;
	destroy(app: string): Promise<void>;
};

type FakeMachine = { id: string; state: string; config: Record<string, unknown> };
type FakeApp = { name: string; network: string; org: string; machines: FakeMachine[]; volumes: { id: string; size_gb: number; region: string; encrypted: boolean }[] };

/**
 * A stand-in for the part of Fly's Machines API the computer uses (src/computer/fly-computer.ts),
 * with the same paths and payloads as api.machines.dev. Execs go to a backend: annie-run on this
 * machine, or a container of the real image (computer-fly.live.test.ts).
 */
export async function fakeFly(backend: Backend, token = "fly-test-token"): Promise<{ url: string; apps: Map<string, FakeApp>; calls: string[]; server: Server; stopMachine(app: string): void; close(): Promise<void> }> {
	const apps = new Map<string, FakeApp>();
	const calls: string[] = [];
	let next = 1;
	const server = createServer((req, res) => {
		void (async () => {
			const send = (status: number, body?: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(body === undefined ? "" : JSON.stringify(body));
			};
			if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
			const url = new URL(req.url ?? "/", "http://fly");
			const body = req.method === "POST" ? ((await readJson(req)) as Record<string, unknown>) : {};
			calls.push(`${req.method} ${url.pathname}`);
			const parts = url.pathname.split("/").filter(Boolean);
			if (parts[0] !== "v1" || parts[1] !== "apps") return send(404, { error: "not found" });
			if (parts.length === 2 && req.method === "GET") return send(200, { total_apps: apps.size, apps: [...apps.values()].map((a) => ({ name: a.name })) });
			if (parts.length === 2 && req.method === "POST") {
				const name = String(body.app_name);
				if (apps.has(name)) return send(422, { error: "taken" });
				apps.set(name, { name, network: String(body.network ?? ""), org: String(body.org_slug), machines: [], volumes: [] });
				return send(201, { name });
			}
			const app = apps.get(parts[2] ?? "");
			if (app === undefined) return send(404, { error: "app not found" });
			if (parts.length === 3 && req.method === "GET") return send(200, { name: app.name });
			if (parts.length === 3 && req.method === "DELETE") {
				apps.delete(app.name);
				await backend.destroy(app.name);
				return send(202);
			}
			if (parts[3] === "volumes" && parts.length === 4 && req.method === "POST") {
				const volume = { id: `vol_${next++}`, size_gb: Number(body.size_gb), region: String(body.region), encrypted: body.encrypted === true };
				app.volumes.push(volume);
				return send(200, volume);
			}
			if (parts[3] !== "machines") return send(404, { error: "not found" });
			if (parts.length === 4 && req.method === "GET") return send(200, app.machines);
			if (parts.length === 4 && req.method === "POST") {
				const machine = { id: `m${(next++).toString().padStart(8, "0")}`, state: "started", config: body.config as Record<string, unknown> };
				app.machines.push(machine);
				await backend.boot(app.name, machine.config);
				return send(200, machine);
			}
			const machine = app.machines.find((m) => m.id === parts[4]);
			if (machine === undefined) return send(404, { error: "machine not found" });
			const action = parts[5];
			if (action === undefined && req.method === "GET") return send(200, machine);
			if (action === undefined && req.method === "POST") {
				machine.config = body.config as Record<string, unknown>;
				await backend.boot(app.name, machine.config);
				return send(200, machine);
			}
			if (action === "start") {
				if (machine.state !== "started") await backend.boot(app.name, machine.config);
				machine.state = "started";
				return send(200, { previous_state: "stopped" });
			}
			if (action === "stop") {
				machine.state = "stopped";
				return send(200, { ok: true });
			}
			if (action === "wait") return send(machine.state === url.searchParams.get("state") ? 200 : 408, { ok: machine.state === url.searchParams.get("state") });
			if (action === "exec") {
				if (machine.state !== "started") return send(412, { error: "machine not started" });
				const timeout = Number(body.timeout ?? 0);
				if (!(timeout > 0 && timeout <= 60)) return send(400, { error: "timeout must be at most 60" });
				const out = await backend.exec(app.name, body.command as string[], String(body.stdin ?? ""));
				// Like Fly: exit_code is left out when it is 0.
				return send(200, out.exit_code === 0 ? { stdout: out.stdout, stderr: out.stderr } : out);
			}
			send(404, { error: "not found" });
		})().catch((error: unknown) => {
			res.writeHead(500);
			res.end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		apps,
		calls,
		server,
		stopMachine(name) {
			for (const m of apps.get(name)?.machines ?? []) m.state = "stopped";
		},
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/** Runs a process with this input; its exit code and output. */
export function runProcess(command: string, args: readonly string[], stdin: string, env?: Record<string, string>): Promise<{ exit_code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ exit_code: code ?? 1, stdout, stderr }));
		child.stdin.end(stdin);
	});
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (c: Buffer) => (data += c.toString()));
		req.on("end", () => {
			try {
				resolve(JSON.parse(data || "{}"));
			} catch {
				resolve({});
			}
		});
	});
}
