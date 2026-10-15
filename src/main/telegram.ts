/**
 * `pnpm dev:telegram`: one tenant, one instance, one Telegram bot, in one process.
 * Reads .env; creates the tenant and instance on first start, with an egress policy
 * that allows exactly the configured model provider and the "telegram" channel.
 */
import { existsSync } from "node:fs";
import { TelegramAdapter } from "../channels/telegram.ts";
import { piDurableEngine } from "../core/adapters/pi-durable.ts";
import { AnnieRuntime, createSlowCounter, modelApiKeySecret, NotFound } from "../core/index.ts";
import { connectChannel } from "../gateway.ts";
import { ConfigError, loadTelegramConfig, type TelegramConfig } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

let config: TelegramConfig;
try {
	config = loadTelegramConfig(process.env);
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(`annie: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

const runtime = new AnnieRuntime({ dataDir: config.dataDir, engine: piDurableEngine, tools: [createSlowCounter()] });
await bootstrap(runtime, config);

const adapter = new TelegramAdapter({
	token: config.telegramBotToken,
	tenantId: config.tenantId,
	instanceId: config.instanceId,
	log: (message) => console.error(message),
});
connectChannel(runtime, adapter, { tenantId: config.tenantId, instanceId: config.instanceId });

const { pending } = await runtime.resume(config.tenantId, config.instanceId);
await adapter.start();
console.error(
	`annie: tenant=${config.tenantId} instance=${config.instanceId} model=${config.modelProvider}/${config.modelId} ` +
		`resumed=${pending}, listening on Telegram (Ctrl+C to stop)`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void (async () => {
			await adapter.stop();
			await runtime.close();
			process.exit(0);
		})();
	});
}

async function bootstrap(runtime: AnnieRuntime, config: TelegramConfig): Promise<void> {
	try {
		await runtime.registry.getTenant(config.tenantId);
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createTenant({ id: config.tenantId, name: config.tenantId });
	}
	try {
		const instance = await runtime.registry.getInstance(config.tenantId, config.instanceId);
		if (instance.model.provider !== config.modelProvider || instance.model.modelId !== config.modelId) {
			console.error(
				`annie: instance ${config.instanceId} is configured for ${instance.model.provider}/${instance.model.modelId}; ` +
					`ANNIE_MODEL_PROVIDER/ANNIE_MODEL_ID are ignored for an existing instance.`,
			);
		}
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createInstance(config.tenantId, {
			id: config.instanceId,
			name: `Telegram (${config.instanceId})`,
			model: { provider: config.modelProvider, modelId: config.modelId },
			egress: { modelProviders: [config.modelProvider], channels: ["telegram"] },
		});
	}
	if (config.modelApiKey !== undefined) {
		await runtime.secrets(config.tenantId).set(modelApiKeySecret(config.modelProvider), config.modelApiKey);
	}
}
