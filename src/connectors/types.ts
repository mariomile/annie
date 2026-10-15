export type InboundMail = {
	readonly messageId: string;
	readonly threadId?: string;
	readonly from: string;
	readonly fromName?: string;
	readonly subject: string;
	readonly bodyText: string;
	readonly receivedAt: string;
	readonly inReplyTo?: string;
};

export interface MailAdapter {
	readonly name: string;
	listNewRequests(tenantId: string, sinceCursor: string): Promise<{ messages: InboundMail[]; nextCursor: string }>;
	sendReply(
		tenantId: string,
		args: {
			to: string;
			subject: string;
			bodyText: string;
			inReplyToMessageId: string;
			idempotencyKey: string;
		},
	): Promise<{ sentMessageId: string }>;
}

export type LeadUpsert = {
	readonly fullName?: string | null;
	readonly title?: string | null;
	readonly company?: string | null;
	readonly email: string | null;
	readonly phone?: string | null;
	readonly productOrService: string | null;
	readonly vatNumber?: string | null;
	readonly originalLanguage?: string;
	readonly missingFields: readonly string[];
	readonly rawSubject: string;
	readonly mailMessageId: string;
};

export interface CrmAdapter {
	readonly name: string;
	upsertLead(
		tenantId: string,
		lead: LeadUpsert,
		idempotencyKey: string,
	): Promise<{ crmLeadId: string; created: boolean }>;
	updateLeadStatus(
		tenantId: string,
		crmLeadId: string,
		status: "replied" | "discarded" | "error",
		note?: string,
	): Promise<void>;
}
