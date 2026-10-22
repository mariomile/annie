/**
 * Deferred tools (ADR 0100): a tool marked deferred is not offered to the model until it loads it
 * with tool_search; once loaded it stays for the conversation.
 */
import { describe, expect, it } from "vitest";
import type { AnnieTool } from "../src/core/index.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

function tool(name: string, calls: string[], deferred?: true): AnnieTool {
	return {
		name,
		description: `The ${name} register.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		...(deferred === undefined ? {} : { deferred }),
		async execute() {
			calls.push(name);
			return `${name} ok`;
		},
	};
}

describe("deferred tools (ADR 0100)", () => {
	it("a deferred tool runs only after tool_search loads it by name, alone, and stays loaded in the conversation", async () => {
		const calls: string[] = [];
		const { runtime, replies } = await runtimeWithInstance({ tools: [tool("near_tool", calls), tool("fatture_registro", calls, true), tool("fatture_archivio", calls, true)] });
		const say = async (text: string, messageId: string, count: number) => {
			await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text, messageId });
			await waitFor(() => replies.length === count);
		};
		await say("/tool fatture_registro {}", "1", 1);
		expect(calls).toEqual([]);
		await say('/tool tool_search {"query":"fatture_registro"}', "2", 2);
		await say("/tool fatture_registro {}", "3", 3);
		await say("/tool near_tool {}", "4", 4);
		// The exact name loaded that tool only, not its neighbours.
		await say("/tool fatture_archivio {}", "5", 5);
		await runtime.close();
		expect(calls).toEqual(["fatture_registro", "near_tool"]);
	});
});
