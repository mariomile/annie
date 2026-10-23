/**
 * Shared by run.ts and real.ts: the cases, and Annie started in a temp dir as `pnpm start`
 * starts her, with the tools the general agent gets captured as the engine receives them.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAnnie } from "../../src/app.ts";
import { piDurableEngine } from "../../src/core/adapters/pi-durable.ts";
import type { DurableEngine } from "../../src/core/engine.ts";
import { instanceId, tenantId } from "../../src/core/ids.ts";
import { engineDir } from "../../src/core/paths.ts";
import { loadAnnieConfig } from "../../src/main/config.ts";

export const root = dirname(fileURLToPath(import.meta.url));

/** One request to the agent. `expect`: the tools any one of which is right as the first call; [] means none. */
export type AgentCase = { id: string; text: string; expect: string[] };

export async function loadCases(): Promise<AgentCase[]> {
	const raw = await readFile(join(root, "cases.jsonl"), "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as AgentCase);
}

export async function bootAnnie(env: Record<string, string>) {
	const dataDir = await mkdtemp(join(tmpdir(), "annie-eval-agente-"));
	const tools = new Map<string, string[]>();
	const engine: DurableEngine = {
		open: (options) => {
			tools.set(options.storageDir, options.tools.map((t) => t.name));
			return piDurableEngine.open(options);
		},
	};
	try {
		const config = loadAnnieConfig({ ...env, ANNIE_DATA_DIR: dataDir });
		const annie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { engine, schedulerIntervalMs: 3_600_000, log: () => {} });
		const general = tools.get(engineDir(dataDir, tenantId("default"), instanceId("annie"))) ?? [];
		const close = async () => { await annie.stop(); await rm(dataDir, { recursive: true, force: true }); };
		return { annie, dataDir, tools: general, close };
	} catch (error) {
		await rm(dataDir, { recursive: true, force: true });
		throw error;
	}
}
