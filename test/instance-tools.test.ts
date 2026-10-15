import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { type AnnieTool, AnnieRuntime, createSlowCounter, type InstanceRecord } from "../src/core/index.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const ask = (instanceId: string, messageId: string) => ({ tenantId: "acme", instanceId, channel: "test", threadId: "t", userId: "u", text: "conta fino a 2", messageId });

async function setup(tools: (record: InstanceRecord) => Promise<readonly AnnieTool[]>) {
	const runtime = new AnnieRuntime({ dataDir: tempDataDir(), engine: piDurableEngine, tools });
	await runtime.registry.createTenant({ id: "acme", name: "acme" });
	for (const id of ["a", "b"]) {
		await runtime.registry.createInstance("acme", { id, name: id, model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
	}
	const replies: Record<string, string[]> = { a: [], b: [] };
	runtime.onReply((r) => replies[r.instanceId]?.push(r.status === "answered" ? r.text : r.status === "unanswered" ? r.reason : r.path));
	return { runtime, replies };
}

describe("tools per instance", () => {
	it("each instance gets the tools computed from its own record", async () => {
		const { runtime, replies } = await setup(async (record) => (record.id === "a" ? [createSlowCounter({ stepMs: 1 })] : []));
		await runtime.submit(ask("a", "1"));
		await runtime.submit(ask("b", "1"));
		await waitFor(() => replies.a!.length === 1 && replies.b!.length === 1);
		expect(replies.a![0]).toBe("Fatto. Ho contato fino a 2.");
		expect(replies.b![0]).not.toContain("Ho contato");
		await runtime.close();
	});

	it("reopen applies a changed tool list; the instance keeps its conversations", async () => {
		let enabled = false;
		const { runtime, replies } = await setup(async () => (enabled ? [createSlowCounter({ stepMs: 1 })] : []));
		await runtime.submit(ask("b", "1"));
		await waitFor(() => replies.b!.length === 1);
		expect(replies.b![0]).not.toContain("Ho contato");
		enabled = true;
		// No channel confirmed the first reply: reopen hands it out again, like a restart would.
		expect(await runtime.reopen("acme", "b")).toMatchObject({ undelivered: 1 });
		await runtime.submit(ask("b", "2"));
		await waitFor(() => replies.b!.includes("Fatto. Ho contato fino a 2."));
		await runtime.close();
	});
});
