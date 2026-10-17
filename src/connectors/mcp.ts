import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileAtomic } from "../core/atomic-file.ts";
import type { AuditLog } from "../core/audit.ts";
import type { AnnieTool } from "../core/engine.ts";
import type { EgressPolicy } from "../core/policy.ts";
import type { TenantSecrets } from "../core/secrets.ts";
import { egressFetch } from "./http.ts";
import { type McpOAuth, McpSignInNeeded } from "./mcp-oauth.ts";

/**
 * A connector to an MCP server, configured by the owner. Holds no secrets: header and
 * environment values name entries of the tenant's secret store.
 */
export type McpConnector = {
	readonly id: string;
	readonly name: string;
	readonly transport:
		| {
				readonly type: "http";
				readonly url: string;
				readonly headerSecrets?: Readonly<Record<string, string>>;
				/** "oauth": the owner signs in on the service's page; the tokens live in the secret store (ADR 0024). */
				readonly auth?: "oauth";
		  }
		| { readonly type: "stdio"; readonly command: string; readonly args?: readonly string[]; readonly envSecrets?: Readonly<Record<string, string>> };
	readonly enabled: boolean;
};

export const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** The name under which an instance's egress policy allows a connector. */
export function connectorEgressName(id: string): string {
	return `mcp:${id}`;
}

/** The connectors of one instance, in one JSON file. */
export class ConnectorStore {
	private readonly file: string;
	constructor(dir: string) {
		this.file = join(dir, "connectors.json");
	}

