import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { connectTwilioNumber, type PendingReplies, PhoneAdapter, spoken } from "../src/channels/phone.ts";
import { ChannelRefused, type InboundMessage } from "../src/channels/types.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const ACCOUNT = `AC${"1".repeat(32)}`;
const AUTH = "0123456789abcdef0123456789abcdef";
const NUMBER = "+390612345678";
const NUMBER_SID = `PN${"a".repeat(32)}`;
const CALLER = "+393331234567";

/** Twilio's signature, as its servers compute it. */
function twilioSign(url: string, params: Record<string, string>, token = AUTH): string {
	const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
	return createHmac("sha1", token).update(data).digest("base64");
}

function memoryPending(): PendingReplies & { all: Map<string, string[]> } {
	const all = new Map<string, string[]>();
	return {
		all,
		take: (n) => {
			const list = all.get(n) ?? [];
			all.delete(n);
			return list;
		},
		put: (n, text) => void all.set(n, [...(all.get(n) ?? []), text]),
	};
}

function adapter(options: { pending?: PendingReplies; allowed?: string[]; waitMs?: number; maxWaits?: number } = {}) {
	return new PhoneAdapter({
		credentials: { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, numberSid: NUMBER_SID },
		tenantId: "default",
		instanceId: "annie",
		publicUrl: "https://annie.example.it",
		pending: options.pending ?? memoryPending(),
		mayCall: async (n) => (options.allowed ?? [CALLER]).includes(n),
		waitMs: options.waitMs ?? 50,
		maxWaits: options.maxWaits ?? 3,
	});
}

const call = (extra: Record<string, string> = {}) => new URLSearchParams({ CallSid: "CA123", From: CALLER, To: NUMBER, ...extra });
const q = (s: string) => new URLSearchParams(s);

