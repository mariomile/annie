import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import type { TenantSecrets } from "../core/secrets.ts";
import { EgressDenied } from "../core/errors.ts";
import { ConnectorHttpError, requestJson } from "./http.ts";

/**
 * What Annie can read of a person's Google account. Google rates gmail.readonly "restricted" (a
 * public app needs a yearly third-party security assessment) and calendar.readonly "sensitive" (a
 * verification of days), so the operator chooses which to ask. Writing (ADR 0021) is asked only
 * when the operator turns it on, and every write waits for the person's approval.
 */
export type GoogleService = "gmail" | "calendar";
export const GOOGLE_SERVICES: readonly GoogleService[] = ["gmail", "calendar"];
export const GOOGLE_SCOPE: Readonly<Record<GoogleService, string>> = {
	gmail: "https://www.googleapis.com/auth/gmail.readonly",
	calendar: "https://www.googleapis.com/auth/calendar.readonly",
};
/** Writing, with approval: drafts and sending mail (no reading or deleting), and events. */
export const GOOGLE_WRITE_SCOPE: Readonly<Record<GoogleService, string>> = {
	gmail: "https://www.googleapis.com/auth/gmail.compose",
	calendar: "https://www.googleapis.com/auth/calendar.events",
};

/** The scopes asked for these services, with writing or without. */
export function googleScopes(services: readonly GoogleService[], write: boolean): string[] {
	return [...services.map((service) => GOOGLE_SCOPE[service]), ...(write ? services.map((service) => GOOGLE_WRITE_SCOPE[service]) : [])];
}

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
	/** Ask to write too (ANNIE_GOOGLE_WRITE): every write still waits for the person's approval. */
	readonly write?: boolean;
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

	/** Whether another person of the tenant connected the same Google account. */
	sharedWithOthers(personId: string, email: string): boolean {
		return Object.entries(readJsonFile<Record<string, GoogleAccount>>(this.file, {})).some(([id, account]) => id !== personId && account.email === email);
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

/** What a return from Google carries on to the console: code, state or error, nothing else. */
export function googleReturnQuery(url: URL): string {
	const keep = new URLSearchParams();
	for (const name of ["code", "state", "error"]) {
		const value = url.searchParams.get(name);
		if (value !== null && value.length <= 2048) keep.set(name, value);
	}
	return keep.toString();
}

/**
 * The OAuth authorization code flow with PKCE. Its calls go to Google's fixed sign-in hosts with
 * the plain fetch: connecting is the person's act from the console, not an instance's tool, so no
 * instance's egress policy applies (the tools that read mail and calendar go through it). The state names the tenant (so Annie Cloud's
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
			scope: [...IDENTITY_SCOPES, ...googleScopes(this.config.services, this.config.write === true)].join(" "),
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
		if (googleScopes(this.config.services, this.config.write === true).some((scope) => !scopes.includes(scope))) {
			await this.revoke(body.refresh_token);
			const what =
				this.config.services.length > 1 || this.config.write === true
					? `ha bisogno di tutti i permessi richiesti (${this.config.services.map((s) => (s === "gmail" ? "posta" : "calendario")).join(" e ")}${this.config.write === true ? ", leggere e scrivere" : ""})`
					: `ha bisogno del permesso di leggere ${this.config.services[0] === "gmail" ? "la posta" : "il calendario"}`;
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
type Message = { id: string; threadId?: string; snippet?: string; labelIds?: string[]; payload?: Part };
type ApiEvent = { id: string; summary?: string; location?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { email?: string; displayName?: string }[] };

/** What a reply needs of the message it answers. */
export type ReplyTarget = { readonly id: string; readonly threadId: string; readonly from: string; readonly replyTo: string; readonly subject: string; readonly messageId: string; readonly references: string };

/** The time of an event as Google takes it: a day (all day) or a moment, with its zone when it has no offset. */
export type EventTime = { readonly date: string } | { readonly dateTime: string; readonly timeZone?: string };

/** A write that may have reached Google: never "not done", never repeated. */
export class GoogleUncertain extends Error {
	override readonly name = "GoogleUncertain";
}

/** One person's Gmail and Calendar over an egress-guarded fetch. Writes are called only for an approved action. */
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
		const body = await this.get<{ items?: ApiEvent[] }>(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, "calendar events");
		return (body.items ?? []).map(calendarEvent);
	}

	async event(id: string): Promise<CalendarEvent> {
		return calendarEvent(await this.get<ApiEvent>(`${EVENTS}/${encodeURIComponent(id)}`, "calendar event"));
	}

	/** The headers a reply to message `id` needs. */
	async replyTarget(id: string): Promise<ReplyTarget> {
		const names = ["From", "Reply-To", "Subject", "Message-ID", "References"].map((n) => `metadataHeaders=${n}`).join("&");
		const m = await this.get<Message>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&${names}`, "mail metadata");
		return { id: m.id, threadId: m.threadId ?? "", from: header(m.payload, "From"), replyTo: header(m.payload, "Reply-To"), subject: header(m.payload, "Subject"), messageId: header(m.payload, "Message-ID"), references: header(m.payload, "References") };
	}

	async sendMail(raw: string, threadId?: string): Promise<{ id: string }> {
		return this.write("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw, ...(threadId === undefined ? {} : { threadId }) }, "mail send");
	}

	async createDraft(raw: string, threadId?: string): Promise<{ id: string }> {
		return this.write("POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw, ...(threadId === undefined ? {} : { threadId }) } }, "mail draft");
	}

	/** `notify`: Google writes to the guests (sendUpdates=all), or tells nobody. */
	async createEvent(event: Record<string, unknown>, notify: boolean): Promise<{ id: string; htmlLink?: string }> {
		return this.write("POST", `${EVENTS}?sendUpdates=${notify ? "all" : "none"}`, event, "calendar create");
	}

	async updateEvent(id: string, change: Record<string, unknown>, notify: boolean): Promise<{ id: string; htmlLink?: string }> {
		return this.write("PATCH", `${EVENTS}/${encodeURIComponent(id)}?sendUpdates=${notify ? "all" : "none"}`, change, "calendar update");
	}

	async deleteEvent(id: string, notify: boolean): Promise<void> {
		await this.write("DELETE", `${EVENTS}/${encodeURIComponent(id)}?sendUpdates=${notify ? "all" : "none"}`, undefined, "calendar delete");
	}

	/**
	 * One write, never retried by itself: the token comes first, so failing to get it is "not
	 * done". Once the request leaves, no answer or a server error is GoogleUncertain; a refusal
	 * (4xx) is not done. A 401 is the one retry: Google did nothing with an expired token.
	 */
	private async write<T>(method: "POST" | "PATCH" | "DELETE", url: string, body: unknown, operation: string): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const token = await this.accessToken();
			let response: Response;
			try {
				response = await this.options.fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			} catch (error) {
				if (error instanceof EgressDenied) throw error;
				throw new GoogleUncertain(`la richiesta a Google è partita ma la risposta non è arrivata`);
			}
			if (response.status === 401 && attempt === 0) {
				this.token = undefined;
				continue;
			}
			if (response.status >= 500) throw new GoogleUncertain(`Google ha risposto ${response.status}: non si sa se l'ha fatto`);
			if (!response.ok) {
				const detail = ((await response.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "";
				throw new ConnectorHttpError("google", operation, response.status, detail.slice(0, 200));
			}
			return (response.status === 204 ? undefined : await response.json().catch(() => ({}))) as T;
		}
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
			redirect: "error",
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

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function calendarEvent(e: ApiEvent): CalendarEvent {
	return {
		id: e.id,
		summary: e.summary ?? "(senza titolo)",
		start: e.start?.dateTime ?? e.start?.date ?? "",
		end: e.end?.dateTime ?? e.end?.date ?? "",
		...(e.location === undefined ? {} : { location: e.location }),
		attendees: (e.attendees ?? []).map((a) => a.displayName ?? a.email ?? "").filter((a) => a !== ""),
	};
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
