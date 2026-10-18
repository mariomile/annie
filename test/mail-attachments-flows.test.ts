import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAnnie, startAnnie } from "../src/app.ts";
import { GOOGLE_SCOPE, GOOGLE_WRITE_SCOPE } from "../src/connectors/google.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { readOnlyInBriefs } from "../src/core/brief.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { GoogleActionError } from "../src/core/google-actions.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import type { Company } from "../src/core/invoices.ts";
import { todayIn } from "../src/core/italian-calendar.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import { auditFile, workspaceDir } from "../src/core/paths.ts";
import { QuoteStore } from "../src/core/quote-store.ts";
import { createQuoteTools, type QuoteEvent } from "../src/core/tools/quote-tools.ts";
import type { QuoteMailProposal } from "../src/core/tools/quote-send.ts";
import { Workspace } from "../src/core/workspace.ts";
import { loadAnnieConfig } from "../src/main/config.ts";
import { cleanTemp, FILES, fakeMail, G1, G2, inside, outside, setup, TUESDAY } from "./solleciti-fixtures.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	cleanTemp();
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "annie-mail-flows-"));
	dirs.push(dir);
	return dir;
}

const NOW = new Date("2026-10-18T08:00:00Z");
const COMPANY: Company = { name: "Beta Ristorazione Srl", vat: "IT03311220036", address: "Via Roma 1, Milano", email: "info@beta.it", signature: "Anna Bianchi\nBeta Ristorazione Srl", by: "test:u", at: NOW.toISOString() };
const PDF_HEAD = "%PDF-1.7\n";
/** A document that reads as a PDF, its text after the header: no worker needed. */
const pdfMake = async (input: MakeInput) => ({ data: new Uint8Array(Buffer.from(`${PDF_HEAD}${input.text}`)), pages: 1, notes: [] });
let calls = 0;
const fresh = (thread: { channel: string; threadId: string } = { channel: "web", threadId: "t1" }): ToolContext => ({ step: (_k, work) => work(), progress: () => {}, signal: new AbortController().signal, callId: `qs${++calls}`, thread });

function quoteMail(unavailable?: string, capacity = 20) {
	const proposals: QuoteMailProposal[] = [];
	return {
		proposals,
		mail: {
			check: async () => unavailable,
			propose: async (p: QuoteMailProposal) => {
				if (proposals.length >= capacity) throw new GoogleActionError("troppe richieste in attesa");
				proposals.push(p);
				return { id: `req${proposals.length}` };
			},
		},
	};
}

function quotes(mail?: ReturnType<typeof quoteMail>["mail"]) {
	const dir = temp();
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const store = new QuoteStore(dir);
	const workspace = new Workspace(join(dir, "workspace"));
	const events: QuoteEvent[] = [];
	const [tool] = createQuoteTools({ workspace, store, company: invoices, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => NOW, make: pdfMake, ...(mail === undefined ? {} : { mail }) });
	if (tool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, ctx = fresh()) => String(await tool.execute(args, ctx));
	return { tool, run, store, workspace, events, dir };
}

const CREATE = { op: "create", customer: "Rossi Srl", items: [{ description: "Consulenza", quantity: 2, unit: "giornate", price: 500 }], vat: 22 };

