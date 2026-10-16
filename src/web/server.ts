import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { type ConnectorStatus, CONNECTOR_ID, type ConnectorStore, connectorEgressName, type McpConnector } from "../connectors/mcp.ts";
import { decideToolProposal, isApprover, NotAnApprover, OWNER, type Approver } from "../core/approvals.ts";
import { EgressDenied, NotFound, UserNotAllowed } from "../core/errors.ts";
import { instanceId } from "../core/ids.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { AnnieRuntime } from "../core/runtime.ts";
import { type Schedule, ScheduleError, schedulePerson } from "../core/schedules.ts";
import { DEFAULT_COST_CAPS, type UsageLedger } from "../core/usage.ts";
import { WorkspaceError } from "../core/workspace.ts";
import type { SegreteriaService } from "../segreteria/service.ts";
import { type PeopleStore, type Person, publicPerson, type SessionStore } from "./auth.ts";
import { WebChannel, type WebEvent } from "./channel.ts";

export type WebAppOptions = {
	readonly runtime: AnnieRuntime;
	readonly tenantId: string;
	readonly people: PeopleStore;
	readonly sessions: SessionStore;
	/** The web channel of each instance that has one. */
	readonly channels: ReadonlyMap<string, WebChannel>;
	readonly connectors: (instanceId: string) => ConnectorStore;
	readonly connectorStatus: (instanceId: string) => readonly ConnectorStatus[];
	readonly segreterie?: ReadonlyMap<string, SegreteriaService>;
	readonly usage: UsageLedger;
	readonly uiDir: string;
	/** Send cookies with Secure (behind https). */
	readonly secureCookies: boolean;
	readonly defaultTimeZone: string;
	/** Create an instance with its web channel, open for `ownerId` (owner only). */
	readonly createInstance?: (input: { id: string; name: string; instructions: string | undefined; ownerId: string }) => Promise<void>;
	readonly log?: (message: string) => void;
};

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

type Ctx = {
	readonly req: IncomingMessage;
	readonly res: ServerResponse;
	readonly url: URL;
	readonly params: string[];
	readonly person: Person | undefined;
};

type Handler = (ctx: Ctx) => Promise<unknown>;
type Route = { method: string; pattern: RegExp; auth: "none" | "person" | "owner"; handler: Handler };

const COOKIE = "annie_session";
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;

const STATIC: Record<string, string> = {
	"/": "index.html",
	"/index.html": "index.html",
	"/login": "index.html",
	"/app.js": "app.js",
	"/app.css": "app.css",
	"/icon.svg": "icon.svg",
	"/fonts/geist-latin.woff2": "fonts/geist-latin.woff2",
	"/fonts/geist-latin-ext.woff2": "fonts/geist-latin-ext.woff2",
	"/fonts/geist-mono-latin.woff2": "fonts/geist-mono-latin.woff2",
	"/fonts/geist-mono-latin-ext.woff2": "fonts/geist-mono-latin-ext.woff2",
};
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

