import { request } from "node:http";
import { COMPUTER_LIMITS, ComputerError, type ComputerProvider, type ComputerRun, tarFiles, untarFirstFile } from "../core/computer.ts";

export type DockerComputerOptions = {
	/** The computer's image (docker/computer.Dockerfile). */
	readonly image: string;
	/** Docker Engine API socket. */
	readonly socketPath?: string;
	/** A sandboxed runtime such as runsc (gVisor); Docker's default otherwise. */
	readonly runtime?: string;
	readonly memoryMb?: number;
	readonly cpus?: number;
	/** A computer with no command for this long is stopped (its files stay). */
	readonly idleMs?: number;
	readonly log?: (message: string) => void;
};

const LABEL = "annie.computer";
const API_TIMEOUT_MS = 30_000;
/** Kept of each of stdout and stderr; the rest is read and dropped. */
const MAX_STREAM_BYTES = 64 * 1024;

/**
 * A computer per instance as a container on this Docker host (ADR 0013): no network at all,
 * uid 1000, read-only root except /work (the instance's volume) and /tmp, no capabilities, no
 * privilege escalation, memory, CPU and process limits, and optionally gVisor. Commands go in
 * with `docker exec`, files with Docker's archive API: the container has no interface to talk to.
 */
export class DockerComputerProvider implements ComputerProvider {
	private readonly ready = new Map<string, Promise<void>>();
	private readonly idle = new Map<string, NodeJS.Timeout>();

	constructor(private readonly options: DockerComputerOptions) {
		const memory = options.memoryMb ?? 1024;
		const cpus = options.cpus ?? 1;
		if (!Number.isInteger(memory) || memory < 128) throw new Error("Computer: memory of at least 128 MB");
		if (!(cpus > 0)) throw new Error("Computer: a positive number of CPUs");
		if (options.runtime !== undefined && !/^[\w.-]{1,40}$/.test(options.runtime)) throw new Error("Computer: invalid runtime");
	}

	async run(key: string, command: string, options: { readonly timeoutS: number }): Promise<ComputerRun> {
		await this.started(key);
		this.touch(key);
		const timeoutS = Math.max(1, Math.min(COMPUTER_LIMITS.maxTimeoutS, Math.round(options.timeoutS)));
		const create = () => this.api("POST", `/containers/${name(key)}/exec`, {
			// timeout(1) kills the command and everything it started when the time is up.
			Cmd: ["timeout", "-s", "KILL", String(timeoutS), "sh", "-c", command],
			AttachStdout: true,
			AttachStderr: true,
			Tty: false,
			User: "1000:1000",
			WorkingDir: "/work",
			Env: ["HOME=/tmp", "MPLCONFIGDIR=/tmp", "LANG=C.UTF-8"],
		}, [201]);
		// A computer stopped behind our back (out of memory, a restart of Docker) is started again, once.
		const exec = (await create().catch(async (error: unknown) => {
			if (!/HTTP 409/.test(message(error))) throw error;
			this.ready.delete(key);
			await this.started(key);
			return create();
		})) as { Id?: string };
		if (exec.Id === undefined || !/^[0-9a-f]{12,64}$/.test(exec.Id)) throw new Error("docker exec: no id");
		const started = Date.now();
		const output = await this.stream(`/exec/${exec.Id}/start`, { Detach: false, Tty: false }, (timeoutS + 15) * 1000);
		const info = (await this.api("GET", `/exec/${exec.Id}/json`, undefined, [200])) as { ExitCode?: number | null; Running?: boolean };
		this.touch(key);
		const exitCode = info.Running === true ? null : (info.ExitCode ?? null);
		return { exitCode, stdout: output.stdout, stderr: output.stderr, timedOut: exitCode === 137 || output.cut, truncated: output.truncated, ms: Date.now() - started };
	}

	async put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void> {
		if (files.length === 0) return;
		await this.started(key);
		this.touch(key);
		await this.api("PUT", `/containers/${name(key)}/archive?path=${encodeURIComponent("/work")}`, tarFiles(files), [200]);
	}

