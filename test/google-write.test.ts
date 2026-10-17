import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { GOOGLE_SCOPE, GOOGLE_WRITE_SCOPE } from "../src/connectors/google.ts";
import { GoogleActionStore, mimeMessage } from "../src/core/google-actions.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const running: RunningAnnie[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

const READ = `openid email ${GOOGLE_SCOPE.gmail} ${GOOGLE_SCOPE.calendar}`;
const ALL = `${READ} ${GOOGLE_WRITE_SCOPE.gmail} ${GOOGLE_WRITE_SCOPE.calendar}`;
const b64 = (text: string) => Buffer.from(text).toString("base64url");

type Call = { method: string; url: URL; body: string };

/** Fake Google that also takes writes: every call recorded; `fail` makes the next write answer that status. */
function fakeGoogle() {
	const calls: Call[] = [];
	const state = { fail: 0, down: false };
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = init?.body === undefined ? "" : String(init.body);
		calls.push({ method, url, body });
		if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
			const form = new URLSearchParams(body);
			if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: "at", refresh_token: `rt-${form.get("code")}`, scope: form.get("code") === "readonly" ? READ : ALL, expires_in: 3600 });
			return Response.json({ access_token: `at-${form.get("refresh_token")}`, expires_in: 3600 });
		}
		if (url.hostname === "openidconnect.googleapis.com") return Response.json({ email: "anna@example.com" });
		if (method !== "GET") {
			if (state.down) throw new TypeError("fetch failed");
			if (state.fail !== 0) {
				const status = state.fail;
				state.fail = 0;
				return Response.json({ error: { message: "nope" } }, { status });
			}
		}
		if (url.pathname === "/gmail/v1/users/me/messages/m1")
			return Response.json({
				id: "m1",
				threadId: "t1",
				snippet: "Ci mandate il preventivo?",
				payload: {
					headers: [
						{ name: "From", value: "Rossi <rossi@cliente.it>" },
						{ name: "Subject", value: "Preventivo" },
						{ name: "Message-ID", value: "<abc@cliente.it>" },
						{ name: "Date", value: "Thu, 15 Oct 2026 09:00:00 +0200" },
					],
				},
			});
		if (url.pathname === "/gmail/v1/users/me/messages/send" && method === "POST") return Response.json({ id: "sent1", threadId: "t1" });
		if (url.pathname === "/gmail/v1/users/me/drafts" && method === "POST") return Response.json({ id: "d1" });
		if (url.pathname === "/calendar/v3/calendars/primary/events" && method === "POST") return Response.json({ id: "new1", htmlLink: "https://www.google.com/calendar/event?eid=new1" });
		if (url.pathname === "/calendar/v3/calendars/primary/events/e1") {
			if (method === "GET") return Response.json({ id: "e1", summary: "Call con Rossi", start: { dateTime: "2026-10-16T10:00:00+02:00" }, end: { dateTime: "2026-10-16T10:30:00+02:00" } });
			if (method === "PATCH") return Response.json({ id: "e1", htmlLink: "https://www.google.com/calendar/event?eid=e1" });
			if (method === "DELETE") return new Response(null, { status: 204 });
		}
		if (url.pathname === "/calendar/v3/calendars/primary/events") return Response.json({ items: [{ id: "e1", summary: "Call con Rossi", start: { dateTime: "2026-10-16T10:00:00+02:00" }, end: { dateTime: "2026-10-16T10:30:00+02:00" } }] });
		return Response.json({ error: "not found" }, { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, calls, state, writes: () => calls.filter((c) => c.method !== "GET" && c.url.hostname !== "oauth2.googleapis.com") };
}

const ENV = { ANNIE_GOOGLE_CLIENT_ID: "client-1", ANNIE_GOOGLE_CLIENT_SECRET: "secret-1", ANNIE_GOOGLE_WRITE: "1" };

async function boot(dataDir = tempDataDir(), google = fakeGoogle(), env: Record<string, string> = ENV) {
	const config = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ...env });
	const annie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { googleFetch: google.fetch, schedulerIntervalMs: 60_000, log: () => {} });
	running.push(annie);
	return { annie, base: `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`, google, dataDir };
}

async function client(base: string, link: string) {
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	return async (path: string, body?: unknown, method?: string) => {
		const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		// biome-ignore lint: test
		return { status: res.status, ...((await res.json()) as any) };
	};
}
type Api = Awaited<ReturnType<typeof client>>;

