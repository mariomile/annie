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
import { buildDraft, scrubPii } from "../src/segreteria/draft.ts";
import { extractLead } from "../src/segreteria/extract.ts";
import { analyzeMail, draftReply } from "../src/segreteria/model.ts";
import { processInboundMail } from "../src/segreteria/pipeline.ts";
import { leadCardAndDraft } from "../src/segreteria/telegram-copy.ts";
import { vatField, vatInMail, withoutVatNumber } from "../src/segreteria/vat.ts";

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

/** A partita IVA that passes the check, for «ora …» cases (the one tax-ids' own tests use). */
const OTHER_GOOD = "00743110157";
const NOTHING = { vatNumber: null, invalid: false };

describe("segreteria: VAT number in a mail", () => {
	it("reads the labels people write, with prefix and separators", () => {
		for (const body of [
			`P.IVA: IT ${GOOD}`,
			"P.IVA: 012 345 609 00, grazie",
			`partita IVA n. ${GOOD}.`,
			`C.F./P.IVA ${GOOD}`,
			`P.IVA/C.F. ${GOOD}`,
			`P.IVA e C.F.: ${GOOD}`,
			`P.IVA n° ${GOOD}`,
			`P.IVA nr. ${GOOD}`,
			`P.IVA.: ${GOOD}`,
			`Partita I.V.A. ${GOOD}`,
			`P.IVA corretta: ${GOOD}`,
			`P.I. ${GOOD}`,
			`p.iva: it${GOOD}`,
			`P.IVA ${GOOD} 333 1234567`,
			`Tel. 333 1234567, P.IVA ${GOOD}`,
		]) {
			expect(vatInMail(body).vatNumber, body).toBe(GOOD);
		}
		for (const body of ["VAT No. DE123456789", "VAT no: DE 123 456 789", "VAT ID: DE123456789", "VAT Reg. No. DE123456789", "USt-IdNr.: DE 123456789", "VAT number: DE 123456789\nBest regards", "VAT DE123456789"]) {
			expect(vatInMail(body).vatNumber, body).toBe("DE123456789");
		}
		expect(vatInMail("VAT number: CHE-123.456.789 MWST").vatNumber).toBe("CHE123456789");
		expect(vatInMail("VAT GB 980 7806 84").vatNumber).toBe("GB980780684");
		expect(vatInMail(`P.IVA ${ENTE}`).vatNumber).toBe(ENTE);
	});

	it("flags a wrong number only near a real shape: 10 to 12 digits, or a VIES prefix and digits", () => {
		for (const body of [`P.IVA ${WRONG}`, `P.IVA: IT ${WRONG}`, "P.IVA: DE12345678", `P.IVA ${GOOD}1`]) {
			expect(vatInMail(body), body).toMatchObject({ vatNumber: null, invalid: true });
		}
		// 10 digits after the label: one short of a partita IVA, likely a typo, so flagged. A landline written there would be too: the label says it is a VAT number.
		expect(vatInMail("P.IVA: 0212345678")).toMatchObject({ vatNumber: null, invalid: true });
		expect(vatInMail("P.IVA 012345678")).toEqual(NOTHING);
	});

	it("leaves amounts, dates, mobile numbers and labels without a number alone", () => {
		for (const body of [
			"Total incl. VAT 1 250 000",
			"VAT 22 000 EUR",
			"Budget 15.000 euro + VAT 20000",
			"vat 12000 L",
			"P.I. 12.03.2024",
			"P.IVA 12-03-2024",
			"Tel. e P.IVA: 333 1234567",
			"P.IVA: 1.250.000.000",
			"Prezzo 1.250.000 P.IVA esclusa",
			"Sono un privato, non ho partita IVA. Grazie",
			"La P.IVA ve la mando dopo; il ponte sollevatore 2 m",
		]) {
			expect(vatInMail(body), body).toEqual(NOTHING);
		}
	});

	it("reads every label: a number written right wins over a wrong one", () => {
		expect(vatInMail(`P.IVA vecchia: ${WRONG}, ora P.IVA: ${OTHER_GOOD}`).vatNumber).toBe(OTHER_GOOD);
		expect(vatInMail(`P.IVA ${WRONG} (vecchia), ora P.IVA ${OTHER_GOOD}`)).toMatchObject({ vatNumber: OTHER_GOOD, invalid: false });
	});

	it("does not backtrack for long on hostile input (100k characters)", () => {
		const started = performance.now();
		for (const body of [`P.IVA ${"1 ".repeat(50_000)}x`, "P.IVA ".repeat(17_000), `P.IVA${" ".repeat(100_000)}x`, `VAT ${"1.".repeat(50_000)}`, `P.IVA e${" ".repeat(100_000)}`, "n° ".repeat(33_000)]) {
			vatInMail(body);
			vatField(body);
		}
		expect(performance.now() - started).toBeLessThan(2000);
	});

});

