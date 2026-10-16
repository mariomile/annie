/**
 * `pnpm cloud`: the control plane of Annie Cloud, with cells as local processes (ADR 0007).
 * The provider for real micro-VMs and the mail service come next (docs/piano-cloud.md).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startControlPlane } from "../cloud/control-plane.ts";
import { LocalCellProvider } from "../cloud/local-provider.ts";
import { FileMailer, type Mailer } from "../cloud/mailer.ts";
import { parseSmtpUrl, SmtpMailer } from "../cloud/smtp.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string) => process.env[name]?.trim() || undefined;
const domain = env("ANNIE_CLOUD_DOMAIN") ?? "annie.localhost";
const dataDir = env("ANNIE_CLOUD_DATA_DIR") ?? "data-cloud";
const port = Number(env("ANNIE_CLOUD_PORT") ?? "8090");
// What every cell gets; the control plane's own settings never reach a cell.
const passed = ["ANNIE_MODEL_PROVIDER", "ANNIE_MODEL_ID", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANNIE_TIME_ZONE", "ANNIE_GOOGLE_CLIENT_ID", "ANNIE_GOOGLE_CLIENT_SECRET", "ANNIE_GOOGLE_SERVICES"];
const cellEnv = Object.fromEntries(passed.flatMap((name) => (env(name) === undefined ? [] : [[name, env(name) as string]])));

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

const cp = await startControlPlane({
	dataDir,
	domain,
	publicScheme: (env("ANNIE_CLOUD_SCHEME") ?? (domain.endsWith("localhost") ? "http" : "https")) as "http" | "https",
	// Locally the browser reaches the control plane on its own port; behind a proxy, on the default one.
	...(domain.endsWith("localhost") ? { publicPort: port } : {}),
	provider: new LocalCellProvider({ root: join(dataDir, "cells"), repoRoot: process.cwd() }),
	mailer: mailer(),
	cellEnv,
	idleMs: Number(env("ANNIE_CLOUD_IDLE_MINUTES") ?? "15") * 60_000,
	web: { host: env("ANNIE_CLOUD_HOST") ?? "127.0.0.1", port },
	tickMs: 30_000,
});
console.error(`annie cloud: http://${domain}:${port} (sign-in links ${env("ANNIE_CLOUD_SMTP_URL") === undefined ? `in ${join(dataDir, "mail", "outbox.txt")}` : "by email"})`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void cp.stop().then(() => process.exit(0)));
