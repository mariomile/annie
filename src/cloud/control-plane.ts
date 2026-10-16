import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { readJsonFile, updateJsonFile } from "../web/locked-json.ts";
import type { Mailer } from "./mailer.ts";
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
	readonly log?: (message: string) => void;
};

export type ControlPlane = {
	readonly server: Server;
	/** Stop idle cells, wake the ones whose next task is due. */
	tick(now: Date): Promise<void>;
	stop(): Promise<void>;
};

type Account = { readonly email: string; readonly tenant: string; readonly createdAt: string };
type Cell = { readonly tenant: string; readonly secret: string; readonly nextWakeAt: string | null };
type PendingLink = { readonly hash: string; readonly email: string; readonly expiresAt: number; readonly usedAt?: number };
type State = { accounts: Account[]; cells: Cell[]; links: PendingLink[] };

const EMPTY: State = { accounts: [], cells: [], links: [] };
const LINK_TTL_MS = 30 * 60 * 1000;
const LINKS_PER_HOUR = 5;
const MAX_BODY = 64 * 1024;
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
	const port = options.publicPort === undefined ? "" : `:${options.publicPort}`;
	const publicUrl = (host: string) => `${options.publicScheme}://${host}${port}`;

	// --- sign-up and sign-in ---
	async function signup(body: { email?: unknown }): Promise<void> {
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		if (!EMAIL.test(email)) throw new HttpError(400, "Indirizzo email non valido");
		const now = Date.now();
		if (read().links.filter((l) => l.email === email && l.expiresAt - LINK_TTL_MS > now - 3_600_000).length >= LINKS_PER_HOUR) throw new HttpError(429, "Troppi link chiesti: riprova tra un'ora");
		const token = randomBytes(32).toString("base64url");
		update((s) => ({ ...s, links: [...s.links.filter((l) => l.expiresAt > now - 3_600_000), { hash: hash(token), email, expiresAt: now + LINK_TTL_MS }] }));
		await options.mailer.send({
			to: email,
			subject: "Entra in Annie",
			text: `Per entrare in Annie apri questo link entro 30 minuti:\n\n${publicUrl(options.domain)}/verify#${token}\n\nSe non l'hai chiesto tu, ignora questa mail.`,
		});
	}

	async function verify(body: { token?: unknown }): Promise<{ loginUrl: string }> {
		const token = typeof body.token === "string" ? body.token : "";
		const now = Date.now();
		let email: string | undefined;
		// Used up under the lock: the same link cannot sign in twice.
		update((s) => {
			const link = s.links.find((l) => l.usedAt === undefined && l.expiresAt > now && sameHash(l.hash, hash(token)));
			if (link === undefined) return s;
			email = link.email;
			return { ...s, links: s.links.map((l) => (l === link ? { ...l, usedAt: now } : l)) };
		});
		if (email === undefined) throw new HttpError(400, "Link non valido o scaduto: chiedine uno nuovo");
		const account = read().accounts.find((a) => a.email === email) ?? (await createAccount(email));
		await ensureRunning(account.tenant);
		const ownerToken = await ownerLink(account.tenant);
		return { loginUrl: `${publicUrl(`${account.tenant}.${options.domain}`)}/login#${ownerToken}` };
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
				ANNIE_OWNER_TOKEN: randomBytes(32).toString("base64url"),
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
		if ((await options.provider.status(tenant)) !== "running") {
			await options.provider.start(tenant);
			log(`cloud: cell ${tenant} started`);
		}
		lastSeen.set(tenant, Date.now());
	}

	async function toCell(tenant: string, path: string, method: "GET" | "POST"): Promise<Response> {
		const cell = cellOf(tenant);
		if (cell === undefined) throw new Error(`No cell ${tenant}`);
		return fetch(`${await options.provider.baseUrl(tenant)}${path}`, { method, headers: { authorization: `Bearer ${cell.secret}` } });
	}

	async function tick(now: Date): Promise<void> {
		for (const cell of read().cells) {
			const status = await options.provider.status(cell.tenant);
			if (status === "running") {
				const idleFor = now.getTime() - (lastSeen.get(cell.tenant) ?? 0);
				if ((open.get(cell.tenant) ?? 0) > 0 || idleFor < options.idleMs) continue;
				const state = (await toCell(cell.tenant, "/internal/cell", "GET")
					.then((r) => r.json())
					.catch(() => undefined)) as { busy: boolean; nextWakeAt: string | null } | undefined;
				if (state === undefined || state.busy) continue;
				update((s) => ({ ...s, cells: s.cells.map((c) => (c.tenant === cell.tenant ? { ...c, nextWakeAt: state.nextWakeAt } : c)) }));
				await options.provider.stop(cell.tenant);
				log(`cloud: cell ${cell.tenant} stopped${state.nextWakeAt === null ? "" : `, wakes at ${state.nextWakeAt}`}`);
			} else if (status === "stopped" && cell.nextWakeAt !== null && Date.parse(cell.nextWakeAt) <= now.getTime()) {
				update((s) => ({ ...s, cells: s.cells.map((c) => (c.tenant === cell.tenant ? { ...c, nextWakeAt: null } : c)) }));
				await ensureRunning(cell.tenant);
				lastSeen.set(cell.tenant, now.getTime());
			}
		}
	}

	// --- HTTP ---
	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
		const url = new URL(req.url ?? "/", "http://cloud.local");
		if (host === options.domain) return home(req, res, url);
		if (host.endsWith(`.${options.domain}`)) {
			const tenant = host.slice(0, -(options.domain.length + 1));
			if (cellOf(tenant) === undefined) return send(res, 404, { error: "Not found" });
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
		if (req.method !== "POST" || req.headers["x-annie"] !== "1") return send(res, 404, { error: "Not found" });
		try {
			if (url.pathname === "/api/signup") {
				await signup(await readJson(req));
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

	async function proxy(tenant: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			await ensureRunning(tenant);
		} catch (error) {
			log(`cloud: cell ${tenant} did not start: ${error instanceof Error ? error.message : String(error)}`);
			return send(res, 503, { error: "Annie si sta svegliando: riprova tra qualche secondo" });
		}
		// The cell's own control-plane endpoints are never reachable from outside.
		if ((req.url ?? "").startsWith("/internal/")) return send(res, 404, { error: "Not found" });
		const target = new URL(await options.provider.baseUrl(tenant));
		open.set(tenant, (open.get(tenant) ?? 0) + 1);
		const done = () => {
			open.set(tenant, Math.max(0, (open.get(tenant) ?? 1) - 1));
			lastSeen.set(tenant, Date.now());
		};
		const headers = { ...req.headers, host: `${tenant}.${options.domain}`, "x-forwarded-proto": options.publicScheme };
		const upstream = request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (answer) => {
			res.writeHead(answer.statusCode ?? 502, answer.headers);
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
		async stop() {
			if (timer !== undefined) clearInterval(timer);
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			for (const id of await options.provider.list()) await options.provider.stop(id);
		},
	};
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** A tenant id that is also a DNS label: from the address's name, plus random characters. */
function tenantFor(email: string): string {
	const name = (email.split("@")[0] ?? "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "annie";
	return `${name}-${randomBytes(3).toString("hex")}`;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function sameHash(a: string, b: string): boolean {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && timingSafeEqual(x, y);
}

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
