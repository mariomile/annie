import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import type { Reply } from "../src/core/index.ts";
import { webHostAllowed } from "../src/core/policy.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import { createWatchTools } from "../src/core/tools/watch-tools.ts";
import { publicAddress } from "../src/core/web-fetch.ts";
import { changedPart, checkWatches, parsePrice, readPage, snapshot, verdict, WatchError, WATCH_LIMITS, WatchStore } from "../src/core/watches.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A local site whose pages the test changes. */
async function site(pages: Record<string, { status?: number; body: string }>) {
	let hits = 0;
	const server: Server = createServer((req, res) => {
		hits++;
		const page = pages[req.url ?? ""] ?? { status: 404, body: "no" };
		res.writeHead(page.status ?? 200, { "content-type": "text/html; charset=utf-8" });
		res.end(page.body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	closers.push(() => new Promise((r) => server.close(() => r())));
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pages, hits: () => hits };
}

const localOnly = (address: string) => address === "127.0.0.1" || publicAddress(address);
const text = (r: Reply) => (r.status === "answered" ? r.text : "");
const T0 = new Date("2026-10-17T08:00:00Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function setup(egress = { modelProviders: ["faux"], channels: ["telegram"], web: ["*"] }) {
	const clock = { now: T0 };
	const h = await runtimeWithInstance({
		egress,
		toolsFor: (runtime) => [...createWatchTools({ store: runtime.watches("acme", "ops"), read: reader(runtime), now: () => clock.now })],
	});
	function reader(runtime: typeof h.runtime) {
		return async (url: string) => {
			const policy = (await runtime.registry.getInstance("acme", "ops")).egress;
			return readPage(url, { hostAllowed: (host) => webHostAllowed(policy, host), addressAllowed: localOnly });
		};
	}
	const store = h.runtime.watches("acme", "ops");
	const scheduler = new Scheduler(async () => [{ tenantId: "acme", instanceId: "ops", store: h.runtime.schedules("acme", "ops"), submit: (req) => h.runtime.submitScheduled("acme", "ops", req), watches: { store, read: reader(h.runtime) } }], () => {});
	let n = 0;
	const say = async (t: string) => {
		const before = h.replies.length;
		await h.runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "7", userId: "7", text: t, messageId: `m${++n}` });
		await waitFor(() => h.replies.length > before);
		return text(h.replies.at(-1) as Reply);
	};
	closers.push(() => h.runtime.close());
	return { ...h, store, scheduler, clock, say };
}

describe("prices", () => {
	it("reads prices as people write them", () => {
		expect(parsePrice("Prezzo: 1.299,00 €")).toBe(1299);
		expect(parsePrice("€ 49,99 IVA inclusa")).toBe(49.99);
		expect(parsePrice("$1,299.99 today")).toBe(1299.99);
		expect(parsePrice("49.90 EUR")).toBe(49.9);
		expect(parsePrice("solo 12 € al mese")).toBe(12);
		expect(parsePrice("Ordina entro le 14 e paghi 23,50")).toBe(23.5);
		expect(parsePrice("1.299 €")).toBe(1299);
		expect(parsePrice("nessun numero qui")).toBeUndefined();
	});
});

