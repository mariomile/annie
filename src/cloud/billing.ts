import { createHmac } from "node:crypto";
import { sameSecret } from "../web/compare.ts";

/**
 * Owni Cloud's subscription (ADR 0010): a flat monthly price, and optionally a price on what a
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
	/** Stripe's subscription status (active, trialing, past_due, canceled, unpaid, …), as Stripe last said when asked. */
	readonly status?: string;
	/** Model cost already sent to Stripe, in US cents, per month (YYYY-MM). Set when the tenant first gets a customer: what came before is the trial's. */
	readonly reportedCents?: Readonly<Record<string, number>>;
	/** The last Checkout page made for this tenant: made to expire when a new one is made, so nobody pays twice. */
	readonly checkoutId?: string;
};

/** A subscription as Stripe has it now. */
export type Subscription = { readonly id: string; readonly customerId: string; readonly status: string; readonly tenant?: string };

/** Statuses that mean a subscription is alive: Owni works and its cost is sent. */
const LIVE = new Set(["active", "trialing", "past_due"]);
export const live = (status: string | undefined) => status !== undefined && LIVE.has(status);
/** Statuses after which only a new subscription helps: Checkout again. Others (unpaid, incomplete) are settled in the portal. */
const OVER = new Set(["canceled", "incomplete_expired"]);
/** Statuses that end access at once, trial or not: the person stopped paying or cancelled. */
const STOPPED = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);
export const mayCheckout = (status: string | undefined) => status === undefined || OVER.has(status);

/** Where a tenant stands: in trial, paying, late with a payment (Stripe retries), or ended (cell kept asleep). */
export type Access = { readonly state: "trial" | "active" | "past_due" | "ended"; readonly trialEndsAt: string };

export function accessOf(account: { readonly createdAt: string; readonly billing?: AccountBilling }, billingSince: string, trialDays: number, now = Date.now()): Access {
	const start = Math.max(Date.parse(account.createdAt), Date.parse(billingSince));
	const trialEndsAt = new Date(start + trialDays * 86_400_000).toISOString();
	const status = account.billing?.status;
	if (status === "active" || status === "trialing") return { state: "active", trialEndsAt };
	if (status === "past_due") return { state: "past_due", trialEndsAt };
	if (status !== undefined && STOPPED.has(status)) return { state: "ended", trialEndsAt };
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

	/**
	 * A Stripe Checkout page for this tenant's subscription. Subscribing during the trial keeps
	 * the days left (Stripe charges when it ends, if that is at least 48 hours away, as Stripe asks).
	 * The tenant's previous page, if still open, is made to expire first.
	 */
	async checkout(input: { readonly tenant: string; readonly email: string; readonly customerId?: string; readonly homeUrl: string; readonly trialEndsAt?: string; readonly previous?: string }): Promise<{ id: string; url: string }> {
		if (input.previous !== undefined) await this.call(`/v1/checkout/sessions/${encodeURIComponent(input.previous)}/expire`, {}).catch(() => {});
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
		const trialEnd = input.trialEndsAt === undefined ? 0 : Math.floor(Date.parse(input.trialEndsAt) / 1000);
		if (trialEnd > Date.now() / 1000 + 49 * 3600) params["subscription_data[trial_end]"] = String(trialEnd);
		const session = await this.call("/v1/checkout/sessions", params);
		return { id: text(session.id, "id"), url: text(session.url, "url") };
	}

	/** Stripe's customer portal: invoices, card, plan, cancellation. */
	async portal(customerId: string, returnUrl: string): Promise<string> {
		return text((await this.call("/v1/billing_portal/sessions", { customer: customerId, return_url: returnUrl })).url, "url");
	}

	/** A subscription as it stands now: events can arrive late and out of order, Stripe's own record cannot. */
	async subscription(id: string): Promise<Subscription> {
		const found = await this.call(`/v1/subscriptions/${encodeURIComponent(id)}`);
		const metadata = (found.metadata ?? {}) as Record<string, unknown>;
		const customer = typeof found.customer === "object" && found.customer !== null ? (found.customer as { id?: unknown }).id : found.customer;
		return { id: text(found.id, "id"), customerId: text(customer, "customer"), status: text(found.status, "status"), ...(typeof metadata.tenant === "string" ? { tenant: metadata.tenant } : {}) };
	}

	/**
	 * Model cost for a customer, in US cents, dated now: it lands in the billing period still open,
	 * never in one already invoiced. The identifier makes a retry count once.
	 */
	async meterEvent(input: { readonly customerId: string; readonly cents: number; readonly identifier: string }): Promise<void> {
		if (this.config.usage === undefined) return;
		await this.call("/v1/billing/meter_events", {
			event_name: this.config.usage.meterEvent,
			"payload[stripe_customer_id]": input.customerId,
			"payload[value]": String(input.cents),
			identifier: input.identifier,
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
		if (typeof event?.type !== "string" || typeof event.created !== "number" || typeof event.data?.object !== "object" || event.data.object === null) throw new BillingRefused("evento non valido");
		return event;
	}

	/** POST with form parameters, or GET without. */
	private async call(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
		const response = await fetch(`${this.config.apiBase ?? "https://api.stripe.com"}${path}`, {
			method: params === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${this.config.secretKey}`, ...(params === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
			...(params === undefined ? {} : { body: new URLSearchParams(params).toString() }),
			signal: AbortSignal.timeout(15_000),
		});
		const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
		// Stripe's message, never the request: the key stays out of logs.
		if (!response.ok) throw new Error(`Stripe ${path}: ${response.status} ${String(body.error?.message ?? "").replace(/\b(sk|rk|whsec)_\w+/g, "[chiave]").slice(0, 200)}`);
		return body;
	}
}

/** A string field Stripe always sends; its absence is an error, never the text "undefined". */
function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`Stripe: risposta senza ${field}`);
	return value;
}
