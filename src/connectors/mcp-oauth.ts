import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TenantSecrets } from "../core/secrets.ts";
import { publicAddress } from "../core/web-fetch.ts";

/**
 * Signing in to an MCP server with OAuth (ADR 0024): the MCP authorization flow, with Annie as
 * the client. The owner presses «Collega», signs in on the service's page, and comes back to the
 * console; the tokens stay on the server, in the tenant's secret store, and refresh by themselves.
 */

/** What one connector's sign-in keeps, as one secret: the client registered, the tokens, the PKCE verifier, the servers found. */
type Saved = {
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	verifier?: string;
	discovery?: OAuthDiscoveryState;
};

/** The secret holding a connector's sign-in. Per instance: two instances with the same connector sign in apart. */
export function mcpOAuthSecret(instanceId: string, connectorId: string): string {
	return `mcp-oauth.${instanceId}.${connectorId}`;
}

/** The connector has no valid sign-in: the owner has to press «Collega» again. */
export class McpSignInNeeded extends Error {
	override readonly name = "McpSignInNeeded";
	constructor() {
		super("accesso da rifare: in Connettori premi «Collega»");
	}
}

/** Why a sign-in did not go through, in words for the owner: never a token or a code. */
export class McpOAuthError extends Error {
	override readonly name = "McpOAuthError";
}

/**
 * The SDK's view of one connector's sign-in, kept in the secret store. Interactive while the owner
 * signs in (it captures the page to send them to); in the background it never starts a sign-in:
 * the connection fails with {@link McpSignInNeeded} and the console says so.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
	/** The service's sign-in page, once the SDK asks to go there. */
	authorizationUrl: URL | undefined;

	constructor(
		private readonly secrets: TenantSecrets,
		private readonly secret: string,
		readonly redirectUrl: string,
		private readonly options: { readonly state?: string; readonly interactive: boolean },
	) {}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Annie",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		return this.options.state ?? "";
	}

	async clientInformation() {
		return (await this.load()).client;
	}
	async saveClientInformation(client: OAuthClientInformationMixed) {
		await this.change((s) => ({ ...s, client }));
	}
	async tokens() {
		return (await this.load()).tokens;
	}
	async saveTokens(tokens: OAuthTokens) {
		await this.change(({ verifier: _used, ...s }) => ({ ...s, tokens }));
	}
	async redirectToAuthorization(url: URL) {
		if (!this.options.interactive) throw new McpSignInNeeded();
		this.authorizationUrl = url;
	}
	async saveCodeVerifier(verifier: string) {
		if (this.options.interactive) await this.change((s) => ({ ...s, verifier }));
	}
	async codeVerifier() {
		const verifier = (await this.load()).verifier;
		if (verifier === undefined) throw new McpOAuthError("collegamento scaduto: premi di nuovo «Collega»");
		return verifier;
	}
	async discoveryState() {
		return (await this.load()).discovery;
	}
	async saveDiscoveryState(discovery: OAuthDiscoveryState) {
		await this.change((s) => ({ ...s, discovery }));
	}
	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
		await this.change((s) => {
			if (scope === "all") return {};
			const { [scope === "verifier" ? "verifier" : scope]: _gone, ...rest } = s as Record<string, unknown>;
			return rest as Saved;
		});
	}

	/** The hosts the sign-in talks to after the MCP server's own: the authorization server and its token endpoint. */
	async authHosts(): Promise<string[]> {
		const discovery = (await this.load()).discovery;
		const urls = [discovery?.authorizationServerUrl, discovery?.authorizationServerMetadata?.token_endpoint];
		return [...new Set(urls.filter((u): u is string => typeof u === "string").map((u) => new URL(u).hostname))];
	}

	private async load(): Promise<Saved> {
		const raw = await this.secrets.get(this.secret);
		if (raw === undefined) return {};
		try {
			return JSON.parse(raw) as Saved;
		} catch {
			return {};
		}
	}

	private async change(next: (saved: Saved) => Saved): Promise<void> {
		await this.secrets.set(this.secret, JSON.stringify(next(await this.load())));
	}
}

/**
 * A fetch for the sign-in itself (discovery, registration, tokens), whose addresses come from the
 * MCP server's metadata: https only, public addresses only, no redirects. A server that names an
 * internal address for its token endpoint reaches nothing.
 */
export function signInFetch(addressAllowed: (address: string) => boolean = publicAddress, base: typeof fetch = fetch): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const loopbackForTests = addressAllowed !== publicAddress && url.protocol === "http:";
		if (url.protocol !== "https:" && !loopbackForTests) throw new McpOAuthError(`il servizio usa un indirizzo non sicuro per l'accesso (${url.hostname})`);
		if (url.username !== "" || url.password !== "") throw new McpOAuthError("indirizzo di accesso non valido");
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
		if (addresses.length === 0 || addresses.some((a) => !addressAllowed(a))) throw new McpOAuthError(`${host} è un indirizzo interno: niente accesso`);
		return base(input, { ...init, redirect: "error" });
	}) as typeof fetch;
}

