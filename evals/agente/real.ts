/**
 * Nightly eval of the general agent with the real model (ADR 0099). Annie starts as `pnpm start`
 * starts her, in a temp dir; each case is a new web chat with one message. What the turn called
 * comes from its record in the usage ledger (ADR 0098). Measured: whether the first tool is one the
 * case accepts (no tool, for the cases that need none), and what the run cost.
 * Writes last-report/agente.json and exits 1 when the accuracy is under the gate.
 *
 * PR CI never runs this. Without ANNIE_JUDGE_MODEL_KEY (an Anthropic key) it skips.
 */
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AuditLog } from "../../src/core/audit.ts";
import { tenantId } from "../../src/core/ids.ts";
import { tenantDir } from "../../src/core/paths.ts";
import { UsageLedger } from "../../src/core/usage.ts";
import { bootAnnie, loadCases, root } from "./annie.ts";

const key = process.env.ANNIE_JUDGE_MODEL_KEY;
if (!key) {
	console.log("eval:agente:real skipped (no ANNIE_JUDGE_MODEL_KEY)");
	process.exit(0);
}

const GATE = { firstToolAccuracy: 0.8 };
const TURN_TIMEOUT_MS = 180_000;
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const cases = (await loadCases()).filter((c) => only.length === 0 || only.includes(c.id));

const { annie, dataDir } = await bootAnnie({ ANNIE_MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: key, ...(process.env.ANNIE_MODEL_ID ? { ANNIE_MODEL_ID: process.env.ANNIE_MODEL_ID } : {}) });
const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: annie.ownerLink?.split("#")[1] }) });
if (login.status !== 200) throw new Error(`login: ${login.status}`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
const api = async (path: string, body?: unknown) => {
	const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	if (!res.ok) throw new Error(`${path}: ${res.status}`);
	return (await res.json()) as Record<string, any>;
};
const audit = new AuditLog(dataDir, tenantId("default"));
const ledger = new UsageLedger(tenantDir(dataDir, tenantId("default")));
// How the case's turn ended: its ledger record when answered, its reason when not. Matched by thread, so a late answer never lands on another case.
const outcome = async (threadId: string) => {
	const turn = (await ledger.records()).find((r) => r.role === "agent" && r.instanceId === "annie" && r.threadId === threadId);
	if (turn !== undefined) return { turn };
	// The ledger is written before the reply: a reply alone is a turn that failed, or one the engine could not measure.
	for (const r of await audit.read()) {
		if (r.instanceId === "annie" && r.threadId === threadId && r.type === "reply.emitted") return { error: r.status === "unanswered" ? String(r.reason ?? "unanswered") : "answered without usage" };
	}
	return undefined;
};

type Row = { id: string; expect: string[]; tools: string[]; firstTool: string | null; ok: boolean; costUsd: number; modelCalls: number; error?: string };
const rows: Row[] = [];
for (const c of cases) {
	const thread = (await api("/api/instances/annie/threads", {})).thread as { id: string };
	await api(`/api/instances/annie/threads/${thread.id}/messages`, { text: c.text });
	const start = Date.now();
	let found: Awaited<ReturnType<typeof outcome>>;
	while (found === undefined && Date.now() - start < TURN_TIMEOUT_MS) {
		await new Promise((r) => setTimeout(r, 500));
		found = await outcome(thread.id);
	}
	const error = found === undefined ? `no answer in ${TURN_TIMEOUT_MS / 1000}s` : found.error;
	if (found?.turn === undefined) {
		rows.push({ id: c.id, expect: c.expect, tools: [], firstTool: null, ok: false, costUsd: 0, modelCalls: 0, error });
		console.log(`✗ ${c.id}: ${error}`);
		continue;
	}
	const turn = found.turn;
	const tools = [...(turn.tools ?? [])];
	// tool_search only loads a deferred tool (ADR 0100): the first tool is the first one it then uses.
	const firstTool = tools.find((t) => t !== "tool_search") ?? tools[0] ?? null;
	const ok = c.expect.length === 0 ? firstTool === null : firstTool !== null && c.expect.includes(firstTool);
	rows.push({ id: c.id, expect: c.expect, tools, firstTool, ok, costUsd: turn.estimatedUsd, modelCalls: turn.modelCalls ?? 0 });
	console.log(`${ok ? "✓" : "✗"} ${c.id}: ${firstTool ?? "(nessuno)"}${ok ? "" : `, atteso ${c.expect.length === 0 ? "nessuno" : c.expect.join(" o ")}`}`);
}
await annie.stop();

const accuracy = rows.length === 0 ? 0 : rows.filter((r) => r.ok).length / rows.length;
const costUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
const report = { at: new Date().toISOString(), model: process.env.ANNIE_MODEL_ID ?? "default", cases: rows.length, firstToolAccuracy: accuracy, costUsd, gate: GATE, pass: accuracy >= GATE.firstToolAccuracy, rows };
await mkdir(join(root, "last-report"), { recursive: true });
await writeFile(join(root, "last-report", "agente.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`eval:agente:real: primo strumento giusto ${(accuracy * 100).toFixed(0)}% (soglia ${GATE.firstToolAccuracy * 100}%), ${rows.length} casi, $${costUsd.toFixed(4)}`);
process.exit(report.pass ? 0 : 1);
