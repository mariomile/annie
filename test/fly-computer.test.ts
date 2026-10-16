import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlyComputerProvider } from "../src/computer/fly-computer.ts";
import { fakeFly, runProcess } from "./fake-fly.ts";

/**
 * The computer on micro-VMs (ADR 0015), against a stand-in for Fly's Machines API whose execs
 * run docker/annie-run.py here: a state folder and a /work per app, the runner as it runs in the
 * machine. Run as root, the runner drops to uid 1000 as it does there.
 */
const root = mkdtempSync(join(tmpdir(), "fly-computer-"));
// uid 1000 reaches its /work through here, as it does on the machine.
chmodSync(root, 0o755);
const runner = join(import.meta.dirname, "..", "docker", "annie-run.py");
const asRoot = process.getuid?.() === 0;
const dirs = (app: string) => ({ state: join(root, app, "state"), work: join(root, app, "work") });
const booted: string[] = [];
const backend = {
	async boot(app: string) {
		const { state, work } = dirs(app);
		booted.push(app);
		mkdirSync(state, { recursive: true, mode: 0o700 });
		if (!existsSync(work)) {
			mkdirSync(work, { recursive: true });
			if (asRoot) {
				chmodSync(join(root, app), 0o755);
				chownSync(work, 1000, 1000);
			}
		}
		// What annie-fly-init leaves once the machine is cut off the network.
		writeFileSync(join(state, "sealed"), "");
	},
	exec(app: string, command: readonly string[], stdin: string) {
		const { state, work } = dirs(app);
		if (command[0] !== "annie-run") return Promise.resolve({ exit_code: 127, stdout: "", stderr: "not found" });
		return runProcess("python3", [runner, ...command.slice(1)], stdin, { ANNIE_RUN_STATE: state, ANNIE_RUN_WORK: work });
	},
	async destroy(app: string) {
		rmSync(join(root, app), { recursive: true, force: true });
	},
};

let fly: Awaited<ReturnType<typeof fakeFly>>;
const computer = (extra: Partial<ConstructorParameters<typeof FlyComputerProvider>[0]> = {}) =>
	new FlyComputerProvider({ token: "fly-test-token", org: "annie", region: "fra", image: "registry.fly.io/annie-computer:fly", apiUrl: fly.url, waitSliceS: 1, chunkBytes: 10, diskMb: 1, ...extra });

beforeAll(async () => {
	fly = await fakeFly(backend);
});
afterAll(async () => {
	await fly.close();
	rmSync(root, { recursive: true, force: true });
});

