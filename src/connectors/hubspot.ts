import { ConnectorHttpError, requestJson } from "./http.ts";
import type { CrmAdapter, LeadUpsert } from "./types.ts";

/** Tenant secret name of the HubSpot private app token (scopes: crm.objects.contacts.read/write). */
export const HUBSPOT_SECRET = "crm.hubspot.accessToken";

/** Hosts the HubSpot adapter talks to; the egress fetch allows only these. */
export const HUBSPOT_HOSTS = ["api.hubapi.com"] as const;

export type LeadStatus = "replied" | "discarded" | "error";

/**
 * Pratica outcome → internal value of the contact's `hs_lead_status`. HubSpot's docs list
 * the labels, not the internal values, and portals can change the options: check them with
 * GET /crm/v3/properties/contacts/hs_lead_status and override here. `null` = leave it.
 */
export const DEFAULT_LEAD_STATUS: Readonly<Record<LeadStatus, string | null>> = {
	replied: "ATTEMPTED_TO_CONTACT",
	discarded: "UNQUALIFIED",
	error: null,
};

export type HubSpotAdapterOptions = {
	readonly accessToken: () => Promise<string | undefined>;
	/** Pass an egress-guarded fetch (see egressFetch). */
	readonly fetch: typeof fetch;
	readonly leadStatus?: Readonly<Record<LeadStatus, string | null>>;
	readonly log?: (message: string) => void;
	readonly now?: () => number;
	readonly retryBaseMs?: number;
};

const API = "https://api.hubapi.com";
/** HubSpot-defined association type: note → contact. */
const NOTE_TO_CONTACT = 202;

const STATUS_NOTE: Record<LeadStatus, string> = {
	replied: "Annie: risposta inviata al cliente (approvata su Telegram).",
	discarded: "Annie: pratica scartata dal commerciale.",
	error: "Annie: errore nella pratica.",
};

/**
 * HubSpot CRM (v3 objects API) with a private app token and plain fetch.
 *
 * - With an email the contact is upserted by email (batch/upsert, idProperty=email), so a
 *   retry updates the same contact. Without one it is created, and a retry can create a
 *   second contact: the pipeline upserts once per pratica, so this needs a crash in between.
 * - Each upsert adds a note on the contact with the request and the missing data, which is
 *   where the commercial looks first. Notes are not retried (a retry could duplicate them).
 * - Only fields the sender wrote go to the CRM (A7): no titles, no VAT number.
 */
export class HubSpotCrmAdapter implements CrmAdapter {
	readonly name = "hubspot";
	private readonly now: () => number;

	constructor(private readonly options: HubSpotAdapterOptions) {
		this.now = options.now ?? Date.now;
	}

	async upsertLead(_tenantId: string, lead: LeadUpsert, idempotencyKey: string): Promise<{ crmLeadId: string; created: boolean }> {
		const properties = contactProperties(lead);
		let crmLeadId: string;
		let created: boolean;
		if (lead.email !== null && lead.email !== "") {
			const result = await this.api<{ results: { id: string; new?: boolean }[] }>("contacts.upsert", "/crm/v3/objects/contacts/batch/upsert", {
				body: { inputs: [{ id: lead.email, idProperty: "email", properties, objectWriteTraceId: idempotencyKey }] },
				retries: 2,
			});
			const first = result.results[0];
			if (first === undefined) throw new ConnectorHttpError("hubspot", "contacts.upsert", 200, "empty results");
			crmLeadId = first.id;
			created = first.new === true;
		} else {
			const result = await this.api<{ id: string }>("contacts.create", "/crm/v3/objects/contacts", { body: { properties } });
			crmLeadId = result.id;
			created = true;
		}
		await this.addNote(crmLeadId, leadNote(lead));
		return { crmLeadId, created };
	}

	async updateLeadStatus(_tenantId: string, crmLeadId: string, status: LeadStatus, note?: string): Promise<void> {
		const value = (this.options.leadStatus ?? DEFAULT_LEAD_STATUS)[status];
		if (value !== null) {
			try {
				await this.api("contacts.update", `/crm/v3/objects/contacts/${encodeURIComponent(crmLeadId)}`, {
					method: "PATCH",
					body: { properties: { hs_lead_status: value } },
					retries: 2,
				});
			} catch (error) {
				// A portal without this option rejects the value: the note below still records the outcome.
				if (!(error instanceof ConnectorHttpError) || error.status !== 400) throw error;
				this.options.log?.(`hubspot: hs_lead_status "${value}" rejected, outcome kept in a note: ${error.detail}`);
			}
		}
		await this.addNote(crmLeadId, note === undefined ? STATUS_NOTE[status] : `${STATUS_NOTE[status]} ${note}`);
	}

	private async addNote(contactId: string, body: string): Promise<void> {
		await this.api("notes.create", "/crm/v3/objects/notes", {
			body: {
				properties: { hs_timestamp: new Date(this.now()).toISOString(), hs_note_body: body.slice(0, 65_536) },
				associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }],
			},
		});
	}

	private async api<T>(operation: string, path: string, request: { method?: "POST" | "PATCH"; body: unknown; retries?: number }): Promise<T> {
		const token = await this.options.accessToken();
		if (token === undefined) throw new Error(`HubSpot credentials missing: set tenant secret ${HUBSPOT_SECRET}`);
		return requestJson<T>(this.options.fetch, `${API}${path}`, {
			connector: "hubspot",
			operation,
			method: request.method ?? "POST",
			headers: { authorization: `Bearer ${token}` },
			body: request.body,
			retries: request.retries ?? 0,
			...(this.options.retryBaseMs === undefined ? {} : { retryBaseMs: this.options.retryBaseMs }),
		});
	}
}

/** Contact properties from what the sender wrote. Empty values are left out, never cleared. */
export function contactProperties(lead: LeadUpsert): Record<string, string> {
	const [firstname, ...rest] = (lead.fullName ?? "").trim().split(/\s+/).filter(Boolean);
	const properties: Record<string, string | undefined> = {
		email: lead.email ?? undefined,
		firstname,
		lastname: rest.length > 0 ? rest.join(" ") : undefined,
		phone: lead.phone ?? undefined,
		company: lead.company ?? undefined,
	};
	return Object.fromEntries(Object.entries(properties).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ""));
}

function leadNote(lead: LeadUpsert): string {
	return [
		`Annie: richiesta di preventivo ricevuta per email («${lead.rawSubject}»).`,
		`Prodotto/servizio: ${lead.productOrService ?? "non indicato"}.`,
		`Dati mancanti: ${lead.missingFields.length > 0 ? lead.missingFields.map((f) => (f === "vatNumberInvalid" ? "P.IVA da ricontrollare" : f)).join(", ") : "nessuno"}.`,
		`Bozza di risposta in attesa di approvazione su Telegram.`,
	].join("\n");
}
