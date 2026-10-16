import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { WEB_ACTION_LIMITS, WebActionStore, sendWebAction } from "../src/core/web-actions.ts";
import { CookieJar, publicAddress, webFetch } from "../src/core/web-fetch.ts";
import { describeForms, formBody, pageForms } from "../src/core/web-forms.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const localOnly = (address: string) => address === "127.0.0.1" || publicAddress(address);
const all = () => true;

const CONTACT = (token: string, action = "/send") => `<html><head><title>Contatti</title></head><body>
<form action="/search" method="get"><input name="q"></form>
<form action="${action}" method="post">
  <input type="hidden" name="csrf" value="${token}">
  <label for="n">Il tuo nome</label><input id="n" name="name" required>
  <input name="email" type="email" placeholder="Email">
  <select name="topic"><option value="info">Informazioni</option><option value="quote" selected>Preventivo</option></select>
  <input type="radio" name="when" value="am" checked><input type="radio" name="when" value="pm">
  <input type="checkbox" name="privacy" value="yes">
  <textarea name="message">Ciao</textarea>
  <button type="submit" name="go" value="1">Invia</button>
</form></body></html>`;

function body(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let text = "";
		req.on("data", (c: Buffer) => {
			text += c.toString();
		});
		req.on("end", () => resolve(text));
	});
}

