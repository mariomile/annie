import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { CONNECTOR_CATALOG, type CatalogEntry } from "../src/connectors/catalog.ts";
import { CONNECTOR_ID } from "../src/connectors/mcp.ts";
import { McpOAuthError, mcpOAuthSecret, signInFetch } from "../src/connectors/mcp-oauth.ts";
import { publicAddress } from "../src/core/web-fetch.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { type OAuthMcp, oauthMcp } from "./fixtures/oauth-mcp-server.ts";
import { tempDataDir } from "./helpers.ts";

const running: RunningAnnie[] = [];
const fakes: OAuthMcp[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
	await Promise.all(
		fakes.splice(0).map((f) => {
			f.server.closeAllConnections();
			return new Promise((r) => f.server.close(r));
		}),
	);
});

async function boot(catalog: CatalogEntry[]) {
	const config = loadAnnieConfig({ ANNIE_DATA_DIR: tempDataDir(), ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ANNIE_PUBLIC_URL: "https://annie.example" });
	const annie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {}, connectorCatalog: catalog, mcpOAuthAddressAllowed: () => true });
	running.push(annie);
	const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	// biome-ignore lint: test
	const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
		const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, ...((await res.json()) as object) };
	};
	return { annie, base, api };
}

async function fake(): Promise<OAuthMcp> {
	const f = await oauthMcp();
	fakes.push(f);
	return f;
}

/** The owner on the service's page: signs in, and the service sends them back with a code. */
async function signInAt(f: OAuthMcp, base: string, page: string): Promise<{ code: string; state: string }> {
	const url = new URL(page);
	expect(url.origin + url.pathname).toBe(`${f.base}/authorize`);
	expect(url.searchParams.get("redirect_uri")).toBe("https://annie.example/oauth/mcp/callback");
	const code = f.codeFor(url.searchParams.get("code_challenge") as string);
	const state = url.searchParams.get("state") as string;
	// The callback hands code and state to the console in the fragment, nothing else.
	const back = await fetch(`${base}/oauth/mcp/callback?code=${code}&state=${encodeURIComponent(state)}&extra=x`, { redirect: "manual" });
	expect(back.status).toBe(302);
	const location = back.headers.get("location") as string;
	expect(location.startsWith("/#/connettore?")).toBe(true);
	const params = new URLSearchParams(location.slice("/#/connettore?".length));
	expect([...params.keys()].sort()).toEqual(["code", "state"]);
	return { code: params.get("code") as string, state: params.get("state") as string };
}

const entry = (f: OAuthMcp, over: Partial<CatalogEntry> = {}): CatalogEntry => ({ id: "demo", name: "Demo", description: "Demo.", url: f.url, auth: "oauth", category: "lavoro", ...over });

describe("connector catalog", () => {
	it("lists well-known servers over https, with ids a connector can have and help for tokens", () => {
		const ids = new Set<string>();
		for (const e of CONNECTOR_CATALOG) {
			expect(CONNECTOR_ID.test(e.id), e.id).toBe(true);
			expect(new URL(e.url).protocol, e.id).toBe("https:");
			expect(ids.has(e.id), e.id).toBe(false);
			ids.add(e.id);
			if (e.auth === "token") expect(e.tokenHelp, e.id).toBeTruthy();
		}
		expect(CONNECTOR_CATALOG.length).toBeGreaterThanOrEqual(10);
	});
});

