import { fork } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

/**
 * Runs code an instance wrote (an approved tool proposto) in a separate Node process:
 *
 * - Node permission model: the file system is limited to the tool's own folder (read and
 *   write) and the runner; no child processes, workers, addons or WASI.
 * - empty environment: no keys, no paths of the host.
 * - network modules (net, http, tls, dns, ...) cannot be imported and the network globals
 *   are removed: the only way out is `fetch`, which goes over IPC to this process and
 *   through the egress-guarded fetch the caller passes (the hosts the tool declared).
 * - time and memory limits; output bounded.
 *
 * The code is an ES module whose default export is `async (args, { workDir }) => result`.
 */
export type SandboxRun = {
	readonly code: string;
	readonly args: Record<string, unknown>;
	/** The tool's own folder: the only place it can read and write. */
	readonly workDir: string;
	/** Where the runner script is kept (outside workDir, readable only). */
	readonly runnerDir: string;
	/** Egress-guarded fetch for the hosts the tool declared. */
	readonly fetch: typeof fetch;
	readonly timeoutMs?: number;
	readonly memoryMb?: number;
	readonly signal?: AbortSignal;
};

export class SandboxError extends Error {
	override readonly name = "SandboxError";
}

const MAX_OUTPUT = 100_000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;

const RUNNER = `// Annie sandbox runner. Written by Annie; do not edit.
import { registerHooks } from "node:module";
const BLOCKED = new Set(["net","http","https","tls","dgram","dns","http2","undici","worker_threads","child_process","cluster","inspector","vm","module","process","v8","wasi","repl","trace_events"].flatMap((m) => [m, "node:" + m]));
registerHooks({ resolve(specifier, context, next) { if (BLOCKED.has(specifier)) throw new Error("Module not allowed in the sandbox: " + specifier); return next(specifier, context); } });
const builtin = process.getBuiltinModule;
process.getBuiltinModule = (id) => { if (BLOCKED.has(id) || BLOCKED.has("node:" + id)) throw new Error("Module not allowed in the sandbox: " + id); return builtin(id); };
for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) { try { delete globalThis[name]; } catch {} }
let seq = 0;
const pending = new Map();
globalThis.fetch = (input, init = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : String(init.body);
  process.send({ type: "fetch", id, url: String(input instanceof Request ? input.url : input), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers ?? {})), body });
});
process.on("message", async (msg) => {
  if (msg.type === "fetchResult") {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(new Response(msg.status === 204 || msg.status === 304 ? null : Buffer.from(msg.body, "base64"), { status: msg.status, headers: msg.headers }));
    return;
  }
  if (msg.type !== "run") return;
  try {
    const mod = await import("data:text/javascript;base64," + Buffer.from(msg.code).toString("base64"));
    if (typeof mod.default !== "function") throw new Error("The tool module must export a default async function");
    const out = await mod.default(msg.args, { workDir: msg.workDir });
    process.send({ type: "result", value: typeof out === "string" ? out : JSON.stringify(out) ?? "" });
  } catch (error) {
    process.send({ type: "error", message: String(error && error.message || error) });
  }
});
`;

async function runnerFile(dir: string): Promise<string> {
	const file = join(dir, "runner.mjs");
	const current = await readFile(file, "utf8").catch(() => undefined);
	if (current !== RUNNER) await writeFileAtomic(file, RUNNER);
	return file;
}

export async function runSandboxed(run: SandboxRun): Promise<string> {
	await mkdir(run.workDir, { recursive: true });
	const runner = await runnerFile(run.runnerDir);
	const child = fork(runner, [], {
		execArgv: ["--permission", `--allow-fs-read=${runner}`, `--allow-fs-read=${run.workDir}`, `--allow-fs-write=${run.workDir}`, `--max-old-space-size=${run.memoryMb ?? 128}`],
		env: {},
		cwd: run.workDir,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		serialization: "json",
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < 2000) stderr += chunk.toString("utf8");
	});
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const finish = (error: Error | undefined, value?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			run.signal?.removeEventListener("abort", onAbort);
			child.kill("SIGKILL");
			if (error) reject(error);
			else resolve((value ?? "").length > MAX_OUTPUT ? `${(value ?? "").slice(0, MAX_OUTPUT)}\n[... troncato]` : (value ?? ""));
		};
		const timer = setTimeout(() => finish(new SandboxError(`Tool timed out after ${run.timeoutMs ?? 30_000} ms`)), run.timeoutMs ?? 30_000);
		const onAbort = () => finish(new SandboxError("Tool call aborted"));
		run.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => finish(new SandboxError(`Sandbox failed: ${error.message}`)));
		child.on("exit", (code, signal) => finish(new SandboxError(`Tool process ended (${signal ?? code})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`)));
		child.on("message", (raw) => {
			const msg = raw as { type: string; id?: number; url?: string; method?: string; headers?: Record<string, string>; body?: string; value?: string; message?: string };
			if (msg.type === "result") return finish(undefined, msg.value);
			if (msg.type === "error") return finish(new SandboxError(msg.message ?? "Tool failed"));
			if (msg.type === "fetch") {
				void (async () => {
					try {
						const response = await run.fetch(String(msg.url), { method: msg.method ?? "GET", headers: msg.headers ?? {}, ...(msg.body === undefined ? {} : { body: msg.body }), ...(run.signal === undefined ? {} : { signal: run.signal }) });
						const bytes = Buffer.from(await response.arrayBuffer());
						if (bytes.length > MAX_FETCH_BYTES) throw new Error(`Response over ${MAX_FETCH_BYTES} bytes`);
						child.send({ type: "fetchResult", id: msg.id, status: response.status, headers: Object.fromEntries(response.headers), body: bytes.toString("base64") });
					} catch (error) {
						child.send({ type: "fetchResult", id: msg.id, error: error instanceof Error ? error.message : String(error) });
					}
				})();
			}
		});
		child.send({ type: "run", code: run.code, args: run.args, workDir: run.workDir });
	});
}
