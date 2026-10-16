/**
 * `pnpm annie <command>`: what the owner does from the command line.
 *
 *   person add <name> [--owner] [--instance <id>]...   create a person, print their login link
 *   person list
 *   person link <id>                                    new login link (the old one stops working)
 *   person remove <id>
 *   person reset-2fa <id>                               turn off two-factor login (lost phone)
 *
 * Works on the data directory; Annie can be running.
 */
import { existsSync } from "node:fs";
import { tenantId as toTenantId } from "../core/ids.ts";
import { tenantDir } from "../core/paths.ts";
import { TenantRegistry } from "../core/registry.ts";
import { PeopleStore, SessionStore } from "../web/auth.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const dataDir = process.env.ANNIE_DATA_DIR?.trim() || "data";
const tenant = process.env.ANNIE_TENANT_ID?.trim() || "default";
const base = process.env.ANNIE_PUBLIC_URL?.trim().replace(/\/+$/, "") || `http://localhost:${process.env.ANNIE_WEB_PORT?.trim() || "8080"}`;
const dir = tenantDir(dataDir, toTenantId(tenant));
const people = new PeopleStore(dir);
const registry = new TenantRegistry(dataDir);

const [group, command, ...rest] = process.argv.slice(2);

function usage(): never {
	console.error("usage: pnpm annie person add <name> [--owner] [--instance <id>]... | person list | person link <id> | person remove <id> | person reset-2fa <id>");
	process.exit(2);
}

if (group !== "person") usage();

switch (command) {
	case "add": {
		const instances: string[] = [];
		const words: string[] = [];
		let owner = false;
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i] as string;
			if (arg === "--owner") owner = true;
			else if (arg === "--instance") instances.push(rest[++i] ?? usage());
			else words.push(arg);
		}
		if (words.length === 0) usage();
		const { person, token } = await people.add(words.join(" "), owner ? "owner" : "member");
		for (const id of instances) {
			const record = await registry.getInstance(tenant, id);
			await registry.setAllowedUsers(tenant, id, "web", [...(record.allowedUsers.web ?? []), person.id]);
			if (!record.egress.channels.includes("web")) await registry.setEgress(tenant, id, { ...record.egress, channels: [...record.egress.channels, "web"] });
		}
		console.log(`${person.name} (${person.role}) ${person.id}${instances.length > 0 ? `, instances: ${instances.join(", ")}` : ""}\nLogin link (give it privately; it works until replaced):\n\n  ${base}/login#${token}\n`);
		break;
	}
	case "list":
		for (const p of await people.list()) console.log(`${p.id}\t${p.role}\t${p.name}\t${p.createdAt}${p.totp === undefined ? "" : "\t2FA"}`);
		break;
	case "link": {
		const id = rest[0] ?? usage();
		const token = await people.rotate(id);
		await new SessionStore(dir).endAllOf(id);
		console.log(`New login link for ${id} (the old one and its sessions are revoked):\n\n  ${base}/login#${token}\n`);
		break;
	}
	case "remove": {
		const id = rest[0] ?? usage();
		const removed = await people.remove(id);
		await new SessionStore(dir).endAllOf(id);
		console.log(removed ? `Removed ${id}.` : `No person ${id}.`);
		break;
	}
	case "reset-2fa": {
		const id = rest[0] ?? usage();
		await people.clearTotp(id);
		console.log(`Two-factor login is off for ${id}; their link alone logs in again.`);
		break;
	}
	default:
		usage();
}