describe("one-click connectors with OAuth", () => {
	it("adds a connector, signs in on the service's page and comes back with its tools; tokens stay in the secret store", async () => {
		const f = await fake();
		const { annie, base, api } = await boot([entry(f)]);
		const { catalog, oauth } = await api("/api/connector-catalog");
		expect(oauth).toBe(true);
		expect(catalog.map((e: CatalogEntry) => e.id)).toEqual(["demo"]);
		const started = await api("/api/instances/annie/connectors/catalog/demo", "POST", {});
		expect(started.status).toBe(200);
		expect(f.registrations).toBe(1);
		expect(f.redirects).toEqual(["https://annie.example/oauth/mcp/callback"]);
		// Before the sign-in finishes, the connector is there and says what it needs.
		const listed = await api("/api/instances/annie/connectors");
		expect(listed.connectors[0]).toMatchObject({ id: "demo", allowed: true, transport: { type: "http", url: f.url, auth: "oauth" } });
		const back = await signInAt(f, base, started.url);
		const done = await api("/api/connectors/oauth/finish", "POST", back);
		expect(done).toMatchObject({ instanceId: "annie", connectorId: "demo" });
		const after = await api("/api/instances/annie/connectors");
		expect(after.connectors[0].status).toEqual({ id: "demo", connected: true, tools: ["demo__add", "demo__whoami"] });
		// The tool call carries the token got at sign-in.
		const thread = (await api("/api/instances/annie/threads", "POST", {})).thread;
		await api(`/api/instances/annie/threads/${thread.id}/messages`, "POST", { text: "/tool demo__whoami {}" });
		let said = "";
		for (let i = 0; i < 300 && !said.includes("Fatto."); i++) {
			said = JSON.stringify((await api(`/api/instances/annie/threads/${thread.id}`)).entries ?? []);
			await new Promise((r) => setTimeout(r, 30));
		}
		expect(said).toContain("Fatto. token:at-1");
		// The same code and state cannot be used twice.
		expect((await api("/api/connectors/oauth/finish", "POST", back)).status).toBe(400);
		const saved = JSON.parse((await annie.runtime.secrets("default").get(mcpOAuthSecret("annie", "demo"))) as string);
		expect(saved.tokens.access_token).toBe("at-1");
		expect(saved.verifier).toBeUndefined();
		// The audit names the connector, never a token or a code.
		const audit = JSON.stringify(await annie.runtime.audit("default").read());
		expect(audit).not.toContain("at-1");
		expect(audit).not.toContain(back.code);
	});

	it("refreshes an expired token by itself; when the refresh is refused, asks the owner to sign in again", async () => {
		const f = await fake();
		const { annie, base, api } = await boot([entry(f)]);
		const started = await api("/api/instances/annie/connectors/catalog/demo", "POST", {});
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, started.url));
		// The service forgets the access token: the next connection refreshes it.
		f.valid.clear();
		await annie.runtime.reopen("default", "annie");
		expect((await api("/api/instances/annie/connectors")).connectors[0].status).toMatchObject({ connected: true });
		expect(JSON.parse((await annie.runtime.secrets("default").get(mcpOAuthSecret("annie", "demo"))) as string).tokens.access_token).toBe("at-2");
		// Now the refresh token is revoked too.
		f.valid.clear();
		f.refreshable.clear();
		await annie.runtime.reopen("default", "annie");
		const status = (await api("/api/instances/annie/connectors")).connectors[0].status;
		expect(status).toMatchObject({ connected: false, signIn: true });
		expect(status.error).toContain("Collega");
		// «Collega» starts a new sign-in, with the client already registered.
		const again = await api("/api/instances/annie/connectors/demo/sign-in", "POST", {});
		expect(again.url).toContain(`${f.base}/authorize`);
		expect(f.registrations).toBe(1);
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, again.url));
		expect((await api("/api/instances/annie/connectors")).connectors[0].status).toMatchObject({ connected: true });
	});

	it("removing the connector drops its sign-in; adding it twice is refused", async () => {
		const f = await fake();
		const { annie, base, api } = await boot([entry(f)]);
		const started = await api("/api/instances/annie/connectors/catalog/demo", "POST", {});
		expect((await api("/api/instances/annie/connectors/catalog/demo", "POST", {})).status).toBe(409);
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, started.url));
		await api("/api/instances/annie/connectors/demo", "DELETE");
		expect(await annie.runtime.secrets("default").get(mcpOAuthSecret("annie", "demo"))).toBeUndefined();
		const record = await annie.runtime.registry.getInstance("default", "annie");
		expect(record.egress.connectors ?? []).not.toContain("mcp:demo");
	});

	it("a service that does not register apps by itself is explained, and nothing is half-saved in its sign-in", async () => {
		const f = await fake();
		f.registration = false;
		const { api } = await boot([entry(f)]);
		const res = await api("/api/instances/annie/connectors/catalog/demo", "POST", {});
		expect(res.status).toBe(502);
		expect(res.error).toContain("token");
	});
});

describe("one-click connectors with a token or nothing", () => {
	it("a token is kept as the Authorization header; an empty one is refused", async () => {
		const f = await fake();
		f.valid.add("pat-123");
		const { annie, api } = await boot([entry(f, { id: "gh", name: "GitHub", auth: "token", tokenHelp: "Da GitHub." })]);
		expect((await api("/api/instances/annie/connectors/catalog/gh", "POST", { token: " " })).status).toBe(400);
		const added = await api("/api/instances/annie/connectors/catalog/gh", "POST", { token: "pat-123" });
		expect(added.status).toMatchObject({ connected: true, tools: ["gh__add", "gh__whoami"] });
		expect(await annie.runtime.secrets("default").get("connector.gh.authorization")).toBe("Bearer pat-123");
	});

	it("a public server connects at once; only the owner sees the catalog", async () => {
		const f = await fake();
		f.valid.add("");
		const { annie, base, api } = await boot([entry(f, { id: "docs", auth: "none" })]);
		const added = await api("/api/instances/annie/connectors/catalog/docs", "POST", {});
		expect(added.status).toMatchObject({ connected: true });
		expect((await api("/api/instances/annie/connectors/catalog/nope", "POST", {})).status).toBe(404);
		const person = await api("/api/people", "POST", { name: "Giulia" });
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: person.link.split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		expect((await fetch(`${base}/api/connector-catalog`, { headers: { cookie } })).status).toBe(403);
		expect(annie).toBeDefined();
	});
});

describe("the sign-in's own requests", () => {
	it("go only to https and public addresses, never following a redirect", async () => {
		const seen: RequestInit[] = [];
		const base = (async (_u: unknown, init?: RequestInit) => {
			seen.push(init ?? {});
			return new Response("{}");
		}) as typeof fetch;
		const guarded = signInFetch(publicAddress, base);
		await expect(guarded("http://example.com/token")).rejects.toBeInstanceOf(McpOAuthError);
		await expect(guarded("https://127.0.0.1/token")).rejects.toThrow(/interno/);
		await expect(guarded("https://[::ffff:10.0.0.1]/token")).rejects.toThrow(/interno/);
		await expect(guarded("https://169.254.169.254/latest")).rejects.toThrow(/interno/);
		await expect(guarded("https://u:p@93.184.216.34/token")).rejects.toBeInstanceOf(McpOAuthError);
		await guarded("https://93.184.216.34/token");
		expect(seen[0]?.redirect).toBe("error");
	});
});
