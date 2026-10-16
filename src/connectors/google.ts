import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import type { TenantSecrets } from "../core/secrets.ts";
import { ConnectorHttpError, requestJson } from "./http.ts";

/**
 * What Annie can read of a person's Google account; never send or change. Google rates
 * gmail.readonly "restricted" (a public app needs a yearly third-party security assessment) and
 * calendar.readonly "sensitive" (a verification of days), so the operator chooses which to ask.
 */
export type GoogleService = "gmail" | "calendar";
export const GOOGLE_SERVICES: readonly GoogleService[] = ["gmail", "calendar"];
export const GOOGLE_SCOPE: Readonly<Record<GoogleService, string>> = {
	gmail: "https://www.googleapis.com/auth/gmail.readonly",
	calendar: "https://www.googleapis.com/auth/calendar.readonly",
};
/** Who the account is: the address shown to the person. */
const IDENTITY_SCOPES = ["openid", "email"];

/** Hosts the Google tools talk to; the egress fetch allows only these. */
export const GOOGLE_HOSTS = ["oauth2.googleapis.com", "gmail.googleapis.com", "www.googleapis.com"] as const;

/** Egress connector name an instance must allow for its people to use their Google account. */
export const GOOGLE_CONNECTOR = "google";

export type GoogleClientConfig = {
	readonly clientId: string;
	readonly clientSecret: string;
	/** Where Google sends the person back: this server's, or the control plane's in Annie Cloud. */
	readonly redirectUrl: string;
	readonly services: readonly GoogleService[];
};

/** A person's connected account, as shown to them. The refresh token lives in the secret store. */
export type GoogleAccount = { readonly email: string; readonly scopes: readonly string[]; readonly connectedAt: string };

const refreshSecret = (personId: string) => `google.${personId}.refreshToken`;

/** The Google accounts of one tenant's people: one per person. */
export class GoogleAccounts {
	private readonly file: string;

	constructor(
		tenantDir: string,
		private readonly secrets: TenantSecrets,
	) {
		this.file = join(tenantDir, "google-accounts.json");
	}

	get(personId: string): GoogleAccount | undefined {
		return readJsonFile<Record<string, GoogleAccount>>(this.file, {})[personId];
	}

	refreshToken(personId: string): Promise<string | undefined> {
		return this.secrets.get(refreshSecret(personId));
	}

	async connect(personId: string, account: GoogleAccount, refreshToken: string): Promise<void> {
		await this.secrets.set(refreshSecret(personId), refreshToken);
		updateJsonFile<Record<string, GoogleAccount>>(this.file, {}, (all) => ({ ...all, [personId]: account }));
	}

	/** Forgets the account; returns the refresh token so it can be revoked with Google. */
	async disconnect(personId: string): Promise<string | undefined> {
		const token = await this.refreshToken(personId);
		await this.secrets.delete(refreshSecret(personId));
		updateJsonFile<Record<string, GoogleAccount>>(this.file, {}, (all) => {
			const { [personId]: _gone, ...rest } = all;
			return rest;
		});
		return token;
	}
}

type PendingConsent = { readonly personId: string; readonly verifier: string; readonly expiresAt: number };

/**
 * The OAuth authorization code flow with PKCE. The state names the tenant (so Annie Cloud's
 * control plane knows which cell to send the person back to) and is single use, bound to the
 * person who started it, and valid for ten minutes. Pending consents live in memory: a restart
 * in the middle only means starting again.
 */
export class GoogleOAuth {
	private readonly pending = new Map<string, PendingConsent>();

	constructor(
		private readonly config: GoogleClientConfig,
		private readonly tenantId: string,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	start(personId: string): string {
		for (const [state, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(state);
		const state = `${this.tenantId}~${randomBytes(18).toString("base64url")}`;
		const verifier = randomBytes(32).toString("base64url");
		this.pending.set(state, { personId, verifier, expiresAt: this.now() + 10 * 60_000 });
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.search = new URLSearchParams({
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUrl,
			response_type: "code",
			scope: [...IDENTITY_SCOPES, ...this.config.services.map((service) => GOOGLE_SCOPE[service])].join(" "),
			access_type: "offline",
			// Without consent Google gives a refresh token only the first time.
			prompt: "consent",
			state,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
		}).toString();
		return url.toString();
	}

	/** Turns the code Google returned into the person's account. Throws GoogleConsentError with a message for the person. */
	async finish(personId: string, state: string, code: string): Promise<{ account: GoogleAccount; refreshToken: string }> {
		const pending = this.pending.get(state);
		if (pending === undefined || pending.expiresAt <= this.now() || pending.personId !== personId) throw new GoogleConsentError("Il collegamento è scaduto o non è partito da qui: riprova da Collega Google.");
		this.pending.delete(state);
		const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, code_verifier: pending.verifier, redirect_uri: this.config.redirectUrl, grant_type: "authorization_code" }),
			redirect: "error",
		});
		const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
		if (!response.ok || body.access_token === undefined || body.refresh_token === undefined) throw new GoogleConsentError(`Google non ha accettato il collegamento${body.error === undefined ? "" : ` (${body.error})`}: riprova.`);
		const scopes = (body.scope ?? "").split(" ").filter((s) => s !== "");
		if (this.config.services.some((service) => !scopes.includes(GOOGLE_SCOPE[service]))) {
			await this.revoke(body.refresh_token);
			const what = this.config.services.length > 1 ? "ha bisogno di tutti i permessi richiesti (posta e calendario)" : `ha bisogno del permesso di leggere ${this.config.services[0] === "gmail" ? "la posta" : "il calendario"}`;
			throw new GoogleConsentError(`Per usare Google, Annie ${what}: riprova lasciando spuntati i permessi.`);
		}
		const profile = await requestJson<{ email?: string }>(this.fetchImpl, "https://openidconnect.googleapis.com/v1/userinfo", { connector: "google", operation: "userinfo", headers: { authorization: `Bearer ${body.access_token}` } });
		return { account: { email: profile.email ?? "", scopes, connectedAt: new Date(this.now()).toISOString() }, refreshToken: body.refresh_token };
	}

	/** Best effort: the account is forgotten here whether or not Google answers. */
	async revoke(token: string): Promise<void> {
		await this.fetchImpl("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), redirect: "error" }).catch(() => undefined);
	}
}

