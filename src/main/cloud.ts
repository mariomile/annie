/**
 * `pnpm cloud`: the control plane of Annie Cloud (ADR 0007, ADR 0008).
 * Cells as local processes (development), containers on one server (ANNIE_CLOUD_PROVIDER=docker)
 * or Railway services (ANNIE_CLOUD_PROVIDER=railway); see docs/runbook.md 6c and 6d.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startControlPlane } from "../cloud/control-plane.ts";
import { DockerCellProvider } from "../cloud/docker-provider.ts";
import { LocalCellProvider } from "../cloud/local-provider.ts";
import type { CellProvider } from "../cloud/provider.ts";
import { RailwayCellProvider } from "../cloud/railway-provider.ts";
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
		return new RailwayCellProvider({ token, image, dataDir, ...(workspaceId === undefined ? {} : { workspaceId }), ...(region === undefined ? {} : { region }) });
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
const cp = await startControlPlane({
	dataDir,
	domain,
	publicScheme: (env("ANNIE_CLOUD_SCHEME") ?? (domain.endsWith("localhost") ? "http" : "https")) as "http" | "https",
	// Locally the browser reaches the control plane on its own port; behind a proxy, on the default one.
	...(domain.endsWith("localhost") ? { publicPort: port } : {}),
	provider: cells,
	mailer: mailer(),
	cellEnv,
	// Railway sleeps a quiet cell by itself: the control plane must let go of it sooner (railway-provider.ts).
	idleMs: env("ANNIE_CLOUD_IDLE_MINUTES") !== undefined ? Number(env("ANNIE_CLOUD_IDLE_MINUTES")) * 60_000 : cells instanceof RailwayCellProvider ? RailwayCellProvider.IDLE_MS : 15 * 60_000,
	web: { host: env("ANNIE_CLOUD_HOST") ?? "127.0.0.1", port },
	tickMs: 30_000,
});
console.error(`annie cloud: http://${domain}:${port} (sign-in links ${env("ANNIE_CLOUD_SMTP_URL") === undefined ? `in ${join(dataDir, "mail", "outbox.txt")}` : "by email"})`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void cp.stop().then(() => process.exit(0)));
