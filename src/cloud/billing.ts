import { createHmac } from "node:crypto";
import { sameSecret } from "../web/compare.ts";

/**
 * Annie Cloud's subscription (ADR 0010): a flat monthly price, and optionally a price on what a
 * tenant's model costs, both set in Stripe, so the price is configuration, not code. Sign-up
 * starts a trial; after it a tenant needs an active subscription, or its cell stays asleep.
 * Payment details only ever reach Stripe's own pages.
 */

export type BillingConfig = {
	readonly secretKey: string;
	readonly webhookSecret: string;
	/** The flat monthly price (price_…). */
	readonly price: string;
	/** A metered price on model cost (price_…), with the meter's event name: one unit is one US cent at list prices. */
	readonly usage?: { readonly price: string; readonly meterEvent: string };
	readonly trialDays: number;
	/** Tests only: a fake Stripe. */
	readonly apiBase?: string;
};

/** What the control plane keeps of a tenant's subscription: ids and status, never payment details. */
export type AccountBilling = {
	readonly customerId?: string;
	readonly subscriptionId?: string;
	/** Stripe's subscription status (active, trialing, past_due, canceled, unpaid, …). */
	readonly status?: string;
	/** Creation time of the last subscription event applied: an older one arriving late is ignored. */
	readonly eventAt?: number;
	/** Model cost already sent to Stripe, in US cents, per month (YYYY-MM). */
	readonly reportedCents?: Readonly<Record<string, number>>;
};

/** Where a tenant stands: in trial, paying, late with a payment (Stripe retries), or ended (cell kept asleep). */
export type Access = { readonly state: "trial" | "active" | "past_due" | "ended"; readonly trialEndsAt: string };

export function accessOf(account: { readonly createdAt: string; readonly billing?: AccountBilling }, billingSince: string, trialDays: number, now = Date.now()): Access {
	const start = Math.max(Date.parse(account.createdAt), Date.parse(billingSince));
	const trialEndsAt = new Date(start + trialDays * 86_400_000).toISOString();
	const status = account.billing?.status;
	if (status === "active" || status === "trialing") return { state: "active", trialEndsAt };
	if (status === "past_due") return { state: "past_due", trialEndsAt };
	return { state: now < Date.parse(trialEndsAt) ? "trial" : "ended", trialEndsAt };
}

export const mayUse = (access: Access) => access.state !== "ended";

export type StripeEvent = { readonly id: string; readonly type: string; readonly created: number; readonly data: { readonly object: Record<string, unknown> } };

export class BillingRefused extends Error {
	override readonly name = "BillingRefused";
}

/** Signatures older than this are refused: a captured delivery cannot be replayed later. */
const TOLERANCE_S = 300;

export class StripeBilling {
	readonly trialDays: number;
	readonly meters: boolean;

	constructor(private readonly config: BillingConfig) {
		this.trialDays = config.trialDays;
		this.meters = config.usage !== undefined;
	}

	/** A Stripe Checkout page for this tenant's subscription. */
	async checkout(input: { readonly tenant: string; readonly email: string; readonly customerId?: string; readonly homeUrl: string }): Promise<string> {
		const params: Record<string, string> = {
			mode: "subscription",
			"line_items[0][price]": this.config.price,
			"line_items[0][quantity]": "1",
			client_reference_id: input.tenant,
			"metadata[tenant]": input.tenant,
			"subscription_data[metadata][tenant]": input.tenant,
			success_url: `${input.homeUrl}/?abbonamento=attivo`,
			cancel_url: `${input.homeUrl}/`,
			locale: "it",
			billing_address_collection: "required",
			"tax_id_collection[enabled]": "true",
			allow_promotion_codes: "true",
		};
		// A metered price takes no quantity: Stripe counts it from the meter.
		if (this.config.usage !== undefined) params["line_items[1][price]"] = this.config.usage.price;
		if (input.customerId === undefined) params.customer_email = input.email;
		else Object.assign(params, { customer: input.customerId, "customer_update[name]": "auto", "customer_update[address]": "auto" });
		return String((await this.call("/v1/checkout/sessions", params)).url);
	}

	/** Stripe's customer portal: invoices, card, plan, cancellation. */
	async portal(customerId: string, returnUrl: string): Promise<string> {
		return String((await this.call("/v1/billing_portal/sessions", { customer: customerId, return_url: returnUrl })).url);
	}

	/** Model cost for a customer, in US cents. The identifier makes a retry count once. */
	async meterEvent(input: { readonly customerId: string; readonly cents: number; readonly identifier: string; readonly at: Date }): Promise<void> {
		if (this.config.usage === undefined) return;
		await this.call("/v1/billing/meter_events", {
			event_name: this.config.usage.meterEvent,
			"payload[stripe_customer_id]": input.customerId,
			"payload[value]": String(input.cents),
			identifier: input.identifier,
			timestamp: String(Math.floor(input.at.getTime() / 1000)),
		});
	}

	/** The event in a webhook delivery, if Stripe signed it (header `t=…,v1=…`, HMAC-SHA256 of `t.body`) in the last 5 minutes. */
	event(rawBody: Buffer, header: string | undefined, now = Date.now()): StripeEvent {
		let timestamp = Number.NaN;
		const signatures: string[] = [];
		for (const part of (header ?? "").split(",")) {
			const [key, value = ""] = part.trim().split("=", 2);
			if (key === "t") timestamp = Number(value);
			if (key === "v1") signatures.push(value);
		}
		if (!Number.isInteger(timestamp) || signatures.length === 0) throw new BillingRefused("firma mancante");
		const expected = createHmac("sha256", this.config.webhookSecret).update(`${timestamp}.`).update(rawBody).digest("hex");
		if (!signatures.some((s) => sameSecret(s, expected))) throw new BillingRefused("firma non valida");
		if (Math.abs(Math.floor(now / 1000) - timestamp) > TOLERANCE_S) throw new BillingRefused("firma scaduta");
		const event = JSON.parse(rawBody.toString("utf8")) as StripeEvent;
		if (typeof event?.type !== "string" || typeof event.created !== "number" || typeof event.data?.object !== "object") throw new BillingRefused("evento non valido");
		return event;
	}

	private async call(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
		const response = await fetch(`${this.config.apiBase ?? "https://api.stripe.com"}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params).toString(),
			signal: AbortSignal.timeout(15_000),
		});
		const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
		// Stripe's message, never the request: the key stays out of logs.
		if (!response.ok) throw new Error(`Stripe ${path}: ${response.status} ${String(body.error?.message ?? "").replace(/\b(sk|rk|whsec)_\w+/g, "[chiave]").slice(0, 200)}`);
		return body;
	}
}

/** When a month's cost is sent: now for the current month, the month's last hours for a closed one (Stripe takes up to 35 days back). */
export function meterTime(month: string, currentMonth: string, now = Date.now()): Date {
	if (month >= currentMonth) return new Date(now);
	const next = new Date(`${month}-01T00:00:00Z`);
	next.setUTCMonth(next.getUTCMonth() + 1);
	return new Date(Math.max(next.getTime() - 3 * 3_600_000, now - 34 * 86_400_000));
}
