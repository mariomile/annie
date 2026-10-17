import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";

/** A real, decodable PNG of this size, all black: what a screenshot looks like to the code that reads it. */
export function blackPng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 0;
	// One filter byte, then a row of grey pixels, per line.
	const raw = Buffer.alloc((width + 1) * height);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export const CUA_TOOLS = ["get_desktop_state", "click", "type_text", "press_key", "hotkey", "scroll", "move_cursor", "drag", "get_screen_size", "launch_app"];

export type FakeSpacesCall = { readonly method: string; readonly params?: any; readonly session?: string; readonly auth?: string; readonly protocol?: string };

/**
 * cua-spacesd as Annie uses it: GET /health, and MCP over plain HTTP POST at /mcp with a bearer
 * token and a session id it mints at `initialize`. Desktop tools answer with a screenshot.
 */
export async function fakeSpaces(options: { token?: () => string | undefined; tools?: readonly string[]; screen?: { width: number; height: number }; sse?: boolean; slowMs?: number; healthyAfter?: number } = {}) {
	const calls: FakeSpacesCall[] = [];
	const sessions = new Map<string, { initialized: boolean }>();
	const screen = options.screen ?? { width: 1280, height: 800 };
	let healthChecks = 0;
	let minted = 0;
	const read = (req: IncomingMessage) =>
		new Promise<string>((resolve) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});
	const server: Server = createServer(async (req, res) => {
		const body = await read(req);
		if (req.method === "GET" && req.url === "/health") {
			healthChecks += 1;
			res.writeHead(healthChecks > (options.healthyAfter ?? 0) ? 204 : 503);
			return res.end();
		}
		if (req.method !== "POST" || req.url !== "/mcp") {
			res.writeHead(404);
			return res.end();
		}
		const auth = req.headers.authorization;
		const session = req.headers["mcp-session-id"] as string | undefined;
		const message = JSON.parse(body) as { id?: number; method: string; params?: any };
		calls.push({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }), ...(session === undefined ? {} : { session }), ...(auth === undefined ? {} : { auth }), ...(req.headers["mcp-protocol-version"] === undefined ? {} : { protocol: req.headers["mcp-protocol-version"] as string }) });
		const token = options.token?.();
		if (token !== undefined && auth !== `Bearer ${token}`) {
			res.writeHead(401, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: "unauthorized" }));
		}
		const reply = (result: unknown, headers: Record<string, string> = {}) => {
			const text = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(result instanceof RpcError ? { error: { code: result.code, message: result.message } } : { result }) });
			if (options.sse === true) {
				res.writeHead(200, { "content-type": "text/event-stream", ...headers });
				return res.end(`event: message\ndata: ${text}\n\n`);
			}
			res.writeHead(200, { "content-type": "application/json", ...headers });
			res.end(text);
		};
		if (message.method === "initialize") {
			minted += 1;
			const id = `sessione-${minted}`;
			sessions.set(id, { initialized: false });
			return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-spacesd", version: "0.3.0" } }, { "mcp-session-id": id });
		}
		const known = session === undefined ? undefined : sessions.get(session);
		if (known === undefined) {
			res.writeHead(session === undefined ? 400 : 404, { "content-type": "application/json" });
			return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: "unknown session" } }));
		}
		if (message.id === undefined) {
			if (message.method === "notifications/initialized") known.initialized = true;
			res.writeHead(202);
			return res.end();
		}
		if (!known.initialized) return reply(new RpcError(-32002, "not initialized"));
		if (message.method === "tools/list") return reply({ tools: (options.tools ?? CUA_TOOLS).map((name) => ({ name, inputSchema: { type: "object" } })) });
		if (message.method !== "tools/call") return reply(new RpcError(-32601, "method not found"));
		const { name, arguments: args } = message.params as { name: string; arguments: Record<string, unknown> };
		if (options.slowMs !== undefined) await new Promise((r) => setTimeout(r, options.slowMs));
		if (!(options.tools ?? CUA_TOOLS).includes(name)) return reply(new RpcError(-32602, `unknown tool ${name}`));
		if (name === "get_desktop_state") {
			const max = Number(args.max_image_dimension ?? 0);
			const scale = max > 0 ? Math.min(1, max / Math.max(screen.width, screen.height)) : 1;
			const shown = { width: Math.round(screen.width * scale), height: Math.round(screen.height * scale) };
			const downscaled = scale < 1 ? { screenshot_original_width: screen.width, screenshot_original_height: screen.height } : {};
			return reply({
				content: [
					{ type: "text", text: "Finestra attiva: Mozilla Firefox" },
					{ type: "image", data: blackPng(shown.width, shown.height).toString("base64"), mimeType: "image/png" },
				],
				structuredContent: { capture_id: `cattura-${calls.length}`, scale_factor: 1, ...downscaled },
			});
		}
		if (name === "get_screen_size") return reply({ content: [{ type: "text", text: JSON.stringify({ ...screen, scale_factor: 1 }) }], structuredContent: { ...screen, scale_factor: 1 } });
		if (name === "launch_app" && args.name === "inesistente") return reply({ content: [{ type: "text", text: "app not found: inesistente" }], isError: true });
		return reply({ content: [{ type: "text", text: `ok ${name}` }] });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		calls,
		/** The tool calls only, as name and arguments. */
		toolCalls: () => calls.filter((c) => c.method === "tools/call").map((c) => ({ name: c.params.name as string, args: c.params.arguments as Record<string, unknown> })),
		/** The server restarted: every session it minted is unknown now. */
		forgetSessions: () => sessions.clear(),
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

class RpcError {
	constructor(
		readonly code: number,
		readonly message: string,
	) {}
}