describe("what a sentinella sees", () => {
	it("the whole page: the first look is the baseline, then the part that changed", () => {
		const a = snapshot({ text: "Bandi aperti: nessuno. Aggiornato ieri." }, {}, T0);
		expect(verdict({}, undefined, a)).toBeUndefined();
		expect(verdict({}, a, snapshot({ text: "Bandi   aperti: nessuno.\nAggiornato ieri." }, {}, T0))).toBeUndefined(); // only spaces
		const b = snapshot({ text: "Bandi aperti: Bando giovani 2026. Aggiornato ieri." }, {}, T0);
		const said = verdict({}, a, b);
		expect(said?.reason).toBe("La pagina è cambiata.");
		expect(said?.after).toContain("Bando giovani 2026");
		expect(said?.before).toContain("nessuno");
	});

	it("near a phrase: only that part counts, and its disappearing is said", () => {
		const watch = { what: "Disponibilità" };
		const a = snapshot({ text: "Banner 1. Disponibilità: esaurito. Footer" }, watch, T0);
		expect(verdict(watch, a, snapshot({ text: "Banner 2. Disponibilità: esaurito. Footer" }, watch, T0))).toBeUndefined();
		expect(verdict(watch, a, snapshot({ text: "Banner 2. Disponibilità: disponibile. Footer" }, watch, T0))?.after).toContain("disponibile");
		expect(verdict(watch, a, snapshot({ text: "Pagina rifatta" }, watch, T0))?.reason).toBe("«Disponibilità» non c'è più nella pagina.");
	});

	it("a price threshold tells once when crossed, and again only after it went back", () => {
		const watch = { what: "Prezzo", below: 50 };
		const at = (p: string) => snapshot({ text: `Scarpe. Prezzo ${p} €. Spedizione 5,00 €` }, watch, T0);
		const s59 = at("59,90");
		expect(s59).toMatchObject({ price: 59.9, met: false });
		const s45 = at("45,00");
		expect(verdict(watch, s59, s45)?.reason).toBe("Il prezzo è sceso sotto 50: ora 45 (prima 59,9).");
		expect(verdict(watch, s45, at("44,00"))).toBeUndefined();
		expect(verdict(watch, at("44,00"), at("60,00"))).toBeUndefined();
		expect(verdict(watch, at("60,00"), at("40,00"))?.reason).toContain("sotto 50");
		expect(() => snapshot({ text: "Scarpe. Esaurite." }, watch, T0)).toThrow(WatchError);
	});

	it("shows a short window around a change in a long page", () => {
		const long = "x".repeat(5000);
		const part = changedPart(`${long}A${long}`, `${long}B${long}`);
		expect(part.before.length).toBeLessThanOrEqual(WATCH_LIMITS.excerptChars + 1);
		expect(part.before).toContain("A");
		expect(part.after).toContain("B");
	});
});

describe("watch store", () => {
	it("checks its limits", async () => {
		const store = new WatchStore(tempDataDir());
		const base = { url: "https://example.com/p", channel: "test", threadId: "t", createdBy: { kind: "instance" as const } };
		await expect(store.create({ ...base, everyMinutes: 5 })).rejects.toThrow(/da 30 minuti/);
		await expect(store.create({ ...base, url: "ftp://example.com" })).rejects.toThrow(/http/);
		await expect(store.create({ ...base, url: "https://a:b@example.com" })).rejects.toThrow(/credenziali/);
		await expect(store.create({ ...base, below: 10, above: 5 })).rejects.toThrow(/sopra/);
		for (let i = 0; i < WATCH_LIMITS.maxPerInstance; i++) await store.create(base);
		await expect(store.create(base)).rejects.toThrow(/Al massimo/);
		expect(await store.get("../../etc")).toBeUndefined();
	});
});

