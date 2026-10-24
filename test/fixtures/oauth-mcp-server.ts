import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDemoServer } from "./mcp-demo-server.ts";

/**
 * The demo MCP server behind OAuth, as the MCP authorization spec has it, all on one loopback
 * port: protected resource metadata, authorization server metadata, dynamic registration, a
 * token endpoint with PKCE and refresh. The sign-in page is not served: a test reads the state
 * and challenge from the address Owni sends the owner to, and comes back with a code.
 */
export type OAuthMcp = {
	readonly base: string;
	readonly url: string;
	readonly server: HttpServer;
	/** Access tokens the MCP endpoint accepts now. */
	readonly valid: Set<string>;
	/** Refresh tokens the token endpoint accepts now. */
	readonly refreshable: Set<string>;
	/** The code a sign-in gets for this challenge (as if the owner signed in). */
	codeFor(challenge: string): string;
	registrations: number;
	/** Turn dynamic registration off (a service that needs a pre-registered app). */
	registration: boolean;
	readonly redirects: string[];
};

export async function oauthMcp(): Promise<OAuthMcp> {
	const codes = new Map<string, string>();
	let issued = 0;
	const state: OAuthMcp = {
		base: "",
		url: "",
		server: undefined as unknown as HttpServer,
		valid: new Set(),
		refreshable: new Set(),
		codeFor(challenge) {
			const code = `code-${codes.size + 1}`;
			codes.set(code, challenge);
			return code;
		},
		registrations: 0,
		registration: true,
		redirects: [],
	};
	const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	const read = async (req: import("node:http").IncomingMessage) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		return Buffer.concat(chunks).toString("utf8");
	};
	const tokens = () => {
		issued++;
		const access = `at-${issued}`;
		const refresh = `rt-${issued}`;
		state.valid.add(access);
		state.refreshable.add(refresh);
		return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh };
	};
	const http = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", state.base);
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource")
			return json(res, 200, { resource: state.url, authorization_servers: [state.base] });
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return json(res, 200, {
				issuer: state.base,
				authorization_endpoint: `${state.base}/authorize`,
				token_endpoint: `${state.base}/token`,
				...(state.registration ? { registration_endpoint: `${state.base}/register` } : {}),
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		if (url.pathname === "/register" && req.method === "POST") {
			const meta = JSON.parse(await read(req)) as { redirect_uris: string[] };
			state.registrations++;
			state.redirects.push(...meta.redirect_uris);
			return json(res, 201, { ...meta, client_id: `client-${state.registrations}`, client_id_issued_at: Math.floor(Date.now() / 1000) });
		}
		if (url.pathname === "/token" && req.method === "POST") {
			const form = new URLSearchParams(await read(req));
			if (form.get("grant_type") === "authorization_code") {
				const challenge = codes.get(form.get("code") ?? "");
				const verifier = form.get("code_verifier") ?? "";
				if (challenge === undefined || createHash("sha256").update(verifier).digest("base64url") !== challenge) return json(res, 400, { error: "invalid_grant" });
				codes.delete(form.get("code") ?? "");
				return json(res, 200, tokens());
			}
			if (form.get("grant_type") === "refresh_token") {
				const refresh = form.get("refresh_token") ?? "";
				if (!state.refreshable.delete(refresh)) return json(res, 400, { error: "invalid_grant" });
				return json(res, 200, tokens());
			}
			return json(res, 400, { error: "unsupported_grant_type" });
		}
		if (url.pathname === "/mcp") {
			const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
			if (!state.valid.has(token)) {
				res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp"`, "content-type": "application/json" });
				return res.end(JSON.stringify({ error: "invalid_token" }));
			}
			const server = createDemoServer(() => `token:${token}`);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on("close", () => void transport.close());
			await server.connect(transport);
			return transport.handleRequest(req, res);
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	return Object.assign(state, { base, url: `${base}/mcp`, server: http });
}