describe("the computer on a Fly machine", () => {
	it("creates an app on a network of its own, a volume and a machine with no service, then runs as uid 1000 in /work", async () => {
		const c = computer();
		const run = await c.run("aaaa1111", "id -u; pwd; echo errore >&2; exit 3", { timeoutS: 10 });
		expect(run).toMatchObject({ exitCode: 3, stderr: "errore\n", timedOut: false, killed: false, truncated: false, diskFull: false });
		expect(run.stdout).toBe(`${asRoot ? 1000 : process.getuid?.()}\n${dirs("annie-computer-aaaa1111").work}\n`);
		const app = fly.apps.get("annie-computer-aaaa1111");
		expect(app).toMatchObject({ network: "annie-computer-aaaa1111", org: "annie" });
		expect(app?.volumes).toEqual([{ id: expect.any(String), size_gb: 1, region: "fra", encrypted: true }]);
		const config = app?.machines[0]?.config as Record<string, unknown>;
		expect(config).toMatchObject({
			image: "registry.fly.io/annie-computer:fly",
			services: [],
			restart: { policy: "no" },
			mounts: [{ volume: app?.volumes[0]?.id, path: "/work" }],
			guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
			env: { ANNIE_IDLE_S: "600" },
			metadata: { annie_computer: "aaaa1111" },
		});
		// A second command reuses the machine.
		expect((await c.run("aaaa1111", "echo di nuovo", { timeoutS: 10 })).stdout).toBe("di nuovo\n");
		expect(app?.machines).toHaveLength(1);
	});

	it("waits past one slice of Fly's exec, kills at its time, and ends what a command left running", async () => {
		const c = computer();
		const long = await c.run("bbbb2222", "sleep 2.5; echo fatto", { timeoutS: 30 });
		expect(long).toMatchObject({ exitCode: 0, stdout: "fatto\n" });
		expect(fly.calls.filter((call) => call.endsWith("/exec")).length).toBeGreaterThan(3);
		const slow = await c.run("bbbb2222", "sleep 30", { timeoutS: 2 });
		expect(slow).toMatchObject({ exitCode: 137, timedOut: true, killed: false });
		if (asRoot) {
			await c.run("bbbb2222", "(sleep 60 &) ; echo via", { timeoutS: 10 });
			const left = await c.run("bbbb2222", "ps -u 1000 -o stat=,comm= | grep -v '^Z' | grep -c sleep || true", { timeoutS: 10 });
			expect(left.stdout.trim()).toBe("0");
		}
	});

	it("stops a command when the conversation is cancelled", async () => {
		const c = computer();
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 1200);
		const started = Date.now();
		const run = await c.run("cccc3333", "sleep 30", { timeoutS: 60, signal: abort.signal });
		expect(run).toMatchObject({ exitCode: null, timedOut: true });
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("keeps the start of stdout and the end of stderr", async () => {
		const run = await computer().run("dddd4444", "python3 -c \"import sys; print('a' * 100000); sys.stderr.write('b' * 100000 + 'FINE')\"", { timeoutS: 30 });
		expect(run.truncated).toBe(true);
		expect(run.stdout.length).toBe(64 * 1024);
		expect(run.stderr.endsWith("FINE")).toBe(true);
		expect(run.stderr.length).toBe(64 * 1024);
	});

	it("copies files in and out in pieces, and refuses folders, links and missing files", async () => {
		const c = computer();
		const data = Buffer.from("una riga di dati che non sta in un pezzo solo\n".repeat(3));
		await c.put("eeee5555", [
			{ path: "dati/vendite.csv", data },
			{ path: "vuoto.txt", data: new Uint8Array() },
		]);
		const run = await c.run("eeee5555", "wc -c < dati/vendite.csv; wc -c < vuoto.txt; ln -s /etc/passwd link; mkdir -p cartella", { timeoutS: 10 });
		expect(run.stdout).toBe(`${data.length}\n0\n`);
		expect(Buffer.from(await c.get("eeee5555", "dati/vendite.csv", 1024))).toEqual(data);
		expect((await c.get("eeee5555", "vuoto.txt", 10)).length).toBe(0);
		await expect(c.get("eeee5555", "dati/vendite.csv", 20)).rejects.toThrow("più grande");
		await expect(c.get("eeee5555", "cartella", 1024)).rejects.toThrow("cartella");
		await expect(c.get("eeee5555", "link", 1024)).rejects.toThrow("collegamento");
		await expect(c.get("eeee5555", "manca.txt", 1024)).rejects.toThrow("non c'è");
		await expect(c.put("eeee5555", [{ path: "../fuori", data }])).rejects.toThrow("percorso non valido");
	});

	it("marks the disk full past its quota and refuses more files until some are deleted", async () => {
		const c = computer();
		const run = await c.run("ffff6666", "head -c 2000000 /dev/zero > grande.bin", { timeoutS: 10 });
		expect(run.diskFull).toBe(true);
		await expect(c.put("ffff6666", [{ path: "altro.txt", data: Buffer.from("x") }])).rejects.toThrow("disco del computer è pieno");
		expect((await c.run("ffff6666", "rm grande.bin", { timeoutS: 10 })).diskFull).toBe(false);
		await c.put("ffff6666", [{ path: "altro.txt", data: Buffer.from("x") }]);
	});

	it("starts a machine that stopped by itself, and keeps the files", async () => {
		const c = computer();
		await c.put("gggg7777", [{ path: "resta.txt", data: Buffer.from("ciao") }]);
		fly.stopMachine("annie-computer-gggg7777");
		expect((await c.run("gggg7777", "cat resta.txt", { timeoutS: 10 })).stdout).toBe("ciao");
		expect(fly.calls).toContain(`POST /v1/apps/annie-computer-gggg7777/machines/${fly.apps.get("annie-computer-gggg7777")?.machines[0]?.id}/start`);
	});

	it("updates the machine when the image changes, on the same volume", async () => {
		await computer().put("hhhh8888", [{ path: "resta.txt", data: Buffer.from("ciao") }]);
		const before = fly.apps.get("annie-computer-hhhh8888")?.machines[0];
		const c = computer({ image: "registry.fly.io/annie-computer:nuova" });
		expect((await c.run("hhhh8888", "cat resta.txt", { timeoutS: 10 })).stdout).toBe("ciao");
		const app = fly.apps.get("annie-computer-hhhh8888");
		expect(app?.machines).toHaveLength(1);
		expect(app?.machines[0]?.id).toBe(before?.id);
		expect(app?.machines[0]?.config).toMatchObject({ image: "registry.fly.io/annie-computer:nuova", mounts: [{ volume: app?.volumes[0]?.id }] });
		expect(app?.volumes).toHaveLength(1);
	});

	it("reset deletes the app with its machine and volume; check tells a bad token apart", async () => {
		const c = computer();
		await c.run("iiii9999", "touch x", { timeoutS: 10 });
		await c.reset("iiii9999");
		expect(fly.apps.has("annie-computer-iiii9999")).toBe(false);
		expect(await c.check()).toBeUndefined();
		expect(await computer({ token: "sbagliato" }).check()).toContain("token");
	});

	it("never runs a command on a machine that is not sealed off the network", async () => {
		const c = computer();
		await c.put("jjjj0000", [{ path: "x", data: Buffer.from("x") }]);
		rmSync(join(dirs("annie-computer-jjjj0000").state, "sealed"));
		await expect(c.run("jjjj0000", "echo no", { timeoutS: 10 })).rejects.toThrow("not cut off from the network");
	}, 20_000);

	it("refuses limits Fly cannot give", () => {
		expect(() => computer({ memoryMb: 1000 })).toThrow("256");
		expect(() => computer({ cpus: 0.5 })).toThrow("CPU");
		expect(() => computer({ region: "Frankfurt" })).toThrow("region");
	});
});
