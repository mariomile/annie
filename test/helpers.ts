import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { type AnnieTool, AnnieRuntime, type EgressPolicy, type Reply } from "../src/core/index.ts";

export function tempDataDir(): string {
	return mkdtempSync(join(tmpdir(), "annie-test-"));
}

export const FAUX_MODEL = { provider: "faux", modelId: "annie-dev" } as const;

/** A runtime with one tenant and one instance on the local deterministic model. */
export async function runtimeWithInstance(options: {
	dataDir?: string;
	tenant?: string;
	instance?: string;
	egress?: EgressPolicy;
	tools?: AnnieTool[];
}): Promise<{ runtime: AnnieRuntime; dataDir: string; replies: Reply[] }> {
	const dataDir = options.dataDir ?? tempDataDir();
	const runtime = new AnnieRuntime({ dataDir, engine: piDurableEngine, tools: options.tools ?? [] });
	const tenant = options.tenant ?? "acme";
	const instance = options.instance ?? "ops";
	await runtime.registry.createTenant({ id: tenant, name: tenant });
	await runtime.registry.createInstance(tenant, {
		id: instance,
		name: instance,
		model: FAUX_MODEL,
		egress: options.egress ?? { modelProviders: ["faux"], channels: ["test"] },
	});
	const replies: Reply[] = [];
	runtime.onReply((reply) => replies.push(reply));
	return { runtime, dataDir, replies };
}

export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
