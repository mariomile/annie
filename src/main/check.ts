import type { AnnieConfig } from "./config.ts";

/**
 * `pnpm annie check`: before a live test, ask each configured service whether the keys in
 * `.env` work and whether this machine reaches it. Nothing secret is printed: a check reports
 * what it found (a bot name, a mailbox) or what to fix (which variable, which host).
 */

export type CheckResult = { readonly name: string; readonly ok: boolean; readonly detail: string };

const TIMEOUT_MS = 10_000;
const GMAIL_SCOPES = ["gmail.readonly", "gmail.send"] as const;

export async function runChecks(config: AnnieConfig, fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
	const call = (url: string, init: RequestInit = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	const checks: Promise<CheckResult>[] = [check(`Modello (${config.modelProvider})`, () => modelCheck(config, call))];
	if (config.telegram !== undefined) {
		const token = config.telegram.token;
		checks.push(check("Telegram (agente)", () => telegramCheck(token, call)));
	}
	const segreteria = config.segreteria;
	if (segreteria !== undefined) {
		checks.push(check("Telegram (segreteria)", () => telegramCheck(segreteria.telegramBotToken, call)));
		checks.push(check("Gmail", () => gmailCheck(segreteria.gmail, call)));
		checks.push(check("HubSpot", () => hubspotCheck(segreteria.hubspotAccessToken, call)));
	}
	return Promise.all(checks);
}

type Call = (url: string, init?: RequestInit) => Promise<Response>;

class CheckFailed extends Error {}

/** Run one check; a network error names the host only, never the URL (it may hold a token). */
async function check(name: string, run: () => Promise<string>): Promise<CheckResult> {
	try {
		return { name, ok: true, detail: await run() };
	} catch (error) {
		if (error instanceof CheckFailed) return { name, ok: false, detail: error.message };
		return { name, ok: false, detail: "errore inatteso nel controllo" };
	}
}

async function reach(call: Call, url: string, init?: RequestInit): Promise<Response> {
	try {
		return await call(url, init);
	} catch {
		const host = new URL(url).host;
		throw new CheckFailed(`${host} non raggiungibile: controlla la rete, o che il dominio sia tra quelli consentiti`);
	}
}

async function modelCheck(config: AnnieConfig, call: Call): Promise<string> {
	if (config.modelProvider === "faux") return "modello locale di sviluppo, nessuna chiave";
	const key = config.modelApiKey ?? "";
	const response =
		config.modelProvider === "anthropic"
			? await reach(call, "https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
			: await reach(call, "https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
	const variable = config.modelProvider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
	if (response.status === 401 || response.status === 403) throw new CheckFailed(`chiave rifiutata: controlla ${variable}`);
	if (!response.ok) throw new CheckFailed(`il provider risponde ${response.status}`);
	const models = ((await response.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
	const found = models.includes(config.modelId);
	if (models.length > 0 && !found) throw new CheckFailed(`chiave valida, ma il modello ${config.modelId} non è tra quelli disponibili (ANNIE_MODEL_ID)`);
	return `chiave valida, modello ${config.modelId}`;
}

async function telegramCheck(token: string, call: Call): Promise<string> {
	const response = await reach(call, `https://api.telegram.org/bot${token}/getMe`);
	const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string } };
	if (response.status === 401 || response.status === 404) throw new CheckFailed("token del bot rifiutato da Telegram: rigeneralo da @BotFather");
	if (payload.ok !== true) throw new CheckFailed(`Telegram risponde ${response.status}`);
	return `bot @${payload.result?.username ?? "?"}`;
}

async function gmailCheck(gmail: { clientId: string; clientSecret: string; refreshToken: string }, call: Call): Promise<string> {
	const token = await reach(call, "https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: gmail.clientId, client_secret: gmail.clientSecret, refresh_token: gmail.refreshToken, grant_type: "refresh_token" }).toString(),
	});
	const granted = (await token.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string };
	if (granted.access_token === undefined) {
		if (granted.error === "invalid_grant") throw new CheckFailed("refresh token scaduto o revocato (GMAIL_REFRESH_TOKEN): rigeneralo; un'app OAuth in «Testing» lo fa scadere dopo 7 giorni");
		throw new CheckFailed(`Google rifiuta le credenziali OAuth (${granted.error ?? token.status}): controlla GMAIL_CLIENT_ID e GMAIL_CLIENT_SECRET`);
	}
	const missing = GMAIL_SCOPES.filter((scope) => !(granted.scope ?? "").includes(scope));
	if (missing.length > 0) throw new CheckFailed(`al token mancano gli scope ${missing.join(", ")}: rigenera il refresh token con entrambi`);
	const profile = await reach(call, "https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${granted.access_token}` } });
	if (!profile.ok) throw new CheckFailed(`Gmail risponde ${profile.status}`);
	const { emailAddress } = (await profile.json()) as { emailAddress?: string };
	return `casella ${emailAddress ?? "?"}, scope di lettura e invio`;
}

async function hubspotCheck(accessToken: string, call: Call): Promise<string> {
	const response = await reach(call, "https://api.hubapi.com/crm/v3/properties/contacts/hs_lead_status", { headers: { authorization: `Bearer ${accessToken}` } });
	if (response.status === 401) throw new CheckFailed("token rifiutato (HUBSPOT_ACCESS_TOKEN)");
	if (response.status === 403) throw new CheckFailed("il token non ha gli scope crm.objects.contacts.read e .write");
	if (!response.ok) throw new CheckFailed(`HubSpot risponde ${response.status}`);
	const property = (await response.json()) as { options?: { value: string }[] };
	const values = (property.options ?? []).map((o) => o.value);
	return `token valido; valori di hs_lead_status nel portale: ${values.length > 0 ? values.join(", ") : "nessuno"}`;
}
