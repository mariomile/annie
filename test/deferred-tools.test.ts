/**
 * Deferred tools (ADR 0100): a tool marked deferred is not offered to the model until it loads it
 * with tool_search; once loaded it stays for the conversation.
 */
import { describe, expect, it } from "vitest";
import { toolSearch } from "../src/core/adapters/pi-durable.ts";
import type { AnnieTool } from "../src/core/index.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

function tool(name: string, calls: string[], deferred?: true): AnnieTool {
	return {
		name,
		description: `The ${name} register.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		deferred,
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

	describe("tool_search", () => {
		const registers = [
			{ ...tool("fatture_registro", []), description: "Le fatture da pagare o incassare: elenco e scadenze. Altro testo che non va nell'elenco.", deferred: true as const },
			{ ...tool("magazzino_giacenze", []), description: "Il magazzino, quante unità restano di un articolo.\nSeconda riga.", deferred: true as const },
		];
		const search = toolSearch(registers);
		const run = async (query: string, limit?: number) => {
			const api = { agent: async () => ({ deferred: registers }) };
			return search.execute({ query, ...(limit === undefined ? {} : { limit }) }, api as never, {} as never);
		};

		it("lists each deferred tool with its first sentence, whole", () => {
			expect(search.description).toContain("- fatture_registro: Le fatture da pagare o incassare\n");
			expect(search.description).not.toContain("elenco e scadenze");
			expect(search.description).toContain("- magazzino_giacenze: Il magazzino, quante unità restano di un articolo");
			expect(search.description).not.toContain("Seconda riga");
		});

		it("loads only the tools named, once each", async () => {
			const result = await run("fatture_registro, fatture_registro");
			expect(result.control).toEqual({ addTools: ["fatture_registro"] });
		});

		it("falls back to the free-text search for anything else", async () => {
			const result = await run("magazzino unità articolo");
			expect(result.control).toEqual({ addTools: ["magazzino_giacenze"] });
			expect((await run("zzzz")).control).toBeUndefined();
		});
	});
});