describe("quotes op send", () => {
	it("asks one card with the quote's PDF attached, to the address given (saved on the quote), with a short Italian letter; the audit counts", async () => {
		const { mail, proposals } = quoteMail();
		const { run, store, events, workspace } = quotes(mail);
		expect(await run(CREATE)).toContain("Fatto il preventivo 2026-001");
		expect(await run({ op: "send", number: "1" })).toContain("non ho l'indirizzo email");
		expect(await run({ op: "send", number: "1", email: "non-valida" })).toContain("email non è un indirizzo valido");
		expect(proposals).toEqual([]);
		const answer = await run({ op: "send", number: "1", email: "Mario@Rossi.IT" });
		expect(answer).toMatch(/^Indirizzo salvato sul preventivo: lo riuso le prossime volte\. Richiesta req1 pronta: inviare il preventivo 2026-001 per mail, con il PDF allegato\./);
		expect(answer).toContain("Allegato: Preventivo-2026-001-Rossi-Srl.pdf");
		const [p] = proposals as [QuoteMailProposal];
		expect(p.to).toBe("mario@rossi.it");
		expect(p.subject).toBe("Preventivo n. 2026-001: Beta Ristorazione Srl");
		expect(p.body).toBe("Gentile Rossi Srl,\n\nin allegato il preventivo n. 2026-001 del 18/10/2026, per un totale di 1.220,00 €.\nIl preventivo è valido fino al 17/11/2026.\n\nResto a disposizione per qualsiasi chiarimento.\n\nCordiali saluti\nAnna Bianchi\nBeta Ristorazione Srl");
		expect(`${p.subject}${p.body}${answer}`).not.toMatch(/[–—]/);
		expect(p.attachments.map((a) => [a.path, a.contentType])).toEqual([["preventivi/Preventivo-2026-001-Rossi-Srl.pdf", "application/pdf"]]);
		expect(p.attachments[0]?.size).toBe((await workspace.read("preventivi/Preventivo-2026-001-Rossi-Srl.pdf")).length);
		expect(p.reason).toBe("Invio del preventivo 2026-001 a Rossi Srl");
		expect(store.read().quotes[0]?.customer.email).toBe("mario@rossi.it");
		// The address saved is used the next time.
		await run({ op: "send", number: "2026-001" });
		expect(proposals[1]?.to).toBe("mario@rossi.it");
		expect(events.filter((e) => e.op === "send")).toEqual([
			{ type: "quote.changed", op: "send", count: 1 },
			{ type: "quote.changed", op: "send", count: 1 },
		]);
	});

	it("refuses a replaced quote or a missing file; a full queue is said", async () => {
		const { mail, proposals } = quoteMail(undefined, 0);
		const { run, workspace } = quotes(mail);
		await run({ ...CREATE, email: "a@b.it" });
		await run({ op: "revise", number: "1", discount: 10 });
		await run({ op: "revise", number: "1", discount: 5 });
		expect(await run({ op: "send", number: "2026-001-R1" })).toContain("è stato sostituito da");
		expect(await run({ op: "send", number: "2026-001" })).toContain("troppe richieste in attesa");
		await workspace.remove("preventivi/Preventivo-2026-001-R2-Rossi-Srl.pdf");
		expect(await run({ op: "send", number: "1" })).toContain("non trovo «Preventivo-2026-001-R2-Rossi-Srl.pdf» nel workspace");
		expect(proposals).toEqual([]);
	});

	it("from a phone or without a mail account: the text to copy and the file with file_send, nothing asked", async () => {
		const { mail, proposals } = quoteMail("la posta si usa solo dalle conversazioni della console, con l'account di chi scrive");
		for (const q of [quotes(mail), quotes()]) {
			await q.run({ ...CREATE, email: "a@b.it" });
			const answer = await q.run({ op: "send", number: "1" }, fresh({ channel: "telegram", threadId: "42" }));
			expect(answer).toMatch(/^Non posso inviare mail da qui \(/);
			expect(answer).toContain("l'allegato puoi mandarlo da qui con file_send");
			expect(answer).toContain("File: preventivi/Preventivo-2026-001-Rossi-Srl.pdf");
			expect(answer).toContain("Oggetto: Preventivo n. 2026-001: Beta Ristorazione Srl");
		}
		expect(proposals).toEqual([]);
	});

	it("another agente's request and the brief never send", async () => {
		const { mail, proposals } = quoteMail();
		const { tool, run } = quotes(mail);
		await run({ ...CREATE, email: "a@b.it" });
		expect(await run({ op: "send", number: "1" }, fresh({ channel: AGENT_CHANNEL, threadId: "x" }))).toContain("in una richiesta di un altro agente non faccio e non cambio preventivi");
		const [guarded] = readOnlyInBriefs([tool], async () => true);
		expect(String(await guarded?.execute({ op: "send", number: "1" }, fresh()))).toContain("legge soltanto");
		expect(String(await guarded?.execute({ op: "show", number: "1" }, fresh()))).toContain("Preventivo 2026-001");
		expect(proposals).toEqual([]);
	});
});

describe("solleciti with the invoices attached", () => {
	it("attach_invoice: each letter carries its invoices' files (the XML and the PDF beside it), checked like any attachment", async () => {
		const pdf = `${PDF_HEAD}fattura B-70`;
		const { mail, proposals } = fakeMail();
		const { run, events } = setup({ ...FILES, "f/g1.pdf": pdf }, { mail, now: TUESDAY });
		const answer = await run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(outside(answer)).toContain("Ho preparato una richiesta di invio");
		expect(outside(answer)).toContain("Le fatture sono allegate");
		expect(proposals[0]?.attachments?.map((a) => [a.path, a.name, a.contentType])).toEqual([
			["f/g1.xml", "g1.xml", "application/xml"],
			["f/g1.pdf", "g1.pdf", "application/pdf"],
			["f/g2.xml", "g2.xml", "application/xml"],
		]);
		expect(events).toEqual([{ type: "invoice.reminder", op: "queue", count: 1 }]);
		// Without attach_invoice, nothing attached; reminder_sent refuses it.
		const plain = fakeMail();
		await setup(FILES, { mail: plain.mail, now: TUESDAY }).run({ op: "reminder", party: "gamma", send: true });
		expect(plain.proposals[0]?.attachments).toBeUndefined();
		expect(await run({ op: "reminder_sent", party: "gamma", attach_invoice: true })).toContain("attach_invoice non servono qui");
		expect(await run({ op: "reminder", party: "gamma", send: true, attach_invoice: "sì" })).toContain("attach_invoice è true o false");
	});

	it("a letter whose files cannot go is not asked, and says why; from a phone, the files to send with file_send", async () => {
		const { mail, proposals } = fakeMail();
		const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f/x${i}.xml`, G1.replace("B-70", `B-9${i}`)]));
		const { run } = setup({ ...many }, { mail, now: TUESDAY });
		const answer = await run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(inside(answer)).toContain("non preparato, al massimo 5 allegati per mail; manda una fattura alla volta con number");
		expect(proposals).toEqual([]);
		const phone = setup({ "f/g1.xml": G1, "f/g2.xml": G2, "f/g1.pdf": `${PDF_HEAD}x` }, { mail: fakeMail("chi scrive non ha collegato Google").mail, now: TUESDAY });
		const copy = await phone.run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(outside(copy)).toContain("l'allegato puoi mandarlo da qui con file_send");
		expect(inside(copy)).toContain("File delle fatture: f/g1.xml, f/g1.pdf, f/g2.xml");
	});
});

/** A fake Google: sign-in, and the mails sent (the message as written). */
function fakeGoogle() {
	const sends: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body === undefined ? "" : String(init.body);
		if (url.pathname === "/token") {
			const form = new URLSearchParams(body);
			if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: "at", refresh_token: "rt", scope: `openid email ${GOOGLE_SCOPE.gmail} ${GOOGLE_SCOPE.calendar} ${GOOGLE_WRITE_SCOPE.gmail} ${GOOGLE_WRITE_SCOPE.calendar}`, expires_in: 3600 });
			return Response.json({ access_token: "at2", expires_in: 3600 });
		}
		if (url.hostname === "openidconnect.googleapis.com") return Response.json({ email: "anna@example.com" });
		if (url.pathname === "/gmail/v1/users/me/messages/send") {
			sends.push(Buffer.from(JSON.parse(body).raw as string, "base64url").toString("utf8"));
			return Response.json({ id: "sent1", threadId: "t1" });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, sends };
}

/** The attachments of a raw message: name (RFC 2231 or quoted) and bytes. */
function attachmentsOf(raw: string): { name: string; data: Buffer }[] {
	const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] as string;
	return raw
		.split(`--${boundary}`)
		.slice(2, -1)
		.map((part) => {
			const [head, body] = part.replace(/^\r\n/, "").split("\r\n\r\n") as [string, string];
			const unfolded = head.replace(/\r\n /g, " ");
			const star = /filename\*=UTF-8''([^;\s]+)/.exec(unfolded)?.[1];
			return { name: star === undefined ? (/filename="([^"]*)"/.exec(unfolded)?.[1] ?? "") : decodeURIComponent(star), data: Buffer.from(body, "base64") };
		});
}

describe("attachments in the app, through the approval card", () => {
	it("a quote and a sollecito with their files reach Gmail only once approved, byte for byte; the audit has counts only", async () => {
		const dataDir = temp();
		const google = fakeGoogle();
		const config = loadAnnieConfig({ ANNIE_DATA_DIR: dataDir, ANNIE_MODEL_PROVIDER: "faux", ANNIE_WEB_PORT: "1", ANNIE_GOOGLE_CLIENT_ID: "c", ANNIE_GOOGLE_CLIENT_SECRET: "s", ANNIE_GOOGLE_WRITE: "1" });
		const annie: RunningAnnie = await startAnnie({ ...config, web: { ...config.web, port: 0 } }, { googleFetch: google.fetch, schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => annie.stop());
		const base = `http://127.0.0.1:${(annie.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-annie": "1" }, body: JSON.stringify({ token: (annie.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown, method?: string) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-annie": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			// biome-ignore lint: test
			return (await res.json()) as any;
		};
		const { url } = await api("/api/google/start", {});
		await api("/api/google/finish", { state: new URL(url).searchParams.get("state"), code: "good" });
		await api(`/api/instances/${config.instanceId}/google`, { allowed: true }, "PUT");
		const workspace = workspaceDir(dataDir, tenantId(config.tenantId), instanceId(config.instanceId));
		mkdirSync(join(workspace, "fatture"), { recursive: true });
		writeFileSync(join(workspace, "fatture", "g1.xml"), G1);
		const thread = (await api(`/api/instances/${config.instanceId}/threads`, {})).thread as { id: string };
		const entries = async () => (await api(`/api/instances/${config.instanceId}/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		const reply = async (text: string): Promise<string> => {
			const before = (await entries()).filter((e) => e.from === "annie").length;
			await api(`/api/instances/${config.instanceId}/threads/${thread.id}/messages`, { text });
			for (const start = Date.now(); Date.now() - start < 30_000; ) {
				const now = (await entries()).filter((e) => e.from === "annie");
				if (now.length > before) return now.at(-1)?.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no reply");
		};
		const outcome = async (id: string) => {
			for (const start = Date.now(); Date.now() - start < 10_000; ) {
				if ((await entries()).some((e) => e.text?.includes(`Esito della richiesta ${id}`))) return;
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no outcome");
		};
		await reply('/tool invoices {"op":"set_company","vat":"03311220036","name":"Beta Ristorazione Srl","address":"Via Roma 1, Milano"}');
		const year = todayIn(config.timeZone).slice(0, 4);
		expect(await reply(`/tool quotes ${JSON.stringify({ ...CREATE, email: "mario@rossi.it" })}`)).toContain(`Fatto il preventivo ${year}-001`);
		expect(await reply(`/tool quotes {"op":"send","number":"1"}`)).toContain("pronta: inviare il preventivo");
		expect(google.sends).toEqual([]);
		const [quoteCard] = (await api(`/api/instances/${config.instanceId}/google-actions`)).actions;
		expect(quoteCard.reason).toMatch(new RegExp(`^Invio del preventivo ${year}-001 a Rossi Srl · Allegato: Preventivo-${year}-001-Rossi-Srl\\.pdf \\(\\d+ KB\\)$`));
		expect((await api(`/api/instances/${config.instanceId}/google-actions/${quoteCard.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		await outcome(quoteCard.id);
		const sentQuote = google.sends[0] as string;
		expect(sentQuote).toContain("To: mario@rossi.it\r\n");
		expect(sentQuote).toContain(`Subject: Preventivo n. ${year}-001: Beta Ristorazione Srl\r\n`);
		const [quotePdf] = attachmentsOf(sentQuote);
		expect(quotePdf?.name).toBe(`Preventivo-${year}-001-Rossi-Srl.pdf`);
		expect(quotePdf?.data.equals(readFileSync(join(workspace, "preventivi", `Preventivo-${year}-001-Rossi-Srl.pdf`)))).toBe(true);

		expect(await reply('/tool invoices {"op":"reminder","party":"gamma","send":true,"attach_invoice":true}')).toContain("Le fatture sono allegate");
		const reminderCard = (await api(`/api/instances/${config.instanceId}/google-actions`)).actions.find((a: { id: string }) => a.id !== quoteCard.id);
		expect(reminderCard.reason).toContain("· Allegato: g1.xml (");
		expect((await api(`/api/instances/${config.instanceId}/google-actions/${reminderCard.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		await outcome(reminderCard.id);
		const [xml] = attachmentsOf(google.sends[1] as string);
		expect(xml?.name).toBe("g1.xml");
		expect(xml?.data.toString("utf8")).toBe(G1);
		const audit = readFileSync(auditFile(dataDir, tenantId(config.tenantId)), "utf8");
		const approved = audit
			.split("\n")
			.filter((l) => l.includes("google_action.approved"))
			.map((l) => JSON.parse(l).attachments);
		expect(approved).toEqual([1, 1]);
		expect(audit).toMatch(/"type":"quote.changed"[^\n]*"op":"send","count":1/);
		for (const secret of ["Rossi", "rossi.it", "Preventivo-", "g1.xml", "fatture/", "Gamma"]) expect(audit).not.toContain(secret);
	}, 60_000);
});
