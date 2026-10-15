import type { MailAdapter } from "./types.ts";

/**
 * Gmail adapter stub. Real OAuth/API wiring waits on Mario's secrets.
 * Production code must not call this without credentials in TenantSecrets.
 */
export class GmailMailAdapter implements MailAdapter {
	readonly name = "gmail";
	constructor(private readonly getAccessToken: () => Promise<string | undefined>) {}

	async listNewRequests(): Promise<never> {
		const token = await this.getAccessToken();
		if (!token) throw new Error("Gmail credentials missing (set tenant secret mail.gmail.accessToken)");
		throw new Error("Gmail listNewRequests: live API not enabled in week-3 without ANNIE_GMAIL_LIVE=1");
	}

	async sendReply(): Promise<never> {
		const token = await this.getAccessToken();
		if (!token) throw new Error("Gmail credentials missing (set tenant secret mail.gmail.accessToken)");
		throw new Error("Gmail sendReply: live API not enabled in week-3 without ANNIE_GMAIL_LIVE=1");
	}
}
