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
