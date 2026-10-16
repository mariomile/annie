/**
 * `pnpm start`: Annie for one tenant in one process. Reads .env (see .env.example), creates
 * what is missing on first start and prints the owner's login link once.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startAnnie } from "../app.ts";
import { InstanceLocked } from "../core/errors.ts";
import { SegreteriaConfigError } from "../segreteria/boot.ts";
import { type AnnieConfig, ConfigError, loadAnnieConfig } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

let config: AnnieConfig;
try {
	config = loadAnnieConfig(process.env);
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(`annie: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

try {
	const annie = await startAnnie(config);
	const url = config.web.publicUrl ?? `http://${config.web.host === "0.0.0.0" ? "localhost" : config.web.host}:${config.web.port}`;
	console.error(
		`annie: tenant=${config.tenantId} instance=${config.instanceId} model=${config.modelProvider}/${config.modelId} ` +
			`web=${url}${config.telegram === undefined ? "" : " telegram=on"}${annie.segreteria === undefined ? "" : ` segreteria=${annie.segreteria.instanceId}`}`,
	);
	if (annie.ownerLink !== undefined) {
		// Not in the logs (docker compose logs keeps them): only on a terminal, and in a 0600 file.
		const file = join(config.dataDir, "owner-login-link.txt");
		if (process.stderr.isTTY) console.error(`annie: first start. Owner login link (keep it private):\n\n  ${annie.ownerLink}\n`);
		console.error(`annie: first start. The owner's login link is in ${file} (read it, then delete the file). New links: pnpm annie person link <id>`);
	}
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void annie.stop().finally(() => process.exit(0));
		});
	}
} catch (error) {
	if (error instanceof SegreteriaConfigError || error instanceof InstanceLocked) {
		console.error(`annie: ${error.message}`);
		process.exit(1);
	}
	throw error;
}
