/**
 * `pnpm cloud`: the control plane of Annie Cloud (ADR 0007, ADR 0008).
 * Cells as local processes (development), containers on one server (ANNIE_CLOUD_PROVIDER=docker)
 * or Railway services (ANNIE_CLOUD_PROVIDER=railway); see docs/runbook.md 6c and 6d.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StripeBilling } from "../cloud/billing.ts";
import { cloudComputers, cloudStatus, deleteTenantComputers, startControlPlane } from "../cloud/control-plane.ts";
import { DockerCellProvider } from "../cloud/docker-provider.ts";
import { LocalCellProvider } from "../cloud/local-provider.ts";
import type { CellProvider } from "../cloud/provider.ts";
import { RailwayCellProvider } from "../cloud/railway-provider.ts";
import { FileMailer, type Mailer } from "../cloud/mailer.ts";
import { parseSmtpUrl, SmtpMailer } from "../cloud/smtp.ts";
import { computerSalt, FlyComputerProvider } from "../computer/fly-computer.ts";
import { computerKey } from "../core/computer.ts";
import { ConfigError, loadComputerConfig } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string) => process.env[name]?.trim() || undefined;
const domain = env("ANNIE_CLOUD_DOMAIN") ?? "annie.localhost";
const dataDir = env("ANNIE_CLOUD_DATA_DIR") ?? "data-cloud";
const port = Number(env("ANNIE_CLOUD_PORT") ?? "8090");
// What every cell gets; the control plane's own settings never reach a cell.
const passed = ["ANNIE_MODEL_PROVIDER", "ANNIE_MODEL_ID", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANNIE_TIME_ZONE", "ANNIE_GOOGLE_CLIENT_ID", "ANNIE_GOOGLE_CLIENT_SECRET", "ANNIE_GOOGLE_SERVICES", "ANNIE_GOOGLE_WRITE", "ANNIE_TRANSCRIBE_URL", "ANNIE_TRANSCRIBE_API_KEY", "ANNIE_TRANSCRIBE_MODEL", "ANNIE_TRANSCRIBE_MAX_SECONDS", "ANNIE_TRANSCRIBE_TIMESTAMPS", "ANNIE_TRANSCRIBE_SPEAKERS", "ANNIE_TRANSCRIBE_MAX_MINUTES", "ANNIE_TRANSCRIBE_MINUTES_PER_DAY", "ANNIE_SPEECH_URL", "ANNIE_SPEECH_API_KEY", "ANNIE_SPEECH_MODEL", "ANNIE_SPEECH_VOICE", "ANNIE_SPEECH_MAX_CHARS", "ANNIE_SPEECH_MAX_PER_DAY", "ANNIE_SPEECH_STYLE", "ANNIE_SEARCH_URL", "ANNIE_SEARCH_API_KEY", "ANNIE_SEARCH_COUNTRY", "ANNIE_SEARCH_LANG", "ANNIE_SEARCH_MAX_PER_DAY", "ANNIE_IMAGE_URL", "ANNIE_IMAGE_API_KEY", "ANNIE_IMAGE_MODEL", "ANNIE_IMAGE_MAX_PER_DAY"];
const cellEnv: Record<string, string> = Object.fromEntries(passed.flatMap((name) => (env(name) === undefined ? [] : [[name, env(name) as string]])));
const scheme = (env("ANNIE_CLOUD_SCHEME") ?? (domain.endsWith("localhost") ? "http" : "https")) as "http" | "https";

/**
 * The instances' computers on Fly machines with ANNIE_CLOUD_COMPUTER=fly (ADR 0015): the token
 * stays here, and cells reach their computers through the control plane. Never Docker: a cell
 * with the Docker socket would have the server (ADR 0013).
 */