type Pending = { readonly instanceId: string; readonly connectorId: string; readonly serverUrl: string; readonly expiresAt: number };

export type McpOAuthOptions = {
	readonly tenantId: string;
	readonly secrets: TenantSecrets;
	/** Where the service sends the owner back: <public URL>/oauth/mcp/callback. */
	readonly redirectUrl: string;
	/** Which addresses the sign-in may reach (tests: the loopback). */
	readonly addressAllowed?: (address: string) => boolean;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
};

/** The sign-ins of one tenant: started by the owner, finished when the service sends them back. */
export class McpOAuth {
	private readonly pending = new Map<string, Pending>();
	private readonly fetchFn: typeof fetch;

	constructor(private readonly options: McpOAuthOptions) {
		this.fetchFn = signInFetch(options.addressAllowed, options.fetch);
	}

	get redirectUrl(): string {
		return this.options.redirectUrl;
	}

	/** The provider a connection uses in the background: it refreshes tokens, never starts a sign-in. */
	provider(instanceId: string, connectorId: string): StoredOAuthProvider {
		return new StoredOAuthProvider(this.options.secrets, mcpOAuthSecret(instanceId, connectorId), this.options.redirectUrl, { interactive: false });
	}

	/** The fetch the sign-in uses, for the connection's own refreshes to the authorization server. */
	get signInFetch(): typeof fetch {
		return this.fetchFn;
	}

	/**
	 * Starts a sign-in: the page to send the owner to, or `undefined` when the tokens kept still
	 * work (refreshed if needed). Tokens that no longer refresh are dropped and a sign-in starts.
	 */
	async start(instanceId: string, connectorId: string, serverUrl: string): Promise<string | undefined> {
		const now = this.now();
		for (const [state, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(state);
		const state = `${this.options.tenantId}~${randomBytes(18).toString("base64url")}`;
		const provider = new StoredOAuthProvider(this.options.secrets, mcpOAuthSecret(instanceId, connectorId), this.options.redirectUrl, { state, interactive: true });
		let result: Awaited<ReturnType<typeof auth>>;
		try {
			result = await auth(provider, { serverUrl, fetchFn: this.fetchFn });
		} catch (error) {
			throw words(error);
		}
		if (result === "AUTHORIZED" || provider.authorizationUrl === undefined) return undefined;
		this.pending.set(state, { instanceId, connectorId, serverUrl, expiresAt: now + 10 * 60_000 });
		return provider.authorizationUrl.toString();
	}

	/** Back from the service: the code becomes tokens. Says which connector it was. */
	async finish(state: string, code: string): Promise<{ instanceId: string; connectorId: string }> {
		const pending = this.pending.get(state);
		if (pending === undefined || pending.expiresAt <= this.now()) throw new McpOAuthError("collegamento scaduto o già usato: premi di nuovo «Collega»");
		this.pending.delete(state);
		const provider = new StoredOAuthProvider(this.options.secrets, mcpOAuthSecret(pending.instanceId, pending.connectorId), this.options.redirectUrl, { state, interactive: true });
		try {
			await auth(provider, { serverUrl: pending.serverUrl, authorizationCode: code, fetchFn: this.fetchFn });
		} catch (error) {
			throw words(error);
		}
		return { instanceId: pending.instanceId, connectorId: pending.connectorId };
	}

	/** Whether a connector has tokens (the console shows «Collegato» or «Collega»). */
	async signedIn(instanceId: string, connectorId: string): Promise<boolean> {
		return (await this.provider(instanceId, connectorId).tokens()) !== undefined;
	}

	/** Drops a connector's sign-in (the connector removed). */
	async forget(instanceId: string, connectorId: string): Promise<void> {
		await this.options.secrets.delete(mcpOAuthSecret(instanceId, connectorId));
		for (const [state, p] of this.pending) if (p.instanceId === instanceId && p.connectorId === connectorId) this.pending.delete(state);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

/** An error of the sign-in, in words for the owner: the SDK's own messages can carry addresses with codes. */
function words(error: unknown): McpOAuthError {
	if (error instanceof McpOAuthError) return error;
	const name = error instanceof Error ? error.name : "";
	if (/InvalidClient|UnauthorizedClient/.test(name)) return new McpOAuthError("il servizio non riconosce Annie come applicazione: riprova, o usa un token");
	if (/InvalidGrant/.test(name)) return new McpOAuthError("il servizio ha rifiutato il codice di accesso: premi di nuovo «Collega»");
	if (/AccessDenied/.test(name)) return new McpOAuthError("accesso negato dal servizio");
	if (error instanceof Error && /does not support dynamic client registration|registration/i.test(error.message))
		return new McpOAuthError("questo servizio non accetta la registrazione automatica delle app: serve un token");
	if (error instanceof TypeError) return new McpOAuthError("il servizio non è raggiungibile da questo server");
	return new McpOAuthError("il servizio non ha completato l'accesso: riprova più tardi");
}