async function connect(base: string, api: Api, code = "good") {
	const { url } = await api("/api/google/start", {});
	const state = new URL(url).searchParams.get("state") as string;
	return { url: new URL(url), done: await api("/api/google/finish", { state, code }) };
}

async function annieSays(api: Api, threadId: string, match: (text: string) => boolean): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < 10_000) {
		const entries = (await api(`/api/instances/annie/threads/${threadId}`)).entries as { from: string; text?: string }[];
		const found = entries.filter((e) => e.from === "annie" && match(e.text ?? "")).at(-1);
		if (found !== undefined) return found.text ?? "";
		await new Promise((r) => setTimeout(r, 30));
	}
	throw new Error("no such reply");
}

async function reply(api: Api, threadId: string, text: string): Promise<string> {
	const before = ((await api(`/api/instances/annie/threads/${threadId}`)).entries as { from: string }[]).filter((e) => e.from === "annie").length;
	await api(`/api/instances/annie/threads/${threadId}/messages`, { text });
	const start = Date.now();
	while (Date.now() - start < 10_000) {
		const answers = ((await api(`/api/instances/annie/threads/${threadId}`)).entries as { from: string; text?: string }[]).filter((e) => e.from === "annie");
		if (answers.length > before) return answers.at(-1)?.text ?? "";
		await new Promise((r) => setTimeout(r, 30));
	}
	throw new Error("no reply");
}

/** The owner, connected to Google with write access, on an instance that allows Google, in a new thread. */
async function ready(env: Record<string, string> = ENV) {
	const booted = await boot(tempDataDir(), fakeGoogle(), env);
	const owner = await client(booted.base, booted.annie.ownerLink as string);
	await connect(booted.base, owner);
	await owner("/api/instances/annie/google", { allowed: true }, "PUT");
	const thread = (await owner("/api/instances/annie/threads", {})).thread as { id: string };
	return { ...booted, owner, thread };
}

const tool = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;
const rawOf = (call: Call | undefined) => Buffer.from((JSON.parse(call?.body ?? "{}").raw ?? JSON.parse(call?.body ?? "{}").message?.raw) as string, "base64url").toString("utf8");

