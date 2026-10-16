import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join } from "node:path";
import { googleReturnQuery } from "../connectors/google.ts";
import { sameSecret } from "../web/compare.ts";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import type { CellState } from "../web/server.ts";
import { type Access, type AccountBilling, accessOf, BillingRefused, mayUse, meterTime, type StripeBilling, type StripeEvent } from "./billing.ts";
import type { Mailer } from "./mailer.ts";
import { romeDayKey } from "../core/usage.ts";
import type { CellProvider } from "./provider.ts";

/**
 * The control plane of Annie Cloud (ADR 0007): sign-up by email link, one cell per tenant,
 * requests routed by host name (`<tenant>.<domain>`) to the tenant's cell, idle cells stopped
 * and woken for their next task. It forwards requests without keeping them; conversations,
 * files and secrets of a tenant live only in its cell.
 */

export type ControlPlaneOptions = {
	readonly dataDir: string;
	/** Annie Cloud's domain: the sign-up page lives here, each tenant at `<tenant>.<domain>`. */
	readonly domain: string;
	readonly publicScheme: "http" | "https";
	/** Port in public links, when it is not the scheme's default (local development). */
	readonly publicPort?: number;
	readonly provider: CellProvider;
	readonly mailer: Mailer;
	/** What every cell gets: model provider and key, time zone. */
	readonly cellEnv: Readonly<Record<string, string>>;
	/** A cell with no request for this long, and nothing under way, is stopped. */
	readonly idleMs: number;
	readonly web: { readonly host: string; readonly port: number };
	/** How often to check idle and due cells; 0: only when `tick` is called. */
	readonly tickMs: number;
	/** Subscriptions through Stripe (ADR 0010); without it Annie Cloud is free to use. */
	readonly billing?: StripeBilling;
	readonly log?: (message: string) => void;
};

export type ControlPlane = {
	/** The tenants, their cells and their spend: for the operator (pnpm cloud status). */
	status(): Promise<TenantStatus[]>;
	readonly server: Server;
	/** Stop idle cells, wake the ones whose next task is due. */
	tick(now: Date): Promise<void>;
	stop(): Promise<void>;
};

type Account = { readonly email: string; readonly tenant: string; readonly createdAt: string; readonly billing?: AccountBilling };
type Cell = {
	readonly tenant: string;
	readonly secret: string;
	readonly nextWakeAt: string | null;
	/** What the cell said it spent when it was last asked (a sleeping cell is not woken to ask). */
	readonly usage?: SeenUsage;
};

type SeenUsage = NonNullable<CellState["usage"]> & { readonly at: string };

/** One tenant as the operator sees it: no conversation, no file, only who, state and spend. */
export type TenantStatus = {
	readonly tenant: string;
	readonly email: string;
	readonly createdAt: string;
	readonly cell: "running" | "stopped" | "missing";
	readonly nextWakeAt: string | null;
	/** Estimated model spend (list prices), as of `readAt`; null if never read. */
	readonly spend: { readonly todayUsd: number; readonly monthUsd: number; readonly lastMonthUsd: number; readonly readAt: string } | null;
	/** Trial or subscription; null when Annie Cloud runs without billing. */
	readonly billing: (Access & { readonly subscription: string | null }) | null;
};

/**
 * A new reading of a cell's spend, kept with what was known: the later reading wins for today,
 * and each month keeps its highest total (a month only grows), so a reading taken just before
 * a newer one never undoes it.
 */
function keepUsage(cells: readonly Cell[], tenant: string, usage: NonNullable<CellState["usage"]>): Cell[] {
	const seen: SeenUsage = { ...usage, at: new Date().toISOString() };
	return cells.map((c) => {
		if (c.tenant !== tenant) return c;
		const old = c.usage;
		const months = { ...old?.months };
		for (const [month, usd] of Object.entries(usage.months)) months[month] = Math.max(months[month] ?? 0, usd);
		const latest = old === undefined || usage.day > old.day ? seen : usage.day < old.day ? old : { ...seen, todayUsd: Math.max(old.todayUsd, usage.todayUsd) };
		return { ...c, usage: { ...latest, months, at: old !== undefined && old.at > seen.at ? old.at : seen.at } };
	});
}