export class GoogleConsentError extends Error {
	override readonly name = "GoogleConsentError";
}

export type MailSummary = { readonly id: string; readonly from: string; readonly subject: string; readonly date: string; readonly snippet: string; readonly unread: boolean };
export type MailMessage = MailSummary & { readonly to: string; readonly text: string };
export type CalendarEvent = { readonly id: string; readonly summary: string; readonly start: string; readonly end: string; readonly location?: string; readonly attendees: readonly string[] };

type Header = { name: string; value: string };
type Part = { mimeType?: string; headers?: Header[]; body?: { data?: string }; parts?: Part[] };
type Message = { id: string; snippet?: string; labelIds?: string[]; payload?: Part };

/** One person's Gmail and Calendar, read only, over an egress-guarded fetch. */
export class GoogleClient {
	private token: { value: string; expiresAt: number } | undefined;

	constructor(
		private readonly options: {
			readonly clientId: string;
			readonly clientSecret: string;
			readonly refreshToken: () => Promise<string | undefined>;
			readonly fetch: typeof fetch;
			readonly now?: () => number;
		},
	) {}

	async searchMail(query: string, max: number): Promise<MailSummary[]> {
		const list = await this.get<{ messages?: { id: string }[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`, "mail search");
		const out: MailSummary[] = [];
		for (const { id } of list.messages ?? []) {
			const m = await this.get<Message>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, "mail metadata");
			out.push(summary(m));
		}
		return out;
	}

	async readMail(id: string): Promise<MailMessage> {
		const m = await this.get<Message>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, "mail read");
		return { ...summary(m), to: header(m.payload, "To"), text: plainText(m.payload) };
	}

	async events(from: string, to: string, max: number): Promise<CalendarEvent[]> {
		const params = new URLSearchParams({ timeMin: from, timeMax: to, maxResults: String(max), singleEvents: "true", orderBy: "startTime" });
		const body = await this.get<{ items?: { id: string; summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { email?: string; displayName?: string }[] }[] }>(
			`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
			"calendar events",
		);
		return (body.items ?? []).map((e) => ({
			id: e.id,
			summary: e.summary ?? "(senza titolo)",
			start: e.start?.dateTime ?? e.start?.date ?? "",
			end: e.end?.dateTime ?? e.end?.date ?? "",
			...(e.location === undefined ? {} : { location: e.location }),
			attendees: (e.attendees ?? []).map((a) => a.displayName ?? a.email ?? "").filter((a) => a !== ""),
		}));
	}

	private async get<T>(url: string, operation: string): Promise<T> {
		const call = async () => requestJson<T>(this.options.fetch, url, { connector: "google", operation, headers: { authorization: `Bearer ${await this.accessToken()}` }, retries: 2, retryBaseMs: 300 });
		try {
			return await call();
		} catch (error) {
			if (!(error instanceof ConnectorHttpError) || error.status !== 401) throw error;
			this.token = undefined;
			return call();
		}
	}

	private async accessToken(): Promise<string> {
		const now = (this.options.now ?? Date.now)();
		if (this.token !== undefined && this.token.expiresAt > now) return this.token.value;
		const refreshToken = await this.options.refreshToken();
		if (refreshToken === undefined) throw new GoogleNotConnected();
		const response = await this.options.fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
		});
		const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
		// invalid_grant: the person revoked access from their Google account.
		if (body.error === "invalid_grant") throw new GoogleNotConnected();
		if (!response.ok || body.access_token === undefined) throw new ConnectorHttpError("google", "token refresh", response.status, body.error ?? "");
		this.token = { value: body.access_token, expiresAt: now + ((body.expires_in ?? 3600) - 60) * 1000 };
		return this.token.value;
	}
}

export class GoogleNotConnected extends Error {
	override readonly name = "GoogleNotConnected";
	constructor() {
		super("Google is not connected for this person");
	}
}

function header(part: Part | undefined, name: string): string {
	return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function summary(m: Message): MailSummary {
	return { id: m.id, from: header(m.payload, "From"), subject: header(m.payload, "Subject"), date: header(m.payload, "Date"), snippet: m.snippet ?? "", unread: (m.labelIds ?? []).includes("UNREAD") };
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** The text of a message: the text/plain part, or the HTML one stripped of tags. */
export function plainText(part: Part | undefined): string {
	const find = (p: Part | undefined, type: string): string | undefined => {
		if (p === undefined) return undefined;
		if (p.mimeType === type && p.body?.data) return decode(p.body.data);
		for (const child of p.parts ?? []) {
			const found = find(child, type);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const text = find(part, "text/plain");
	if (text !== undefined) return text.trim();
	const html = find(part, "text/html");
	if (html === undefined) return "";
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
