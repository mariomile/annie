/** Local account access is an explicit, tenant-scoped capability; never read or copy tokens. */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { SUBSCRIPTION_PROVIDERS, subscriptionProvider, type SubscriptionProvider } from "./model-providers.ts";

export type LocalProviderStatus = SubscriptionProvider & {
	readonly key: "local" | "missing";
	readonly installed: boolean;
	readonly authenticated: boolean;
	readonly connected: boolean;
	readonly status: "connected" | "disconnected" | "not-installed" | "login-required" | "unavailable" | "connecting";
	readonly error?: string;
};
export type CliRequest = {
	readonly provider: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly input?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
};
export type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type CliRunner = (request: CliRequest) => Promise<CliResult>;
export class LocalProviderError extends Error {
	override readonly name = "LocalProviderError";
}
type Saved = { providers: Record<string, boolean>; initialSelectionDone?: boolean };
type LoginJob = { abort: AbortController; done: Promise<void> };

/** Finder starts with a minimal PATH; look in the standard official CLI locations too. */
export function localCliExecutable(provider: string, path = process.env.PATH, userHome = homedir()): string {
	const command = provider === "claude-code" ? "claude" : provider === "codex" ? "codex" : undefined;
	if (command === undefined) throw new LocalProviderError("Provider locale sconosciuto");
	const dirs = [...(path?.split(delimiter) ?? []), join(userHome, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter((d) => d.startsWith("/"));
	for (const dir of new Set(dirs)) {
		const candidate = join(dir, command);
		try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* Try the next standard location. */ }
	}
	throw new LocalProviderError("CLI non installata");
}

/** Whitelisted official CLIs only. Shell interpretation and arbitrary executable paths are absent. */
export const runLocalCli: CliRunner = (request) => new Promise((resolve, reject) => {
	let command: string;
	try { command = localCliExecutable(request.provider); } catch (error) { return reject(error); }
	if (request.signal?.aborted) return reject(new LocalProviderError("Operazione annullata"));
	// API key env vars override subscription billing in both CLIs. Keep only OS/login context.
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	env.PATH = [dirname(process.execPath), ...(env.PATH?.split(delimiter) ?? []), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
	const child = spawn(command, [...request.args], { cwd: request.cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let outputBytes = 0;
	let failure: Error | undefined;
	let settled = false;
	let forceKill: ReturnType<typeof setTimeout> | undefined;
	const stop = (error: Error) => {
		failure ??= error;
		child.kill("SIGTERM");
		forceKill ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
		forceKill.unref();
	};
	const abort = () => stop(new LocalProviderError("Operazione annullata"));
	request.signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => stop(new LocalProviderError("Il provider non ha risposto in tempo. Riprova.")), request.timeoutMs ?? 180_000);
	timeout.unref();
	const clean = () => { clearTimeout(timeout); if (forceKill !== undefined) clearTimeout(forceKill); request.signal?.removeEventListener("abort", abort); };
	const append = (chunk: string, output: "stdout" | "stderr") => {
		if (failure !== undefined) return;
		outputBytes += Buffer.byteLength(chunk);
		if (outputBytes > 8_000_000) { stop(new LocalProviderError("La risposta del provider supera il limite")); return; }
		if (output === "stdout") stdout += chunk; else stderr += chunk;
	};
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => append(chunk, "stdout"));
	child.stderr.on("data", (chunk: string) => append(chunk, "stderr"));
	child.on("error", (error: NodeJS.ErrnoException) => {
		if (settled) return; settled = true; clean();
		reject(new LocalProviderError(error.code === "ENOENT" ? "CLI non installata" : "Impossibile avviare il provider locale"));
	});
	child.on("close", (code) => {
		if (settled) return; settled = true; clean();
		if (failure !== undefined) reject(failure); else resolve({ code: code ?? 1, stdout, stderr });
	});
	child.stdin.on("error", () => {}); // A CLI rejecting arguments can close stdin before it consumes input.
	child.stdin.end(request.input ?? "");
});

export class LocalProviders {
	private readonly file: string;
	private readonly cwd: string;
	private readonly statuses = new Map<string, LocalProviderStatus>();
	private readonly jobs = new Map<string, LoginJob>();
	private readonly connections = new Map<string, Promise<LocalProviderStatus>>();
	private readonly revisions = new Map<string, number>();
	private readonly inFlight = new Set<AbortController>();
	private connectionReady: (() => Promise<void>) | undefined;
	private readyTask: Promise<void> | undefined;
	private closed = false;
	constructor(readonly tenantId: string, dir: string, private readonly runner: CliRunner = runLocalCli) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.file = join(dir, "connections.json");
		this.cwd = join(dir, "empty");
		mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
	}
	private saved(): Saved { return readJsonFile(this.file, { providers: {} }); }
	private remember(id: string, connected: boolean) {
		updateJsonFile<Saved>(this.file, { providers: {} }, (saved) => ({ ...saved, providers: { ...saved.providers, [id]: connected } }));
	}
	/** A one-time bootstrap choice; later detections never replace a person's selection. */
	initialModel(): { provider: string; modelId: string } | undefined {
		const selected = SUBSCRIPTION_PROVIDERS.find((p) => this.connected(p.id));
		if (selected === undefined) return undefined;
		let first = false;
		updateJsonFile<Saved>(this.file, { providers: {} }, (saved) => {
			if (saved.initialSelectionDone) return saved;
			first = true;
			return { ...saved, initialSelectionDone: true };
		});
		return first ? { provider: selected.id, modelId: selected.defaultModel } : undefined;
	}
	connected(id: string): boolean {
		return !this.closed && this.saved().providers[id] === true && this.statuses.get(id)?.authenticated === true;
	}
	list(): LocalProviderStatus[] {
		return SUBSCRIPTION_PROVIDERS.map((p) => this.statuses.get(p.id) ?? { ...p, key: "missing", installed: false, authenticated: false, connected: false, status: "unavailable" });
	}
	/** The local app can finish pending first-run setup before publishing a new connection. */
	onConnectionReady(callback: () => Promise<void>): void {
		this.connectionReady = callback;
	}
	private async notifyReady(): Promise<void> {
		if (this.closed || this.connectionReady === undefined) return;
		this.readyTask ??= Promise.resolve().then(() => this.connectionReady?.()).then(() => {}).finally(() => { this.readyTask = undefined; });
		await this.readyTask;
	}
	async detect(): Promise<LocalProviderStatus[]> {
		await Promise.all(SUBSCRIPTION_PROVIDERS.map(async (p) => { if (!this.jobs.has(p.id)) await this.probe(p.id, true); }));
		await this.notifyReady();
		return this.list();
	}
	private async finishConnection(status: LocalProviderStatus): Promise<LocalProviderStatus> {
		this.remember(status.id, true);
		this.statuses.set(status.id, { ...status, connected: false, key: "missing", status: "connecting" });
		try { await this.notifyReady(); }
		catch {
			const message = "Accesso riuscito, ma il modello iniziale non è pronto. Premi Rileva di nuovo.";
			this.statuses.set(status.id, { ...status, connected: false, key: "missing", status: "unavailable", error: message });
			throw new LocalProviderError(message);
		}
		if (this.closed || !this.connected(status.id)) return this.statuses.get(status.id) ?? status;
		const connected = { ...status, connected: true, key: "local" as const, status: "connected" as const };
		this.statuses.set(status.id, connected);
		return connected;
	}
	private async probe(id: string, automatic: boolean): Promise<LocalProviderStatus> {
		const p = subscriptionProvider(id);
		if (p === undefined || this.closed) throw new LocalProviderError("Provider locale non disponibile");
		let installed = true;
		let authenticated = false;
		let error: string | undefined;
		try {
			const result = await this.execute({ provider: id, args: id === "claude-code" ? ["auth", "status", "--json"] : ["login", "status"], cwd: this.cwd, timeoutMs: 12_000 });
			if (id === "claude-code") {
				let auth: Record<string, unknown>;
				try { auth = JSON.parse(result.stdout) as Record<string, unknown>; } catch { throw new LocalProviderError("Stato di accesso non riconosciuto: aggiorna Claude Code e riprova"); }
				authenticated = result.code === 0 && auth.loggedIn === true && (auth.authMethod === "claude.ai" || auth.authMethod === "oauth");
			} else authenticated = result.code === 0 && /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`);
		} catch (problem) {
			installed = !(problem instanceof Error && problem.message === "CLI non installata");
			if (installed) error = "Impossibile verificare l'accesso locale. Aggiorna la CLI e riprova.";
		}
		const preference = this.saved().providers[id];
		if (automatic && authenticated && preference === undefined) this.remember(id, true);
		const connected = authenticated && this.saved().providers[id] === true;
		const status: LocalProviderStatus = { ...p, installed, authenticated, connected, key: connected ? "local" : "missing", status: !installed ? "not-installed" : error !== undefined ? "unavailable" : connected ? "connected" : authenticated ? "disconnected" : "login-required", ...(error === undefined ? {} : { error }) };
		this.statuses.set(id, status);
		return status;
	}
	connect(id: string): Promise<LocalProviderStatus> {
		let pending = this.connections.get(id);
		if (pending !== undefined) return pending;
		pending = this.beginConnect(id).finally(() => this.connections.delete(id));
		this.connections.set(id, pending);
		return pending;
	}
	private async beginConnect(id: string): Promise<LocalProviderStatus> {
		const revision = this.revisions.get(id);
		if (this.jobs.has(id)) return this.list().find((p) => p.id === id) as LocalProviderStatus;
		const status = await this.probe(id, false);
		if (this.closed || this.revisions.get(id) !== revision) return status;
		if (!status.installed) throw new LocalProviderError("Installa prima la CLI ufficiale del provider sul tuo computer");
		if (status.authenticated) {
			return this.finishConnection(status);
		}
		const abort = new AbortController();
		const connecting = { ...status, status: "connecting" as const };
		this.statuses.set(id, connecting);
		const done = this.execute({ provider: id, args: id === "claude-code" ? ["auth", "login", "--claudeai"] : ["login"], cwd: this.cwd, signal: abort.signal, timeoutMs: 300_000 })
			.then(async (result) => {
				if (abort.signal.aborted || this.closed) return;
				const checked = await this.probe(id, false);
				if (abort.signal.aborted || this.closed) return;
				if (result.code !== 0 || !checked.authenticated) throw new LocalProviderError("Accesso non completato. Riprova oppure accedi dalla CLI ufficiale.");
				await this.finishConnection(checked);
			})
			.catch(() => {
				if (abort.signal.aborted || this.closed) return;
				if (this.connected(id)) this.statuses.set(id, { ...(this.statuses.get(id) ?? status), status: "unavailable", error: "Accesso riuscito, ma il modello iniziale non è pronto. Premi Rileva di nuovo." });
				else this.statuses.set(id, { ...status, status: "login-required", error: "Accesso non completato. Riprova oppure accedi dalla CLI ufficiale." });
			})
			.finally(() => { if (this.jobs.get(id)?.abort === abort) this.jobs.delete(id); });
		this.jobs.set(id, { abort, done });
		return connecting;
	}
	disconnect(id: string): void {
		if (subscriptionProvider(id) === undefined) throw new LocalProviderError("Provider locale sconosciuto");
		this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
		this.jobs.get(id)?.abort.abort();
		this.remember(id, false);
		const status = this.statuses.get(id);
		if (status !== undefined) this.statuses.set(id, { ...status, connected: false, key: "missing", status: status.installed ? "disconnected" : "not-installed", error: undefined });
	}
	async inference(request: CliRequest): Promise<CliResult> {
		if (!this.connected(request.provider)) throw new LocalProviderError("Collega prima il tuo abbonamento nelle impostazioni Provider");
		return this.execute(request);
	}
	private async execute(request: CliRequest): Promise<CliResult> {
		if (this.closed) throw new LocalProviderError("Provider locale chiuso");
		const abort = new AbortController();
		const propagate = () => abort.abort();
		if (request.signal?.aborted) abort.abort(); else request.signal?.addEventListener("abort", propagate, { once: true });
		this.inFlight.add(abort);
		try { return await this.runner({ ...request, signal: abort.signal }); }
		finally { this.inFlight.delete(abort); request.signal?.removeEventListener("abort", propagate); }
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const abort of this.inFlight) abort.abort();
		await Promise.allSettled([...this.jobs.values()].map((job) => job.done).concat([...this.connections.values()].map((connection) => connection.then(() => {})), this.readyTask === undefined ? [] : [this.readyTask]));
	}
}
