import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RailwayCellProvider } from "../src/cloud/railway-provider.ts";
import { tempDataDir } from "./helpers.ts";

/** Fake Railway: the GraphQL API and the cells' domains, every call recorded. */
function fakeRailway(options: { failOn?: string; coldStarts?: number } = {}) {
	const calls: { operation: string; variables: any; auth: string }[] = [];
	const health: string[] = [];
	let cold = options.coldStarts ?? 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/healthz")) {
			health.push(url);
			// The first requests to a sleeping service get a 502 while it boots.
			if (cold > 0) {
				cold--;
				return new Response("Bad Gateway", { status: 502 });
			}
			return Response.json({ ok: true });
		}
		const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: any };
		const operation = /^mutation (\w+)/.exec(query)?.[1] ?? "query";
		calls.push({ operation, variables, auth: String((init?.headers as Record<string, string>).authorization) });
		if (operation === options.failOn) return Response.json({ errors: [{ message: "Not Authorized" }] });
		const data: Record<string, unknown> = {
			projectCreate: { projectCreate: { id: "prj1", environments: { edges: [{ node: { id: "env1", name: "production" } }] } } },
			serviceCreate: { serviceCreate: { id: "svc1" } },
			volumeCreate: { volumeCreate: { id: "vol1" } },
			variableCollectionUpsert: { variableCollectionUpsert: true },
			serviceInstanceUpdate: { serviceInstanceUpdate: true },
			serviceDomainCreate: { serviceDomainCreate: { domain: "annie-a1.up.railway.app" } },
			serviceInstanceDeployV2: { serviceInstanceDeployV2: "dep1" },
			projectDelete: { projectDelete: true },
		};
		return Response.json({ data: data[operation] });
	}) as typeof fetch;
	return { fetch: fetchImpl, calls, health };
}

const provider = (dataDir: string, railway: ReturnType<typeof fakeRailway>) =>
	new RailwayCellProvider({ token: "rw-token", image: "ghcr.io/buildrs/annie:latest", dataDir, fetch: railway.fetch, pollMs: 5, startTimeoutMs: 2_000 });

describe("Railway cell provider", () => {
	it("creates a project per cell, with the image, a volume on /data, sleep on, in the EU, without deploying yet", async () => {
		const railway = fakeRailway();
		const cells = provider(tempDataDir(), railway);
		await cells.create("a1", { ANNIE_TENANT_ID: "a1", ANNIE_CELL_SECRET: "s".repeat(32) });
		expect(railway.calls.map((c) => c.operation)).toEqual(["projectCreate", "serviceCreate", "volumeCreate", "variableCollectionUpsert", "serviceInstanceUpdate", "serviceDomainCreate"]);
		expect(railway.calls.every((c) => c.auth === "Bearer rw-token")).toBe(true);
		const byName = Object.fromEntries(railway.calls.map((c) => [c.operation, c.variables]));
		expect(byName.projectCreate.input.name).toBe("annie-a1");
		expect(byName.serviceCreate.input).toEqual({ projectId: "prj1", name: "annie", source: { image: "ghcr.io/buildrs/annie:latest" } });
		expect(byName.volumeCreate.input).toEqual({ projectId: "prj1", environmentId: "env1", serviceId: "svc1", mountPath: "/data" });
		expect(byName.variableCollectionUpsert.input).toMatchObject({ skipDeploys: true, variables: { ANNIE_TENANT_ID: "a1", ANNIE_DATA_DIR: "/data", PORT: "8080" } });
		expect(byName.serviceInstanceUpdate).toMatchObject({ serviceId: "svc1", environmentId: "env1", input: { sleepApplication: true, region: "europe-west4-drams3a", healthcheckPath: "/healthz" } });
		expect(await cells.status("a1")).toBe("stopped");
		expect(await cells.baseUrl("a1")).toBe("https://annie-a1.up.railway.app");
		expect(await cells.list()).toEqual(["a1"]);
	});

	it("the first start deploys; a start waits out the cold start's 502s; stop only lets Railway put it to sleep", async () => {
		const railway = fakeRailway({ coldStarts: 3 });
		const cells = provider(tempDataDir(), railway);
		await cells.create("a1", {});
		await cells.start("a1");
		expect(railway.calls.filter((c) => c.operation === "serviceInstanceDeployV2")).toHaveLength(1);
		expect(railway.health).toHaveLength(4);
		expect(await cells.status("a1")).toBe("running");
		const before = railway.calls.length;
		await cells.stop("a1");
		expect(railway.calls.length).toBe(before);
		expect(await cells.status("a1")).toBe("stopped");
		// Waking again: no new deploy, just a request.
		await cells.start("a1");
		expect(railway.calls.filter((c) => c.operation === "serviceInstanceDeployV2")).toHaveLength(1);
	});

	it("a failed create leaves no project behind; errors name the operation, never the token", async () => {
		const railway = fakeRailway({ failOn: "volumeCreate" });
		const dataDir = tempDataDir();
		const cells = provider(dataDir, railway);
		const failed = cells.create("a1", {});
		await expect(failed).rejects.toThrow("railway volumeCreate: Not Authorized");
		await expect(failed).rejects.not.toThrow(/rw-token/);
		expect(railway.calls.at(-1)).toMatchObject({ operation: "projectDelete", variables: { id: "prj1" } });
		expect(await cells.status("a1")).toBe("missing");
		await expect(cells.create("../x", {})).rejects.toThrow(/Invalid cell id/);
	});

	it("upgrade sets new variables and redeploys, keeping the volume; destroy deletes the project", async () => {
		const railway = fakeRailway();
		const dataDir = tempDataDir();
		const cells = provider(dataDir, railway);
		await cells.create("a1", {});
		await cells.upgrade("a1", { ANNIE_MODEL_ID: "nuovo" });
		const tail = railway.calls.slice(-2);
		expect(tail.map((c) => c.operation)).toEqual(["variableCollectionUpsert", "serviceInstanceDeployV2"]);
		expect(tail[0]?.variables.input.variables).toEqual({ ANNIE_MODEL_ID: "nuovo" });
		expect(railway.calls.some((c) => c.operation === "volumeDelete")).toBe(false);
		await cells.destroy("a1");
		expect(railway.calls.at(-1)).toMatchObject({ operation: "projectDelete", variables: { id: "prj1" } });
		expect(await cells.list()).toEqual([]);
		expect(readFileSync(join(dataDir, "railway-cells.json"), "utf8")).not.toContain("rw-token");
	});
});
