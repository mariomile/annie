import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import type { CellProvider, CellStatus } from "./provider.ts";

export type RailwayCellOptions = {
	/** An account or workspace token (Authorization: Bearer). Never logged. */
	readonly token: string;
	/** A public image of Annie, e.g. ghcr.io/<owner>/annie:latest (built by .github/workflows/image.yml). */
	readonly image: string;
	/** Where the control plane keeps which Railway project is which cell. */
	readonly dataDir: string;
	/** Railway workspace (team) the projects go to; the token's default if unset. */
	readonly workspaceId?: string;
	/** EU West, Amsterdam. */
	readonly region?: string;
	readonly fetch?: typeof fetch;
	/** How long a deploy or a cold start has to answer /healthz. */
	readonly startTimeoutMs?: number;
	readonly pollMs?: number;
};

type CellRecord = { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly domain: string; readonly deployed: boolean; readonly awake: boolean };

const API = "https://backboard.railway.com/graphql/v2";
const DEFAULT_REGION = "europe-west4-drams3a";

/**
 * The GraphQL documents, in one place. Taken from Railway's public API as used by open-source
 * clients (October 2026); the first live run is the check (docs/week9.md).
 */
const GQL = {
	projectCreate: "mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id environments { edges { node { id name } } } } }",
	serviceCreate: "mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }",
	volumeCreate: "mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }",
	variables: "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }",
	instance: "mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
	domain: "mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }",
	deploy: "mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
	projectDelete: "mutation projectDelete($id: String!) { projectDelete(id: $id) }",
} as const;

/**
 * Cells on Railway: one project per tenant (its own private network and volume), one service
 * from Annie's image with a volume on /data, in the EU region, with Railway's serverless mode on.
 *
 * Railway puts a service to sleep by itself after minutes without outbound traffic and wakes it
 * on the next request, so "stopped" here means stopped for the control plane: it stops talking
 * to the cell and lets Railway put it to sleep; `start` wakes it with a request, retrying while
 * the cold start answers 502. The control plane reaches a cell on its Railway domain, like any
 * self-hosted Annie behind https: the cell's own login and cell secret guard it.
 */
export class RailwayCellProvider implements CellProvider {
	private readonly file: string;
	private readonly fetchImpl: typeof fetch;
	private readonly starting = new Map<string, Promise<void>>();

	constructor(private readonly options: RailwayCellOptions) {
		this.file = join(options.dataDir, "railway-cells.json");
		this.fetchImpl = options.fetch ?? fetch;
	}

	async create(id: string, env: Readonly<Record<string, string>>): Promise<void> {
		assertId(id);
		if (this.record(id) !== undefined) throw new Error(`Cell ${id} exists`);
		const project = (await this.gql<{ projectCreate: { id: string; environments: { edges: { node: { id: string; name: string } }[] } } }>(GQL.projectCreate, {
			input: { name: `annie-${id}`, ...(this.options.workspaceId === undefined ? {} : { teamId: this.options.workspaceId }) },
		})).projectCreate;
		const environmentId = project.environments.edges[0]?.node.id;
		try {
			if (environmentId === undefined) throw new Error(`Railway project for ${id} has no environment`);
			const scope = { projectId: project.id, environmentId };
			const serviceId = (await this.gql<{ serviceCreate: { id: string } }>(GQL.serviceCreate, { input: { projectId: project.id, name: "annie", source: { image: this.options.image } } })).serviceCreate.id;
			await this.gql(GQL.volumeCreate, { input: { ...scope, serviceId, mountPath: "/data" } });
			await this.gql(GQL.variables, {
				input: { ...scope, serviceId, skipDeploys: true, variables: { ...env, ANNIE_DATA_DIR: "/data", ANNIE_WEB_HOST: "0.0.0.0", ANNIE_WEB_PORT: "8080", PORT: "8080" } },
			});
			await this.gql(GQL.instance, { serviceId, environmentId, input: { sleepApplication: true, region: this.options.region ?? DEFAULT_REGION, healthcheckPath: "/healthz" } });
			const domain = (await this.gql<{ serviceDomainCreate: { domain: string } }>(GQL.domain, { input: { ...scope, serviceId, targetPort: 8080 } })).serviceDomainCreate.domain;
			this.save(id, { ...scope, serviceId, domain, deployed: false, awake: false });
		} catch (error) {
			// Nothing half made stays behind, and nothing keeps costing.
			await this.gql(GQL.projectDelete, { id: project.id }).catch(() => {});
			throw error;
		}
	}

