import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StripeBilling } from "../src/cloud/billing.ts";
import { type ControlPlane, startControlPlane } from "../src/cloud/control-plane.ts";
import { MemoryMailer } from "../src/cloud/mailer.ts";
import type { CellProvider } from "../src/cloud/provider.ts";
import { createComputerProvider } from "../src/computer/create.ts";
import { RemoteComputerProvider } from "../src/computer/remote-computer.ts";
import { ComputerError, type ComputerProvider, type ComputerRun, computerKey } from "../src/core/computer.ts";
import { ConfigError, loadAnnieConfig, loadComputerConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

/** The computers of Annie Cloud (ADR 0015): cells ask the control plane, which holds Fly's token. */
const running: ControlPlane[] = [];
afterEach(async () => {
	for (const cp of running.splice(0)) await cp.stop();
});

const SECRET_A = "segreto-della-cella-a-0123456789";
const SECRET_B = "segreto-della-cella-b-0123456789";
const KEY = "0123456789abcdef0123456789abcdef";

/** What the control plane's provider was asked, and a command that can be held open. */
class Recorder implements ComputerProvider {
	readonly calls: string[] = [];
	readonly files = new Map<string, Uint8Array>();
	hold: Promise<void> | undefined;
	aborted = false;
	async run(key: string, command: string, options: { readonly timeoutS: number; readonly signal?: AbortSignal }): Promise<ComputerRun> {
		this.calls.push(`run ${key} ${command}`);
		options.signal?.addEventListener("abort", () => (this.aborted = true));
		if (command === "rifiuta") throw new ComputerError("il disco del computer è pieno");
		if (command === "rompi") throw new Error("fly POST /v1/apps: HTTP 500 dettagli interni");
		await this.hold;
		return { exitCode: 0, stdout: `ok ${options.timeoutS}`, stderr: "", timedOut: false, killed: false, truncated: false, ms: 1, diskFull: false };
	}
	async put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void> {
		for (const f of files) this.files.set(`${key}/${f.path}`, f.data);
	}
	async get(key: string, path: string): Promise<Uint8Array> {
		const data = this.files.get(`${key}/${path}`);
		if (data === undefined) throw new ComputerError(`nel computer non c'è /work/${path}`);
		return data;
	}
	async reset(key: string): Promise<void> {
		this.calls.push(`reset ${key}`);
	}
	async check(): Promise<string | undefined> {
		return undefined;
	}
	async close(): Promise<void> {}
}

const idle: CellProvider = {
	create: async () => {},
	start: async () => {},
	stop: async () => {},
	destroy: async () => {},
	status: async () => "stopped",
	list: async () => [],
	baseUrl: async () => "http://127.0.0.1:1",
};

async function controlPlane(computer: ComputerProvider, state: Record<string, unknown> = {}, billing?: StripeBilling) {
	const dataDir = tempDataDir();
	const now = new Date().toISOString();
	writeFileSync(
		join(dataDir, "control-plane.json"),
		JSON.stringify({
			accounts: [
				{ email: "a@x.example", tenant: "aaaa", createdAt: now },
				{ email: "b@x.example", tenant: "bbbb", createdAt: now },
			],
			cells: [
				{ tenant: "aaaa", secret: SECRET_A, nextWakeAt: null },
				{ tenant: "bbbb", secret: SECRET_B, nextWakeAt: null },
			],
			links: [],
			...state,
		}),
	);
	const cp = await startControlPlane({ dataDir, domain: "annie.test", publicScheme: "http", provider: idle, mailer: new MemoryMailer(), cellEnv: {}, idleMs: 60_000, web: { host: "127.0.0.1", port: 0 }, tickMs: 0, computer, ...(billing === undefined ? {} : { billing }), log: () => {} });
	running.push(cp);
	return `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
}

describe("computers through the control plane", () => {
	it("runs a cell's command under a key of its own tenant, so no cell reaches another's computer", async () => {
		const recorder = new Recorder();
		const url = await controlPlane(recorder);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		const b = new RemoteComputerProvider({ url, tenant: "bbbb", cellSecret: SECRET_B });
		expect((await a.run(KEY, "echo ciao", { timeoutS: 30 })).stdout).toBe("ok 30");
		await b.run(KEY, "echo ciao", { timeoutS: 30 });
		// The same key from two tenants: two computers.
		expect(recorder.calls).toEqual([`run ${computerKey("aaaa", KEY)} echo ciao`, `run ${computerKey("bbbb", KEY)} echo ciao`]);
		await a.put(KEY, [{ path: "dati/x.csv", data: Buffer.from("1,2") }]);
		expect(Buffer.from(await a.get(KEY, "dati/x.csv", 100)).toString()).toBe("1,2");
		await expect(b.get(KEY, "dati/x.csv", 100)).rejects.toThrow("non c'è");
		await a.reset(KEY);
		expect(recorder.calls.at(-1)).toBe(`reset ${computerKey("aaaa", KEY)}`);
		expect(await a.check()).toBeUndefined();
	});

	it("answers no one without the cell's token, and never with the cell's secret itself", async () => {
		const url = await controlPlane(new Recorder());
		await expect(new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_B }).run(KEY, "x", { timeoutS: 5 })).rejects.toThrow("HTTP 404");
		await expect(new RemoteComputerProvider({ url, tenant: "zzzz", cellSecret: SECRET_A }).run(KEY, "x", { timeoutS: 5 })).rejects.toThrow("HTTP 404");
		const raw = await fetch(`${url}/internal/computer/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET_A}`, "x-annie-tenant": "aaaa" }, body: JSON.stringify({ key: KEY, command: "x", timeoutS: 5 }) });
		expect(raw.status).toBe(404);
		// Through a tenant's own host the cell's internal paths stay closed.
		const viaTenant = await fetch(`${url}/internal/computer/check`, { headers: { host: "aaaa.annie.test" } });
		expect(viaTenant.status).toBe(404);
	});

	it("says what the person can act on, hides the rest, and checks keys, paths and sizes", async () => {
		const url = await controlPlane(new Recorder());
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		await expect(a.run(KEY, "rifiuta", { timeoutS: 5 })).rejects.toThrow(ComputerError);
		await expect(a.run(KEY, "rompi", { timeoutS: 5 })).rejects.toThrow(/HTTP 502 il computer non risponde$/);
		await expect(a.run("non-una-chiave", "x", { timeoutS: 5 })).rejects.toThrow("HTTP 400");
		await expect(a.put(KEY, [{ path: "../fuori", data: Buffer.from("x") }])).rejects.toThrow("percorso non valido");
		await expect(a.get(KEY, "x", 999 * 1024 * 1024)).rejects.toThrow("HTTP 400");
	});

	it("ends the command when the cell lets go, and lets a tenant run two at a time", async () => {
		const recorder = new Recorder();
		let release = () => {};
		recorder.hold = new Promise((resolve) => (release = resolve));
		const url = await controlPlane(recorder);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		const cancel = new AbortController();
		const first = a.run(KEY, "uno", { timeoutS: 60, signal: cancel.signal }).catch(() => "annullato");
		const second = a.run(KEY, "due", { timeoutS: 60 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect(a.run(KEY, "tre", { timeoutS: 60 })).rejects.toThrow("altri comandi in corso");
		// Another tenant is not held up.
		const b = new RemoteComputerProvider({ url, tenant: "bbbb", cellSecret: SECRET_B });
		const other = b.run(KEY, "suo", { timeoutS: 60 });
		cancel.abort();
		expect(await first).toBe("annullato");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(recorder.aborted).toBe(true);
		release();
		expect((await second).exitCode).toBe(0);
		expect((await other).exitCode).toBe(0);
	});

	it("runs nothing for a tenant whose trial is over", async () => {
		const past = new Date(Date.now() - 40 * 86_400_000).toISOString();
		const recorder = new Recorder();
		const billing = new StripeBilling({ secretKey: "sk_test_annie", webhookSecret: "whsec_test_annie", price: "price_flat", trialDays: 14, apiBase: "http://127.0.0.1:1" });
		const url = await controlPlane(recorder, { billingSince: past, accounts: [{ email: "a@x.example", tenant: "aaaa", createdAt: past }] }, billing);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		await expect(a.run(KEY, "x", { timeoutS: 5 })).rejects.toThrow("periodo di prova è finito");
		expect(recorder.calls).toEqual([]);
	});
});

describe("computer settings", () => {
	it("reads Docker, Fly and the cell's computers, and refuses what Fly cannot give", () => {
		expect(loadComputerConfig({ ANNIE_COMPUTER: "docker" })).toMatchObject({ kind: "docker", image: "annie-computer:latest" });
		const fly = { ANNIE_COMPUTER: "fly", FLY_API_TOKEN: "t", ANNIE_FLY_ORG: "annie", ANNIE_COMPUTER_IMAGE: "registry.fly.io/annie-computer:fly" };
		expect(loadComputerConfig(fly)).toEqual({ kind: "fly", token: "t", org: "annie", region: "fra", image: "registry.fly.io/annie-computer:fly", memoryMb: 1024, cpus: 1, diskMb: 2048 });
		expect(() => loadComputerConfig({ ...fly, ANNIE_COMPUTER_IMAGE: "" })).toThrow(ConfigError);
		expect(() => loadComputerConfig({ ...fly, ANNIE_COMPUTER_MEMORY_MB: "1000" })).toThrow("256");
		expect(() => loadComputerConfig({ ...fly, ANNIE_COMPUTER_CPUS: "0.5" })).toThrow("whole CPUs");
		expect(() => loadComputerConfig({ ANNIE_COMPUTER: "cloud", ANNIE_COMPUTER_URL: "https://annie.example" })).toThrow("ANNIE_CELL_SECRET");
		expect(() => loadComputerConfig({ ANNIE_COMPUTER: "podman" })).toThrow("docker or fly");
		const cell = loadAnnieConfig({ ANNIE_MODEL_PROVIDER: "faux", ANNIE_TENANT_ID: "aaaa", ANNIE_CELL_SECRET: SECRET_A, ANNIE_COMPUTER: "cloud", ANNIE_COMPUTER_URL: "https://annie.example/" });
		expect(cell.computer).toEqual({ kind: "cloud", url: "https://annie.example" });
		expect(createComputerProvider(cell.computer as NonNullable<typeof cell.computer>, { tenant: "aaaa", cellSecret: SECRET_A })).toBeInstanceOf(RemoteComputerProvider);
	});
});
