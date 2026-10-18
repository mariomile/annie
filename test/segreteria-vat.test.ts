import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeCrmAdapter } from "../src/connectors/crm-fake.ts";
import { FakeMailAdapter } from "../src/connectors/mail-fake.ts";
import type { InboundMail } from "../src/connectors/types.ts";
import { AuditLog } from "../src/core/audit.ts";
import type { CompletionRequest, ModelClient } from "../src/core/completion.ts";
import { tenantId as tid } from "../src/core/ids.ts";
import { DEFAULT_MODEL_ROLES, FAUX_MODEL_ROLES } from "../src/core/model-routing.ts";
import { auditFile } from "../src/core/paths.ts";
import { type LeadFields, type Pratica, PracticeStore } from "../src/core/practice.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { loadChecks, runDeterministicChecks } from "../src/segreteria/checks.ts";
import { buildDraft } from "../src/segreteria/draft.ts";
import { extractLead, findVatNumber } from "../src/segreteria/extract.ts";
import { analyzeMail } from "../src/segreteria/model.ts";
import { processInboundMail } from "../src/segreteria/pipeline.ts";
import { leadCardAndDraft } from "../src/segreteria/telegram-copy.ts";

const checks = await loadChecks(join(import.meta.dirname, "..", "evals", "segreteria"));

/** Made-up numbers: GOOD passes the formal check (Luhn digit, VAT office 090), WRONG is GOOD with its last digit off by one. */
const GOOD = "01234560900";
const WRONG = "01234560901";
/** A body's numeric codice fiscale (9 first) that passes the same check. */
const ENTE = "90012340569";

const mail = (body: string, over: Partial<InboundMail> = {}): InboundMail => ({
	messageId: "m1",
	from: "Paolo Rinaldi <p.rinaldi@magazzini.example>",
	fromName: "Paolo Rinaldi",
	subject: "Richiesta preventivo scaffali",
	bodyText: `Buongiorno, sono Paolo Rinaldi di Magazzini Rinaldi Srl. Vorremmo un preventivo per 12 scaffalature, installazione presso il deposito di Forlì entro novembre. ${body}`,
	receivedAt: "2026-10-16T10:00:00.000Z",
	...over,
});