describe("Google: scrivere con approvazione", () => {
	it("with ANNIE_GOOGLE_WRITE Annie asks to compose mail and edit events; an account connected read only is asked to reconnect", async () => {
		const { annie, base } = await boot();
		const owner = await client(base, annie.ownerLink as string);
		const { url } = await connect(base, owner, "readonly");
		expect(url.searchParams.get("scope")).toBe(ALL);
		// Google gave fewer permissions than asked: the account is refused, as before.
		expect((await connect(base, owner, "readonly")).done.status).toBe(400);
		expect((await owner("/api/google")).write).toBe(true);
		await connect(base, owner, "good");
		expect((await owner("/api/google")).account.canWrite).toBe(true);
		expect(() => loadAnnieConfig({ ANNIE_MODEL_PROVIDER: "faux", ...ENV, ANNIE_GOOGLE_WRITE: "maybe" })).toThrow(/ANNIE_GOOGLE_WRITE/);
	});

	it("a mail is sent only after the person approves it, once, with the exact text shown; the audit keeps no content", async () => {
		const { owner, thread, google, dataDir } = await ready();
		const asked = await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "Riunione è confermata", body: "Ciao Luca,\nconfermo giovedì alle 10.\nAnna", reason: "Conferma della riunione a Luca" }));
		expect(asked).toMatch(/Richiesta [0-9a-f]{12} pronta/);
		expect(google.writes()).toEqual([]);
		const { actions } = await owner("/api/instances/annie/google-actions");
		expect(actions).toHaveLength(1);
		const action = actions[0];
		expect(action).toMatchObject({ kind: "mail.send", status: "pending", account: "anna@example.com", thread: { channel: "web", threadId: thread.id }, mail: { to: ["luca@example.com"], cc: [], subject: "Riunione è confermata" } });
		const decided = await owner(`/api/instances/annie/google-actions/${action.id}/decision`, { decision: "approved" });
		expect(decided.action.status).toBe("done");
		const sends = google.writes();
		expect(sends.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /gmail/v1/users/me/messages/send"]);
		const raw = rawOf(sends[0]);
		expect(raw).toContain("To: luca@example.com\r\n");
		expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Riunione è confermata").toString("base64")}?=\r\n`);
		expect(Buffer.from(raw.split("\r\n\r\n")[1] as string, "base64").toString("utf8")).toBe("Ciao Luca,\nconfermo giovedì alle 10.\nAnna");
		// Twice is nothing more.
		expect((await owner(`/api/instances/annie/google-actions/${action.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		expect(google.writes()).toHaveLength(1);
		// The conversation hears how it went.
		expect(await annieSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${action.id}`))).toContain("inviata");
		const audit = readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8");
		expect(audit).toMatch(/google_action\.approved[\s\S]*google_action\.done/);
		for (const secret of ["luca@example.com", "Riunione", "giovedì", "anna@example.com"]) expect(audit).not.toContain(secret);
	});

	it("a reply goes to the sender, in the same Gmail thread; a draft is only saved", async () => {
		const { owner, thread, google } = await ready();
		await reply(owner, thread.id, tool("google_mail_send", { reply_to: "m1", body: "Ve lo mandiamo venerdì.", reason: "Risposta a Rossi" }));
		const [replyAction] = (await owner("/api/instances/annie/google-actions")).actions;
		expect(replyAction.mail).toMatchObject({ to: ["rossi@cliente.it"], subject: "Re: Preventivo" });
		await owner(`/api/instances/annie/google-actions/${replyAction.id}/decision`, { decision: "approved" });
		const sent = google.writes()[0];
		expect(JSON.parse(sent?.body ?? "{}").threadId).toBe("t1");
		expect(rawOf(sent)).toContain("In-Reply-To: <abc@cliente.it>\r\nReferences: <abc@cliente.it>\r\n");
		await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "Bozza", body: "Da rivedere", draft: true, reason: "Bozza per Luca" }));
		const draft = (await owner("/api/instances/annie/google-actions")).actions.find((a: { kind: string }) => a.kind === "mail.draft");
		expect((await owner(`/api/instances/annie/google-actions/${draft.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		expect(google.writes().at(-1)?.url.pathname).toBe("/gmail/v1/users/me/drafts");
		expect(rawOf(google.writes().at(-1))).toContain("To: luca@example.com");
	});

	it("calendar: create with invitations, change and delete an event, each approved, showing the event as it is", async () => {
		const { owner, thread, google } = await ready();
		expect(await reply(owner, thread.id, tool("google_calendar_events", {}))).toContain("id e1");
		await reply(owner, thread.id, tool("google_calendar_create", { summary: "Pranzo con Luca", start: "2026-10-20T13:00", end: "2026-10-20T14:00", attendees: ["luca@example.com"], notify: true, reason: "Pranzo" }));
		await reply(owner, thread.id, tool("google_calendar_update", { event_id: "e1", start: "2026-10-16T11:00:00+02:00", end: "2026-10-16T11:30:00+02:00", reason: "Spostare la call" }));
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Annullare la call" }));
		const { actions } = await owner("/api/instances/annie/google-actions");
		const [create, update, remove] = actions;
		expect(create).toMatchObject({ kind: "calendar.create", event: { summary: "Pranzo con Luca", attendees: ["luca@example.com"] }, notify: true });
		expect(update).toMatchObject({ kind: "calendar.update", current: { summary: "Call con Rossi", start: "2026-10-16T10:00:00+02:00" } });
		expect(remove).toMatchObject({ kind: "calendar.delete", current: { summary: "Call con Rossi" } });
		for (const a of actions) expect((await owner(`/api/instances/annie/google-actions/${a.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		const [post, patch, del] = google.writes();
		expect(post?.url.searchParams.get("sendUpdates")).toBe("all");
		expect(JSON.parse(post?.body ?? "{}")).toEqual({ summary: "Pranzo con Luca", start: { dateTime: "2026-10-20T13:00:00", timeZone: "Europe/Rome" }, end: { dateTime: "2026-10-20T14:00:00", timeZone: "Europe/Rome" }, attendees: [{ email: "luca@example.com" }] });
		expect(patch?.method).toBe("PATCH");
		expect(patch?.url.searchParams.get("sendUpdates")).toBe("none");
		expect(JSON.parse(patch?.body ?? "{}")).toEqual({ start: { dateTime: "2026-10-16T11:00:00+02:00" }, end: { dateTime: "2026-10-16T11:30:00+02:00" } });
		expect(`${del?.method} ${del?.url.pathname}`).toBe("DELETE /calendar/v3/calendars/primary/events/e1");
		expect(await annieSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${create.id}`))).toContain("https://www.google.com/calendar/event?eid=new1");
	});

	it("rejected: nothing reaches Google; only the person whose account it is sees and decides", async () => {
		const { owner, thread, google, base, annie } = await ready();
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Annullare" }));
		const [action] = (await owner("/api/instances/annie/google-actions")).actions;
		// An approver of the instance is not the owner of the calendar.
		const { link, person } = await owner("/api/people", { name: "Luca" });
		const settings = (await owner("/api/instances/annie/settings")).settings;
		await owner("/api/instances/annie/settings", { name: settings.name, instructions: settings.instructions, webPeople: [...settings.allowedUsers.web, person.id], webApprovers: [...(settings.approvers.web ?? []), person.id] }, "PUT");
		const luca = await client(base, link);
		expect((await luca("/api/instances/annie/google-actions")).actions).toEqual([]);
		expect((await luca(`/api/instances/annie/google-actions/${action.id}/decision`, { decision: "approved" })).status).toBe(404);
		expect((await owner(`/api/instances/annie/google-actions/${action.id}/decision`, { decision: "rejected" })).action.status).toBe("rejected");
		expect(google.writes()).toEqual([]);
		expect(await annieSays(owner, thread.id, (t) => t.includes(action.id))).toContain("rifiutata");
		expect(annie.runtime).toBeDefined();
	});

	it("refuses what cannot be sent safely: bad addresses, headers broken across lines, threads outside the console", async () => {
		const { owner, thread, google } = await ready();
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["non-un-indirizzo"], subject: "x", body: "y", reason: "prova" }))).toContain("indirizzo non valido");
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.it"], subject: "x\r\nBcc: spia@evil.com", body: "y", reason: "prova" }))).toContain("Errore");
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.it>, spia@evil.com"], subject: "x", body: "y", reason: "prova" }))).toContain("indirizzo non valido");
		expect(await reply(owner, thread.id, tool("google_calendar_create", { summary: "x", start: "2026-10-20T14:00", end: "2026-10-20T13:00", reason: "prova" }))).toContain("Errore");
		expect((await owner("/api/instances/annie/google-actions")).actions).toEqual([]);
		expect(google.writes()).toEqual([]);
	});

	it("Google refusing is a failure; Google not answering is an unknown outcome, never sent again", async () => {
		const { owner, thread, google } = await ready();
		await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.it"], subject: "Uno", body: "1", reason: "prova" }));
		await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.it"], subject: "Due", body: "2", reason: "prova" }));
		await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.it"], subject: "Tre", body: "3", reason: "prova" }));
		const [one, two, three] = (await owner("/api/instances/annie/google-actions")).actions;
		google.state.fail = 400;
		expect((await owner(`/api/instances/annie/google-actions/${one.id}/decision`, { decision: "approved" })).action.status).toBe("failed");
		google.state.fail = 503;
		expect((await owner(`/api/instances/annie/google-actions/${two.id}/decision`, { decision: "approved" })).action.status).toBe("uncertain");
		google.state.down = true;
		expect((await owner(`/api/instances/annie/google-actions/${three.id}/decision`, { decision: "approved" })).action.status).toBe("uncertain");
		expect(await annieSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${two.id}`))).toContain("non si sa");
	});

	it("without ANNIE_GOOGLE_WRITE there is nothing to write with", async () => {
		const { owner, thread } = await ready({ ANNIE_GOOGLE_CLIENT_ID: "client-1", ANNIE_GOOGLE_CLIENT_SECRET: "secret-1" });
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Annullare" }));
		expect((await owner("/api/instances/annie/google-actions")).actions).toEqual([]);
		expect((await owner("/api/google")).write).toBe(false);
	});

	it("store: an action left running by a dead process becomes uncertain; old ones expire", async () => {
		const store = new GoogleActionStore(join(tempDataDir(), "ga"));
		const a = await store.propose({ kind: "calendar.delete", personId: "p1", account: "x@y.it", reason: "r", event: { id: "e1" } }, new Date("2026-10-17T10:00:00Z"));
		expect((await store.get(a.id, new Date("2026-10-18T11:00:00Z")))?.status).toBe("expired");
		const b = await store.propose({ kind: "calendar.delete", personId: "p1", account: "x@y.it", reason: "r", event: { id: "e1" } });
		await store.decide(b.id, "approved", "p1", async () => {
			const settled = await new GoogleActionStore(join(store.dir)).settleInterrupted();
			expect(settled.map((s) => s.id)).toEqual([b.id]);
			return { done: "x" };
		});
		expect(mimeMessage({ to: ["a@b.it"], cc: [], subject: "Ciao", body: "x" })).toContain("Content-Type: text/plain; charset=UTF-8");
	});
});
