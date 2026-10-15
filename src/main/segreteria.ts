/**
 * `pnpm dev:segreteria`: the segreteria commerciale of one tenant, in one process.
 * Gmail in, HubSpot for leads, Telegram for the sales people's approval. Reads .env;
 * creates the tenant and the instance on first start and stores the credentials in the
 * tenant's secret store. Never sends a reply without Approva.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TelegramAdapter } from "../channels/telegram.ts";
import { GMAIL_HOSTS, GMAIL_SECRETS, GmailMailAdapter } from "../connectors/gmail.ts";
import { egressFetch } from "../connectors/http.ts";
import { HUBSPOT_HOSTS, HUBSPOT_SECRET, HubSpotCrmAdapter } from "../connectors/hubspot.ts";
import { createPiCompletionClient } from "../core/adapters/pi-durable-completion.ts";
import { AuditLog, AnnieRuntime, type EgressPolicy, InstanceLocked, modelApiKeySecret, NotFound } from "../core/index.ts";
import { tenantId as toTenantId, instanceId as toInstanceId } from "../core/ids.ts";
import { InstanceLock } from "../core/lock.ts";
import { DEFAULT_MODEL_ROLES, FAUX_MODEL_ROLES } from "../core/model-routing.ts";
import { instanceDir, lockFile, tenantDir } from "../core/paths.ts";
import { assertModelProviderAllowed } from "../core/policy.ts";
import { UsageLedger } from "../core/usage.ts";
import { loadChecks } from "../segreteria/checks.ts";
import { SegreteriaService } from "../segreteria/service.ts";
import { ConfigError, loadSegreteriaConfig, type SegreteriaConfig } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

let config: SegreteriaConfig;
try {
	config = loadSegreteriaConfig(process.env);
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(`annie: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

const runtime = new AnnieRuntime({ dataDir: config.dataDir, engine: { open: () => Promise.reject(new Error("the segreteria opens no conversation engine")) } });
const egress: EgressPolicy = { modelProviders: [config.modelProvider], channels: ["telegram"], connectors: ["gmail", "hubspot"] };
await bootstrap(runtime, config);

const t = toTenantId(config.tenantId);
const i = toInstanceId(config.instanceId);
let lock: InstanceLock;
try {
	lock = InstanceLock.acquire(lockFile(config.dataDir, t, i), `${t}/${i}`);
} catch (error) {
	if (error instanceof InstanceLocked) {
		console.error(`annie: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

const secrets = runtime.secrets(config.tenantId);
const record = await runtime.registry.getInstance(config.tenantId, config.instanceId);
const policy = () => record.egress;
const log = (message: string) => console.error(message);

const mail = new GmailMailAdapter({
	fetch: egressFetch("gmail", GMAIL_HOSTS, policy),
	credentials: async () => {
		const [clientId, clientSecret, refreshToken] = await Promise.all([secrets.get(GMAIL_SECRETS.clientId), secrets.get(GMAIL_SECRETS.clientSecret), secrets.get(GMAIL_SECRETS.refreshToken)]);
		return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
	},
});
const crm = new HubSpotCrmAdapter({ fetch: egressFetch("hubspot", HUBSPOT_HOSTS, policy), accessToken: () => secrets.get(HUBSPOT_SECRET), log });
const telegram = new TelegramAdapter({ token: config.telegramBotToken, tenantId: config.tenantId, instanceId: config.instanceId, log });
const model =
	config.modelProvider === "faux"
		? undefined
		: {
				client: createPiCompletionClient({ apiKey: (provider) => secrets.get(modelApiKeySecret(provider)), assertAllowed: (provider) => assertModelProviderAllowed(record.egress, provider) }),
				checks: await loadChecks(join(import.meta.dirname, "..", "..", "evals", "segreteria")),
			};

const service = new SegreteriaService({
	tenantId: config.tenantId,
	instanceId: config.instanceId,
	instanceDir: instanceDir(config.dataDir, t, i),
	mail,
	crm,
	telegram,
	audit: new AuditLog(config.dataDir, t),
	usage: new UsageLedger(tenantDir(config.dataDir, t)),
	roles: config.modelProvider === "faux" ? FAUX_MODEL_ROLES : DEFAULT_MODEL_ROLES,
	...(model === undefined ? {} : { model }),
	salesUserIds: record.allowedUsers.telegram ?? [],
	tenantConfig: { requireVatNumber: config.requireVatNumber },
	pollIntervalMs: config.pollSeconds * 1000,
	log,
});

await service.start();
await telegram.start();
console.error(
	`annie: segreteria tenant=${config.tenantId} instance=${config.instanceId} model=${config.modelProvider} ` +
		`sales=${(record.allowedUsers.telegram ?? []).length}, mailbox every ${config.pollSeconds}s (Ctrl+C to stop)`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void (async () => {
			await telegram.stop();
			await service.stop();
			lock.release();
			process.exit(0);
		})();
	});
}

async function bootstrap(runtime: AnnieRuntime, config: SegreteriaConfig): Promise<void> {
	try {
		await runtime.registry.getTenant(config.tenantId);
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createTenant({ id: config.tenantId, name: config.tenantId });
	}
	try {
		const instance = await runtime.registry.getInstance(config.tenantId, config.instanceId);
		const same = JSON.stringify(instance.egress) === JSON.stringify(egress);
		if (!same) await runtime.registry.setEgress(config.tenantId, config.instanceId, egress);
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		const roles = config.modelProvider === "faux" ? FAUX_MODEL_ROLES : DEFAULT_MODEL_ROLES;
		await runtime.registry.createInstance(config.tenantId, { id: config.instanceId, name: `Segreteria (${config.instanceId})`, model: roles.draft, egress });
	}
	await runtime.registry.setAllowedUsers(config.tenantId, config.instanceId, "telegram", config.salesUserIds);
	const secrets = runtime.secrets(config.tenantId);
	if (config.anthropicApiKey !== undefined) await secrets.set(modelApiKeySecret("anthropic"), config.anthropicApiKey);
	await secrets.set(GMAIL_SECRETS.clientId, config.gmail.clientId);
	await secrets.set(GMAIL_SECRETS.clientSecret, config.gmail.clientSecret);
	await secrets.set(GMAIL_SECRETS.refreshToken, config.gmail.refreshToken);
	await secrets.set(HUBSPOT_SECRET, config.hubspotAccessToken);
}
