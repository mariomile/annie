import { customToolName, type ToolProposal, toolEgressName } from "./proposals.ts";
import type { AnnieRuntime } from "./runtime.ts";

export type Approver = { readonly channel: string; readonly userId: string };

/** The owner, acting from the command line or the web console as owner. */
export const OWNER: Approver = { channel: "owner", userId: "owner" };

export class NotAnApprover extends Error {
	override readonly name = "NotAnApprover";
}

/** May `who` approve actions of this instance? The owner always may. */
export async function isApprover(runtime: AnnieRuntime, tenant: string, instance: string, who: Approver): Promise<boolean> {
	if (who.channel === OWNER.channel && who.userId === OWNER.userId) return true;
	const record = await runtime.registry.getInstance(tenant, instance);
	return (record.approvers?.[who.channel] ?? []).includes(who.userId);
}

/**
 * Approve or reject a tool proposto. Approving lets the tool reach its declared hosts
 * (tool:<name> in the egress policy) and reopens the instance so the model can call it.
 * The conversation it was proposed in is told. Deciding twice keeps the first decision.
 */
export async function decideToolProposal(
	runtime: AnnieRuntime,
	tenant: string,
	instance: string,
	id: string,
	decision: "approved" | "rejected",
	by: Approver,
): Promise<ToolProposal> {
	const audit = runtime.audit(tenant);
	if (!(await isApprover(runtime, tenant, instance, by))) {
		await audit.append({ type: "user.denied", instanceId: instance, channel: by.channel, userId: by.userId, action: `tool.${decision}`, proposalId: id });
		throw new NotAnApprover(`${by.channel}:${by.userId} cannot approve actions of ${tenant}/${instance}`);
	}
	const { proposal, changed } = await runtime.proposals(tenant, instance).decide(id, decision, by);
	if (!changed) return proposal;
	await audit.append({ type: `tool.${decision}`, instanceId: instance, proposalId: id, tool: proposal.name, hosts: proposal.hosts.join(","), by: `${by.channel}:${by.userId}` });
	if (decision === "approved") {
		const record = await runtime.registry.getInstance(tenant, instance);
		const connectors = record.egress.connectors ?? [];
		if (proposal.hosts.length > 0 && !connectors.includes(toolEgressName(proposal.name))) {
			await runtime.registry.setEgress(tenant, instance, { ...record.egress, connectors: [...connectors, toolEgressName(proposal.name)] });
		}
		await runtime.reopen(tenant, instance);
	}
	if (proposal.thread !== undefined) {
		const text =
			decision === "approved"
				? `Il tool ${customToolName(proposal.name)} (proposta ${proposal.id}) è stato approvato: ora posso usarlo.`
				: `Il tool ${customToolName(proposal.name)} (proposta ${proposal.id}) è stato rifiutato: non lo userò.`;
		await runtime.sendMessage(tenant, instance, { ...proposal.thread, text, key: `proposal:${proposal.id}` });
	}
	return proposal;
}
