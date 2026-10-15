import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

/** A tool the instance wrote, waiting for (or past) an approver's decision. */
export type ToolProposal = {
	readonly id: string;
	/** Tool name as the model will call it, without the custom_ prefix. */
	readonly name: string;
	readonly description: string;
	/** JSON Schema of the arguments. */
	readonly parameters: Record<string, unknown>;
	/** ES module source; default export `async (args, { workDir }) => result`. */
	readonly code: string;
	/** Hosts it may reach over https; empty: no network. */
	readonly hosts: readonly string[];
	readonly status: "pending" | "approved" | "rejected";
	/** The conversation it was proposed in: told about the decision. */
	readonly thread?: { readonly channel: string; readonly threadId: string };
	readonly proposedAt: string;
	readonly decidedBy?: { readonly channel: string; readonly userId: string };
	readonly decidedAt?: string;
	/** Approvers' chats that have the approval card. */
	readonly notified?: readonly string[];
};

export class ProposalError extends Error {
	override readonly name = "ProposalError";
}

export const PROPOSAL_LIMITS = { maxCodeChars: 50_000, maxHosts: 10, maxPending: 20 } as const;
const NAME = /^[a-z][a-z0-9_]{2,40}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Name under which the egress policy allows an approved tool's network access. */
export function toolEgressName(name: string): string {
	return `tool:${name}`;
}

/** The model-facing name of an approved tool. */
export function customToolName(name: string): string {
	return `custom_${name}`;
}

export class ProposalStore {
	constructor(private readonly dir: string) {}

	async propose(input: Pick<ToolProposal, "name" | "description" | "parameters" | "code" | "hosts" | "thread">, now = new Date()): Promise<ToolProposal> {
		if (!NAME.test(input.name)) throw new ProposalError("Name: lowercase letters, digits and _, 3 to 41 characters, starting with a letter");
		if (input.description.trim() === "") throw new ProposalError("Empty description");
		if (input.code.length > PROPOSAL_LIMITS.maxCodeChars) throw new ProposalError(`Code over ${PROPOSAL_LIMITS.maxCodeChars} characters`);
		if (!/export\s+default/.test(input.code)) throw new ProposalError("The code must have a default export: export default async (args, { workDir }) => result");
		if (input.hosts.length > PROPOSAL_LIMITS.maxHosts) throw new ProposalError(`At most ${PROPOSAL_LIMITS.maxHosts} hosts`);
		const bad = input.hosts.filter((h) => !HOST.test(h));
		if (bad.length > 0) throw new ProposalError(`Not host names: ${bad.join(", ")} (no scheme, no path, e.g. api.example.com)`);
		if (input.parameters.type !== "object") throw new ProposalError('parameters must be a JSON Schema with type "object"');
		const all = await this.list();
		if (all.filter((p) => p.status === "pending").length >= PROPOSAL_LIMITS.maxPending) throw new ProposalError(`Too many proposals waiting (${PROPOSAL_LIMITS.maxPending})`);
		const proposal: ToolProposal = { ...input, hosts: [...new Set(input.hosts)], id: randomBytes(6).toString("hex"), status: "pending", proposedAt: now.toISOString() };
		await this.save(proposal);
		return proposal;
	}

	async get(id: string): Promise<ToolProposal | undefined> {
		if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
		try {
			return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as ToolProposal;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async list(): Promise<ToolProposal[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const all = await Promise.all(names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => this.get(n.slice(0, -5))));
		return all.filter((p): p is ToolProposal => p !== undefined).sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
	}

	/** Approved tools, the latest approval of each name winning. */
	async approved(): Promise<ToolProposal[]> {
		const byName = new Map<string, ToolProposal>();
		for (const p of await this.list()) if (p.status === "approved") byName.set(p.name, p);
		return [...byName.values()];
	}

	/** Only a pending proposal can be decided; deciding twice returns the first decision. */
	async decide(id: string, decision: "approved" | "rejected", by: { channel: string; userId: string }, now = new Date()): Promise<{ proposal: ToolProposal; changed: boolean }> {
		const current = await this.get(id);
		if (current === undefined) throw new ProposalError(`No proposal ${id}`);
		if (current.status !== "pending") return { proposal: current, changed: false };
		const proposal: ToolProposal = { ...current, status: decision, decidedBy: by, decidedAt: now.toISOString() };
		await this.save(proposal);
		return { proposal, changed: true };
	}

	async markNotified(id: string, chat: string): Promise<void> {
		const current = await this.get(id);
		if (current === undefined) return;
		await this.save({ ...current, notified: [...new Set([...(current.notified ?? []), chat])] });
	}

	private save(p: ToolProposal): Promise<void> {
		return writeFileAtomic(join(this.dir, `${p.id}.json`), `${JSON.stringify(p, null, 2)}\n`);
	}
}
