import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import type { AnnieTool, EngineOpenOptions, EngineReply } from "../src/core/engine.ts";
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

/**
 * Two chats left mid-turn on the local model; meanwhile t2 got its own model, which has no
 * key here: on it t2 cannot answer, on the old one it would.
 */
async function leftMidTurn(): Promise<{ storageDir: string; s1: string; s2: string }> {
	const storageDir = tempDataDir();
	let holding = 0;
	const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
	const { submissionId: s1 } = await first.submit("web:t1", "/tool hold {}");
	const { submissionId: s2 } = await first.submit("web:t2", "/tool hold {}");
	await waitFor(() => holding === 2);
	await first.setThreadModel("web:t2", GROK);
	await first.close();
	return { storageDir, s1, s2 };
}

const reopen = (storageDir: string, modelUsable?: EngineOpenOptions["modelUsable"]) =>
	piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(false)], ...(modelUsable === undefined ? {} : { modelUsable }) });

describe("restart after the configuration changed", () => {
	it("resume(): every pending conversation is aligned before any of them runs again", async () => {
		const { storageDir } = await leftMidTurn();
		const replies: EngineReply[] = [];
		let resuming = false;
		// Checking t2's model during resume() is held until t1 has answered (or a second, when
		// nothing runs yet): had the scheduler started before t2 was aligned, t2 would answer on
		// the old model meanwhile.
		const session = await reopen(storageDir, async () => {
			if (resuming) await waitFor(() => replies.length > 0, 1_000).catch(() => {});
			return true;
		});
		session.onReply((reply) => replies.push(reply));
		resuming = true;
		expect(await session.resume()).toEqual({ pending: 2 });
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "unanswered" });
		await session.close();
	});

	it("reattach() before resume(), the runtime's order: the work goes on with the configuration of now", async () => {
		const { storageDir, s1, s2 } = await leftMidTurn();
		const session = await reopen(storageDir);
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		expect(await session.reattach(s1, "web:t1")).toBe(true);
		expect(await session.reattach(s2, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "unanswered" });
		expect(await session.resume()).toEqual({ pending: 0 });
		await session.close();
	});
});