describe("Phone adapter", () => {
	it("takes only webhooks Twilio signed over our address and the parameters", () => {
		const phone = adapter();
		const url = phone.hookUrl("?step=heard&call=CA123&turn=1");
		const params = { CallSid: "CA123", From: CALLER, SpeechResult: "ciao" };
		const body = new URLSearchParams(params);
		expect(phone.signed(url, body, twilioSign(url, params))).toBe(true);
		expect(phone.signed(url, body, twilioSign(url, params, "f".repeat(32)))).toBe(false);
		expect(phone.signed(`${url}x`, body, twilioSign(url, params))).toBe(false);
		expect(phone.signed(url, new URLSearchParams({ ...params, SpeechResult: "altro" }), twilioSign(url, params))).toBe(false);
		expect(phone.signed(url, body, undefined)).toBe(false);
	});

	it("refuses a number not in the list before answering; greets and listens otherwise", async () => {
		const phone = adapter();
		expect(await phone.handle(q(""), call({ From: "+390000000000" }))).toContain("<Reject/>");
		expect(await phone.handle(q(""), call({ From: "anonymous" }))).toContain("<Reject/>");
		const hello = await phone.handle(q(""), call());
		expect(hello).toContain('<Gather input="speech" language="it-IT"');
		expect(hello).toContain("Dimmi pure.");
		expect(hello).toContain("step=heard&amp;call=CA123&amp;turn=1");
	});

	it("a phrase heard goes to Annie once per call and turn, and her reply is spoken", async () => {
		const phone = adapter({ waitMs: 2_000 });
		const inbound: InboundMessage[] = [];
		phone.onInbound(async (m) => {
			inbound.push(m);
			setTimeout(() => void phone.send({ tenantId: "default", instanceId: "annie", channel: "phone", threadId: m.threadId, text: "**Domani** piove, vedi [qui](https://meteo.it).", idempotencyKey: "k" }), 20);
		});
		const xml = await phone.handle(q("step=heard&call=CA123&turn=1"), call({ SpeechResult: "Che tempo fa domani?" }));
		expect(inbound).toEqual([expect.objectContaining({ channel: "phone", threadId: CALLER, userId: CALLER, privateThread: true, messageId: "CA123:1", text: "Che tempo fa domani?" })]);
		expect(xml).toContain("Domani piove, vedi qui.");
		expect(xml).toContain("turn=2");
	});

	it("a slow reply: «un momento», Twilio comes back, and after the last wait the call ends with the reply kept", async () => {
		const pending = memoryPending();
		const phone = adapter({ pending, maxWaits: 2 });
		phone.onInbound(async () => {});
		const first = await phone.handle(q("step=heard&call=CA123&turn=1"), call({ SpeechResult: "Fammi un riassunto" }));
		expect(first).toContain("Un momento.");
		expect(first).toContain('<Redirect method="POST">https://annie.example.it/hooks/phone/annie?step=wait&amp;call=CA123&amp;turn=1&amp;n=1</Redirect>');
		const last = await phone.handle(q("step=wait&call=CA123&turn=1&n=1"), call());
		expect(last).toContain("Richiamami");
		expect(last).toContain("<Hangup/>");
		// The reply that comes after is kept, and said when the person calls again.
		await phone.send({ tenantId: "default", instanceId: "annie", channel: "phone", threadId: CALLER, text: "Ecco il riassunto.", idempotencyKey: "k" });
		const again = await phone.handle(q(""), call({ CallSid: "CA999" }));
		expect(again).toContain("Ti avevo lasciato una risposta. Ecco il riassunto.");
		expect(pending.all.size).toBe(0);
	});

	it("silence asks again, a goodbye hangs up, a send to something that is not a number is refused", async () => {
		const phone = adapter();
		phone.onInbound(async () => {
			throw new Error("should not be called");
		});
		expect(await phone.handle(q("step=heard&call=CA123&turn=2"), call({ SpeechResult: "  " }))).toContain("Puoi ripetere?");
		const bye = await phone.handle(q("step=heard&call=CA123&turn=2"), call({ SpeechResult: "Grazie, ciao." }));
		expect(bye).toContain("<Hangup/>");
		expect(bye).not.toContain("<Gather");
		await expect(phone.send({ tenantId: "default", instanceId: "annie", channel: "phone", threadId: "web:1", text: "x", idempotencyKey: "k" })).rejects.toBeInstanceOf(ChannelRefused);
	});

	it("speech has no markup, no addresses, no XML from the reply, and long replies are cut", async () => {
		expect(spoken("# Titolo\n- uno\n- due `x` https://a.it/b?c=1")).toBe("Titolo uno due x un link");
		expect(spoken("a ".repeat(2000)).length).toBeLessThan(1600);
		const phone = adapter({ waitMs: 1_000 });
		phone.onInbound(async (m) => void phone.send({ tenantId: "default", instanceId: "annie", channel: "phone", threadId: m.threadId, text: '</Say><Dial>+391</Dial> & "x"', idempotencyKey: "k" }));
		const xml = await phone.handle(q("step=heard&call=CA123&turn=1"), call({ SpeechResult: "prova" }));
		expect(xml).not.toContain("<Dial>");
		expect(xml).toContain("&lt;/Say&gt;");
	});
});

/** Twilio's REST API for numbers, as a fetch. */
function fakeTwilio() {
	const calls: { method: string; url: string; auth: string; body: string }[] = [];
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ method: init?.method ?? "GET", url, auth: String((init?.headers as Record<string, string>)?.authorization ?? ""), body: String(init?.body ?? "") });
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if ((init?.headers as Record<string, string>)?.authorization !== `Basic ${Buffer.from(`${ACCOUNT}:${AUTH}`).toString("base64")}`) return json(401, { message: "Authenticate" });
		if (url.includes("/IncomingPhoneNumbers.json?PhoneNumber=")) {
			const asked = decodeURIComponent(url.split("PhoneNumber=")[1] ?? "");
			return json(200, { incoming_phone_numbers: asked === NUMBER ? [{ sid: NUMBER_SID }] : [] });
		}
		if (url.endsWith(`/IncomingPhoneNumbers/${NUMBER_SID}.json`) && init?.method === "POST") return json(200, { sid: NUMBER_SID });
		return json(404, { message: "Not found" });
	}) as typeof fetch;
	return { fn, calls };
}

