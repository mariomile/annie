import { COMPUTER_LIMITS, ComputerError, type ComputerProvider, type ComputerRun } from "../core/computer.ts";
import { computerToken } from "../web/compare.ts";

export type RemoteComputerOptions = {
	/** The control plane, as the cell reaches it. */
	readonly url: string;
	readonly tenant: string;
	readonly cellSecret: string;
	readonly fetch?: typeof fetch;
};

const API_TIMEOUT_MS = 60_000;

/**
 * A cell's computers in Annie Cloud (ADR 0015): the control plane runs them on micro-VMs and
 * holds the provider's token; the cell only asks, for its own tenant, with a token derived from
 * its secret. The control plane names each computer after the tenant and the cell's key, so a
 * cell can reach no other tenant's computers whatever key it sends.
 */
export class RemoteComputerProvider implements ComputerProvider {
	private readonly base: string;
	private readonly fetch: typeof fetch;

	constructor(private readonly options: RemoteComputerOptions) {
		this.base = `${options.url.replace(/\/+$/, "")}/internal/computer`;
		this.fetch = options.fetch ?? fetch;
	}

	async run(key: string, command: string, options: { readonly timeoutS: number; readonly signal?: AbortSignal }): Promise<ComputerRun> {
		const timeout = AbortSignal.timeout((Math.min(COMPUTER_LIMITS.maxTimeoutS, options.timeoutS) + 120) * 1000);
		const response = await this.call("POST", "/run", JSON.stringify({ key, command, timeoutS: options.timeoutS }), options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]));
		return (await response.json()) as ComputerRun;
	}

	async put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void> {
		for (const file of files) await this.call("PUT", `/file?${new URLSearchParams({ key, path: file.path })}`, file.data, AbortSignal.timeout(5 * 60_000));
	}

	async get(key: string, path: string, maxBytes: number): Promise<Uint8Array> {
		const response = await this.call("GET", `/file?${new URLSearchParams({ key, path, max: String(maxBytes) })}`, undefined, AbortSignal.timeout(5 * 60_000));
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.length > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
		return data;
	}

	async reset(key: string): Promise<void> {
		await this.call("POST", "/reset", JSON.stringify({ key }), AbortSignal.timeout(API_TIMEOUT_MS));
	}

	async check(): Promise<string | undefined> {
		try {
			const response = await this.call("GET", "/check", undefined, AbortSignal.timeout(API_TIMEOUT_MS));
			return ((await response.json()) as { problem?: string }).problem;
		} catch (error) {
			return `il control plane non risponde (${(error instanceof Error ? error.message : String(error)).slice(0, 120)})`;
		}
	}

	async close(): Promise<void> {}

	/** A request to the control plane; what it refuses for a reason the person can act on comes back as a ComputerError. */
	private async call(method: string, path: string, body: string | Uint8Array | undefined, signal: AbortSignal): Promise<Response> {
		const response = await this.fetch(`${this.base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${computerToken(this.options.cellSecret)}`,
				"x-annie-tenant": this.options.tenant,
				...(body === undefined ? {} : { "content-type": typeof body === "string" ? "application/json" : "application/octet-stream" }),
			},
			...(body === undefined ? {} : { body }),
			signal,
		});
		if (response.ok) return response;
		const text = await response.text().catch(() => "");
		let error = "";
		try {
			error = String((JSON.parse(text) as { error?: string }).error ?? "");
		} catch {}
		if (response.status === 422 || response.status === 402 || response.status === 429) throw new ComputerError(error.slice(0, 300) || "il computer ha rifiutato la richiesta");
		throw new Error(`computer service: HTTP ${response.status} ${error.slice(0, 200)}`);
	}
}