function computers(): FlyComputerProvider | undefined {
	const kind = env("ANNIE_CLOUD_COMPUTER");
	if (kind === undefined) {
		// Switched off: an upgrade takes the computer away from cells that had it, too.
		cellEnv.ANNIE_COMPUTER = "";
		return undefined;
	}
	try {
		if (kind !== "fly") throw new ConfigError("ANNIE_CLOUD_COMPUTER: fly, or unset for no computer (Docker computers are never for cells)");
		const config = loadComputerConfig(process.env, kind, "ANNIE_CLOUD_COMPUTER");
		if (config?.kind !== "fly") throw new ConfigError("ANNIE_CLOUD_COMPUTER: fly");
		const url = env("ANNIE_CLOUD_COMPUTER_URL") ?? `${scheme}://${domain}${domain.endsWith("localhost") ? `:${port}` : ""}`;
		if (!/^https?:\/\/[^\s/]+\/?$/.test(url)) throw new ConfigError("ANNIE_CLOUD_COMPUTER_URL: the control plane's address as cells reach it (http(s)://host[:port])");
		cellEnv.ANNIE_COMPUTER = "cloud";
		cellEnv.ANNIE_COMPUTER_URL = url;
		return new FlyComputerProvider({ ...config, salt: computerSalt(dataDir), log: (message) => console.error(`annie cloud: ${message}`) });
	} catch (error) {
		console.error(`annie cloud: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
const computer = computers();

/** Cells as containers (one server) with ANNIE_CLOUD_PROVIDER=docker; local processes otherwise (development). */
function provider(): CellProvider {
	const kind = env("ANNIE_CLOUD_PROVIDER") ?? "local";
	if (kind === "local") return new LocalCellProvider({ root: join(dataDir, "cells"), repoRoot: process.cwd() });
	if (kind === "railway") {
		const token = env("RAILWAY_API_TOKEN");
		const image = env("ANNIE_CLOUD_RAILWAY_IMAGE");
		if (token === undefined || image === undefined) {
			console.error("annie cloud: ANNIE_CLOUD_PROVIDER=railway needs RAILWAY_API_TOKEN and ANNIE_CLOUD_RAILWAY_IMAGE (e.g. ghcr.io/<owner>/annie:latest)");
			process.exit(1);
		}
		const workspaceId = env("ANNIE_CLOUD_RAILWAY_WORKSPACE");
		const region = env("ANNIE_CLOUD_RAILWAY_REGION");
		return new RailwayCellProvider({ token, image, dataDir, log: (message) => console.error(`annie cloud: ${message}`), ...(workspaceId === undefined ? {} : { workspaceId }), ...(region === undefined ? {} : { region }) });
	}
	if (kind !== "docker") {
		console.error(`annie cloud: ANNIE_CLOUD_PROVIDER="${kind}": use local, docker or railway`);
		process.exit(1);
	}
	const memory = env("ANNIE_CLOUD_CELL_MEMORY_MB");
	// A typo must not become "no limit": Docker reads a missing memory value as unlimited.
	if (memory !== undefined && !(/^\d+$/.test(memory) && Number(memory) >= 128)) {
		console.error("annie cloud: ANNIE_CLOUD_CELL_MEMORY_MB: a whole number of megabytes, at least 128");
		process.exit(1);
	}
	return new DockerCellProvider({ image: env("ANNIE_CLOUD_DOCKER_IMAGE") ?? "annie:local", ...(memory === undefined ? {} : { memoryMb: Number(memory) }) });
}

/** A real mail service when ANNIE_CLOUD_SMTP_URL is set; otherwise links go to a file to read. */
function mailer(): Mailer {
	const url = env("ANNIE_CLOUD_SMTP_URL");
	if (url === undefined) return new FileMailer(join(dataDir, "mail"));
	const from = env("ANNIE_CLOUD_MAIL_FROM");
	if (from === undefined) {
		console.error("annie cloud: ANNIE_CLOUD_SMTP_URL needs ANNIE_CLOUD_MAIL_FROM, the sender of the sign-in links");
		process.exit(1);
	}
	try {
		return new SmtpMailer(parseSmtpUrl(url, from));
	} catch (error) {
		console.error(`annie cloud: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/** Subscriptions through Stripe when ANNIE_CLOUD_STRIPE_SECRET_KEY is set (ADR 0010); free to use otherwise. */
function billing(): StripeBilling | undefined {
	const secretKey = env("ANNIE_CLOUD_STRIPE_SECRET_KEY");
	if (secretKey === undefined) return undefined;
	const fail = (message: string): never => {
		console.error(`annie cloud: ${message}`);
		process.exit(1);
	};
	// Prefixes checked so that two values swapped, or a publishable key, stop here and not at the first payment.
	const named = (name: string, prefix: RegExp, what: string) => {
		const value = env(name);
		if (value !== undefined && !prefix.test(value)) fail(`${name}: expected ${what}`);
		return value;
	};
	named("ANNIE_CLOUD_STRIPE_SECRET_KEY", /^(sk|rk)_(test|live)_/, "a secret or restricted key (sk_… or rk_…)");
	const webhookSecret = named("ANNIE_CLOUD_STRIPE_WEBHOOK_SECRET", /^whsec_/, "the webhook's signing secret (whsec_…)") ?? fail("ANNIE_CLOUD_STRIPE_SECRET_KEY needs ANNIE_CLOUD_STRIPE_WEBHOOK_SECRET (whsec_…)");
	const price = named("ANNIE_CLOUD_STRIPE_PRICE", /^price_/, "a price id (price_…)") ?? fail("ANNIE_CLOUD_STRIPE_SECRET_KEY needs ANNIE_CLOUD_STRIPE_PRICE (price_…)");
	const usagePrice = named("ANNIE_CLOUD_STRIPE_USAGE_PRICE", /^price_/, "a price id (price_…)");
	const meterEvent = env("ANNIE_CLOUD_STRIPE_METER_EVENT");
	if (usagePrice === price) fail("ANNIE_CLOUD_STRIPE_USAGE_PRICE must be the metered price, not the flat one");
	if ((usagePrice === undefined) !== (meterEvent === undefined)) fail("ANNIE_CLOUD_STRIPE_USAGE_PRICE and ANNIE_CLOUD_STRIPE_METER_EVENT go together");
	const trialDays = env("ANNIE_CLOUD_TRIAL_DAYS") ?? "14";
	if (!/^\d{1,3}$/.test(trialDays)) fail("ANNIE_CLOUD_TRIAL_DAYS: a whole number of days (0 for no trial)");
	return new StripeBilling({
		secretKey,
		webhookSecret,
		price,
		trialDays: Number(trialDays),
		...(usagePrice === undefined || meterEvent === undefined ? {} : { usage: { price: usagePrice, meterEvent } }),
	});
}

// `pnpm cloud status`: every tenant, its cell and its spend (an estimate from the model's list
// prices), beside a running control plane. Emails are the operator's to see; nothing else is.
if (process.argv[2] === "status") {
	const rows = await cloudStatus({ dataDir, provider: provider() });
	if (rows.length === 0) console.log("Nessun tenant ancora.");
	const rome = (iso: string) => new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
	for (const r of rows) {
		const spend = r.spend === null ? "spesa: mai letta" : `oggi $${r.spend.todayUsd.toFixed(2)}, mese $${r.spend.monthUsd.toFixed(2)}, mese scorso $${r.spend.lastMonthUsd.toFixed(2)} (letta ${rome(r.spend.readAt)})`;
		const ended = r.billing?.subscription === null || r.billing?.subscription === "incomplete" ? "prova finita, sospeso" : `abbonamento ${r.billing?.subscription}, sospeso`;
		const plan = r.billing === null ? "" : `  ${{ trial: `in prova fino al ${rome(r.billing.trialEndsAt)}`, active: "abbonato", past_due: "pagamento in ritardo", ended }[r.billing.state]}`;
		console.log(`${r.tenant}  ${r.email}  dal ${r.createdAt.slice(0, 10)}  cella ${r.cell}${r.nextWakeAt === null ? "" : `, si sveglia ${rome(r.nextWakeAt)}`}  ${spend}${plan}`);
	}
	const month = rows.reduce((sum, r) => sum + (r.spend?.monthUsd ?? 0), 0);
	console.log(`${rows.length} tenant, ${rows.filter((r) => r.cell === "running").length} celle accese, spesa del mese stimata $${month.toFixed(2)} (prezzi di listino, ultime letture)`);
	process.exit(0);
}

// `pnpm cloud computers`: the computers each tenant has used, with their Fly app (ADR 0015).
// `pnpm cloud computers delete <tenant>`: deletes them, machines and files, for an account that leaves.
if (process.argv[2] === "computers") {
	const tenant = process.argv[4];
	if (process.argv[3] === "delete") {
		if (computer === undefined || tenant === undefined) {
			console.error("annie cloud: computers delete <tenant>, with ANNIE_CLOUD_COMPUTER=fly and its settings");
			process.exit(1);
		}
		console.log(`${await deleteTenantComputers({ dataDir, tenant, computer })} computer cancellati per ${tenant}`);
		process.exit(0);
	}
	const rows = cloudComputers({ dataDir });
	if (rows.length === 0) console.log("Nessun computer ancora.");
	for (const c of rows) console.log(`${c.tenant}  ${c.key.slice(0, 8)}  dal ${c.createdAt.slice(0, 10)}${computer === undefined ? "" : `  app ${computer.appOf(computerKey(c.tenant, c.key))}`}`);
	process.exit(0);
}

// `pnpm cloud upgrade`, with the control plane stopped: every cell gets a new container from the
// current image and the current model settings (ANNIE_MODEL_*, keys); volumes and data stay.
if (process.argv[2] === "upgrade") {
	const cells = provider();
	if (!(cells instanceof DockerCellProvider || cells instanceof RailwayCellProvider)) {
		console.error("annie cloud: upgrade is for docker and railway cells; local cells run the code of this checkout");
		process.exit(1);
	}
	for (const id of await cells.list()) {
		await cells.upgrade(id, cellEnv);
		console.error(`annie cloud: cell ${id} upgraded`);
	}
	process.exit(0);
}

const cells = provider();
const subscriptions = billing();
if (cells instanceof RailwayCellProvider) cells.forgetAwake();
const cp = await startControlPlane({
	dataDir,
	domain,
	publicScheme: scheme,
	// Locally the browser reaches the control plane on its own port; behind a proxy, on the default one.
	...(domain.endsWith("localhost") ? { publicPort: port } : {}),
	provider: cells,
	mailer: mailer(),
	cellEnv,
	...(subscriptions === undefined ? {} : { billing: subscriptions }),
	...(computer === undefined ? {} : { computer }),
	// Railway sleeps a quiet cell by itself: the control plane must let go of it sooner (railway-provider.ts).
	idleMs: env("ANNIE_CLOUD_IDLE_MINUTES") !== undefined ? Number(env("ANNIE_CLOUD_IDLE_MINUTES")) * 60_000 : cells instanceof RailwayCellProvider ? RailwayCellProvider.IDLE_MS : 15 * 60_000,
	web: { host: env("ANNIE_CLOUD_HOST") ?? "127.0.0.1", port },
	tickMs: 30_000,
});
console.error(`annie cloud: http://${domain}:${port} (sign-in links ${env("ANNIE_CLOUD_SMTP_URL") === undefined ? `in ${join(dataDir, "mail", "outbox.txt")}` : "by email"})`);
if (computer !== undefined) void computer.check().then((problem) => console.error(`annie cloud: computers on Fly ${problem === undefined ? "ready" : `not ready: ${problem}`}`));
if (subscriptions !== undefined) console.error(`annie cloud: subscriptions through Stripe, ${subscriptions.trialDays} days of trial, webhook at /stripe/webhook${subscriptions.meters ? ", model cost metered" : ""}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void cp.stop().then(() => process.exit(0)));