	start(id: string): Promise<void> {
		const pending = this.starting.get(id);
		if (pending !== undefined) return pending;
		const starting = this.wake(id).finally(() => this.starting.delete(id));
		this.starting.set(id, starting);
		return starting;
	}

	/** The control plane stops talking to it; Railway puts it to sleep minutes later. */
	async stop(id: string): Promise<void> {
		await this.starting.get(id)?.catch(() => {});
		const cell = this.record(id);
		if (cell !== undefined) this.save(id, { ...cell, awake: false });
	}

	async destroy(id: string): Promise<void> {
		const cell = this.record(id);
		if (cell === undefined) return;
		await this.gql(GQL.projectDelete, { id: cell.projectId });
		updateJsonFile<Record<string, CellRecord>>(this.file, {}, ({ [id]: _gone, ...rest }) => rest);
	}

	async status(id: string): Promise<CellStatus> {
		const cell = this.record(id);
		if (cell === undefined) return "missing";
		return cell.awake ? "running" : "stopped";
	}

	async list(): Promise<string[]> {
		return Object.keys(readJsonFile<Record<string, CellRecord>>(this.file, {}));
	}

	async baseUrl(id: string): Promise<string> {
		const cell = this.record(id);
		if (cell === undefined) throw new Error(`No cell ${id}`);
		return `https://${cell.domain}`;
	}

	/** New image or settings (a new model key): new variables, then a redeploy; the volume stays. */
	async upgrade(id: string, changes: Readonly<Record<string, string>> = {}): Promise<void> {
		const cell = this.record(id);
		if (cell === undefined) throw new Error(`No cell ${id}`);
		const scope = { projectId: cell.projectId, environmentId: cell.environmentId, serviceId: cell.serviceId };
		if (Object.keys(changes).length > 0) await this.gql(GQL.variables, { input: { ...scope, skipDeploys: true, variables: changes } });
		await this.gql(GQL.deploy, { serviceId: cell.serviceId, environmentId: cell.environmentId });
		this.save(id, { ...cell, deployed: true, awake: false });
	}

	private async wake(id: string): Promise<void> {
		let cell = this.record(id);
		if (cell === undefined) throw new Error(`No cell ${id}`);
		if (!cell.deployed) {
			await this.gql(GQL.deploy, { serviceId: cell.serviceId, environmentId: cell.environmentId });
			cell = { ...cell, deployed: true };
			this.save(id, cell);
		}
		// The first request to a sleeping service may get a 502 while it boots: keep asking.
		const deadline = Date.now() + (this.options.startTimeoutMs ?? 180_000);
		while (Date.now() < deadline) {
			const ok = await this.fetchImpl(`https://${cell.domain}/healthz`, { signal: AbortSignal.timeout(10_000) })
				.then((r) => r.ok)
				.catch(() => false);
			if (ok) {
				this.save(id, { ...cell, awake: true });
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 1_000));
		}
		throw new Error(`Cell ${id} did not answer in time`);
	}

	private async gql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
		const operation = /^mutation (\w+)/.exec(query)?.[1] ?? "query";
		const response = await this.fetchImpl(API, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(30_000),
			redirect: "error",
		});
		const body = (await response.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
		if (!response.ok || body.errors !== undefined || body.data === undefined) {
			const message = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
			throw new Error(`railway ${operation}: ${message.slice(0, 300)}`);
		}
		return body.data;
	}

	private record(id: string): CellRecord | undefined {
		return readJsonFile<Record<string, CellRecord>>(this.file, {})[id];
	}

	private save(id: string, cell: CellRecord): void {
		updateJsonFile<Record<string, CellRecord>>(this.file, {}, (all) => ({ ...all, [id]: cell }));
	}
}

function assertId(id: string): void {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`Invalid cell id ${id}`);
}
