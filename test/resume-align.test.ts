import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import type { AnnieTool, EngineReply } from "../src/core/engine.ts";
import { tempDataDir, waitFor } from "./helpers.ts";

const DEV = { provider: "faux", modelId: "annie-dev" };
const GROK = { provider: "xai", modelId: "grok-4.7" };

/** A tool that holds the turn until the session closes, or answers at once. */
function hold(blocking: boolean, started: () => void = () => {}): AnnieTool {
	return {
		name: "hold",
		description: "Wait",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		execute: async (_args, { signal }) => {
			if (!blocking) return "ok";
			started();
			return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		},
	};
}

describe("resume after the configuration changed", () => {
	it("aligns every pending conversation before any of them runs again", async () => {
		const storageDir = tempDataDir();
		// 1. Two chats left mid-turn on the local model.
		let holding = 0;
		const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
		await first.submit("web:t1", "/tool hold {}");
		await first.submit("web:t2", "/tool hold {}");
		await waitFor(() => holding === 2);
		await first.close();

		// 2. Meanwhile t2 got its own model, which has no key here: it cannot answer. Checking it
		// takes a while, so t2 is aligned well after t1.
		const second = await piDurableEngine.open({
			storageDir,
			model: DEV,
			apiKey: async () => undefined,
			tools: [hold(false)],
			modelUsable: () => new Promise((resolve) => setTimeout(() => resolve(true), 300)),
		});
		await second.setThreadModel("web:t2", GROK);
		const replies: EngineReply[] = [];
		second.onReply((reply) => replies.push(reply));
		expect(await second.resume()).toEqual({ pending: 2 });
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		// Started before its alignment, t2 would have finished on the local model.
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "unanswered" });
		await second.close();
	});
});