/** A site with a contact form: it sets a session cookie and wants it, and the token, back. */
async function contactSite(options: { action?: string } = {}) {
	const posts: { body: string; cookie: string | undefined }[] = [];
	let token = "t1";
	const server: Server = createServer(async (req, res) => {
		if (req.method === "GET" && req.url === "/contact") {
			token = `t${posts.length + 1}x`;
			res.writeHead(200, { "content-type": "text/html", "set-cookie": `sid=${token}; Path=/; HttpOnly` });
			return res.end(CONTACT(token, options.action));
		}
		if (req.method === "POST" && req.url === "/send") {
			const text = await body(req);
			posts.push({ body: text, cookie: req.headers.cookie });
			const ok = new URLSearchParams(text).get("csrf") === token && req.headers.cookie === `sid=${token}`;
			res.writeHead(303, { location: ok ? "/thanks" : "/error" });
			return res.end();
		}
		if (req.url === "/thanks") return res.writeHead(200, { "content-type": "text/html" }).end("<title>Grazie</title><p>Messaggio ricevuto</p>");
		if (req.url === "/error") return res.writeHead(400, { "content-type": "text/html" }).end("<p>Sessione scaduta</p>");
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	closers.push(() => new Promise((r) => server.close(() => r())));
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts, setAction: (a: string) => (options.action = a) };
}

describe("forms on a page", () => {
	it("lists forms with their fields, labels and choices; hidden fields are the site's", () => {
		const forms = pageForms(CONTACT("abc"), "https://example.com/contact");
		expect(forms.map((f) => [f.method, f.action])).toEqual([
			["GET", "https://example.com/search"],
			["POST", "https://example.com/send"],
		]);
		const fields = forms[1]?.fields ?? [];
		expect(fields.find((f) => f.name === "name")).toMatchObject({ kind: "text", required: true, label: "Il tuo nome" });
		expect(fields.find((f) => f.name === "topic")).toMatchObject({ value: "quote", options: ["info", "quote"] });
		expect(fields.find((f) => f.name === "when")).toMatchObject({ value: "am", options: ["am", "pm"] });
		const listed = describeForms(forms);
		expect(listed).toContain("Modulo 1: POST https://example.com/send");
		expect(listed).toContain("name (text, obbligatorio, «Il tuo nome»)");
		expect(listed).not.toContain("csrf");
	});

	it("builds the body over the defaults; refuses unknown, hidden and out-of-choice values", () => {
		const form = pageForms(CONTACT("abc"), "https://example.com/contact")[1]!;
		const sent = new URLSearchParams(formBody(form, { name: "Mario", privacy: "on", when: "pm" }).body.toString());
		expect([...sent]).toEqual([
			["csrf", "abc"],
			["name", "Mario"],
			["email", ""],
			["topic", "quote"],
			["when", "pm"],
			["privacy", "yes"],
			["message", "Ciao"],
			["go", "1"],
		]);
		expect(() => formBody(form, { csrf: "mine" })).toThrow(/lo decide il sito/);
		expect(() => formBody(form, { password: "x" })).toThrow(/non ha un campo/);
		expect(() => formBody(form, { topic: "spam" })).toThrow(/non è tra le scelte/);
		const multipart = pageForms(`<form method=post enctype="multipart/form-data"><input name=a></form>`, "https://e.com/")[0]!;
		const m = formBody(multipart, { a: "1" });
		expect(m.contentType).toMatch(/^multipart\/form-data; boundary=/);
		expect(m.body.toString()).toContain('name="a"\r\n\r\n1\r\n');
	});

	it("hostile HTML costs linear time", () => {
		const started = Date.now();
		pageForms(`${"<form method=post>".repeat(20)}${"<input name=a ".repeat(50_000)}${"<label for=x>".repeat(50_000)}`, "https://e.com/");
		expect(Date.now() - started).toBeLessThan(1_500);
	});
});

describe("sending a form", () => {
	it("a POST goes with this visit's cookies; the redirect after it is a GET", async () => {
		const s = await contactSite();
		const cookies = new CookieJar();
		const page = await webFetch(`${s.base}/contact`, { hostAllowed: all, addressAllowed: localOnly, cookies });
		const form = pageForms(page.body, page.url)[1]!;
		const answer = await webFetch(form.action, { hostAllowed: all, addressAllowed: localOnly, cookies, send: formBody(form, { name: "Mario" }) });
		expect(answer.url).toBe(`${s.base}/thanks`);
		expect(answer.body).toContain("Messaggio ricevuto");
		expect(s.posts).toHaveLength(1);
	});

	it("sendWebAction reads the page again (fresh token) and refuses a form that now goes elsewhere", async () => {
		const s = await contactSite();
		const action = { id: "a".repeat(12), pageUrl: `${s.base}/contact`, form: 1, action: `${s.base}/send`, method: "POST" as const, values: { name: "Mario" }, reason: "x", status: "running" as const, proposedAt: new Date().toISOString() };
		const result = await sendWebAction(action, { hostAllowed: all, addressAllowed: localOnly });
		expect(result).toMatchObject({ status: 200, title: "Grazie", text: "Messaggio ricevuto" });
		s.setAction("https://evil.example/collect");
		await expect(sendWebAction(action, { hostAllowed: all, addressAllowed: localOnly })).rejects.toThrow(/ora va a https:\/\/evil\.example/);
		expect(s.posts).toHaveLength(1);
	});
});

describe("web action store", () => {
	it("decides once even when two approvals race; expires after 24 hours; a crash mid-send is uncertain, never resent", async () => {
		const dir = tempDataDir();
		const store = new WebActionStore(dir);
		const input = { pageUrl: "https://e.com/c", form: 0, action: "https://e.com/s", values: { a: "1" }, reason: "prova" };
		const a = await store.propose(input);
		let sent = 0;
		const run = async () => {
			sent++;
			await new Promise((r) => setTimeout(r, 30));
			return { status: 200, url: "https://e.com/ok", title: "", text: "ok" };
		};
		const by = { channel: "web", userId: "p1" };
		const [first, second] = await Promise.all([store.decide(a.id, "approved", by, run), store.decide(a.id, "approved", by, run)]);
		expect(sent).toBe(1);
		expect([first.changed, second.changed]).toEqual([true, false]);
		expect((await store.get(a.id))?.status).toBe("done");

		const old = await store.propose(input, new Date(Date.now() - WEB_ACTION_LIMITS.ttlMs - 1000));
		expect((await store.get(old.id))?.status).toBe("expired");
		expect((await store.decide(old.id, "approved", by, run)).changed).toBe(false);
		expect(sent).toBe(1);

		const crashed = await store.propose(input);
		// The send never finishes: the process "dies" with the action running on disk.
		void store.decide(crashed.id, "approved", by, () => new Promise(() => {}));
		await new Promise((r) => setTimeout(r, 20));
		expect((await new WebActionStore(dir).settleInterrupted()).map((x) => x.id)).toEqual([crashed.id]);
		expect((await store.get(crashed.id))?.status).toBe("uncertain");
	});
});

async function boot(dataDir: string) {
	const config = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1" });
	const annie: RunningAnnie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { webAddressAllowed: localOnly, schedulerIntervalMs: 60_000, log: () => {} });
	closers.push(() => annie.stop());
	const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
	const loginWith = async (token: string) => {
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		return async (path: string, body?: unknown, method?: string) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			// biome-ignore lint: test
			return { status: res.status, ...((await res.json()) as any) };
		};
	};
	const api = await loginWith((annie.ownerLink as string).split("#")[1] as string);
	const chat = async (as: typeof api) => {
		const thread = (await as("/api/instances/annie/threads", {})).thread;
		const entries = async () => (await as(`/api/instances/annie/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		const reply = async (text: string, count = 1): Promise<string> => {
			const before = (await entries()).filter((e) => e.from === "annie").length;
			if (text !== "") await as(`/api/instances/annie/threads/${thread.id}/messages`, { text });
			for (const start = Date.now(); Date.now() - start < 20_000; ) {
				const now = (await entries()).filter((e) => e.from === "annie");
				if (now.length >= before + count) return now.at(-1)?.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no reply");
		};
		return { thread, reply, entries };
	};
	return { annie, api, loginWith, chat, dataDir };
}

describe("web_submit in an instance", () => {
	it("off until the owner allows it; then nothing leaves until the person approves, once; the outcome comes back to the chat", async () => {
		const s = await contactSite();
		const { annie, api, chat, dataDir } = await boot(tempDataDir());
		const policy = (await annie.runtime.registry.getInstance("default", "annie")).egress;
		await annie.runtime.registry.setEgress("default", "annie", { ...policy, web: ["*"] });
		const { reply } = await chat(api);
		const read = await reply(`/tool web_read {"url":"${s.base}/contact"}`);
		expect(read).toContain(`Modulo 1: POST ${s.base}/send`);
		expect(read).not.toContain("Modulo 0");
		const ask = `/tool web_submit {"page_url":"${s.base}/contact","form":1,"values":{"name":"Mario","email":"m@example.com"},"reason":"Chiedo un preventivo"}`;
		expect(await reply(ask)).toContain("l'owner non ha acceso le azioni sul web");
		expect((await api("/api/instances/annie/web-actions-allowed", { allowed: true }, "PUT")).allowed).toBe(true);
		expect(await reply(`/tool web_submit {"page_url":"${s.base}/contact","form":1,"values":{"csrf":"x"},"reason":"prova"}`)).toContain("lo decide il sito");
		expect(await reply(ask)).toMatch(/Richiesta [0-9a-f]{12} pronta/);
		expect(s.posts).toHaveLength(0);
		const { actions } = await api("/api/instances/annie/web-actions");
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ status: "pending", values: { name: "Mario", email: "m@example.com" }, action: `${s.base}/send` });
		// Approving sends it, once; the outcome is a new message for Annie in the same chat.
		const decided = await api(`/api/instances/annie/web-actions/${actions[0].id}/decision`, { decision: "approved" });
		expect(decided.action).toMatchObject({ status: "done", result: { status: 200, title: "Grazie" } });
		expect(await reply("", 1)).toMatch(/Esito della richiesta [0-9a-f]{12}[\s\S]*Messaggio ricevuto/);
		expect((await api(`/api/instances/annie/web-actions/${actions[0].id}/decision`, { decision: "approved" })).action.status).toBe("done");
		expect(s.posts).toHaveLength(1);
		expect(new URLSearchParams(s.posts[0]?.body).get("name")).toBe("Mario");
		const audit = readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8");
		expect(audit).toContain('"type":"web_action.done"');
		expect(audit).not.toContain("m@example.com");
	});

	it("another person can neither see nor decide someone's request; an approver can", async () => {
		const s = await contactSite();
		const { annie, api, loginWith, chat } = await boot(tempDataDir());
		const policy = (await annie.runtime.registry.getInstance("default", "annie")).egress;
		await annie.runtime.registry.setEgress("default", "annie", { ...policy, web: ["*"], connectors: [...(policy.connectors ?? []), "web-actions"] });
		const people = [];
		for (const name of ["Luca", "Sara"]) {
			const { person, link } = await api("/api/people", { name });
			people.push({ person, as: await loginWith(String(link).split("#")[1] as string) });
		}
		const record = await annie.runtime.registry.getInstance("default", "annie");
		await annie.runtime.registry.setAllowedUsers("default", "annie", "web", [...(record.allowedUsers.web ?? []), ...people.map((p) => p.person.id)]);
		const [luca, sara] = people as [(typeof people)[0], (typeof people)[0]];
		const { reply } = await chat(luca.as);
		expect(await reply(`/tool web_submit {"page_url":"${s.base}/contact","form":1,"values":{"name":"Luca"},"reason":"Contatto"}`)).toMatch(/pronta/);
		const [action] = (await luca.as("/api/instances/annie/web-actions")).actions;
		expect(action.requester).toBe(`web:${luca.person.id}`);
		expect((await sara.as("/api/instances/annie/web-actions")).actions).toEqual([]);
		expect((await sara.as(`/api/instances/annie/web-actions/${action.id}/decision`, { decision: "approved" })).status).toBe(403);
		expect(s.posts).toHaveLength(0);
		// The owner is an approver: sees it and may reject it.
		expect((await api("/api/instances/annie/web-actions")).actions).toHaveLength(1);
		expect((await api(`/api/instances/annie/web-actions/${action.id}/decision`, { decision: "rejected" })).action.status).toBe("rejected");
		expect(s.posts).toHaveLength(0);
	});
});
