import { afterEach, describe, expect, it, vi } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { AnnieRuntime, EgressDenied } from "../src/core/index.ts";
import { FAUX_MODEL, runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("egress policy", () => {
	it("denies everything by default: an instance created without a policy cannot reach any model", async () => {
		const dataDir = tempDataDir();
		const runtime = new AnnieRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "Acme" });
		const instance = await runtime.registry.createInstance("acme", { id: "ops", name: "Ops", model: FAUX_MODEL });
		expect(instance.egress).toEqual({ modelProviders: [], channels: [] });

		await expect(runtime.openInstance("acme", "ops")).rejects.toThrow(EgressDenied);
		await expect(runtime.openInstance("acme", "ops")).rejects.toMatchObject({ kind: "model_provider", target: "faux" });
		const audit = await runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "egress.denied", kind: "model_provider", target: "faux" }));
	});

	it("denies a model provider that is not the one explicitly allowed", async () => {
		const dataDir = tempDataDir();
		const runtime = new AnnieRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "Acme" });
		await runtime.registry.createInstance("acme", {
			id: "ops",
			name: "Ops",
			model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
			egress: { modelProviders: ["faux"], channels: ["telegram"] },
		});
		await expect(runtime.openInstance("acme", "ops")).rejects.toMatchObject({ kind: "model_provider", target: "anthropic" });
	});

	it("denies channels that are not explicitly allowed, before anything reaches the engine", async () => {
		const { runtime, replies } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: [] } });
		const message = { tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "1", userId: "u", text: "ciao" };
		await expect(runtime.submit(message)).rejects.toMatchObject({ name: "EgressDenied", kind: "channel", target: "telegram" });

		const audit = await runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "egress.denied", kind: "channel", target: "telegram" }));
		expect(audit.some((e) => e.type === "message.received")).toBe(false);
		expect(replies).toEqual([]);
		await runtime.close();
	});

	it("allowed traffic makes no network calls when the allowed model is local", async () => {
		const fetchSpy = vi.fn(async () => {
			throw new Error("network is not allowed in this test");
		});
		vi.stubGlobal("fetch", fetchSpy);
		const { runtime, replies } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["test"] } });
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "1", userId: "u", text: "ciao" });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "answered" });
		expect(fetchSpy).not.toHaveBeenCalled();
		await runtime.close();
	});
});
