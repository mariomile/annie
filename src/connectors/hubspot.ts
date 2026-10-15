import type { CrmAdapter, LeadUpsert } from "./types.ts";

/** HubSpot adapter stub. Live calls wait on Mario's HubSpot token. */
export class HubSpotCrmAdapter implements CrmAdapter {
	readonly name = "hubspot";
	constructor(private readonly getAccessToken: () => Promise<string | undefined>) {}

	async upsertLead(_tenantId: string, _lead: LeadUpsert, _idempotencyKey: string): Promise<never> {
		const token = await this.getAccessToken();
		if (!token) throw new Error("HubSpot credentials missing (set tenant secret crm.hubspot.accessToken)");
		throw new Error("HubSpot upsertLead: live API not enabled in week-3 without ANNIE_HUBSPOT_LIVE=1");
	}

	async updateLeadStatus(): Promise<never> {
		const token = await this.getAccessToken();
		if (!token) throw new Error("HubSpot credentials missing");
		throw new Error("HubSpot updateLeadStatus: live API not enabled in week-3 without ANNIE_HUBSPOT_LIVE=1");
	}
}