/** The web console and web channel of one tenant. */
export function createWebApp(options: WebAppOptions): Server {
	const { runtime, tenantId } = options;
	const routes: Route[] = [];
	const route = (method: string, path: string, auth: Route["auth"], handler: Handler) =>
		routes.push({ method, pattern: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`), auth, handler });

	const instanceAccess = async (person: Person, instanceId: string) => {
		let record;
		try {
			record = await runtime.registry.getInstance(tenantId, instanceId);
		} catch {
			throw new HttpError(404, "No such instance");
		}
		const member = (record.allowedUsers.web ?? []).includes(person.id);
		if (person.role !== "owner" && !member) throw new HttpError(404, "No such instance");
		return { record, member };
	};
	// Open event streams, so a channel created later reaches them too.
	const streams = new Set<(channel: WebChannel) => void>();
	const approverOf = (person: Person): Approver => (person.role === "owner" ? OWNER : { channel: "web", userId: person.id });
	const channelOf = (instanceId: string) => {
		const channel = options.channels.get(instanceId);
		if (channel === undefined) throw new HttpError(409, "This instance has no web channel");
		return channel;
	};

	// --- session ---
	route("POST", "/api/login", "none", async ({ req, res }) => {
		const body = (await readJson(req)) as { token?: string };
		const person = await options.people.byToken(String(body.token ?? ""));
		if (person === undefined) throw new HttpError(401, "Link non valido o revocato");
		const session = await options.sessions.create(person.id);
		res.setHeader("set-cookie", `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}${options.secureCookies ? "; Secure" : ""}`);
		await runtime.audit(tenantId).append({ type: "web.login", personId: person.id });
		return { person: publicPerson(person) };
	});
	route("POST", "/api/logout", "person", async ({ req, res }) => {
		const session = cookie(req, COOKIE);
		if (session !== undefined) await options.sessions.end(session);
		res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
		return { ok: true };
	});
	route("GET", "/api/me", "person", async ({ person }) => ({ person: publicPerson(person as Person) }));

	// --- instances ---
	const describeInstance = async (r: InstanceRecord, p: Person) => ({
		id: r.id,
		name: r.name,
		canChat: options.channels.has(r.id) && (r.allowedUsers.web ?? []).includes(p.id) && r.egress.channels.includes("web"),
		isApprover: await isApprover(runtime, tenantId, r.id, approverOf(p)),
		hasSegreteria: options.segreterie?.has(r.id) ?? false,
	});
	route("GET", "/api/instances", "person", async ({ person }) => {
		const p = person as Person;
		const all = await runtime.registry.listInstances(tenantId);
		const visible = all.filter((r) => p.role === "owner" || (r.allowedUsers.web ?? []).includes(p.id));
		return { instances: await Promise.all(visible.map((r) => describeInstance(r, p))) };
	});
	route("POST", "/api/instances", "owner", async ({ person, req }) => {
		if (options.createInstance === undefined) throw new HttpError(501, "Questa installazione non crea istanze dalla console");
		const body = (await readJson(req)) as { id?: unknown; name?: unknown; instructions?: unknown };
		const id = typeof body.id === "string" ? body.id.trim() : "";
		const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
		const instructions = typeof body.instructions === "string" && body.instructions.trim() !== "" ? body.instructions.slice(0, 20_000) : undefined;
		try {
			instanceId(id);
		} catch {
			throw new HttpError(400, "ID non valido: minuscole, numeri, - e _, fino a 63 caratteri, iniziando con una lettera o un numero");
		}
		if (name === "") throw new HttpError(400, "Serve un nome");
		try {
			await runtime.registry.getInstance(tenantId, id);
			throw new HttpError(409, "Un'istanza con questo ID esiste già");
		} catch (error) {
			if (!(error instanceof NotFound)) throw error;
		}
		await options.createInstance({ id, name, instructions, ownerId: (person as Person).id });
		const channel = options.channels.get(id);
		if (channel !== undefined) for (const attach of streams) attach(channel);
		return { instance: await describeInstance(await runtime.registry.getInstance(tenantId, id), person as Person) };
	});

	// --- chat ---
	route("GET", "/api/instances/:id/threads", "person", async ({ person, params }) => {
		await instanceAccess(person as Person, params[0] as string);
		return { threads: await channelOf(params[0] as string).threads((person as Person).id) };
	});
	route("POST", "/api/instances/:id/threads", "person", async ({ person, params, req }) => {
		const { member } = await instanceAccess(person as Person, params[0] as string);
		if (!member) throw new HttpError(403, "Non sei tra le persone che possono scrivere a questa istanza");
		const body = (await readJson(req)) as { title?: string };
		return { thread: await channelOf(params[0] as string).createThread((person as Person).id, typeof body.title === "string" ? body.title : undefined) };
	});
	route("GET", "/api/instances/:id/threads/:thread", "person", async ({ person, params }) => {
		await instanceAccess(person as Person, params[0] as string);
		const channel = channelOf(params[0] as string);
		const thread = await channel.thread(params[1] as string);
		if (thread === undefined || thread.personId !== (person as Person).id) throw new HttpError(404, "No such thread");
		return { thread, entries: await channel.transcript(thread.id) };
	});
	route("POST", "/api/instances/:id/threads/:thread/messages", "person", async ({ person, params, req }) => {
		await instanceAccess(person as Person, params[0] as string);
		const body = (await readJson(req)) as { text?: string };
		const text = String(body.text ?? "").trim();
		if (text === "" || text.length > 20_000) throw new HttpError(400, "Messaggio vuoto o troppo lungo");
		try {
			return { entry: await channelOf(params[0] as string).post(params[1] as string, (person as Person).id, text) };
		} catch (error) {
			if (error instanceof UserNotAllowed) throw new HttpError(403, "Non sei tra le persone che possono scrivere a questa istanza");
			if (error instanceof EgressDenied) throw new HttpError(403, "Questa istanza non accetta messaggi dal web");
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});
	route("GET", "/api/events", "person", async ({ person, req, res }) => {
		const p = person as Person;
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		res.write(": connected\n\n");
		const listeners: [WebChannel, (e: WebEvent) => void][] = [];
		const attach = (channel: WebChannel) => {
			const listener = (event: WebEvent) => res.write(`event: entry\ndata: ${JSON.stringify(event)}\n\n`);
			channel.events.on(p.id, listener);
			listeners.push([channel, listener]);
		};
		for (const channel of options.channels.values()) attach(channel);
		streams.add(attach);
		const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
		await new Promise<void>((resolve) => req.on("close", resolve));
		clearInterval(ping);
		streams.delete(attach);
		for (const [channel, listener] of listeners) channel.events.off(p.id, listener);
		return STREAMED;
	});

	// --- files ---
	route("GET", "/api/instances/:id/files", "person", async ({ person, params }) => {
		await instanceAccess(person as Person, params[0] as string);
		return { files: await runtime.workspace(tenantId, params[0] as string).list() };
	});
	route("GET", "/api/instances/:id/files/raw", "person", async ({ person, params, url, res }) => {
		await instanceAccess(person as Person, params[0] as string);
		const path = url.searchParams.get("path") ?? "";
		const data = await workspaceCall(() => runtime.workspace(tenantId, params[0] as string).read(path));
		const name = path.split("/").at(-1) ?? "file";
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": data.length,
			"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
			"cache-control": "no-store",
		});
		res.end(data);
		return STREAMED;
	});
	route("PUT", "/api/instances/:id/files/raw", "person", async ({ person, params, url, req }) => {
		const { member } = await instanceAccess(person as Person, params[0] as string);
		if (!member && (person as Person).role !== "owner") throw new HttpError(403, "Forbidden");
		const name = (url.searchParams.get("name") ?? "file").replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
		const data = await readBody(req, MAX_UPLOAD);
		const file = await workspaceCall(() => runtime.workspace(tenantId, params[0] as string).write(`uploads/${name}`, data));
		await runtime.audit(tenantId).append({ type: "web.upload", instanceId: params[0], personId: (person as Person).id, path: file.path, bytes: file.size });
		return { file };
	});
	route("DELETE", "/api/instances/:id/files", "person", async ({ person, params, url }) => {
		await instanceAccess(person as Person, params[0] as string);
		if ((person as Person).role !== "owner") throw new HttpError(403, "Solo l'owner può eliminare file da qui");
		await workspaceCall(() => runtime.workspace(tenantId, params[0] as string).remove(url.searchParams.get("path") ?? ""));
		return { ok: true };
	});

	// --- tasks programmati ---
	route("GET", "/api/instances/:id/schedules", "person", async ({ person, params }) => {
		const p = person as Person;
		await instanceAccess(p, params[0] as string);
		const all = await runtime.schedules(tenantId, params[0] as string).list();
		// A member sees the tasks that act for them; the owner sees all.
		return { schedules: p.role === "owner" ? all : all.filter((s) => mine(s, p)) };
	});
	route("POST", "/api/instances/:id/schedules", "person", async ({ person, params, req }) => {
		const p = person as Person;
		await instanceAccess(p, params[0] as string);
		const body = (await readJson(req)) as { instruction?: string; at?: string; cron?: string; timeZone?: string; threadId?: string };
		const thread = await channelOf(params[0] as string).thread(String(body.threadId ?? ""));
		if (thread === undefined || thread.personId !== p.id) throw new HttpError(400, "Scegli una tua chat dove ricevere i risultati");
		try {
			const schedule = await runtime.schedules(tenantId, params[0] as string).create({
				instruction: String(body.instruction ?? ""),
				channel: "web",
				threadId: thread.id,
				when: body.cron ? { cron: body.cron, timeZone: body.timeZone || options.defaultTimeZone } : { at: String(body.at ?? "") },
				createdBy: { kind: "person", channel: "web", userId: p.id },
			});
			return { schedule };
		} catch (error) {
			if (error instanceof ScheduleError) throw new HttpError(400, error.message);
			throw error;
		}
	});
	route("DELETE", "/api/instances/:id/schedules/:sid", "person", async ({ person, params }) => {
		const p = person as Person;
		await instanceAccess(p, params[0] as string);
		const store = runtime.schedules(tenantId, params[0] as string);
		const schedule = await store.get(params[1] as string);
		if (schedule === undefined || (p.role !== "owner" && !mine(schedule, p))) throw new HttpError(404, "No such task");
		return { removed: await store.remove(schedule.id) };
	});

	// --- tools proposti ---
	route("GET", "/api/instances/:id/proposals", "person", async ({ person, params }) => {
		await instanceAccess(person as Person, params[0] as string);
		return { proposals: await runtime.proposals(tenantId, params[0] as string).list() };
	});
	route("POST", "/api/instances/:id/proposals/:pid/decision", "person", async ({ person, params, req }) => {
		await instanceAccess(person as Person, params[0] as string);
		const body = (await readJson(req)) as { decision?: string };
		if (body.decision !== "approved" && body.decision !== "rejected") throw new HttpError(400, "decision: approved | rejected");
		try {
			return { proposal: await decideToolProposal(runtime, tenantId, params[0] as string, params[1] as string, body.decision, approverOf(person as Person)) };
		} catch (error) {
			if (error instanceof NotAnApprover) throw new HttpError(403, "Non sei un approvatore di questa istanza");
			throw error;
		}
	});

	// --- segreteria ---
	route("GET", "/api/instances/:id/pratiche", "person", async ({ person, params }) => {
		await instanceAccess(person as Person, params[0] as string);
		const service = options.segreterie?.get(params[0] as string);
		if (service === undefined) throw new HttpError(404, "Questa istanza non è una segreteria");
		const all = await service.practices.list();
		return { pratiche: all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ mail: _mail, ...p }) => p) };
	});
	route("POST", "/api/instances/:id/pratiche/:pid/action", "person", async ({ person, params, req }) => {
		const p = person as Person;
		await instanceAccess(p, params[0] as string);
		const service = options.segreterie?.get(params[0] as string);
		if (service === undefined) throw new HttpError(404, "Questa istanza non è una segreteria");
		if (!(await isApprover(runtime, tenantId, params[0] as string, approverOf(p)))) throw new HttpError(403, "Non sei un approvatore di questa istanza");
		const body = (await readJson(req)) as { action?: string; text?: string; requestId?: string; draftVersion?: number };
		if (body.action !== "approve" && body.action !== "edit" && body.action !== "discard") throw new HttpError(400, "action: approve | edit | discard");
		const result = await service.act({ userId: `web:${p.id}` }, params[1] as string, body.action, {
			...(typeof body.text === "string" ? { text: body.text } : {}),
			...(typeof body.draftVersion === "number" ? { draftVersion: body.draftVersion } : {}),
			actionId: typeof body.requestId === "string" ? body.requestId.slice(0, 80) : randomUUID(),
		});
		return { result: result.kind === "handled" ? { kind: "handled", sent: result.sent, status: result.pratica.status } : result };
	});

	// --- owner: connectors, settings, people, audit ---
	route("GET", "/api/instances/:id/connectors", "owner", async ({ params }) => {
		const list = await options.connectors(params[0] as string).list();
		const status = options.connectorStatus(params[0] as string);
		const record = await runtime.registry.getInstance(tenantId, params[0] as string);
		return { connectors: list.map((c) => ({ ...c, allowed: (record.egress.connectors ?? []).includes(connectorEgressName(c.id)), status: status.find((s) => s.id === c.id) })) };
	});
	route("PUT", "/api/instances/:id/connectors/:cid", "owner", async ({ params, req }) => {
		const body = (await readJson(req)) as Partial<McpConnector> & { allowed?: boolean };
		const id = params[1] as string;
		if (!CONNECTOR_ID.test(id)) throw new HttpError(400, "ID: lettere minuscole, cifre e trattini");
		const connector: McpConnector = { id, name: String(body.name ?? id), transport: body.transport as McpConnector["transport"], enabled: body.enabled !== false };
		if (connector.transport?.type !== "http" && connector.transport?.type !== "stdio") throw new HttpError(400, "transport: http | stdio");
		try {
			await options.connectors(params[0] as string).save(connector);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		const record = await runtime.registry.getInstance(tenantId, params[0] as string);
		const name = connectorEgressName(id);
		const current = record.egress.connectors ?? [];
		const allowed = body.allowed !== false;
		const next = allowed ? [...new Set([...current, name])] : current.filter((c) => c !== name);
		if (next.join() !== current.join()) await runtime.registry.setEgress(tenantId, params[0] as string, { ...record.egress, connectors: next });
		await runtime.audit(tenantId).append({ type: "connector.saved", instanceId: params[0], connector: id, transport: connector.transport.type, allowed });
		await runtime.reopen(tenantId, params[0] as string);
		return { status: options.connectorStatus(params[0] as string).find((s) => s.id === id) };
	});
	route("DELETE", "/api/instances/:id/connectors/:cid", "owner", async ({ params }) => {
		const removed = await options.connectors(params[0] as string).remove(params[1] as string);
		const record = await runtime.registry.getInstance(tenantId, params[0] as string);
		const name = connectorEgressName(params[1] as string);
		if ((record.egress.connectors ?? []).includes(name)) await runtime.registry.setEgress(tenantId, params[0] as string, { ...record.egress, connectors: (record.egress.connectors ?? []).filter((c) => c !== name) });
		await runtime.reopen(tenantId, params[0] as string);
		return { removed };
	});
	route("PUT", "/api/instances/:id/secrets/:name", "owner", async ({ params, req }) => {
		const name = params[1] as string;
		if (!/^connector\.[a-z0-9-]{1,24}\.[a-zA-Z0-9_.-]{1,40}$/.test(name)) throw new HttpError(400, "Nome segreto: connector.<id>.<nome>");
		const body = (await readJson(req)) as { value?: string };
		if (typeof body.value !== "string" || body.value === "") throw new HttpError(400, "Valore mancante");
		await runtime.secrets(tenantId).set(name, body.value);
		await runtime.audit(tenantId).append({ type: "secret.set", instanceId: params[0], name });
		return { ok: true };
	});
	route("GET", "/api/instances/:id/settings", "owner", async ({ params }) => {
		const r = await runtime.registry.getInstance(tenantId, params[0] as string);
		return { settings: { name: r.name, instructions: r.instructions ?? "", model: r.model, egress: r.egress, allowedUsers: r.allowedUsers, approvers: r.approvers ?? {} } };
	});
	route("PUT", "/api/instances/:id/settings", "owner", async ({ params, req }) => {
		const body = (await readJson(req)) as { name?: string; instructions?: string; webPeople?: string[]; webApprovers?: string[] };
		const id = params[0] as string;
		const people = new Set((await options.people.list()).map((p) => p.id));
		const pick = (list: unknown) => (Array.isArray(list) ? list.map(String).filter((x) => people.has(x)) : undefined);
		const record = await runtime.registry.getInstance(tenantId, id);
		const webPeople = pick(body.webPeople);
		const webApprovers = pick(body.webApprovers);
		if (webPeople !== undefined) {
			await runtime.registry.setAllowedUsers(tenantId, id, "web", webPeople);
			if (!record.egress.channels.includes("web")) await runtime.registry.setEgress(tenantId, id, { ...record.egress, channels: [...record.egress.channels, "web"] });
		}
		await runtime.registry.updateInstance(tenantId, id, {
			...(typeof body.name === "string" ? { name: body.name.slice(0, 80) } : {}),
			...(typeof body.instructions === "string" ? { instructions: body.instructions.slice(0, 20_000) || null } : {}),
			...(webApprovers === undefined ? {} : { approvers: { ...(record.approvers ?? {}), web: webApprovers } }),
		});
		await runtime.reopen(tenantId, id);
		return { ok: true };
	});
	route("GET", "/api/people", "owner", async () => ({ people: (await options.people.list()).map(publicPerson) }));
	route("POST", "/api/people", "owner", async ({ req, url }) => {
		const body = (await readJson(req)) as { name?: string; role?: string };
		try {
			const { person, token } = await options.people.add(String(body.name ?? ""), body.role === "owner" ? "owner" : "member");
			await runtime.audit(tenantId).append({ type: "person.created", personId: person.id, role: person.role });
			return { person: publicPerson(person), link: loginLink(url, token) };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});
	route("POST", "/api/people/:pid/link", "owner", async ({ params, url }) => {
		const token = await options.people.rotate(params[0] as string).catch(() => {
			throw new HttpError(404, "No such person");
		});
		await options.sessions.endAllOf(params[0] as string);
		await runtime.audit(tenantId).append({ type: "person.link_rotated", personId: params[0] });
		return { link: loginLink(url, token) };
	});
	route("DELETE", "/api/people/:pid", "owner", async ({ params, person }) => {
		if (params[0] === (person as Person).id) throw new HttpError(400, "Non puoi eliminare te stesso");
		const removed = await options.people.remove(params[0] as string);
		await options.sessions.endAllOf(params[0] as string);
		await runtime.audit(tenantId).append({ type: "person.removed", personId: params[0] });
		return { removed };
	});
	route("GET", "/api/usage", "person", async () => ({ usage: { todayUsd: await options.usage.todaySpent(), softUsd: DEFAULT_COST_CAPS.softUsdPerDay, hardUsd: DEFAULT_COST_CAPS.hardUsdPerDay } }));
	route("GET", "/api/audit", "owner", async ({ url }) => {
		const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
		const all = await runtime.audit(tenantId).read();
		return { events: all.slice(-limit).reverse() };
	});

	const server = createServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			options.log?.(`web: ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) send(res, 500, { error: "Errore interno" });
			else res.end();
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		securityHeaders(res);
		const url = new URL(req.url ?? "/", "http://annie.local");
		if (req.method === "GET" && url.pathname in STATIC) return serveStatic(res, STATIC[url.pathname] as string);
		if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
		if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
		const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
		if (match === undefined) return send(res, 404, { error: "Not found" });
		// A header a cross-site form or image cannot send: every change needs it.
		if (req.method !== "GET" && req.headers["x-annie"] !== "1") return send(res, 403, { error: "Missing X-Annie header" });
		let person: Person | undefined;
		if (match.auth !== "none") {
			const personId = await options.sessions.personOf(cookie(req, COOKIE));
			person = personId === undefined ? undefined : await options.people.get(personId);
			if (person === undefined) return send(res, 401, { error: "Accesso richiesto" });
			if (match.auth === "owner" && person.role !== "owner") return send(res, 403, { error: "Solo l'owner" });
		}
		const params = (match.pattern.exec(url.pathname) ?? []).slice(1).map((p) => decodeURIComponent(p));
		try {
			const result = await match.handler({ req, res, url, params, person });
			if (result !== STREAMED) send(res, 200, result);
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			throw error;
		}
	}

	async function serveStatic(res: ServerResponse, name: string): Promise<void> {
		const data = await readFile(join(options.uiDir, name));
		res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "cache-control": name === "index.html" ? "no-store" : name.startsWith("fonts/") ? "public, max-age=31536000, immutable" : "public, max-age=300" });
		res.end(data);
	}

	return server;
}

const STREAMED = Symbol("streamed");

/** A task that acts for this person on the web (they created it, or it writes to their thread). */
function mine(schedule: Schedule, person: Person): boolean {
	const who = schedulePerson(schedule);
	return who?.channel === "web" && who.userId === person.id;
}

function securityHeaders(res: ServerResponse): void {
	res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("referrer-policy", "no-referrer");
	res.setHeader("x-frame-options", "DENY");
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store" });
	res.end(data);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return undefined;
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > max) throw new HttpError(413, `Troppo grande: oltre ${max} byte`);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const data = await readBody(req, MAX_JSON);
	if (data.length === 0) return {};
	try {
		const value: unknown = JSON.parse(data.toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "JSON non valido");
	}
}

async function workspaceCall<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof WorkspaceError) throw new HttpError(error.message.startsWith("File not found") ? 404 : 400, error.message);
		throw error;
	}
}

/** Relative: the console prefixes its own origin (Annie may sit behind a proxy). */
function loginLink(_url: URL, token: string): string {
	return `/login#${token}`;
}