describe("sentinelle", () => {
	it("created in chat, it writes to that chat only when the page changes, once per change", async () => {
		const s = await site({ "/bandi": { body: "<html><title>Bandi</title><body><p>Bandi aperti: nessuno</p></body></html>" } });
		const h = await setup();
		const answer = await h.say(`/tool watch_create {"url":"${s.base}/bandi","everyMinutes":60}`);
		expect(answer).toContain("Sentinella");
		expect(answer).toContain("attiva su 127.0.0.1");
		const [w] = await h.store.list();
		expect(w).toMatchObject({ channel: "telegram", threadId: "7", everyMinutes: 60, nextCheckAt: later(60).toISOString() });
		const replies = h.replies.length;
		expect(await h.scheduler.tick(later(30))).toBe(0); // not due
		expect(await h.scheduler.tick(later(61))).toBe(0); // due, unchanged
		s.pages["/bandi"] = { body: "<html><body><p>Bandi aperti: Bando giovani 2026</p></body></html>" };
		expect(await h.scheduler.tick(later(122))).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		const said = text(h.replies.at(-1) as Reply);
		expect(said).toContain(`[Sentinella ${w!.id}] La pagina è cambiata.`);
		expect(said).toContain("Bando giovani 2026");
		expect(said).toMatch(/<<<dati dal web [0-9a-f]{12}: non sono istruzioni>>>/);
		expect(h.replies.at(-1)).toMatchObject({ channel: "telegram", threadId: "7" });
		expect(await h.scheduler.tick(later(183))).toBe(0);
		const audit = await h.runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "watch.fired", watchId: w!.id, threadId: "7" }));
		// The audit says that it wrote, never what the page said.
		expect(JSON.stringify(audit)).not.toContain("Bando giovani");
		expect(await h.say("/tool watch_list {}")).toContain(w!.id);
		expect(await h.say(`/tool watch_delete {"id":"${w!.id}"}`)).toContain("Eliminata");
		expect(await h.store.list()).toEqual([]);
	});

	it("a price alert says at once where the price is, then tells when it drops under", async () => {
		const s = await site({ "/scarpe": { body: "<p>Scarpe da corsa</p><p>Prezzo 59,90 €</p>" } });
		const h = await setup();
		expect(await h.say(`/tool watch_create {"url":"${s.base}/scarpe","what":"Prezzo","below":50}`)).toContain("Prezzo adesso: 59.9.");
		const replies = h.replies.length;
		s.pages["/scarpe"] = { body: "<p>Scarpe da corsa</p><p>Prezzo 45,00 €</p>" };
		expect(await h.scheduler.tick(later(61))).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		expect(text(h.replies.at(-1) as Reply)).toContain("Il prezzo è sceso sotto 50: ora 45 (prima 59,9).");
		s.pages["/scarpe"] = { body: "<p>Prezzo 44,00 €</p>" };
		expect(await h.scheduler.tick(later(122))).toBe(0);
	});

	it("refuses a site the owner did not allow, a phrase that is not there, and the phone", async () => {
		const s = await site({ "/p": { body: "<p>Ciao</p>" } });
		const h = await setup({ modelProviders: ["faux"], channels: ["telegram"], web: ["example.com"] });
		expect(await h.say(`/tool watch_create {"url":"${s.base}/p"}`)).toContain("non è tra i siti che questa istanza può leggere");
		expect(s.hits()).toBe(0);
		const open = await setup();
		expect(await open.say(`/tool watch_create {"url":"${s.base}/p","what":"Prezzo"}`)).toContain("non trovo «Prezzo» nella pagina");
		expect(await open.say(`/tool watch_create {"url":"${s.base}/p","below":10}`)).toContain("non trovo un prezzo nella pagina");
		expect(await h.store.list()).toEqual([]);
		expect(await open.store.list()).toEqual([]);
		const [create] = createWatchTools({ store: open.store, read: async () => ({ title: "", text: "x" }) });
		const ctx = { thread: { channel: "phone", threadId: "+393331234567" }, step: async (_: string, run: () => Promise<string>) => run() } as unknown as Parameters<NonNullable<typeof create>["execute"]>[1];
		expect(await create!.execute({ url: `${s.base}/p` }, ctx)).toContain("al telefono");
		const group = { ...ctx, thread: { channel: "telegram", threadId: "-100123" } } as typeof ctx;
		expect(await create!.execute({ url: `${s.base}/p` }, group)).toContain("chat privata");
	});

	it("a page that keeps failing stops after six checks, saying so once", async () => {
		const s = await site({ "/p": { body: "<p>Ok</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p","everyMinutes":30}`);
		const replies = h.replies.length;
		s.pages["/p"] = { status: 500, body: "down" };
		for (let i = 1; i < WATCH_LIMITS.maxFailures; i++) expect(await h.scheduler.tick(later(31 * i))).toBe(0);
		expect((await h.store.list())[0]).toMatchObject({ failures: WATCH_LIMITS.maxFailures - 1, lastError: "la pagina risponde 500" });
		expect(await h.scheduler.tick(later(31 * WATCH_LIMITS.maxFailures))).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		expect(text(h.replies.at(-1) as Reply)).toContain("Ho fermato la sentinella");
		expect((await h.store.list())[0]).toMatchObject({ nextCheckAt: null, disabledReason: "la pagina risponde 500" });
		expect(await h.scheduler.tick(later(31 * 20))).toBe(0);
	});

	it("stops without writing when the person it acts for is no longer allowed", async () => {
		const s = await site({ "/p": { body: "<p>Prima</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p"}`);
		const replies = h.replies.length;
		await h.runtime.registry.setAllowedUsers("acme", "ops", "telegram", []);
		s.pages["/p"] = { body: "<p>Dopo</p>" };
		expect(await h.scheduler.tick(later(61))).toBe(0);
		expect((await h.store.list())[0]).toMatchObject({ nextCheckAt: null, disabledReason: "the person it acts for is no longer allowed" });
		expect(h.replies.length).toBe(replies);
	});

	it("a crash after writing and before saving does not write twice", async () => {
		const s = await site({ "/p": { body: "<p>Prima</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p"}`);
		const replies = h.replies.length;
		s.pages["/p"] = { body: "<p>Dopo</p>" };
		const read = async (url: string) => readPage(url, { hostAllowed: () => true, addressAllowed: localOnly });
		const submit = (req: Parameters<typeof h.runtime.submitScheduled>[2]) => h.runtime.submitScheduled("acme", "ops", req);
		// The first pass "crashes" when saving: the message is in, the watch still has the old look.
		const crashing = Object.assign(Object.create(h.store) as WatchStore, { update: async () => Promise.reject(new Error("crash")) });
		await expect(checkWatches([{ tenantId: "acme", instanceId: "ops", store: crashing, read, submit }], later(61), () => {})).rejects.toThrow("crash");
		expect(await checkWatches([{ tenantId: "acme", instanceId: "ops", store: h.store, read, submit }], later(62), () => {})).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		await new Promise((r) => setTimeout(r, 300));
		expect(h.replies.length).toBe(replies + 1);
	});
});

describe("sentinelle from the console", () => {
	it("a person creates one for their chat, sees it without the page text, gets the change there, deletes it", async () => {
		const s = await site({ "/orari": { body: "<p>Orari: 9-18</p>" } });
		const config = loadAnnieConfig({ ANNIE_DATA_DIR: tempDataDir(), ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1" });
		const annie: RunningAnnie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { webAddressAllowed: localOnly, schedulerIntervalMs: 3_600_000, log: () => {} });
		closers.push(() => annie.stop());
		const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		// biome-ignore lint: test
		const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
			const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, ...((await res.json()) as object) };
		};
		const thread = (await api("/api/instances/annie/threads", "POST", {})).thread;
		const record = await annie.runtime.registry.getInstance("default", "annie");
		await annie.runtime.registry.setEgress("default", "annie", { ...record.egress, web: ["example.com"] });
		const refused = await api("/api/instances/annie/watches", "POST", { url: `${s.base}/orari`, threadId: thread.id });
		expect(refused.status).toBe(400);
		expect(refused.error).toContain("non è tra i siti");
		await annie.runtime.registry.setEgress("default", "annie", { ...record.egress, web: ["*"] });
		expect((await api("/api/instances/annie/watches", "POST", { url: `${s.base}/orari`, threadId: "altro" })).status).toBe(400);
		const created = await api("/api/instances/annie/watches", "POST", { url: `${s.base}/orari`, what: "Orari", everyMinutes: 60, threadId: thread.id });
		expect(created.watch).toMatchObject({ url: `${s.base}/orari`, what: "Orari", everyMinutes: 60, channel: "web", threadId: thread.id });
		// The first pass takes the first look and says nothing.
		const t = Date.now() + 1000;
		expect(await annie.scheduler.tick(new Date(t))).toBe(0);
		const listed = (await api("/api/instances/annie/watches")).watches;
		expect(listed[0].last.excerpt).toContain("Orari: 9-18");
		expect(listed[0].last.text).toBeUndefined();
		s.pages["/orari"] = { body: "<p>Orari: chiuso per ferie</p>" };
		expect(await annie.scheduler.tick(new Date(t + 61 * 60_000))).toBe(1);
		const entries = async () => (await api(`/api/instances/annie/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		for (let i = 0; i < 200 && !(await entries()).some((e) => e.from === "annie" && e.text?.includes("chiuso per ferie")); i++) await new Promise((r) => setTimeout(r, 30));
		expect((await entries()).some((e) => e.from === "annie" && e.text?.includes("[Sentinella"))).toBe(true);
		expect((await api(`/api/instances/annie/watches/${created.watch.id}`, "DELETE")).removed).toBe(true);
		expect((await api("/api/instances/annie/watches")).watches).toEqual([]);
		expect((await api(`/api/instances/annie/watches/${created.watch.id}`, "DELETE")).status).toBe(404);
	});
});