	async list(): Promise<McpConnector[]> {
		try {
			return JSON.parse(await readFile(this.file, "utf8")) as McpConnector[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async save(connector: McpConnector): Promise<void> {
		if (!CONNECTOR_ID.test(connector.id)) throw new Error(`Invalid connector id "${connector.id}": lowercase letters, digits, dashes, up to 24`);
		if (connector.transport.type === "http") {
			const url = new URL(connector.transport.url);
			if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP URL must be http(s)");
		}
		const all = (await this.list()).filter((c) => c.id !== connector.id);
		await writeFileAtomic(this.file, `${JSON.stringify([...all, connector], null, 2)}\n`);
	}

	async remove(id: string): Promise<boolean> {
		const all = await this.list();
		const kept = all.filter((c) => c.id !== id);
		if (kept.length === all.length) return false;
		await writeFileAtomic(this.file, `${JSON.stringify(kept, null, 2)}\n`);
		return true;
	}
}

export type McpConnectionsOptions = {
	readonly instanceId: string;
	readonly secrets: TenantSecrets;
	readonly policy: () => Promise<EgressPolicy>;
	readonly audit: AuditLog;
	readonly log?: (message: string) => void;
	/** Base fetch under the egress guard (tests). */
	readonly fetch?: typeof fetch;
	/** Per tool call. */
	readonly callTimeoutMs?: number;
	/** Sign-ins of connectors with OAuth; without it they do not connect. */
	readonly oauth?: McpOAuth;
};

export type ConnectorStatus = {
	readonly id: string;
	readonly connected: boolean;
	readonly tools: readonly string[];
	readonly error?: string;
	/** The connector needs the owner to sign in (again). */
	readonly signIn?: boolean;
};

/** Largest tool result passed to the model, in characters. */
const MAX_RESULT = 100_000;

/**
 * Live connections to an instance's MCP servers. `connect` opens every enabled connector
 * the policy allows and returns its tools as Annie tools; `close` ends them. A connector that
 * fails is skipped (audited), so one broken server never takes the instance down.
 */
export class McpConnections {
	private clients: { id: string; client: Client }[] = [];
	private statuses: ConnectorStatus[] = [];

	constructor(private readonly options: McpConnectionsOptions) {}

	status(): readonly ConnectorStatus[] {
		return this.statuses;
	}

	async connect(connectors: readonly McpConnector[]): Promise<AnnieTool[]> {
		await this.close();
		const policy = await this.options.policy();
		const tools: AnnieTool[] = [];
		const statuses: ConnectorStatus[] = [];
		for (const connector of connectors) {
			if (!connector.enabled) continue;
			if (!(policy.connectors ?? []).includes(connectorEgressName(connector.id))) {
				statuses.push({ id: connector.id, connected: false, tools: [], error: `egress policy does not allow ${connectorEgressName(connector.id)}` });
				await this.options.audit.append({ type: "egress.denied", instanceId: this.options.instanceId, kind: "connector", target: connectorEgressName(connector.id) });
				continue;
			}
			try {
				const client = new Client({ name: "annie", version: "0.0.0" });
				await client.connect(await this.transport(connector), { timeout: 20_000 });
				this.clients.push({ id: connector.id, client });
				const listed = await client.listTools(undefined, { timeout: 20_000 });
				const names: string[] = [];
				for (const tool of listed.tools) {
					const name = toolName(connector.id, tool.name);
					names.push(name);
					tools.push(this.wrap(connector, client, name, tool));
				}
				statuses.push({ id: connector.id, connected: true, tools: names });
				await this.options.audit.append({ type: "connector.connected", instanceId: this.options.instanceId, connector: connector.id, tools: names.length });
			} catch (error) {
				const signIn = error instanceof UnauthorizedError || error instanceof McpSignInNeeded;
				const message = signIn ? new McpSignInNeeded().message : error instanceof Error ? error.message : String(error);
				statuses.push({ id: connector.id, connected: false, tools: [], error: message, ...(signIn ? { signIn: true } : {}) });
				this.options.log?.(`mcp: connector ${connector.id} not connected: ${message}`);
				await this.options.audit.append({ type: "connector.failed", instanceId: this.options.instanceId, connector: connector.id, error: message.slice(0, 300) });
			}
		}
		this.statuses = statuses;
		return tools;
	}

	async close(): Promise<void> {
		const clients = this.clients;
		this.clients = [];
		await Promise.allSettled(clients.map((c) => c.client.close()));
	}

	private async transport(connector: McpConnector) {
		const { secrets } = this.options;
		if (connector.transport.type === "http") {
			const url = new URL(connector.transport.url);
			const headers: Record<string, string> = {};
			for (const [header, secret] of Object.entries(connector.transport.headerSecrets ?? {})) {
				const value = await secrets.get(secret);
				if (value === undefined) throw new Error(`secret ${secret} for header ${header} is missing`);
				headers[header] = value;
			}
			if (connector.transport.auth === "oauth") {
				const oauth = this.options.oauth;
				if (oauth === undefined) throw new Error("accesso OAuth non disponibile su questo server");
				const provider = oauth.provider(this.options.instanceId, connector.id);
				if ((await provider.tokens()) === undefined) throw new McpSignInNeeded();
				// The refreshes go to the authorization server found at sign-in, under the same policy.
				return new StreamableHTTPClientTransport(url, {
					fetch: egressFetch(connectorEgressName(connector.id), [url.hostname, ...(await provider.authHosts())], this.options.policy, this.options.fetch),
					requestInit: { headers },
					authProvider: provider,
				});
			}
			return new StreamableHTTPClientTransport(url, {
				fetch: egressFetch(connectorEgressName(connector.id), [url.hostname], this.options.policy, this.options.fetch),
				requestInit: { headers },
			});
		}
		// Only what the connector names (the SDK adds a fixed set of basics: HOME, PATH, USER,
		// SHELL, TERM, LOGNAME), never the rest of Annie's environment, where keys live.
		const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
		for (const [name, secret] of Object.entries(connector.transport.envSecrets ?? {})) {
			const value = await secrets.get(secret);
			if (value === undefined) throw new Error(`secret ${secret} for ${name} is missing`);
			env[name] = value;
		}
		return new StdioClientTransport({ command: connector.transport.command, args: [...(connector.transport.args ?? [])], env, stderr: "ignore" });
	}

	private wrap(connector: McpConnector, client: Client, name: string, tool: { name: string; description?: string; inputSchema: Record<string, unknown> }): AnnieTool {
		return {
			name,
			description: `[${connector.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
			parameters: { type: "object", ...tool.inputSchema },
			// What a third-party tool does is unknown: never rerun it after a crash.
			replaySafe: false,
			execute: async (args, ctx) => {
				const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal: ctx.signal, timeout: this.options.callTimeoutMs ?? 120_000 });
				const content = (result.content ?? []) as { type: string; text?: string; mimeType?: string }[];
				const text = content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ""}]`)).join("\n");
				const bounded = text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[... troncato]` : text;
				return result.isError === true ? `Errore dal connettore ${connector.name}: ${bounded}` : bounded;
			},
		};
	}
}

/** `<connector>__<tool>`, in the characters and length model APIs accept. */
export function toolName(connectorId: string, tool: string): string {
	return `${connectorId}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
