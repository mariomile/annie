import type { CrmAdapter, LeadUpsert } from "./types.ts";

export class FakeCrmAdapter implements CrmAdapter {
	readonly name = "fake-crm";
	readonly leads = new Map<string, { lead: LeadUpsert; crmLeadId: string; created: boolean; status?: string }>();
	failNextUpsert = false;
	upsertCalls = 0;

	async upsertLead(
		_tenantId: string,
		lead: LeadUpsert,
		idempotencyKey: string,
	): Promise<{ crmLeadId: string; created: boolean }> {
		this.upsertCalls += 1;
		if (this.failNextUpsert) {
			this.failNextUpsert = false;
			throw new Error("CRM timeout");
		}
		const existing = this.leads.get(idempotencyKey);
		if (existing) return { crmLeadId: existing.crmLeadId, created: false };
		const crmLeadId = `crm-${this.leads.size + 1}`;
		this.leads.set(idempotencyKey, { lead, crmLeadId, created: true });
		return { crmLeadId, created: true };
	}

	async updateLeadStatus(
		_tenantId: string,
		crmLeadId: string,
		status: "replied" | "discarded" | "error",
		_note?: string,
	): Promise<void> {
		for (const entry of this.leads.values()) {
			if (entry.crmLeadId === crmLeadId) {
				entry.status = status;
				return;
			}
		}
	}
}