describe("connectTwilioNumber", () => {
	it("finds the number in the account and points its calls at the cell", async () => {
		const twilio = fakeTwilio();
		expect(await connectTwilioNumber({ accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, voiceUrl: "https://annie.example.it/hooks/phone/annie", fetch: twilio.fn })).toEqual({ numberSid: NUMBER_SID });
		const set = twilio.calls.at(-1);
		expect(set?.method).toBe("POST");
		expect(new URLSearchParams(set?.body)).toEqual(new URLSearchParams({ VoiceUrl: "https://annie.example.it/hooks/phone/annie", VoiceMethod: "POST" }));
		await expect(connectTwilioNumber({ accountSid: ACCOUNT, authToken: "f".repeat(32), number: NUMBER, voiceUrl: "x", fetch: twilio.fn })).rejects.toBeInstanceOf(ChannelRefused);
		await expect(connectTwilioNumber({ accountSid: ACCOUNT, authToken: AUTH, number: "+390699999999", voiceUrl: "x", fetch: twilio.fn })).rejects.toThrow("non è nell'account");
	});
});

describe("Phone in an instance", () => {
	async function boot(publicUrl = "https://annie.example.it") {
		const twilio = fakeTwilio();
		const dataDir = tempDataDir();
		const config = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ANNIE_PUBLIC_URL: publicUrl });
		const annie: RunningAnnie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { phoneFetch: twilio.fn, phoneWait: { ms: 5_000, max: 3 }, schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => annie.stop());
		const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown, method?: string, as = cookie) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie: as, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, ...((await res.json()) as any) };
		};
		const hook = async (query: string, params: Record<string, string>, signature?: string) => {
			const res = await fetch(`${base}/hooks/phone/annie${query}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature ?? twilioSign(`${publicUrl}/hooks/phone/annie${query}`, params) }, body: new URLSearchParams(params).toString() });
			return { status: res.status, text: await res.text() };
		};
		return { api, hook, twilio };
	}

	it("the owner connects a number; allowed callers talk to Annie, strangers are rejected, forged webhooks refused", async () => {
		const { api, hook, twilio } = await boot();
		expect((await api("/api/instances/annie/phone")).phone).toMatchObject({ connected: false, https: true, allowedUsers: [] });
		expect((await api("/api/instances/annie/phone", { accountSid: ACCOUNT }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/annie/phone", { accountSid: ACCOUNT, authToken: AUTH, number: "0612345678" }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/annie/phone", { accountSid: ACCOUNT, authToken: "f".repeat(32), number: NUMBER }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/annie/phone", { allowedUsers: ["393331234567"] }, "PUT")).status).toBe(400);
		const connected = await api("/api/instances/annie/phone", { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, allowedUsers: [CALLER] }, "PUT");
		expect(connected.phone).toMatchObject({ connected: true, number: NUMBER, accountSid: ACCOUNT, allowedUsers: [CALLER] });
		expect(JSON.stringify(connected)).not.toContain(AUTH);
		expect(new URLSearchParams(twilio.calls.at(-1)?.body).get("VoiceUrl")).toBe("https://annie.example.it/hooks/phone/annie");
		// Saving only the list does not call Twilio.
		const before = twilio.calls.length;
		expect((await api("/api/instances/annie/phone", { allowedUsers: [CALLER, "+393479876543"] }, "PUT")).phone.allowedUsers).toHaveLength(2);
		expect(twilio.calls).toHaveLength(before);

		const start = { CallSid: "CA1", From: CALLER, To: NUMBER };
		expect((await hook("", start, "forged")).status).toBe(403);
		expect((await hook("", { ...start, From: "+390000000000" })).text).toContain("<Reject/>");
		expect((await hook("", start)).text).toContain("Dimmi pure.");
		const heard = await hook("?step=heard&call=CA1&turn=1", { ...start, SpeechResult: "ciao dal telefono" });
		expect(heard.status).toBe(200);
		expect(heard.text).toContain("ciao dal telefono");
		expect(heard.text).toContain("<Gather");

		expect((await api("/api/instances/annie/phone", undefined, "DELETE")).status).toBe(200);
		expect((await api("/api/instances/annie/phone")).phone.connected).toBe(false);
		expect((await hook("", start)).status).toBe(404);
		// Only the owner.
		expect((await api("/api/instances/annie/phone", undefined, "GET", "")).status).toBe(401);
	}, 30_000);

	it("without a public https address the number cannot be connected", async () => {
		const { api } = await boot("http://annie.example.it");
		expect((await api("/api/instances/annie/phone")).phone.https).toBe(false);
		const res = await api("/api/instances/annie/phone", { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER }, "PUT");
		expect([res.status, res.error]).toEqual([400, expect.stringContaining("https")]);
	});
});