	async get(key: string, path: string, maxBytes: number): Promise<Uint8Array> {
		await this.started(key);
		this.touch(key);
		const where = `/containers/${name(key)}/archive?path=${encodeURIComponent(`/work/${path}`)}`;
		// The size first, from the stat Docker sends with HEAD: a big file is never read.
		const stat = await this.statOf(where);
		if (stat === undefined) throw new ComputerError(`nel computer non c'è /work/${path}`);
		if ((stat.mode & 0x80000000) !== 0) throw new ComputerError(`/work/${path} è una cartella: indica i file uno per uno`);
		if ((stat.mode & 0x08000000) !== 0) throw new ComputerError(`/work/${path} è un collegamento, non un file`);
		if (stat.size > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
		const archive = (await this.api("GET", where, undefined, [200], true)) as Buffer;
		const file = untarFirstFile(archive);
		if (file === undefined) throw new ComputerError(`/work/${path} non è un file`);
		if (file.length > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
		return file;
	}

	async reset(key: string): Promise<void> {
		clearTimeout(this.idle.get(key));
		this.idle.delete(key);
		await this.ready.get(key)?.catch(() => {});
		this.ready.delete(key);
		await this.api("DELETE", `/containers/${name(key)}?force=true`, undefined, [204, 404]);
		await this.api("DELETE", `/volumes/${name(key)}`, undefined, [204, 404]);
	}

	async close(): Promise<void> {
		const keys = [...this.idle.keys()];
		for (const timer of this.idle.values()) clearTimeout(timer);
		this.idle.clear();
		for (const key of keys) await this.stop(key);
	}

	private async stop(key: string): Promise<void> {
		this.ready.delete(key);
		await this.api("POST", `/containers/${name(key)}/stop?t=2`, undefined, [204, 304, 404]).catch((error: unknown) => this.options.log?.(`computer: ${key} not stopped: ${message(error)}`));
	}

	/** Stopped after a while with no commands. */
	private touch(key: string): void {
		clearTimeout(this.idle.get(key));
		const timer = setTimeout(() => {
			this.idle.delete(key);
			void this.stop(key);
		}, this.options.idleMs ?? 10 * 60_000);
		timer.unref();
		this.idle.set(key, timer);
	}

	/** Created on first use, started when stopped; once at a time per computer. */
	private started(key: string): Promise<void> {
		const pending = this.ready.get(key);
		if (pending !== undefined) return pending;
		const starting = this.launch(key).catch((error: unknown) => {
			this.ready.delete(key);
			throw error;
		});
		this.ready.set(key, starting);
		return starting;
	}

	private async launch(key: string): Promise<void> {
		let info = (await this.api("GET", `/containers/${name(key)}/json`, undefined, [200, 404])) as { State?: { Running?: boolean } } | undefined;
		if (info === undefined) {
			await this.create(key);
			info = {};
		}
		if (info.State?.Running !== true) await this.api("POST", `/containers/${name(key)}/start`, undefined, [204, 304]);
	}

	private async create(key: string): Promise<void> {
		const memory = (this.options.memoryMb ?? 1024) * 1024 * 1024;
		try {
			await this.api(
				"POST",
				`/containers/create?name=${name(key)}`,
				{
					Image: this.options.image,
					User: "1000:1000",
					// Nothing to do but wait for commands.
					Cmd: ["sleep", "infinity"],
					WorkingDir: "/work",
					Labels: { [LABEL]: key },
					NetworkDisabled: true,
					HostConfig: {
						NetworkMode: "none",
						Binds: [`${name(key)}:/work`],
						ReadonlyRootfs: true,
						Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m" },
						CapDrop: ["ALL"],
						SecurityOpt: ["no-new-privileges:true"],
						Memory: memory,
						MemorySwap: memory,
						NanoCpus: Math.round((this.options.cpus ?? 1) * 1e9),
						PidsLimit: 128,
						RestartPolicy: { Name: "no" },
						LogConfig: { Type: "none", Config: {} },
						...(this.options.runtime === undefined ? {} : { Runtime: this.options.runtime }),
					},
				},
				[201],
			);
		} catch (error) {
			if (/No such image/i.test(message(error))) throw new ComputerError(`l'immagine del computer ${this.options.image} non c'è su questo server: l'operatore la costruisce con docker build -f docker/computer.Dockerfile`);
			throw error;
		}
	}

	/** Docker's stat of a path (the X-Docker-Container-Path-Stat header of HEAD), or undefined when missing. */
	private statOf(path: string): Promise<{ size: number; mode: number } | undefined> {
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: this.socket(), path: `/v1.43${path}`, method: "HEAD" }, (res) => {
				res.resume();
				if (res.statusCode === 404) return resolve(undefined);
				const header = res.headers["x-docker-container-path-stat"];
				if (res.statusCode !== 200 || typeof header !== "string") return reject(new Error(`docker HEAD archive: HTTP ${res.statusCode}`));
				try {
					const stat = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { size?: number; mode?: number };
					resolve({ size: Number(stat.size ?? 0), mode: Number(stat.mode ?? 0) >>> 0 });
				} catch {
					reject(new Error("docker HEAD archive: unreadable stat"));
				}
			});
			req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error("docker HEAD archive: no answer")));
			req.on("error", reject);
			req.end();
		});
	}

	/** An exec's output: Docker's stream of frames (8-byte header: stream, 3 zeros, length). */
	private stream(path: string, body: unknown, timeoutMs: number): Promise<{ stdout: string; stderr: string; truncated: boolean; cut: boolean }> {
		return new Promise((resolve, reject) => {
			const kept = { 1: [] as Buffer[], 2: [] as Buffer[] };
			const size = { 1: 0, 2: 0 };
			let truncated = false;
			let pending = Buffer.alloc(0);
			let cut = false;
			const finish = () => {
				const text = (stream: 1 | 2) => Buffer.concat(kept[stream]).toString("utf8");
				resolve({ stdout: text(1), stderr: text(2), truncated, cut });
			};
			const req = request({ socketPath: this.socket(), path: `/v1.43${path}`, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
				if (res.statusCode !== 200) {
					res.resume();
					return reject(new Error(`docker exec start: HTTP ${res.statusCode}`));
				}
				res.on("data", (chunk: Buffer) => {
					pending = Buffer.concat([pending, chunk]);
					while (pending.length >= 8) {
						const length = pending.readUInt32BE(4);
						if (pending.length < 8 + length) break;
						const stream = pending[0] === 2 ? 2 : 1;
						const payload = pending.subarray(8, 8 + length);
						pending = pending.subarray(8 + length);
						const room = MAX_STREAM_BYTES - size[stream];
						if (room <= 0) {
							truncated = true;
							continue;
						}
						if (payload.length > room) truncated = true;
						kept[stream].push(Buffer.from(payload.subarray(0, room)));
						size[stream] += Math.min(room, payload.length);
					}
				});
				res.on("end", finish);
				res.on("error", reject);
			});
			// A command that outlives its own timeout (it cannot: timeout(1) kills it) does not hold the tool forever.
			req.setTimeout(timeoutMs, () => {
				cut = true;
				req.destroy();
				finish();
			});
			req.on("error", (error) => (cut ? undefined : reject(error)));
			req.end(JSON.stringify(body));
		});
	}

	private socket(): string {
		return this.options.socketPath ?? "/var/run/docker.sock";
	}

	private api(method: string, path: string, body: unknown, ok: readonly number[], raw = false): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const tar = Buffer.isBuffer(body);
			const headers = body === undefined ? {} : { "content-type": tar ? "application/x-tar" : "application/json" };
			const req = request({ socketPath: this.socket(), path: `/v1.43${path}`, method, headers }, (res) => {
				const chunks: Buffer[] = [];
				let total = 0;
				res.on("data", (c: Buffer) => {
					total += c.length;
					// An archive asked for is at most one file of maxFileBytes, plus its headers.
					if (total > COMPUTER_LIMITS.maxFileBytes + 64 * 1024) return req.destroy(new ComputerError("file troppo grande"));
					chunks.push(c);
				});
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					const data = Buffer.concat(chunks);
					if (!ok.includes(status)) return reject(new Error(`docker ${method} ${path.split("?")[0]}: HTTP ${status} ${dockerMessage(data.toString("utf8"))}`));
					// 404 where it is expected: missing, not an error.
					if (status === 404) return resolve(undefined);
					if (raw) return resolve(data);
					if (data.length === 0) return resolve(undefined);
					try {
						resolve(JSON.parse(data.toString("utf8")));
					} catch {
						resolve(undefined);
					}
				});
			});
			req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: no answer in ${API_TIMEOUT_MS / 1000} s`)));
			req.on("error", reject);
			req.end(body === undefined ? undefined : tar ? body : JSON.stringify(body));
		});
	}
}

function name(key: string): string {
	if (!/^[a-z0-9][a-z0-9_-]{0,100}$/.test(key)) throw new Error(`Invalid computer key ${key}`);
	return `annie-computer-${key}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function dockerMessage(text: string): string {
	try {
		return String((JSON.parse(text) as { message?: string }).message ?? "").slice(0, 200);
	} catch {
		return text.slice(0, 200);
	}
}