describe("segreteria: VAT number in the heuristics", () => {
	it("finds the number after its label, with prefix and separators, and nothing without a number", () => {
		expect(findVatNumber(`P.IVA: IT ${GOOD}`)).toBe(`IT ${GOOD}`);
		expect(findVatNumber("P.IVA: 012 345 609 00, grazie")).toBe("012 345 609 00");
		expect(findVatNumber(`partita IVA n. ${GOOD}.`)).toBe(GOOD);
		expect(findVatNumber(`C.F./P.IVA ${GOOD}`)).toBe(GOOD);
		expect(findVatNumber("VAT number: DE 123456789\nBest regards")).toBe("DE 123456789");
		expect(findVatNumber(`P.IVA ${GOOD} 333 1234567`)).toBe(GOOD);
		expect(findVatNumber("Sono un privato, non ho partita IVA. Grazie")).toBeNull();
		expect(findVatNumber("La P.IVA ve la mando dopo; il ponte sollevatore 2 m")).toBeNull();
	});

	it("does not backtrack for long on hostile input", () => {
		const started = performance.now();
		findVatNumber(`P.IVA ${"1 ".repeat(50_000)}x`);
		findVatNumber("P.IVA ".repeat(20_000));
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("keeps a number written right, normalized; flags a wrong one instead of keeping it", () => {
		expect(extractLead(mail(`P.IVA: IT 012.345.609.00`))).toMatchObject({ vatNumber: GOOD });
		expect(extractLead(mail("VAT number: DE 123 456 789"))).toMatchObject({ vatNumber: "DE123456789" });
		expect(extractLead(mail(`P.IVA ${ENTE}`))).toMatchObject({ vatNumber: ENTE });
		expect(extractLead(mail(`P.IVA ${GOOD}`)).missingFields).not.toContain("vatNumberInvalid");
		for (const body of [`P.IVA ${WRONG}`, "P.IVA: DE12345678", "P.IVA 0123456789"]) {
			const lead = extractLead(mail(body));
			expect(lead.vatNumber, body).toBeNull();
			expect(lead.missingFields, body).toContain("vatNumberInvalid");
		}
	});

	it("requireVatNumber: a wrong number still needs asking, once; a good one does not", () => {
		const require = { requireVatNumber: true };
		expect(extractLead(mail(""), require).missingFields).toContain("vatNumber");
		const wrong = extractLead(mail(`P.IVA ${WRONG}`), require).missingFields;
		expect(wrong).toContain("vatNumberInvalid");
		expect(wrong).not.toContain("vatNumber");
		const good = extractLead(mail(`P.IVA ${GOOD}`), require).missingFields;
		expect(good).not.toContain("vatNumber");
		expect(good).not.toContain("vatNumberInvalid");
	});
});

/** A model client that answers from a script, in order. */
function scripted(answers: string[]): ModelClient & { requests: CompletionRequest[] } {
	const requests: CompletionRequest[] = [];
	return {
		requests,
		async complete(request) {
			requests.push(request);
			const next = answers.shift();
			if (next === undefined) throw new Error("script exhausted");
			return { text: next, inputTokens: 1000, outputTokens: 250 };
		},
	};
}

const analysis = (vatNumber: string | null) =>
	JSON.stringify({
		classification: "richiesta_preventivo",
		fullName: "Paolo Rinaldi",
		company: "Magazzini Rinaldi Srl",
		productOrService: "scaffalature",
		requests: ["scaffalature"],
		quantity: "12",
		deliverySite: "Forlì",
		vatNumber,
		originalLanguage: "it",
		missing: [],
	});

describe("segreteria: VAT number from the model", () => {
	it("checks what the model read: kept normalized when right, asked again when wrong", async () => {
		const good = await analyzeMail(scripted([analysis(`IT ${GOOD}`)]), DEFAULT_MODEL_ROLES.extract, mail(""));
		expect(good.lead.vatNumber).toBe(GOOD);
		expect(good.lead.missingFields).toEqual([]);
		const wrong = await analyzeMail(scripted([analysis(WRONG)]), DEFAULT_MODEL_ROLES.extract, mail(""), { requireVatNumber: true });
		expect(wrong.lead.vatNumber).toBeNull();
		expect(wrong.lead.missingFields).toEqual(["vatNumberInvalid"]);
		const missing = await analyzeMail(scripted([analysis(null)]), DEFAULT_MODEL_ROLES.extract, mail(""), { requireVatNumber: true });
		expect(missing.lead.missingFields).toEqual(["vatNumber"]);
	});
});

const lead = (over: Partial<LeadFields> = {}): LeadFields => ({
	fullName: "Paolo Rinaldi",
	company: "Magazzini Rinaldi Srl",
	email: "p.rinaldi@magazzini.example",
	productOrService: "scaffalature",
	vatNumber: null,
	missingFields: ["vatNumberInvalid"],
	source: "email",
	rawSubject: "Richiesta preventivo",
	rawSnippet: "",
	receivedAt: "2026-10-16T10:00:00.000Z",
	mailMessageId: "m1",
	...over,
});

describe("segreteria: a wrong VAT number in the draft and on the card", () => {
	it("the draft asks politely to double-check it, in Italian and English, and passes the CI checks", () => {
		const italian = buildDraft(lead());
		expect(italian.body).toContain("La partita IVA che ci ha indicato non risulta corretta: può ricontrollarla?");
		expect(runDeterministicChecks(checks, { ...italian, mustAsk: ["vatNumberInvalid"], customerEmail: lead().email })).toEqual([]);
		const en = buildDraft(lead({ originalLanguage: "en" }));
		expect(en.body).toContain("The VAT number you gave us does not appear to be correct: could you please double-check it?");
		expect(runDeterministicChecks(checks, { ...en, mustAsk: ["vatNumberInvalid"], customerEmail: lead().email })).toEqual([]);
	});

	it("a draft that asks for the VAT number from scratch does not count as asking to double-check it", () => {
		const draft = buildDraft(lead({ missingFields: ["vatNumber"] }));
		expect(runDeterministicChecks(checks, { ...draft, mustAsk: ["vatNumberInvalid"] })).toEqual([{ check: "mustAsk", detail: "missing question for vatNumberInvalid" }]);
	});

	it("the owner's card says it in one line, not as a field name", () => {
		const pratica = { praticaId: "abcdef0123456789", lead: lead(), missingFields: ["quantity", "vatNumberInvalid"], draftVersion: 1, draftSubject: "Re: x", draftBody: "…" } as unknown as Pratica;
		const card = leadCardAndDraft(pratica);
		expect(card).toContain("Dati mancanti: quantity\nP.IVA: quella indicata non supera il controllo formale, nella bozza chiedo di ricontrollarla.\n");
		expect(card).not.toContain("vatNumberInvalid");
		expect(card).not.toContain("——");
		const ok = leadCardAndDraft({ ...pratica, missingFields: [] } as Pratica);
		expect(ok).not.toContain("P.IVA");
	});
});

describe("segreteria: a wrong VAT number through the pipeline", () => {
	it("goes to the CRM as missing, never as the number; the draft and the audit never repeat it", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "annie-seg-vat-"));
		const crm = new FakeCrmAdapter();
		const audit = new AuditLog(dataDir, tid("acme"));
		const notifications: string[] = [];
		const { pratica } = await processInboundMail(
			{
				tenantId: "acme",
				instanceId: "segreteria",
				practices: new PracticeStore(join(dataDir, "acme", "instances", "segreteria")),
				mail: new FakeMailAdapter(),
				crm,
				audit,
				usage: new UsageLedger(join(dataDir, "acme")),
				roles: FAUX_MODEL_ROLES,
				notify: async (msg) => {
					notifications.push(msg.text);
				},
			},
			mail(`P.IVA: IT ${WRONG}`),
		);
		const [entry] = [...crm.leads.values()];
		expect(entry?.lead.vatNumber).toBeNull();
		expect(entry?.lead.missingFields).toContain("vatNumberInvalid");
		expect(pratica.draftBody).toContain("può ricontrollarla?");
		expect(pratica.draftBody).not.toContain(WRONG);
		expect(notifications.join("\n")).toContain("P.IVA: quella indicata non supera il controllo formale");
		const file = auditFile(dataDir, tid("acme"));
		expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain(WRONG);
	});
});
