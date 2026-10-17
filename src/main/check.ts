import { DEFAULT_LEAD_STATUS } from "../connectors/hubspot.ts";
import { computerLabel, createComputerProvider } from "../computer/create.ts";
import { ecbRates, ExchangeRateError, type ExchangeRatesConfig } from "../core/exchange-rates.ts";
import { DEV_PROVIDER, modelProvider } from "../core/model-providers.ts";
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
	const transcription = config.transcription;
	if (transcription !== undefined) checks.push(check("Trascrizione dei vocali", () => transcriptionCheck(transcription, call)));
	const speech = config.speech;
	if (speech !== undefined) checks.push(check("Risposte a voce", () => speechCheck(speech, call)));
	const search = config.webSearch;
	if (search !== undefined) checks.push(check("Ricerca sul web", () => searchCheck(search, call)));
	const weather = config.weather;
	if (weather !== undefined) checks.push(check("Meteo", () => weatherCheck(weather, call)));
	const rates = config.exchangeRates;
	if (rates !== undefined) checks.push(check("Cambi", () => exchangeRatesCheck(rates, fetchImpl)));
	const computer = config.computer;
	if (computer !== undefined) checks.push(check(`Computer (${computerLabel(computer)})`, () => computerCheck(config, computer)));
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
	if (config.modelProvider === DEV_PROVIDER) return "modello locale di sviluppo, nessuna chiave";
	const key = config.modelApiKeys[config.modelProvider] ?? "";
	const variable = modelProvider(config.modelProvider)?.keyEnv ?? "la chiave del modello";
	// The providers whose model list is checked here; the others prove the key at the first reply.
	if (config.modelProvider !== "anthropic" && config.modelProvider !== "openai") return `chiave presente in ${variable}, modello ${config.modelId}: la prima risposta in chat la verifica`;
	const response =
		config.modelProvider === "anthropic"
			? await reach(call, "https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
			: await reach(call, "https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed(`chiave rifiutata: controlla ${variable}`);
	if (!response.ok) throw new CheckFailed(`il provider risponde ${response.status}`);
	const models = ((await response.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
	const found = models.includes(config.modelId);
	if (models.length > 0 && !found) throw new CheckFailed(`chiave valida, ma il modello ${config.modelId} non è tra quelli disponibili (ANNIE_MODEL_ID)`);
	return `chiave valida, modello ${config.modelId}`;
}

/** The Docker host answers and has the image (ADR 0013), Fly takes the token, or the control plane answers (ADR 0015). */
async function computerCheck(config: AnnieConfig, computer: NonNullable<AnnieConfig["computer"]>): Promise<string> {
	const problem = await createComputerProvider(computer, { tenant: config.tenantId, dataDir: config.dataDir, ...(config.cell.secret === undefined ? {} : { cellSecret: config.cell.secret }) }).check();
	if (problem !== undefined) throw new CheckFailed(problem);
	if (computer.kind === "docker") return `Docker risponde, immagine ${computer.image} presente`;
	if (computer.kind === "fly") return `Fly accetta il token dell'organizzazione ${computer.org}; l'immagine ${computer.image} si prova al primo comando`;
	return "il control plane risponde";
}

/** The service's model list: the key works and the model is there (the services that list models). */
async function transcriptionCheck(config: { url: string; apiKey: string; model: string }, call: Call): Promise<string> {
	const response = await reach(call, `${config.url.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed("chiave rifiutata: controlla ANNIE_TRANSCRIBE_API_KEY");
	if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla ANNIE_TRANSCRIBE_URL`);
	const models = ((await response.json().catch(() => ({}))) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
	// Aliases (voxtral-mini-latest) are not always listed: a warning, not a failure.
	if (models.length > 0 && !models.includes(config.model)) return `chiave valida; il modello ${config.model} non compare nell'elenco del servizio, prova un vocale per esserne certo`;
	return `chiave valida, modello ${config.model}`;
}

/** The key works: the service lists its models. No audio is made, so the check costs nothing. */
async function speechCheck(config: { url: string; apiKey: string; model: string; voice: string }, call: Call): Promise<string> {
	const response = await reach(call, `${config.url}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed("chiave rifiutata: controlla ANNIE_SPEECH_API_KEY");
	if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla ANNIE_SPEECH_URL`);
	return `chiave valida (modello ${config.model} e voce ${config.voice} non verificati: prova un vocale)`;
}

/** One search for a word everyone has: the key works and results come back. */
async function searchCheck(config: { url: string; apiKey: string; country: string; language: string }, call: Call): Promise<string> {
	const url = new URL(config.url);
	url.searchParams.set("q", "Roma");
	url.searchParams.set("count", "1");
	url.searchParams.set("country", config.country);
	url.searchParams.set("search_lang", config.language);
	const response = await reach(call, url.toString(), { headers: { accept: "application/json", "x-subscription-token": config.apiKey } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed("chiave rifiutata: controlla ANNIE_SEARCH_API_KEY");
	if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla ANNIE_SEARCH_URL`);
	return `chiave valida, ${url.host} risponde`;
}

/** One place and a one-day forecast for it: both addresses answer (with the key, on a paid plan). Bodies are not read. */
async function weatherCheck(config: { forecastUrl: string; geocodingUrl: string; apiKey?: string }, call: Call): Promise<string> {
	const geocoding = new URL(config.geocodingUrl);
	for (const [name, value] of [["name", "Roma"], ["count", "1"], ["format", "json"]]) geocoding.searchParams.set(name as string, value as string);
	const forecast = new URL(config.forecastUrl);
	for (const [name, value] of [["latitude", "41.89"], ["longitude", "12.51"], ["daily", "weather_code"], ["forecast_days", "1"]]) forecast.searchParams.set(name as string, value as string);
	for (const [url, variable] of [[geocoding, "ANNIE_WEATHER_GEOCODING_URL"], [forecast, "ANNIE_WEATHER_URL"]] as const) {
		if (config.apiKey !== undefined) url.searchParams.set("apikey", config.apiKey);
		const response = await reach(call, url.toString(), { headers: { accept: "application/json" } });
		await response.body?.cancel().catch(() => {});
		if (response.status === 401 || response.status === 403) throw new CheckFailed(config.apiKey === undefined ? "richiesta rifiutata: per un uso commerciale serve un piano e ANNIE_WEATHER_API_KEY" : "chiave rifiutata: controlla ANNIE_WEATHER_API_KEY");
		if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla ${variable}`);
	}
	return `${geocoding.host} e ${forecast.host} rispondono${config.apiKey === undefined ? "" : ", chiave valida"}`;
}

/** The day's file of reference rates, downloaded and read: the host answers and the file makes sense. */
async function exchangeRatesCheck(config: ExchangeRatesConfig, fetchImpl: typeof fetch): Promise<string> {
	const host = new URL(config.url).host;
	try {
		const { day } = await ecbRates(config, fetchImpl).rateOn();
		return `${host} risponde, cambi del ${day.date} per ${day.rates.size} valute`;
	} catch (error) {
		if (error instanceof ExchangeRateError) throw new CheckFailed(`${error.message}: controlla che ${host} sia raggiungibile, o ANNIE_EXCHANGE_RATES_URL`);
		throw error;
	}
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
	const listed = `valori di hs_lead_status nel portale: ${values.length > 0 ? values.join(", ") : "nessuno"}`;
	// The segreteria sets these after a pratica; a portal without them only gets the note.
	const missing = Object.values(DEFAULT_LEAD_STATUS).filter((v): v is string => v !== null && !values.includes(v));
	if (missing.length > 0) throw new CheckFailed(`token valido, ma il portale non ha ${missing.join(", ")}, che la segreteria imposta: aggiungili o cambia la mappa (${listed})`);
	return `token valido; ${listed}`;
}
