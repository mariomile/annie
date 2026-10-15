import type { InboundMail, MailAdapter } from "./types.ts";

/** In-memory mail adapter for tests. Never hits the network. */
export class FakeMailAdapter implements MailAdapter {
	readonly name = "fake-mail";
	readonly inbox: InboundMail[] = [];
	readonly sent: Array<{
		tenantId: string;
		to: string;
		subject: string;
		bodyText: string;
		inReplyToMessageId: string;
		idempotencyKey: string;
		sentMessageId: string;
	}> = [];
	failNextSend = false;
	private sendCountByKey = new Map<string, number>();

	seed(messages: InboundMail[]): void {
		this.inbox.push(...messages);
	}

	async listNewRequests(
		_tenantId: string,
		sinceCursor: string,
	): Promise<{ messages: InboundMail[]; nextCursor: string }> {
		const start = sinceCursor === "" ? 0 : Number(sinceCursor);
		const messages = this.inbox.slice(start);
		return { messages, nextCursor: String(this.inbox.length) };
	}

	async sendReply(
		tenantId: string,
		args: {
			to: string;
			subject: string;
			bodyText: string;
			inReplyToMessageId: string;
			idempotencyKey: string;
		},
	): Promise<{ sentMessageId: string }> {
		const existing = this.sent.find((s) => s.idempotencyKey === args.idempotencyKey);
		if (existing) return { sentMessageId: existing.sentMessageId };
		if (this.failNextSend) {
			this.failNextSend = false;
			throw new Error("mailbox unavailable");
		}
		const sentMessageId = `sent-${this.sent.length + 1}`;
		this.sent.push({ tenantId, ...args, sentMessageId });
		this.sendCountByKey.set(args.idempotencyKey, (this.sendCountByKey.get(args.idempotencyKey) ?? 0) + 1);
		return { sentMessageId };
	}

	sendCount(idempotencyKey: string): number {
		return this.sendCountByKey.get(idempotencyKey) ?? 0;
	}
}
