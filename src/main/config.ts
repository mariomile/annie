import type { WebSearchConfig } from "../core/web-search.ts";
import type { SpeakerConfig } from "../channels/speech.ts";
import type { TranscriberConfig } from "../channels/voice.ts";
import { GOOGLE_SERVICES, type GoogleService } from "../connectors/google.ts";
export type TelegramConfig = {
	readonly telegramBotToken: string;
	readonly modelProvider: string;
	readonly modelId: string;
	/** Undefined for the local "faux" model, which needs no key. */
	readonly modelApiKey: string | undefined;
	readonly dataDir: string;
	readonly tenantId: string;
	readonly instanceId: string;
	/** Telegram user IDs allowed to talk to the bot; undefined leaves the instance's list as it is. */
	readonly telegramAllowedUsers: readonly string[] | undefined;
};

export const DEFAULT_MODEL_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-sonnet-5-5";

/** Env var holding the API key of each provider. */
export const MODEL_KEY_ENV: Readonly<Record<string, string>> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
};

export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

/** Reads the configuration of `pnpm dev:telegram`. Throws ConfigError naming each missing variable. */
export function loadTelegramConfig(env: Readonly<Record<string, string | undefined>>): TelegramConfig {
	const missing: string[] = [];
	const telegramBotToken = nonEmpty(env.TELEGRAM_BOT_TOKEN);
	if (telegramBotToken === undefined) missing.push("TELEGRAM_BOT_TOKEN");

	const modelProvider = nonEmpty(env.ANNIE_MODEL_PROVIDER) ?? DEFAULT_MODEL_PROVIDER;
	let modelApiKey: string | undefined;
	if (modelProvider !== "faux") {
		const keyEnv = MODEL_KEY_ENV[modelProvider];
		if (keyEnv === undefined) {
			throw new ConfigError(
				`ANNIE_MODEL_PROVIDER="${modelProvider}" is not supported. Use one of: ${[...Object.keys(MODEL_KEY_ENV), "faux"].join(", ")}`,
			);
		}
		modelApiKey = nonEmpty(env[keyEnv]);
		if (modelApiKey === undefined) missing.push(keyEnv);
	}

	const allowedRaw = nonEmpty(env.ANNIE_TELEGRAM_ALLOWED_USERS);
	const telegramAllowedUsers = allowedRaw?.split(",").map((id) => id.trim()).filter((id) => id !== "");
	const invalid = telegramAllowedUsers?.filter((id) => !/^\d+$/.test(id)) ?? [];
	if (invalid.length > 0) {
		throw new ConfigError(`ANNIE_TELEGRAM_ALLOWED_USERS must be a comma-separated list of numeric Telegram user IDs; invalid: ${invalid.join(", ")}`);
	}

	if (missing.length > 0) {
		throw new ConfigError(
			`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} in .env (see .env.example).`,
		);
	}
	return {
		telegramBotToken: telegramBotToken as string,
		modelProvider,
		modelId: nonEmpty(env.ANNIE_MODEL_ID) ?? (modelProvider === "faux" ? "annie-dev" : DEFAULT_MODEL_ID),
		modelApiKey,
		dataDir: nonEmpty(env.ANNIE_DATA_DIR) ?? "data",
		tenantId: nonEmpty(env.ANNIE_TENANT_ID) ?? "default",
		instanceId: nonEmpty(env.ANNIE_INSTANCE_ID) ?? "telegram",
		telegramAllowedUsers,
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export type SegreteriaConfig = {
	readonly telegramBotToken: string;
	/** "anthropic" (Haiku reads, Sonnet drafts) or "faux" (heuristics, no key). */
	readonly modelProvider: "anthropic" | "faux";
	readonly anthropicApiKey: string | undefined;
	readonly gmail: { readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string };
	readonly hubspotAccessToken: string;
	readonly salesUserIds: readonly string[];
	readonly dataDir: string;
	readonly tenantId: string;
	readonly instanceId: string;
	readonly pollSeconds: number;
	readonly requireVatNumber: boolean;
};

/** Reads the configuration of `pnpm dev:segreteria`. Throws ConfigError naming each missing variable. */
export function loadSegreteriaConfig(env: Readonly<Record<string, string | undefined>>): SegreteriaConfig {
	const missing: string[] = [];
	const need = (name: string): string => {
		const value = nonEmpty(env[name]);
		if (value === undefined) missing.push(name);
		return value ?? "";
	};
	const telegramBotToken = need("TELEGRAM_BOT_TOKEN");
	const provider = nonEmpty(env.ANNIE_SEGRETERIA_MODEL) ?? "anthropic";
	if (provider !== "anthropic" && provider !== "faux") throw new ConfigError(`ANNIE_SEGRETERIA_MODEL="${provider}" is not supported. Use anthropic or faux.`);
	const anthropicApiKey = provider === "anthropic" ? need("ANTHROPIC_API_KEY") : undefined;
	const gmail = { clientId: need("GMAIL_CLIENT_ID"), clientSecret: need("GMAIL_CLIENT_SECRET"), refreshToken: need("GMAIL_REFRESH_TOKEN") };
	const hubspotAccessToken = need("HUBSPOT_ACCESS_TOKEN");
	const allowedRaw = need("ANNIE_TELEGRAM_ALLOWED_USERS");
	const salesUserIds = allowedRaw.split(",").map((id) => id.trim()).filter((id) => id !== "");
	const invalid = salesUserIds.filter((id) => !/^\d+$/.test(id));
	if (invalid.length > 0) throw new ConfigError(`ANNIE_TELEGRAM_ALLOWED_USERS must be a comma-separated list of numeric Telegram user IDs; invalid: ${invalid.join(", ")}`);
	if (missing.length > 0) {
		throw new ConfigError(
			`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} in .env (see .env.example).`,
		);
	}
	const pollSeconds = Number(nonEmpty(env.ANNIE_MAIL_POLL_SECONDS) ?? "60");
	if (!Number.isInteger(pollSeconds) || pollSeconds < 10) throw new ConfigError("ANNIE_MAIL_POLL_SECONDS must be an integer of at least 10");
	return {
		telegramBotToken,
		modelProvider: provider,
		anthropicApiKey: provider === "anthropic" ? anthropicApiKey : undefined,
		gmail,
		hubspotAccessToken,
		salesUserIds,
		dataDir: nonEmpty(env.ANNIE_DATA_DIR) ?? "data",
		tenantId: nonEmpty(env.ANNIE_TENANT_ID) ?? "default",
		instanceId: nonEmpty(env.ANNIE_SEGRETERIA_INSTANCE_ID) ?? "segreteria",
		pollSeconds,
		requireVatNumber: /^(1|true|yes|si|sì)$/i.test(nonEmpty(env.ANNIE_REQUIRE_VAT_NUMBER) ?? ""),
	};
}

export type AnnieConfig = {
	readonly dataDir: string;
	readonly tenantId: string;
	readonly instanceId: string;
	readonly instanceName: string;
	readonly modelProvider: string;
	readonly modelId: string;
	readonly modelApiKey: string | undefined;
	readonly timeZone: string;
	readonly web: { readonly host: string; readonly port: number; readonly publicUrl: string | undefined };
	readonly telegram:
		| {
				readonly token: string;
				readonly allowedUsers: readonly string[] | undefined;
				readonly approvers: readonly string[] | undefined;
				/** Webhook instead of long polling: Telegram pushes to ANNIE_PUBLIC_URL with this secret. */
				readonly webhookSecret: string | undefined;
		  }
		| undefined;
	readonly segreteria: SegreteriaConfig | undefined;
	/** Running as a cell of Annie Cloud: set by the control plane. */
	readonly cell: { readonly secret: string | undefined };
	/** The OAuth client people connect their Google account with (Gmail and Calendar, read only). */
	readonly google: { readonly clientId: string; readonly clientSecret: string; readonly redirectUrl: string; readonly services: readonly GoogleService[] } | undefined;
	/** Chromium for web_screenshot; Playwright's own if unset. */
	readonly chromiumPath: string | undefined;
	/** The operator accepts Chromium without its sandbox where the sandbox cannot start (ADR 0009). */
	readonly screenshotsWithoutSandbox: boolean;
	/** Where voice messages are transcribed (an OpenAI-compatible service); off if unset. */
	readonly transcription: TranscriberConfig | undefined;
	/** Replies as voice notes (ADR 0020), when the operator set a speech service. */
	readonly speech: SpeakerConfig | undefined;
	/** Web search for the instances (ADR 0017): Brave Search, or the same API elsewhere; off if unset. */
	readonly webSearch: WebSearchConfig | undefined;
	/** Phone calls (ADR 0012): Twilio's REST API (the Ireland region for data in the EU) and the language spoken. */
	readonly phone: { readonly apiBase: string; readonly voice: string };
	/** The instances' computers: a container each on this Docker host (ADR 0013), a Fly machine each, or, in a cell of Annie Cloud, through the control plane (ADR 0015). */
	readonly computer: ComputerConfig | undefined;
};

export type ComputerConfig =
	| { readonly kind: "docker"; readonly image: string; readonly socketPath: string; readonly runtime?: string; readonly memoryMb: number; readonly cpus: number; readonly diskMb: number }
	| { readonly kind: "fly"; readonly token: string; readonly org: string; readonly region: string; readonly image: string; readonly memoryMb: number; readonly cpus: number; readonly diskMb: number; readonly appPrefix?: string; readonly maxConcurrent?: number }
	| { readonly kind: "cloud"; readonly url: string };

/**
 * ANNIE_COMPUTER and its settings: docker (ADR 0013), fly (ADR 0015) or, in a cell, cloud. The
 * control plane of Annie Cloud reads the same settings with `kind` from ANNIE_CLOUD_COMPUTER.
 */
export function loadComputerConfig(env: Readonly<Record<string, string | undefined>>, kind = nonEmpty(env.ANNIE_COMPUTER), variable = "ANNIE_COMPUTER"): ComputerConfig | undefined {
	if (kind === undefined) return undefined;
	if (kind === "cloud") {
		const url = nonEmpty(env.ANNIE_COMPUTER_URL);
		if (url === undefined || !/^https?:\/\/[^\s/]+\/?$/.test(url)) throw new ConfigError("ANNIE_COMPUTER=cloud needs ANNIE_COMPUTER_URL, the control plane's address (http(s)://host[:port])");
		if (nonEmpty(env.ANNIE_CELL_SECRET) === undefined) throw new ConfigError("ANNIE_COMPUTER=cloud is for a cell of Annie Cloud: it needs ANNIE_CELL_SECRET");
		return { kind, url: url.replace(/\/$/, "") };
	}
	if (kind !== "docker" && kind !== "fly") throw new ConfigError(`${variable}: docker or fly, or unset for no computer`);
	const memoryMb = Number(nonEmpty(env.ANNIE_COMPUTER_MEMORY_MB) ?? "1024");
	if (!Number.isInteger(memoryMb) || memoryMb < 128 || memoryMb > 16384) throw new ConfigError("ANNIE_COMPUTER_MEMORY_MB: whole megabytes between 128 and 16384");
	const cpus = Number(nonEmpty(env.ANNIE_COMPUTER_CPUS) ?? "1");
	if (!(cpus >= 0.25 && cpus <= 16)) throw new ConfigError("ANNIE_COMPUTER_CPUS: between 0.25 and 16");
	const diskMb = Number(nonEmpty(env.ANNIE_COMPUTER_DISK_MB) ?? "2048");
	if (!Number.isInteger(diskMb) || diskMb < 64 || diskMb > 102400) throw new ConfigError("ANNIE_COMPUTER_DISK_MB: whole megabytes between 64 and 102400");
	if (kind === "fly") {
		const token = nonEmpty(env.FLY_API_TOKEN);
		const org = nonEmpty(env.ANNIE_FLY_ORG);
		const image = nonEmpty(env.ANNIE_COMPUTER_IMAGE);
		const region = nonEmpty(env.ANNIE_FLY_REGION) ?? "fra";
		if (token === undefined || org === undefined || image === undefined) throw new ConfigError(`${variable}=fly needs FLY_API_TOKEN, ANNIE_FLY_ORG and ANNIE_COMPUTER_IMAGE (the fly target of docker/computer.Dockerfile, in a registry Fly can pull from)`);
		if (!/^[a-z0-9-]{1,40}$/.test(org)) throw new ConfigError("ANNIE_FLY_ORG: the organization's slug");
		if (!/^[a-z]{3}$/.test(region)) throw new ConfigError("ANNIE_FLY_REGION: a Fly region code, e.g. fra");
		if (!Number.isInteger(cpus) || cpus > 8) throw new ConfigError("ANNIE_COMPUTER_CPUS: Fly machines have 1 to 8 whole CPUs");
		if (memoryMb < 256 || memoryMb % 256 !== 0 || memoryMb > cpus * 2048) throw new ConfigError("ANNIE_COMPUTER_MEMORY_MB: on Fly, steps of 256 MB, at most 2048 MB per CPU");
		const appPrefix = nonEmpty(env.ANNIE_FLY_APP_PREFIX);
		if (appPrefix !== undefined && !/^[a-z][a-z0-9-]{1,20}$/.test(appPrefix)) throw new ConfigError("ANNIE_FLY_APP_PREFIX: 2 to 21 lowercase letters, digits and dashes, starting with a letter");
		const concurrent = nonEmpty(env.ANNIE_COMPUTER_MAX_RUNNING);
		if (concurrent !== undefined && !(/^\d+$/.test(concurrent) && Number(concurrent) >= 1 && Number(concurrent) <= 200)) throw new ConfigError("ANNIE_COMPUTER_MAX_RUNNING: commands at once on Fly, 1 to 200");
		return { kind, token, org, region, image, memoryMb, cpus, diskMb, ...(appPrefix === undefined ? {} : { appPrefix }), ...(concurrent === undefined ? {} : { maxConcurrent: Number(concurrent) }) };
	}
	const runtime = nonEmpty(env.ANNIE_COMPUTER_RUNTIME);
	if (runtime !== undefined && !/^[\w.-]{1,40}$/.test(runtime)) throw new ConfigError("ANNIE_COMPUTER_RUNTIME: a Docker runtime name, e.g. runsc");
	return { kind, image: nonEmpty(env.ANNIE_COMPUTER_IMAGE) ?? "annie-computer:latest", socketPath: nonEmpty(env.ANNIE_DOCKER_SOCKET) ?? "/var/run/docker.sock", memoryMb, cpus, diskMb, ...(runtime === undefined ? {} : { runtime }) };
}

/** Reads the configuration of `pnpm start`. Only the model key is required; Telegram and the segreteria are optional. */
export function loadAnnieConfig(env: Readonly<Record<string, string | undefined>>): AnnieConfig {
	const missing: string[] = [];
	const modelProvider = nonEmpty(env.ANNIE_MODEL_PROVIDER) ?? DEFAULT_MODEL_PROVIDER;
	let modelApiKey: string | undefined;
	if (modelProvider !== "faux") {
		const keyEnv = MODEL_KEY_ENV[modelProvider];
		if (keyEnv === undefined) throw new ConfigError(`ANNIE_MODEL_PROVIDER="${modelProvider}" is not supported. Use one of: ${[...Object.keys(MODEL_KEY_ENV), "faux"].join(", ")}`);
		modelApiKey = nonEmpty(env[keyEnv]);
		if (modelApiKey === undefined) missing.push(keyEnv);
	}
	const ids = (name: string): readonly string[] | undefined => {
		const raw = nonEmpty(env[name]);
		if (raw === undefined) return undefined;
		const list = raw.split(",").map((id) => id.trim()).filter((id) => id !== "");
		const invalid = list.filter((id) => !/^\d+$/.test(id));
		if (invalid.length > 0) throw new ConfigError(`${name} must be a comma-separated list of numeric Telegram user IDs; invalid: ${invalid.join(", ")}`);
		return list;
	};
	const port = Number(nonEmpty(env.ANNIE_WEB_PORT) ?? "8080");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("ANNIE_WEB_PORT must be a port number");
	const publicUrl = nonEmpty(env.ANNIE_PUBLIC_URL)?.replace(/\/+$/, "");
	if (publicUrl !== undefined && !/^https?:\/\//.test(publicUrl)) throw new ConfigError("ANNIE_PUBLIC_URL must start with http:// or https://");
	const webhookSecret = nonEmpty(env.ANNIE_TELEGRAM_WEBHOOK_SECRET);
	if (webhookSecret !== undefined) {
		// Telegram's rule for secret_token: 1-256 characters, letters, digits, _ and -.
		if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) throw new ConfigError("ANNIE_TELEGRAM_WEBHOOK_SECRET: 1 to 256 characters, only letters, digits, _ and -");
		if (publicUrl === undefined) throw new ConfigError("ANNIE_TELEGRAM_WEBHOOK_SECRET needs ANNIE_PUBLIC_URL: Telegram sends the updates there");
	}
	const cellSecret = nonEmpty(env.ANNIE_CELL_SECRET);
	if (cellSecret !== undefined && cellSecret.length < 16) throw new ConfigError("ANNIE_CELL_SECRET: at least 16 characters");
	const googleId = nonEmpty(env.ANNIE_GOOGLE_CLIENT_ID);
	const googleSecret = nonEmpty(env.ANNIE_GOOGLE_CLIENT_SECRET);
	let google: AnnieConfig["google"];
	if (googleId !== undefined || googleSecret !== undefined) {
		if (googleId === undefined || googleSecret === undefined) throw new ConfigError("Set both ANNIE_GOOGLE_CLIENT_ID and ANNIE_GOOGLE_CLIENT_SECRET, or neither");
		const redirectUrl = nonEmpty(env.ANNIE_GOOGLE_REDIRECT_URL) ?? (publicUrl === undefined ? `http://localhost:${port}` : publicUrl) + "/oauth/google/callback";
		if (!/^https?:\/\/[^/]+\/oauth\/google\/callback$/.test(redirectUrl)) throw new ConfigError("ANNIE_GOOGLE_REDIRECT_URL must be an http(s) address ending in /oauth/google/callback (Google accepts http only on localhost)");
		const services = (nonEmpty(env.ANNIE_GOOGLE_SERVICES) ?? GOOGLE_SERVICES.join(",")).split(",").map((x) => x.trim()).filter((x) => x !== "");
		const unknown = services.filter((x) => !(GOOGLE_SERVICES as readonly string[]).includes(x));
		if (services.length === 0 || unknown.length > 0) throw new ConfigError(`ANNIE_GOOGLE_SERVICES: a comma-separated list of ${GOOGLE_SERVICES.join(", ")}${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}`);
		google = { clientId: googleId, clientSecret: googleSecret, redirectUrl, services: [...new Set(services)] as GoogleService[] };
	}
	const transcribeUrl = nonEmpty(env.ANNIE_TRANSCRIBE_URL);
	const transcribeKey = nonEmpty(env.ANNIE_TRANSCRIBE_API_KEY);
	let transcription: TranscriberConfig | undefined;
	if (transcribeUrl !== undefined || transcribeKey !== undefined) {
		if (transcribeUrl === undefined || transcribeKey === undefined) throw new ConfigError("Set both ANNIE_TRANSCRIBE_URL and ANNIE_TRANSCRIBE_API_KEY, or neither");
		if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(transcribeUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(transcribeUrl)) throw new ConfigError("ANNIE_TRANSCRIBE_URL: an https address, e.g. https://api.mistral.ai/v1");
		// Mistral's model unless told otherwise: a service in the EU.
		const model = nonEmpty(env.ANNIE_TRANSCRIBE_MODEL) ?? (transcribeUrl.includes("api.mistral.ai") ? "voxtral-mini-latest" : transcribeUrl.includes("api.openai.com") ? "whisper-1" : undefined);
		if (model === undefined) throw new ConfigError("ANNIE_TRANSCRIBE_MODEL: the model of this transcription service");
		const maxSeconds = Number(nonEmpty(env.ANNIE_TRANSCRIBE_MAX_SECONDS) ?? "300");
		if (!Number.isInteger(maxSeconds) || maxSeconds < 10 || maxSeconds > 3600) throw new ConfigError("ANNIE_TRANSCRIBE_MAX_SECONDS: whole seconds between 10 and 3600");
		transcription = { url: transcribeUrl, apiKey: transcribeKey, model, maxSeconds };
	}
	const speechUrl = nonEmpty(env.ANNIE_SPEECH_URL);
	const speechKey = nonEmpty(env.ANNIE_SPEECH_API_KEY);
	let speech: SpeakerConfig | undefined;
	if (speechUrl !== undefined || speechKey !== undefined) {
		if (speechUrl === undefined || speechKey === undefined) throw new ConfigError("Set both ANNIE_SPEECH_URL and ANNIE_SPEECH_API_KEY, or neither");
		if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(speechUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(speechUrl)) throw new ConfigError("ANNIE_SPEECH_URL: an https address, e.g. https://api.openai.com/v1");
		const openai = speechUrl.includes("api.openai.com");
		const model = nonEmpty(env.ANNIE_SPEECH_MODEL) ?? (openai ? "gpt-4o-mini-tts" : undefined);
		if (model === undefined) throw new ConfigError("ANNIE_SPEECH_MODEL: the model of this speech service");
		const voice = nonEmpty(env.ANNIE_SPEECH_VOICE) ?? (openai ? "nova" : undefined);
		if (voice === undefined) throw new ConfigError("ANNIE_SPEECH_VOICE: the voice of this speech service");
		const maxChars = Number(nonEmpty(env.ANNIE_SPEECH_MAX_CHARS) ?? "1500");
		if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 4000) throw new ConfigError("ANNIE_SPEECH_MAX_CHARS: whole characters between 100 and 4000");
		speech = { url: speechUrl.replace(/\/+$/, ""), apiKey: speechKey, model, voice, maxChars };
	}
	const searchKey = nonEmpty(env.ANNIE_SEARCH_API_KEY);
	let webSearch: WebSearchConfig | undefined;
	if (searchKey !== undefined) {
		const url = nonEmpty(env.ANNIE_SEARCH_URL) ?? "https://api.search.brave.com/res/v1/web/search";
		if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(url)) throw new ConfigError("ANNIE_SEARCH_URL: an https address, e.g. https://api.search.brave.com/res/v1/web/search");
		const country = (nonEmpty(env.ANNIE_SEARCH_COUNTRY) ?? "IT").toUpperCase();
		if (!/^([A-Z]{2}|ALL)$/.test(country)) throw new ConfigError("ANNIE_SEARCH_COUNTRY: two letters (IT, FR, US…) or ALL");
		const language = (nonEmpty(env.ANNIE_SEARCH_LANG) ?? "it").toLowerCase();
		if (!/^[a-z]{2}(-[a-z]{2,4})?$/.test(language)) throw new ConfigError("ANNIE_SEARCH_LANG: a language code, e.g. it or en");
		const maxPerDay = Number(nonEmpty(env.ANNIE_SEARCH_MAX_PER_DAY) ?? "200");
		if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 100_000) throw new ConfigError("ANNIE_SEARCH_MAX_PER_DAY: a whole number from 1 to 100000");
		webSearch = { url, apiKey: searchKey, country, language, maxPerDay };
	} else if (nonEmpty(env.ANNIE_SEARCH_URL) !== undefined) {
		throw new ConfigError("ANNIE_SEARCH_URL is set without ANNIE_SEARCH_API_KEY");
	}
	const computer = loadComputerConfig(env);
	const token = nonEmpty(env.TELEGRAM_BOT_TOKEN);
	const telegram = token === undefined ? undefined : { token, allowedUsers: ids("ANNIE_TELEGRAM_ALLOWED_USERS"), approvers: ids("ANNIE_TELEGRAM_APPROVERS"), webhookSecret };
	const timeZone = nonEmpty(env.ANNIE_TIME_ZONE) ?? "Europe/Rome";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
	} catch {
		throw new ConfigError(`ANNIE_TIME_ZONE="${timeZone}" is not a time zone`);
	}
	if (missing.length > 0) throw new ConfigError(`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} in .env (see .env.example).`);
	const segreteriaToken = nonEmpty(env.ANNIE_SEGRETERIA_TELEGRAM_BOT_TOKEN);
	let segreteria: SegreteriaConfig | undefined;
	if (segreteriaToken !== undefined) {
		try {
			segreteria = loadSegreteriaConfig({
				...env,
				TELEGRAM_BOT_TOKEN: segreteriaToken,
				ANNIE_TELEGRAM_ALLOWED_USERS: env.ANNIE_SEGRETERIA_SALES,
				ANNIE_SEGRETERIA_MODEL: modelProvider === "faux" ? "faux" : "anthropic",
			});
		} catch (error) {
			// Same checks as dev:segreteria, with the names this process reads.
			if (error instanceof ConfigError) throw new ConfigError(error.message.replaceAll("ANNIE_TELEGRAM_ALLOWED_USERS", "ANNIE_SEGRETERIA_SALES").replaceAll("TELEGRAM_BOT_TOKEN", "ANNIE_SEGRETERIA_TELEGRAM_BOT_TOKEN"));
			throw error;
		}
	}
	return {
		dataDir: nonEmpty(env.ANNIE_DATA_DIR) ?? "data",
		tenantId: nonEmpty(env.ANNIE_TENANT_ID) ?? "default",
		instanceId: nonEmpty(env.ANNIE_INSTANCE_ID) ?? "annie",
		instanceName: nonEmpty(env.ANNIE_INSTANCE_NAME) ?? "Annie",
		modelProvider,
		modelId: nonEmpty(env.ANNIE_MODEL_ID) ?? (modelProvider === "faux" ? "annie-dev" : DEFAULT_MODEL_ID),
		modelApiKey,
		timeZone,
		web: { host: nonEmpty(env.ANNIE_WEB_HOST) ?? "127.0.0.1", port, publicUrl },
		telegram,
		segreteria,
		cell: { secret: cellSecret },
		google,
		chromiumPath: nonEmpty(env.ANNIE_CHROMIUM_PATH),
		screenshotsWithoutSandbox: nonEmpty(env.ANNIE_SCREENSHOTS_WITHOUT_SANDBOX) === "1",
		transcription,
		speech,
		webSearch,
		computer,
		phone: { apiBase: (nonEmpty(env.ANNIE_TWILIO_API) ?? "https://api.twilio.com").replace(/\/$/, ""), voice: nonEmpty(env.ANNIE_PHONE_VOICE) ?? "Polly.Bianca" },
	};
}
