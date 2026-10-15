import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { AuditLog, tenantId } from "../src/core/index.ts";
import { tempDataDir } from "./helpers.ts";

const WORKER = join(import.meta.dirname, "fixtures", "crash-worker.ts");

function spawnWorker(mode: "start" | "resume", dataDir: string, effectsFile: string): { child: ChildProcess; lines: string[]; waitForLine: (prefix: string) => Promise<string> } {
	const child = spawn(process.execPath, ["--import", "tsx", "--no-warnings", WORKER, mode, dataDir, effectsFile], {
		cwd: join(import.meta.dirname, ".."),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	const waiters: { prefix: string; resolve: (line: string) => void }[] = [];
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	createInterface({ input: child.stdout! }).on("line", (line) => {
		lines.push(line);
		for (const waiter of waiters.filter((w) => line.startsWith(w.prefix))) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(line);
		}
	});
	const waitForLine = (prefix: string) =>
		new Promise<string>((resolve, reject) => {
			const found = lines.find((line) => line.startsWith(prefix));
			if (found !== undefined) return resolve(found);
			waiters.push({ prefix, resolve });
			child.once("exit", (code, signal) => reject(new Error(`worker exited (${code ?? signal}) before "${prefix}"\n${stderr}`)));
		});
	return { child, lines, waitForLine };
}

function effects(file: string): { pid: number; step: number }[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => {
			const [pid, step] = line.split(" ").map(Number) as [number, number];
			return { pid, step };
		});
}

describe("crash and resume", () => {
	it("a SIGKILLed run resumes in a new process without redoing checkpointed steps", async () => {
		const dataDir = tempDataDir();
		const effectsFile = join(dataDir, "effects.log");

		// 1. First process: start counting to 6, kill it hard right after step 3 is checkpointed.
		const first = spawnWorker("start", dataDir, effectsFile);
		await first.waitForLine("CHECKPOINT 3");
		first.child.kill("SIGKILL");
		await new Promise((resolve) => first.child.once("exit", resolve));
		expect(first.lines.some((line) => line.startsWith("REPLY"))).toBe(false);
		const beforeCrash = effects(effectsFile);
		expect(beforeCrash.map((e) => e.step)).toEqual([1, 2, 3]);

		// 2. Second process on the same storage: resume() continues the interrupted run.
		const second = spawnWorker("resume", dataDir, effectsFile);
		expect(await second.waitForLine("RESUMED")).toBe("RESUMED 1");
		const replyLine = await second.waitForLine("REPLY");
		await new Promise((resolve) => second.child.once("exit", resolve));

		const reply = JSON.parse(replyLine.slice("REPLY ".length));
		expect(reply).toMatchObject({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", status: "answered", text: "Fatto. Ho contato fino a 6." });

		// Every step ran exactly once; steps 1-3 by the first process, 4-6 by the second.
		const all = effects(effectsFile);
		expect(all.map((e) => e.step)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(new Set(all.slice(0, 3).map((e) => e.pid))).toEqual(new Set([first.child.pid]));
		expect(new Set(all.slice(3).map((e) => e.pid))).toEqual(new Set([second.child.pid]));

		const audit = await new AuditLog(dataDir, tenantId("acme")).read();
		expect(audit.find((e) => e.type === "instance.resumed")).toMatchObject({ pending: 1 });
	});
});
