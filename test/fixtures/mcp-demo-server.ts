/**
 * A tiny MCP server for tests, with two tools: add (numbers) and whoami (echoes the
 * DEMO_TOKEN env var or the Authorization header it received). Run over stdio when started
 * as a process; createDemoServer() is also used in-process over HTTP.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function createDemoServer(identity: () => string): Server {
	const server = new Server({ name: "demo", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
			{ name: "whoami", description: "Who is calling", inputSchema: { type: "object", properties: {} } },
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name === "add") {
			const { a, b } = request.params.arguments as { a: number; b: number };
			return { content: [{ type: "text", text: String(a + b) }] };
		}
		if (request.params.name === "whoami") return { content: [{ type: "text", text: identity() }] };
		return { content: [{ type: "text", text: "unknown tool" }], isError: true };
	});
	return server;
}

if (process.argv[2] === "stdio") {
	await createDemoServer(() => `env:${process.env.DEMO_TOKEN ?? "none"} leak:${process.env.ANNIE_SHOULD_NOT_LEAK ?? "none"}`).connect(new StdioServerTransport());
}