/** Today's and this month's figures from a reading, in Europe/Rome; stale figures count as zero. */
function spendNow(usage: SeenUsage | undefined): TenantStatus["spend"] {
	if (usage === undefined) return null;
	const today = romeDayKey();
	const month = today.slice(0, 7);
	const previous = new Date(`${month}-15T12:00:00Z`);
	previous.setUTCMonth(previous.getUTCMonth() - 1);
	return {
		todayUsd: usage.day === today ? usage.todayUsd : 0,
		monthUsd: usage.months[month] ?? 0,
		lastMonthUsd: usage.months[previous.toISOString().slice(0, 7)] ?? 0,
		readAt: usage.at,
	};
}
/** What a sign-in link gives: the way into the cell, and with billing where the tenant stands and Stripe's pages. */
type VerifyResult = { readonly loginUrl?: string; readonly billing?: Access & { readonly checkoutUrl?: string; readonly portalUrl?: string } };
type PendingLink = { readonly hash: string; readonly email: string; readonly expiresAt: number; readonly usedAt?: number };
type State = {
	accounts: Account[];
	cells: Cell[];
	links: PendingLink[];
	/** When billing was first switched on: tenants from before get their trial from then. */
	billingSince?: string;
};

const EMPTY: State = { accounts: [], cells: [], links: [] };
const LINK_TTL_MS = 30 * 60 * 1000;
const LINKS_PER_IP_HOUR = 20;
const SLEEPING = { error: "Annie dorme: entra dal link di accesso per svegliarla" };
const CELL_TIMEOUT_MS = 5_000;
const LINKS_PER_HOUR = 5;
const MAX_BODY = 64 * 1024;
const MAX_WEBHOOK_BODY = 512 * 1024;
/** A running cell is asked for its spend at least this often, so a cell that never sleeps is billed too. */
const USAGE_EVERY_MS = 60 * 60 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const UI: Record<string, string> = { "/": "index.html", "/verify": "index.html", "/cloud.js": "cloud.js" };
const SHARED_UI: Record<string, string> = { "/app.css": "app.css", "/icon.svg": "icon.svg" };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
	const file = join(options.dataDir, "control-plane.json");
	const log = options.log ?? ((message: string) => console.error(message));
	const read = () => readJsonFile<State>(file, EMPTY);
	const update = (change: (state: State) => State) => updateJsonFile<State>(file, EMPTY, change);
	/** When each cell last saw a request, and how many requests (event streams too) are open. */
	const lastSeen = new Map<string, number>();
	const open = new Map<string, number>();
	const creating = new Map<string, Promise<Account>>();
	const stoppings = new Map<string, Promise<void>>();
	/** Sign-in links asked per address of the asker, in this process. */
	const linksByIp = new Map<string, number[]>();
	const port = options.publicPort === undefined ? "" : `:${options.publicPort}`;
	const publicUrl = (host: string) => `${options.publicScheme}://${host}${port}`;
	const billing = options.billing;
	if (billing !== undefined && read().billingSince === undefined) update((s) => ({ ...s, billingSince: s.billingSince ?? new Date().toISOString() }));
	/** Where a tenant stands with its subscription; undefined when there is no billing. */
	const accessFor = (tenant: string): Access | undefined => {
		const state = read();
		const account = state.accounts.find((a) => a.tenant === tenant);
		return billing === undefined || account === undefined ? undefined : accessOf(account, state.billingSince ?? account.createdAt, billing.trialDays);
	};
	const suspended = (tenant: string) => {
		const access = accessFor(tenant);
		return access !== undefined && !mayUse(access);
	};

	// --- sign-up and sign-in ---
	async function signup(body: { email?: unknown; purpose?: unknown }, ip: string): Promise<void> {
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		if (!EMAIL.test(email)) throw new HttpError(400, "Indirizzo email non valido");
		const now = Date.now();
		const recent = (linksByIp.get(ip) ?? []).filter((at) => at > now - 3_600_000);
		if (recent.length >= LINKS_PER_IP_HOUR) throw new HttpError(429, "Troppi link chiesti da qui: riprova tra un'ora");
		linksByIp.set(ip, [...recent, now]);
		if (read().links.filter((l) => l.email === email && l.expiresAt - LINK_TTL_MS > now - 3_600_000).length >= LINKS_PER_HOUR) throw new HttpError(429, "Troppi link chiesti: riprova tra un'ora");
		const token = randomBytes(32).toString("base64url");
		update((s) => ({ ...s, links: [...s.links.filter((l) => l.expiresAt > now - 3_600_000), { hash: hash(token), email, expiresAt: now + LINK_TTL_MS }] }));
		const forBilling = body.purpose === "billing" && billing !== undefined;
		await options.mailer.send({
			to: email,
			subject: forBilling ? "Il tuo abbonamento ad Annie" : "Entra in Annie",
			text: `Per ${forBilling ? "gestire l'abbonamento ad Annie" : "entrare in Annie"} apri questo link entro 30 minuti:\n\n${publicUrl(options.domain)}/verify${forBilling ? "?per=abbonamento" : ""}#${token}\n\nSe non l'hai chiesto tu, ignora questa mail.`,
		});
	}

	async function verify(body: { token?: unknown; purpose?: unknown }): Promise<VerifyResult> {
		const token = typeof body.token === "string" ? body.token : "";
		const now = Date.now();
		let email: string | undefined;
		// Used up under the lock: the same link cannot sign in twice.
		update((s) => {
			const link = s.links.find((l) => l.usedAt === undefined && l.expiresAt > now && sameSecret(l.hash, hash(token)));
			if (link === undefined) return s;
			email = link.email;
			return { ...s, links: s.links.map((l) => (l === link ? { ...l, usedAt: now } : l)) };
		});
		if (email === undefined) throw new HttpError(400, "Link non valido o scaduto: chiedine uno nuovo");
		const signedIn = email;
		try {
			const account = read().accounts.find((a) => a.email === signedIn) ?? (await createAccount(signedIn));
			const access = accessFor(account.tenant);
			// A tenant whose trial ended without a subscription gets the way to subscribe, and its cell stays asleep.
			const loginUrl = access === undefined || mayUse(access) ? await signInLink(account.tenant) : undefined;
			if (access === undefined) return { loginUrl: loginUrl as string };
			const wantsBilling = body.purpose === "billing" || loginUrl === undefined;
			return { ...(loginUrl === undefined ? {} : { loginUrl }), billing: { ...access, ...(wantsBilling ? await billingLinks(account.tenant, access, loginUrl !== undefined) : {}) } };
		} catch (error) {
			// Our failure, not the person's: the link works again for a retry.
			update((s) => ({ ...s, links: s.links.map((l) => (sameSecret(l.hash, hash(token)) ? { hash: l.hash, email: l.email, expiresAt: l.expiresAt } : l)) }));
			throw error;
		}
	}

	async function signInLink(tenant: string): Promise<string> {
		await ensureRunning(tenant);
		return `${publicUrl(`${tenant}.${options.domain}`)}/login#${await ownerLink(tenant)}`;
	}

	/** Stripe's pages for this tenant: subscribing while it has no subscription, the portal once it has a customer. */
	async function billingLinks(tenant: string, access: Access, canSignIn: boolean): Promise<{ checkoutUrl?: string; portalUrl?: string }> {
		if (billing === undefined) return {};
		const account = read().accounts.find((a) => a.tenant === tenant) as Account;
		const homeUrl = publicUrl(options.domain);
		try {
			const customerId = account.billing?.customerId;
			const subscribed = access.state === "active" || access.state === "past_due";
			return {
				...(subscribed ? {} : { checkoutUrl: await billing.checkout({ tenant, email: account.email, homeUrl, ...(customerId === undefined ? {} : { customerId }) }) }),
				...(customerId === undefined ? {} : { portalUrl: await billing.portal(customerId, homeUrl) }),
			};
		} catch (error) {
			// Stripe down: someone who may use Annie still gets in; someone who must subscribe tries again.
			if (!canSignIn) throw error;
			log(`cloud: billing links for ${tenant}: ${error instanceof Error ? error.message : String(error)}`);
			return {};
		}
	}

	function createAccount(email: string): Promise<Account> {
		const pending = creating.get(email);
		if (pending !== undefined) return pending;
		const work = (async () => {
			const tenant = tenantFor(email);
			const secret = randomBytes(32).toString("base64url");
			await options.provider.create(tenant, {
				...options.cellEnv,
				ANNIE_TENANT_ID: tenant,
				ANNIE_PUBLIC_URL: publicUrl(`${tenant}.${options.domain}`),
				ANNIE_CELL_SECRET: secret,
				// Google sends everyone back to one address, the control plane's, which passes the person on to their cell.
				...(options.cellEnv.ANNIE_GOOGLE_CLIENT_ID === undefined ? {} : { ANNIE_GOOGLE_REDIRECT_URL: `${publicUrl(options.domain)}/oauth/google/callback` }),
			});
			const account: Account = { email, tenant, createdAt: new Date().toISOString() };
			update((s) => ({ ...s, accounts: [...s.accounts, account], cells: [...s.cells, { tenant, secret, nextWakeAt: null }] }));
			log(`cloud: new tenant ${tenant}`);
			return account;
		})().finally(() => creating.delete(email));
		creating.set(email, work);
		return work;
	}

	async function ownerLink(tenant: string): Promise<string> {
		const response = await toCell(tenant, "/internal/owner-link", "POST");
		if (!response.ok) throw new Error(`Cell ${tenant} gave no owner link (${response.status})`);
		return ((await response.json()) as { token: string }).token;
	}

	// --- cells ---
	const cellOf = (tenant: string) => read().cells.find((c) => c.tenant === tenant);

	async function ensureRunning(tenant: string): Promise<void> {
		await stoppings.get(tenant)?.catch(() => {});
		if ((await options.provider.status(tenant)) !== "running") {
			await options.provider.start(tenant);
			log(`cloud: cell ${tenant} started`);
		}
		lastSeen.set(tenant, Date.now());
	}

	async function toCell(tenant: string, path: string, method: "GET" | "POST"): Promise<Response> {
		const cell = cellOf(tenant);
		if (cell === undefined) throw new Error(`No cell ${tenant}`);
		return fetch(`${await options.provider.baseUrl(tenant)}${path}`, { method, headers: { authorization: `Bearer ${cell.secret}` }, signal: AbortSignal.timeout(CELL_TIMEOUT_MS) });
	}

	let ticking: Promise<void> | undefined;
	/** One round at a time; cells in parallel, so a cell that hangs does not hold up the others. */
	function tick(now: Date): Promise<void> {
		if (ticking !== undefined) return ticking;
		ticking = Promise.allSettled(read().cells.map((cell) => tickCell(cell, now)))
			.then((results) => {
				for (const r of results) if (r.status === "rejected") log(`cloud: tick: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
			})
			.finally(() => {
				ticking = undefined;
			});
		return ticking;
	}

	async function tickCell(cell: Cell, now: Date): Promise<void> {
		const status = await options.provider.status(cell.tenant);
		if (status === "running") {
			if (billing?.meters && now.getTime() - Date.parse(cell.usage?.at ?? "1970-01-01") >= USAGE_EVERY_MS) {
				const reading = await cellState(cell.tenant);
				if (reading?.usage !== undefined) keepReading(cell.tenant, reading.usage);
			}
			const quiet = () => (open.get(cell.tenant) ?? 0) === 0 && now.getTime() - (lastSeen.get(cell.tenant) ?? 0) >= options.idleMs;
			if (!quiet()) return;
			const seen = lastSeen.get(cell.tenant);
			const state = await cellState(cell.tenant);
			// A request that came in while we asked keeps the cell up.
			if (state === undefined || state.busy || !quiet() || lastSeen.get(cell.tenant) !== seen) return;
			await stopCell(cell.tenant, state);
		} else if (status === "stopped" && cell.nextWakeAt !== null && Date.parse(cell.nextWakeAt) <= now.getTime() && !suspended(cell.tenant)) {
			await ensureRunning(cell.tenant);
			setNextWake(cell.tenant, null);
			lastSeen.set(cell.tenant, now.getTime());
		}
	}

	async function cellState(tenant: string): Promise<CellState | undefined> {
		return (await toCell(tenant, "/internal/cell", "GET")
			.then((r) => (r.ok ? r.json() : undefined))
			.catch(() => undefined)) as CellState | undefined;
	}

	/** Save when to wake it, then stop it; requests arriving meanwhile wait and wake it again. */
	function stopCell(tenant: string, state: CellState): Promise<void> {
		const stopping = (async () => {
			setNextWake(tenant, state.nextWakeAt, state.usage);
			await options.provider.stop(tenant);
			log(`cloud: cell ${tenant} stopped${state.nextWakeAt === null ? "" : `, wakes at ${state.nextWakeAt}`}`);
		})().finally(() => stoppings.delete(tenant));
		stoppings.set(tenant, stopping);
		return stopping;
	}

	function setNextWake(tenant: string, nextWakeAt: string | null, usage?: CellState["usage"]): void {
		update((s) => {
			const cells = s.cells.map((c) => (c.tenant === tenant ? { ...c, nextWakeAt } : c));
			return { ...s, cells: usage === undefined ? cells : keepUsage(cells, tenant, usage) };
		});
		if (usage !== undefined) void reportUsage(tenant);
	}

	function keepReading(tenant: string, usage: NonNullable<CellState["usage"]>): void {
		update((s) => ({ ...s, cells: keepUsage(s.cells, tenant, usage) }));
		void reportUsage(tenant);
	}

	// --- billing ---
	const reporting = new Map<string, Promise<void>>();
	/** Sends Stripe the model cost not sent yet, month by month; one tenant at a time, and a retry counts once. */
	function reportUsage(tenant: string): Promise<void> {
		if (!billing?.meters) return Promise.resolve();
		const run = (reporting.get(tenant) ?? Promise.resolve())
			.then(async () => {
				const state = read();
				const account = state.accounts.find((a) => a.tenant === tenant);
				const months = state.cells.find((c) => c.tenant === tenant)?.usage?.months ?? {};
				const customerId = account?.billing?.customerId;
				if (account === undefined || customerId === undefined || !["active", "trialing", "past_due"].includes(account.billing?.status ?? "")) return;
				const current = romeDayKey().slice(0, 7);
				for (const month of Object.keys(months).sort()) {
					const cents = Math.round((months[month] ?? 0) * 100);
					const sent = account.billing?.reportedCents?.[month] ?? 0;
					if (cents <= sent) continue;
					await billing.meterEvent({ customerId, cents: cents - sent, identifier: `${tenant}-${month}-${cents}`, at: meterTime(month, current) });
					updateBilling(tenant, (b) => ({ ...b, reportedCents: { ...b.reportedCents, [month]: Math.max(b.reportedCents?.[month] ?? 0, cents) } }));
				}
			})
			.catch((error: unknown) => log(`cloud: usage for ${tenant} not sent: ${error instanceof Error ? error.message : String(error)}`))
			.finally(() => {
				if (reporting.get(tenant) === run) reporting.delete(tenant);
			});
		reporting.set(tenant, run);
		return run;
	}

	function updateBilling(tenant: string, change: (billing: AccountBilling) => AccountBilling): void {
		update((s) => ({ ...s, accounts: s.accounts.map((a) => (a.tenant === tenant ? { ...a, billing: change(a.billing ?? {}) } : a)) }));
	}

	/**
	 * What Stripe tells: a finished checkout links the tenant to its customer and subscription;
	 * subscription events carry its status. Model cost from before the subscription stays in the
	 * trial: the months as they stand are marked as sent.
	 */
	function applyEvent(event: StripeEvent): void {
		const object = event.data.object;
		const str = (value: unknown) => (typeof value === "string" ? value : undefined);
		const accounts = read().accounts;
		if (event.type === "checkout.session.completed") {
			const tenant = str(object.client_reference_id);
			if (tenant === undefined || !accounts.some((a) => a.tenant === tenant)) return;
			const months = read().cells.find((c) => c.tenant === tenant)?.usage?.months ?? {};
			updateBilling(tenant, (b) => ({
				...b,
				...(str(object.customer) === undefined ? {} : { customerId: str(object.customer) }),
				...(str(object.subscription) === undefined ? {} : { subscriptionId: str(object.subscription) }),
				status: b.status ?? (object.payment_status === "unpaid" ? "incomplete" : "active"),
				reportedCents: b.customerId === undefined ? Object.fromEntries(Object.entries(months).map(([m, usd]) => [m, Math.round(usd * 100)])) : (b.reportedCents ?? {}),
			}));
			log(`cloud: ${tenant} subscribed`);
			return;
		}
		if (!event.type.startsWith("customer.subscription.")) return;
		const metadata = (object.metadata ?? {}) as Record<string, unknown>;
		const tenant = str(metadata.tenant) ?? accounts.find((a) => a.billing?.customerId !== undefined && a.billing.customerId === str(object.customer))?.tenant;
		if (tenant === undefined || !accounts.some((a) => a.tenant === tenant)) return;
		updateBilling(tenant, (b) => {
			// Stripe does not promise order: an event older than the one applied changes nothing.
			if ((b.eventAt ?? 0) > event.created) return b;
			return {
				...b,
				...(str(object.customer) === undefined ? {} : { customerId: str(object.customer) }),
				...(str(object.id) === undefined ? {} : { subscriptionId: str(object.id) }),
				status: event.type === "customer.subscription.deleted" ? "canceled" : (str(object.status) ?? b.status ?? "incomplete"),
				eventAt: event.created,
			};
		});
		log(`cloud: ${tenant} subscription ${event.type.slice("customer.subscription.".length)}`);
	}

	async function stripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (billing === undefined) return send(res, 404, { error: "Not found" });
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > MAX_WEBHOOK_BODY) return send(res, 413, { error: "Too large" });
			chunks.push(chunk);
		}
		let event: StripeEvent;
		try {
			event = billing.event(Buffer.concat(chunks), req.headers["stripe-signature"] as string | undefined);
		} catch (error) {
			if (error instanceof BillingRefused || error instanceof SyntaxError) return send(res, 400, { error: "Firma o evento non valido" });
			throw error;
		}
		applyEvent(event);
		send(res, 200, { received: true });
	}

	// --- HTTP ---
	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
		const url = new URL(req.url ?? "/", "http://cloud.local");
		if (host === options.domain) return home(req, res, url);
		if (host.endsWith(`.${options.domain}`)) {
			const tenant = host.slice(0, -(options.domain.length + 1));
			// An unknown tenant answers like a sleeping one: host names reveal nothing.
			if (cellOf(tenant) === undefined) return send(res, 503, SLEEPING);
			return proxy(tenant, req, res);
		}
		send(res, 404, { error: "Not found" });
	}

	async function home(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		securityHeaders(res);
		if (req.method === "GET" && url.pathname in UI) return serve(res, join(import.meta.dirname, "ui", UI[url.pathname] as string));
		if (req.method === "GET" && url.pathname in SHARED_UI) return serve(res, join(import.meta.dirname, "..", "web", "ui", SHARED_UI[url.pathname] as string));
		if (req.method === "GET" && /^\/fonts\/[a-z0-9-]+\.woff2$/.test(url.pathname)) return serve(res, join(import.meta.dirname, "..", "web", "ui", url.pathname));
		if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
		if (req.method === "GET" && url.pathname === "/api/info") return send(res, 200, { billing: billing !== undefined, ...(billing === undefined ? {} : { trialDays: billing.trialDays }) });
		if (req.method === "GET" && url.pathname === "/oauth/google/callback") return googleCallback(res, url);
		// Stripe signs its deliveries; that signature, not our header, is the check here.
		if (req.method === "POST" && url.pathname === "/stripe/webhook") return stripeWebhook(req, res);
		if (req.method !== "POST" || req.headers["x-annie"] !== "1") return send(res, 404, { error: "Not found" });
		try {
			if (url.pathname === "/api/signup") {
				await signup(await readJson(req), req.socket.remoteAddress ?? "");
				return send(res, 200, { ok: true });
			}
			if (url.pathname === "/api/verify") return send(res, 200, await verify(await readJson(req)));
			send(res, 404, { error: "Not found" });
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			log(`cloud: ${error instanceof Error ? error.message : String(error)}`);
			send(res, 500, { error: "Qualcosa non va: riprova tra poco" });
		}
	}

	/**
	 * Google's way back for every cell: the state starts with the tenant, set by its cell. The
	 * person goes straight to their console, which finishes the connection with its session
	 * (the same step a cell's own callback does), so a sleeping cell needs no waking for this.
	 */
	function googleCallback(res: ServerResponse, url: URL): void {
		const tenant = /^([a-z0-9]{1,63})~/.exec(url.searchParams.get("state") ?? "")?.[1];
		if (tenant === undefined || !read().accounts.some((a) => a.tenant === tenant)) return send(res, 404, { error: "Collegamento non valido: riprova dalla tua Annie" });
		res.writeHead(302, { location: `${publicUrl(`${tenant}.${options.domain}`)}/#/google?${googleReturnQuery(url)}`, "cache-control": "no-store" });
		res.end();
	}

	async function proxy(tenant: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = cellPath(req.url ?? "");
		// The cell's endpoints for the control plane are never reachable from outside, however
		// the path is spelled; anything but a plain "/path" target is refused too.
		if (path === undefined || /^\/internal(\/|$)/i.test(path.pathname)) return send(res, 404, { error: "Not found" });
		if (suspended(tenant)) {
			// The person is sent where they can subscribe; nothing reaches or wakes the cell.
			if (req.method === "GET" && String(req.headers.accept ?? "").includes("text/html")) {
				res.writeHead(302, { location: `${publicUrl(options.domain)}/?sospesa=1`, "cache-control": "no-store" });
				return void res.end();
			}
			return send(res, 402, { error: `Il periodo di prova è finito: attiva l'abbonamento da ${publicUrl(options.domain)}` });
		}
		const awake = (await options.provider.status(tenant)) === "running" && !stoppings.has(tenant);
		if (!awake && !mayWake(req, path.pathname)) return send(res, 503, SLEEPING);
		try {
			await ensureRunning(tenant);
		} catch (error) {
			log(`cloud: cell ${tenant} did not start: ${error instanceof Error ? error.message : String(error)}`);
			return send(res, 503, { error: "Annie si sta svegliando: riprova tra qualche secondo" });
		}
		const target = new URL(await options.provider.baseUrl(tenant));
		open.set(tenant, (open.get(tenant) ?? 0) + 1);
		const done = () => {
			open.set(tenant, Math.max(0, (open.get(tenant) ?? 1) - 1));
			lastSeen.set(tenant, Date.now());
		};
		// A cell on this host speaks http; one on a platform (Railway) is reached over https.
		const call = target.protocol === "https:" ? httpsRequest : request;
		const upstream = call({ host: target.hostname, port: target.port, method: req.method, path: `${path.pathname}${path.search}`, headers: forwardHeaders(req, tenant, target.host) }, (answer) => {
			res.writeHead(answer.statusCode ?? 502, withoutHopByHop(answer.headers));
			answer.pipe(res);
		});
		upstream.on("error", () => {
			if (!res.headersSent) send(res, 502, { error: "Annie non risponde: riprova tra poco" });
			else res.destroy();
		});
		res.once("close", () => {
			upstream.destroy();
			done();
		});
		req.pipe(upstream);
	}

	/** Headers for the cell: no credentials meant for the control plane, no hop-by-hop, our own forwarding facts. */
	function forwardHeaders(req: IncomingMessage, tenant: string, cellHost: string): Record<string, string | string[]> {
		const headers = withoutHopByHop(req.headers);
		for (const name of Object.keys(headers)) if (name === "authorization" || name.startsWith("x-forwarded-")) delete headers[name];
		// Host is the cell's own address (a platform routes by it); the public one goes in X-Forwarded-Host.
		return { ...headers, host: cellHost, "x-forwarded-host": `${tenant}.${options.domain}`, "x-forwarded-proto": options.publicScheme, "x-forwarded-for": req.socket.remoteAddress ?? "" };
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			log(`cloud: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) send(res, 500, { error: "Errore interno" });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.web.port, options.web.host, () => resolve());
	});
	const timer = options.tickMs > 0 ? setInterval(() => void tick(new Date()).catch((error: unknown) => log(`cloud: tick: ${String(error)}`)), options.tickMs) : undefined;

	return {
		server,
		tick,
		status: () => cloudStatus({ ...options, ...(billing === undefined ? {} : { trialDays: billing.trialDays }) }),
		async stop() {
			if (timer !== undefined) clearInterval(timer);
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			// Each running cell tells when to wake it before going down, so its tasks survive a restart.
			for (const id of await options.provider.list()) {
				if ((await options.provider.status(id)) !== "running") continue;
				const state = await cellState(id);
				if (state !== undefined) setNextWake(id, state.nextWakeAt, state.usage);
				await options.provider.stop(id);
			}
		},
	};
}

/**
 * Every tenant, its cell and its spend, for the operator. A running cell is asked (and what it
 * says is kept); a sleeping one shows what it said last, without being woken. Works beside a
 * running control plane: it only reads the state file and asks cells.
 */
export async function cloudStatus(options: { readonly dataDir: string; readonly provider: CellProvider; readonly trialDays?: number }): Promise<TenantStatus[]> {
	const file = join(options.dataDir, "control-plane.json");
	const state = readJsonFile<State>(file, EMPTY);
	const within = <T>(work: Promise<T>, fallback: T): Promise<T> =>
		Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), CELL_TIMEOUT_MS))]);
	return Promise.all(
		state.accounts.map(async (account) => {
			const cell = state.cells.find((c) => c.tenant === account.tenant);
			const now = await within<TenantStatus["cell"]>(options.provider.status(account.tenant), "missing");
			let usage = cell?.usage;
			if (now === "running" && cell !== undefined) {
				// A cell stopped meanwhile, or one that hangs, keeps its last reading.
				const fresh = await within(
					(async () => {
						const answer = await fetch(`${await options.provider.baseUrl(account.tenant)}/internal/cell`, { headers: { authorization: `Bearer ${cell.secret}` }, signal: AbortSignal.timeout(CELL_TIMEOUT_MS) });
						return answer.ok ? ((await answer.json()) as CellState) : undefined;
					})(),
					undefined,
				);
				if (fresh?.usage !== undefined) {
					const kept = updateJsonFile<State>(file, EMPTY, (s) => ({ ...s, cells: keepUsage(s.cells, account.tenant, fresh.usage as NonNullable<CellState["usage"]>) }));
					usage = kept.cells.find((c) => c.tenant === account.tenant)?.usage;
				}
			}
			const billing = options.trialDays === undefined ? null : { ...accessOf(account, state.billingSince ?? account.createdAt, options.trialDays), subscription: account.billing?.status ?? null };
			return { tenant: account.tenant, email: account.email, createdAt: account.createdAt, cell: now, nextWakeAt: cell?.nextWakeAt ?? null, spend: spendNow(usage), billing };
		}),
	);
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** A tenant id that is also a DNS label, random: the address of a cell does not show who it is. */
function tenantFor(_email: string): string {
	const letters = "abcdefghijkmnpqrstuvwxyz23456789";
	return `a${[...randomBytes(11)].map((b) => letters[b % letters.length]).join("")}`;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");


function securityHeaders(res: ServerResponse): void {
	res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("referrer-policy", "no-referrer");
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function serve(res: ServerResponse, path: string): Promise<void> {
	const data = await readFile(path);
	res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
	res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY) throw new HttpError(413, "Richiesta troppo grande");
		chunks.push(chunk);
	}
	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "JSON non valido");
	}
}

/** The normalized path of an origin-form request target ("/a/b?c"), or undefined for any other form. */
function cellPath(target: string): { pathname: string; search: string } | undefined {
	if (!target.startsWith("/") || target.startsWith("//")) return undefined;
	try {
		const url = new URL(target, "http://cell.invalid");
		return { pathname: url.pathname, search: url.search };
	} catch {
		return undefined;
	}
}

/**
 * A stopped cell wakes for its people (a session cookie), the sign-in link, and Telegram's
 * webhooks; an anonymous request does not, or anyone could keep any cell running.
 */
function mayWake(req: IncomingMessage, pathname: string): boolean {
	if (pathname.startsWith("/hooks/")) return true;
	// The sign-in link needs no wake: the control plane starts the cell before handing it out.
	return /(?:^|;\s*)annie_session=[\w-]{20,}/.test(String(req.headers.cookie ?? ""));
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function withoutHopByHop(headers: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
	return out;
}
