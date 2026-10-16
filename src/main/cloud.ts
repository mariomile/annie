/**
 * `pnpm cloud`: the control plane of Annie Cloud, with cells as local processes (ADR 0007).
 * The provider for real micro-VMs and the mail service come next (docs/piano-cloud.md).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startControlPlane } from "../cloud/control-plane.ts";
import { LocalCellProvider } from "../cloud/local-provider.ts";
import { FileMailer } from "../cloud/mailer.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string) => process.env[name]?.trim() || undefined;
const domain = env("ANNIE_CLOUD_DOMAIN") ?? "annie.localhost";
const dataDir = env("ANNIE_CLOUD_DATA_DIR") ?? "data-cloud";
const port = Number(env("ANNIE_CLOUD_PORT") ?? "8090");
// What every cell gets; the control plane's own settings never reach a cell.
const passed = ["ANNIE_MODEL_PROVIDER", "ANNIE_MODEL_ID", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANNIE_TIME_ZONE"];
const cellEnv = Object.fromEntries(passed.flatMap((name) => (env(name) === undefined ? [] : [[name, env(name) as string]])));

const cp = await startControlPlane({
	dataDir,
	domain,
	publicScheme: (env("ANNIE_CLOUD_SCHEME") ?? (domain.endsWith("localhost") ? "http" : "https")) as "http" | "https",
	// Locally the browser reaches the control plane on its own port; behind a proxy, on the default one.
	...(domain.endsWith("localhost") ? { publicPort: port } : {}),
	provider: new LocalCellProvider({ root: join(dataDir, "cells"), repoRoot: process.cwd() }),
	mailer: new FileMailer(join(dataDir, "mail")),
	cellEnv,
	idleMs: Number(env("ANNIE_CLOUD_IDLE_MINUTES") ?? "15") * 60_000,
	web: { host: env("ANNIE_CLOUD_HOST") ?? "127.0.0.1", port },
	tickMs: 30_000,
});
console.error(`annie cloud: http://${domain}:${port} (sign-in links in ${join(dataDir, "mail", "outbox.txt")})`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void cp.stop().then(() => process.exit(0)));
