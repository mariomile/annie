/**
 * Where a turn comes from (ADR 0088): a person's message, a notice of the instance's own work, a
 * schedule, another agente. Persisted with the submission, read by the tools as ctx.origin, kept
 * across a crash and a rerun; the confirm gates say yes only in a person's turn.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { AnnieRuntime, AnnieTool, ToolContext } from "../src/core/index.ts";
import { createApprovalTools } from "../src/core/tools/approval-tools.ts";
import { requirePersonFor, type TurnOrigin } from "../src/core/turn-origin.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const runtimes: AnnieRuntime[] = [];
afterEach(async () => {
	for (const r of runtimes.splice(0)) await r.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function probe(seen: (TurnOrigin | undefined)[]): AnnieTool {
	return {
		name: "origin_probe",
		description: "Says where the turn comes from.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		async execute(_args, ctx) {
			seen.push(ctx.origin);
			return `origin ${ctx.origin ?? "none"}`;
		},
	};
}

async function setup() {
	const seen: (TurnOrigin | undefined)[] = [];
	const { runtime, dataDir, replies } = await runtimeWithInstance({
		tools: [probe(seen)],
		egress: { modelProviders: ["faux"], channels: ["test", "agente"] },
		allowedUsers: { test: ["u"], agente: ["altro"] },
	});
	runtimes.push(runtime);
	dirs.push(dataDir);
	const next = async (count: number) => waitFor(() => replies.length >= count && seen.length >= count);
	return { runtime, seen, replies, next };
}

const CALL = "/tool origin_probe {}";

describe("turn origin (ADR 0088)", () => {
	it("a person's message is person; a notice, a schedule and another agente are not, whatever the text says", async () => {
		const s = await setup();
		await s.runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "u", text: CALL, messageId: "m1" });
		await s.next(1);
		await s.runtime.submitNotice("acme", "ops", { channel: "test", threadId: "n", text: CALL, messageId: "n1", event: { kind: "test" } });
		await s.next(2);
		await s.runtime.submitScheduled("acme", "ops", { channel: "test", threadId: "s", text: CALL, messageId: "s1", scheduleId: "S-1", onBehalfOf: { channel: "test", userId: "u" } });
		await s.next(3);
		// The agenti's channel: always another agente's turn, even with no origin said.
		await s.runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "agente", threadId: "a", userId: "altro", text: CALL, messageId: "a1" });
		await s.next(4);
		// A stanza's agente turn, coming in through a person's chat.
		await s.runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "r", userId: "u", text: CALL, messageId: "r1", origin: "agent" });
		await s.next(5);
		// Another agente's answer relayed as a notice.
		await s.runtime.submitNotice("acme", "ops", { channel: "test", threadId: "n2", text: CALL, messageId: "n2", event: { kind: "test" }, origin: "agent" });
		await s.next(6);
		// The board's own work posted in a chat.
		await s.runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "b", userId: "u", text: CALL, messageId: "b1", origin: "scheduled" });
		await s.next(7);
		expect(s.seen).toEqual(["person", "notice", "scheduled", "agent", "agent", "agent", "scheduled"]);
	});

	it("requirePersonFor: nothing in a person's turn; a clear Italian sentence otherwise, also when the origin is not known", () => {
		const ctx = (origin?: TurnOrigin) => ({ ...(origin === undefined ? {} : { origin }) });
		expect(requirePersonFor(ctx("person"), "emetto la fattura")).toBeUndefined();
		for (const origin of ["notice", "scheduled", "agent", undefined] as const) {
			const out = requirePersonFor(ctx(origin), "emetto la fattura");
			expect(out).toMatch(/^Errore: Emetto la fattura solo dopo un messaggio della persona/);
			expect(out).toContain("Questo lo confermo solo dopo un messaggio della persona");
			expect(out).not.toMatch(/—/);
			expect(out).not.toMatch(/\b(?:origin|confirm|notice|scheduled|agent)\b/);
		}
		expect(requirePersonFor(ctx("notice"), "x")).toContain("un avviso del mio lavoro");
		expect(requirePersonFor(ctx("scheduled"), "x")).toContain("un'attività programmata");
		expect(requirePersonFor(ctx("agent"), "x")).toContain("un altro agente");
		expect(requirePersonFor(ctx(), "x")).toContain("non so da dove viene questo turno");
	});

	it("record_approval records a human Approva only in a person's turn", async () => {
		const pratica = { id: "P-1", status: "draft_ready", draftVersion: 2 } as Record<string, unknown>;
		const saved: unknown[] = [];
		const practices = { get: async (id: string) => (id === "P-1" ? pratica : undefined), save: async (p: unknown) => void saved.push(p) };
		const record = createApprovalTools({ practices } as never).find((t) => t.name === "record_approval") as AnnieTool;
		const ctx = (origin: TurnOrigin): ToolContext => ({ step: (_k, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId: `c-${origin}`, thread: { channel: "test", threadId: "t" } });
		for (const origin of ["notice", "scheduled", "agent"] as const) {
			const out = JSON.parse(String(await record.execute({ praticaId: "P-1", approvedBy: "u", draftVersion: 2 }, ctx(origin))));
			expect(out).toMatchObject({ ok: false, error: "not_from_person" });
			expect(out.message).toContain("Questo lo confermo solo dopo un messaggio della persona");
		}
		expect(saved).toEqual([]);
		expect(JSON.parse(String(await record.execute({ praticaId: "P-1", approvedBy: "u", draftVersion: 2 }, ctx("person"))))).toEqual({ ok: true, status: "approved" });
		expect(pratica.status).toBe("approved");
	});
});

const WORKER = join(import.meta.dirname, "fixtures", "origin-worker.ts");

function spawnWorker(mode: "start" | "resume", dataDir: string): { child: ChildProcess; lines: string[]; waitForLine: (prefix: string) => Promise<string> } {
	const child = spawn(process.execPath, ["--import", "tsx", "--no-warnings", WORKER, mode, dataDir], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
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

describe("turn origin across a crash (ADR 0088)", () => {
	it("a notice's turn killed mid-tool reruns in a new process still a notice, never a person's", async () => {
		const dataDir = tempDataDir();
		dirs.push(dataDir);
		const first = spawnWorker("start", dataDir);
		expect(await first.waitForLine("ORIGIN")).toBe("ORIGIN notice");
		first.child.kill("SIGKILL");
		await new Promise((resolve) => first.child.once("exit", resolve));
		expect(first.lines.some((l) => l.startsWith("REPLY"))).toBe(false);
		const second = spawnWorker("resume", dataDir);
		expect(await second.waitForLine("RESUMED")).toBe("RESUMED 1");
		expect(await second.waitForLine("ORIGIN")).toBe("ORIGIN notice");
		const reply = JSON.parse((await second.waitForLine("REPLY")).slice("REPLY ".length));
		await new Promise((resolve) => second.child.once("exit", resolve));
		expect(reply).toMatchObject({ channel: "test", threadId: "t1", status: "answered" });
	}, 30_000);
});