describe("segreteria: VAT number in the heuristic lead", () => {
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
	const read = async (vatNumber: string | null) => (await analyzeMail(scripted([analysis(vatNumber)]), DEFAULT_MODEL_ROLES.extract, mail(""), { requireVatNumber: true })).lead;

	it("checks what the model read: kept normalized when right, asked again when wrong, asked for when missing", async () => {
		const good = await analyzeMail(scripted([analysis(`IT ${GOOD}`)]), DEFAULT_MODEL_ROLES.extract, mail(""));
		expect(good.lead.vatNumber).toBe(GOOD);
		expect(good.lead.missingFields).toEqual([]);
		expect(good.vatAsWritten).toBe(`IT ${GOOD}`);
		expect(await read(WRONG)).toMatchObject({ vatNumber: null, missingFields: ["vatNumberInvalid"] });
		expect(await read(null)).toMatchObject({ vatNumber: null, missingFields: ["vatNumber"] });
	});

	it("placeholders are no number: asked for as missing, never «non risulta corretta»", async () => {
		for (const value of ["N/A", "n.d.", "-", "null", "None", "Not given", "Chiedere al cliente", "Smith"]) {
			expect(await read(value), value).toMatchObject({ vatNumber: null, missingFields: ["vatNumber"] });
			expect(vatField(value), value).toEqual(NOTHING);
		}
	});

	it("checks only what has a VAT number's shape in the model's value", async () => {
		expect(await read(`IT${OTHER_GOOD} (da verificare)`)).toMatchObject({ vatNumber: OTHER_GOOD, missingFields: [] });
		expect(await read(`P.IVA ${OTHER_GOOD}`)).toMatchObject({ vatNumber: OTHER_GOOD, missingFields: [] });
		expect(await read("DE 123 456 789")).toMatchObject({ vatNumber: "DE123456789", missingFields: [] });
		expect(vatField(`${WRONG} (da verificare)`)).toMatchObject({ vatNumber: null, invalid: true, asWritten: WRONG });
		// No VAT number's shape: a total, a phone number, a codice fiscale.
		for (const value of ["€ 12.000", "333 1234567", "RSSMRA80A01H501X", "15.000"]) expect(vatField(value), value).toEqual(NOTHING);
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
	it("alone: its own paragraph before the close, in Italian and English, passing the CI checks", () => {
		const italian = buildDraft(lead());
		expect(italian.body).toContain("\n\nLe segnaliamo che la partita IVA indicata non risulta corretta: può cortesemente ricontrollarla e inviarcela di nuovo?\n\nRestiamo a disposizione.");
		expect(italian.body).not.toContain("preventivo accurato");
		expect(runDeterministicChecks(checks, { ...italian, mustAsk: ["vatNumberInvalid"], customerEmail: lead().email })).toEqual([]);
		const en = buildDraft(lead({ originalLanguage: "en" }));
		expect(en.body).toContain("\n\nWe noticed that the VAT number you provided does not appear to be correct: could you please check it and send it to us again?\n\nWe remain at your disposal.");
		expect(runDeterministicChecks(checks, { ...en, language: "en", mustAsk: ["vatNumberInvalid"], customerEmail: lead().email })).toEqual([]);
	});

	it("after other questions: «inoltre» / «also», and the questions start lower case after the comma", () => {
		const italian = buildDraft(lead({ missingFields: ["quantity", "deliverySite", "vatNumberInvalid"] }));
		expect(italian.body).toContain("Per prepararle un preventivo accurato, può indicarci la quantità richiesta? Può indicarci la sede di installazione o il luogo di consegna?\n\nLe segnaliamo inoltre che la partita IVA indicata non risulta corretta: può cortesemente ricontrollarla e inviarcela di nuovo?\n\nRestiamo a disposizione.");
		expect(runDeterministicChecks(checks, { ...italian, mustAsk: ["quantity", "deliverySite", "vatNumberInvalid"] })).toEqual([]);
		const en = buildDraft(lead({ originalLanguage: "en", missingFields: ["quantity", "vatNumberInvalid"] }));
		expect(en.body).toContain("To prepare an accurate quote, could you please indicate the required quantity?\n\nWe also noticed that the VAT number");
	});

	it("the re-check ask is exempt from mustNotAskVatNumber (a private customer who gave a number); asking for one is not", () => {
		const recheck = buildDraft(lead({ company: null }));
		expect(runDeterministicChecks(checks, { ...recheck, mustAsk: ["vatNumberInvalid"], mustNotAskVatNumber: true })).toEqual([]);
		const ask = buildDraft(lead({ missingFields: ["vatNumber"] }));
		expect(runDeterministicChecks(checks, { ...ask, mustNotAskVatNumber: true })).toEqual([{ check: "mustAsk", detail: "mustNotAskVatNumber violated" }]);
	});

	it("a draft that asks for the VAT number from scratch does not count as asking to re-check it", () => {
		const draft = buildDraft(lead({ missingFields: ["vatNumber"] }));
		expect(runDeterministicChecks(checks, { ...draft, mustAsk: ["vatNumberInvalid"] })).toEqual([{ check: "mustAsk", detail: "missing question for vatNumberInvalid" }]);
	});

	it("scrubPii takes out VAT numbers written in groups or with a prefix, and keeps amounts", () => {
		const body = "Gentile Cliente, la P.IVA 012 345 609 01 o IT 012.345.609.01 o DE 1234 5678 non torna. Budget 12.000 €, totale 1.250.000.000 €.";
		const out = scrubPii(body, lead());
		for (const gone of ["012 345 609 01", "012.345.609.01", "1234 5678"]) expect(out).not.toContain(gone);
		expect(out).toContain("12.000 €");
		expect(out).toContain("1.250.000.000 €");
	});

	it("withoutVatNumber takes out the customer's number however it is written, and nothing else", () => {
		const out = withoutVatNumber("la partita IVA 0123-456-0901, cioè IT01234560901 o it 012 345 609 01, ordine 12345678901", "012 345 609 01");
		expect(out).not.toMatch(/0123-456-0901|01234560901|609 01/);
		expect(out).toContain("partita IVA ,");
		expect(out).toContain("12345678901");
	});

	it("the owner's card says it in one line, not as a field name", () => {
		const pratica = { praticaId: "abcdef0123456789", lead: lead(), missingFields: ["quantity", "vatNumberInvalid"], draftVersion: 1, draftSubject: "Re: x", draftBody: "…" } as unknown as Pratica;
		const card = leadCardAndDraft(pratica);
		expect(card).toContain("Dati mancanti: quantity\nP.IVA sbagliata: non l'ho salvata, nella bozza chiedo al cliente di ricontrollarla.\n");
		expect(card).not.toContain("vatNumberInvalid");
		expect(card).not.toContain("——");
		const ok = leadCardAndDraft({ ...pratica, missingFields: [] } as Pratica);
		expect(ok).not.toContain("P.IVA");
	});
});

describe("segreteria: a model draft that repeats the wrong number", () => {
	it("draftReply takes it out, even written in a way scrubPii does not catch", async () => {
		const body =
			"Gentile Signor Rinaldi,\n\nLa ringraziamo per la richiesta relativa alle scaffalature.\n\nLe segnaliamo che la partita IVA 0123-456-0901 non risulta corretta: può cortesemente ricontrollarla?\n\nRestiamo a disposizione e Le invieremo il preventivo appena ricevuti i dati.\nCordiali saluti\n[Nome commerciale] · [Azienda]";
		const draft = await draftReply(scripted([JSON.stringify({ subject: "Re: Richiesta preventivo scaffali (P.IVA 0123-456-0901)", body })]), DEFAULT_MODEL_ROLES.draft, {
			mail: mail(`P.IVA: IT ${WRONG}`),
			lead: lead(),
			requests: ["scaffalature"],
			checks,
			vatAsWritten: `IT ${WRONG}`,
		});
		expect(draft.source).toBe("model");
		expect(draft.body).not.toContain("0123-456-0901");
		expect(draft.subject).not.toContain("0123-456-0901");
		expect(draft.body).toContain("la partita IVA non risulta corretta");
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
		expect(pratica.draftBody).toContain("può cortesemente ricontrollarla e inviarcela di nuovo?");
		expect(pratica.draftBody).not.toContain(WRONG);
		expect(notifications.join("\n")).toContain("P.IVA sbagliata: non l'ho salvata");
		const file = auditFile(dataDir, tid("acme"));
		expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain(WRONG);
	});
});
