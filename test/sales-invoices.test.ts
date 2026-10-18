import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { readOnlyInBriefs } from "../src/core/brief.ts";
import type { ClientCard } from "../src/core/clients.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { AnnieTool, ToolContext } from "../src/core/engine.ts";
import { fatturaData, fatturaText } from "../src/core/fattura-pa.ts";
import { fatturaXml } from "../src/core/fattura-pa-writer.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { type Company, register } from "../src/core/invoices.ts";
import { makeDocument } from "../src/core/make-document.ts";
import { latin1 } from "../src/core/plain-text.ts";
import { QuoteStore } from "../src/core/quote-store.ts";
import type { Quote } from "../src/core/quotes.ts";
import { FIELD_LIMITS, FORFETTARIO_DICITURA, NATURE } from "../src/core/sales-invoice-rules.ts";
import { SALES_BROKEN, SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import { amount2, salesTotals } from "../src/core/sales-invoice-sums.ts";
import { type IssuedInvoice, isIssued, italianAddress, progressiveCode, salesAgentReads, salesCallReads, type SalesInvoice } from "../src/core/sales-invoices.ts";
import { NATURA } from "../src/core/fattura-pa-codes.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import type { WorkEntry } from "../src/core/timesheet.ts";
import { TimesheetStore } from "../src/core/timesheet-store.ts";
import { createSalesInvoiceTools, type SalesEvent } from "../src/core/tools/sales-invoice-tools.ts";
import { child, children, descendant, parseXml, type XmlElement } from "../src/core/xml-tree.ts";
import { Workspace } from "../src/core/workspace.ts";

// Every tax id here is made up and passes its checksum; every name is invented.
const SELLER_VAT = "IT03311220036";
const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday 18 October 2026, in Rome
let calls = 0;
const fresh = (callId = `c${++calls}`, thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, signal: new AbortController().signal, callId, thread });

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "annie-sales-"));
	dirs.push(dir);
	return dir;
}

const IBAN = "IT60X0542811101000000123456";
const ORDINARIO: Company = { vat: SELLER_VAT, name: "Beta Studio Srl", cf: "03311220036", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: [IBAN], by: "test:u", at: NOW.toISOString() };
const FORFETTARIO: Company = { ...ORDINARIO, name: "Giuseppe Verdi", cf: "VRDGPP75C10F205G", regime: "forfettario" };

/** A business customer, said in full. */
const DELTA = { customer: "Delta Servizi Srl", vat_number: "00743110157", address: "Via Verdi 2, 00184 Roma RM", recipient_code: "M5UXCR1" };
const line = (description: string, price: number | string, extra: Record<string, unknown> = {}) => ({ description, price, ...extra });

const quote = (o: Partial<Quote> = {}): Quote => ({
	number: "2026-004",
	base: "2026-004",
	revision: 0,
	date: "2026-10-01",
	validDays: 30,
	customer: { name: "Delta Servizi Srl", vat: "00743110157", address: "Via Verdi 2, 00184 Roma RM" },
	lines: [{ description: "Sito web", quantity: "1", price: "1000", vat: 22 }],
	terms: "Bonifico a 60 giorni fine mese",
	status: "accepted",
	file: "preventivi/Preventivo-2026-004.pdf",
	by: "test:u",
	at: NOW.toISOString(),
	...o,
});

const entry = (n: number, minutes: number, extra: Partial<WorkEntry> = {}): WorkEntry => ({ id: `O-2026-000${n}`, date: `2026-10-0${n}`, client: "Delta Servizi Srl", minutes, billable: true, rate: "50", description: `Sviluppo ${n}`, by: "test:u", at: NOW.toISOString(), ...extra });

type Setup = { company?: Company | null; quotes?: Quote[]; entries?: WorkEntry[]; cards?: ClientCard[]; real?: boolean };

function setup(o: Setup = {}) {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	if (o.company !== null) invoices.setCompany(o.company ?? ORDINARIO);
	writeFileSync(join(dir, "quotes.json"), JSON.stringify({ next: { 2026: 10 }, quotes: o.quotes ?? [] }));
	writeFileSync(join(dir, "timesheet.json"), JSON.stringify({ next: { 2026: 10 }, entries: o.entries ?? [], timers: [], rates: [], reservations: [] }));
	const quotes = new QuoteStore(dir);
	const timesheet = new TimesheetStore(dir, { now: () => clock.now });
	const store = new SalesInvoiceStore(dir);
	const events: SalesEvent[] = [];
	const clock = { now: NOW };
	const made: string[] = [];
	const [tool] = createSalesInvoiceTools({
		workspace,
		store,
		company: invoices,
		taxes: new TaxStore(dir),
		clients: { read: () => ({ cards: o.cards ?? [], nextCard: 1, nextFollowUp: 1, calls: [], broken: false }) },
		quotes,
		timesheet,
		timeZone: "Europe/Rome",
		whoIs: () => "test:u",
		record: async (e) => {
			events.push(e);
		},
		now: () => clock.now,
		make: async (input) => {
			made.push(input.text);
			return o.real === true ? makeDocument(input) : { data: Buffer.from(`%PDF-1.4 finta\n${input.text}`), notes: [] };
		},
	});
	if (tool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const last = (): SalesInvoice => store.read().invoices.at(-1) as SalesInvoice;
	/** A draft, then its issue after the yes: the invoice issued. */
	const issued = async (args: Record<string, unknown>): Promise<{ inv: IssuedInvoice; answer: string; draft: string }> => {
		const draft = await run({ op: "draft", ...args });
		const id = last().id;
		expect(isIssued(last()), draft).toBe(false);
		const answer = await run({ op: "issue", draft: id, confirm: true });
		const inv = store.read().invoices.find((i) => i.id === id);
		if (inv === undefined || !isIssued(inv)) throw new Error(`not issued: ${answer}`);
		return { inv, answer, draft };
	};
	const xmlOf = (inv: IssuedInvoice) => readFileSync(join(root, inv.file as string), "utf8");
	return { dir, root, workspace, invoices, quotes, timesheet, store, events, clock, made, tool, run, last, issued, xmlOf, at: (iso: string) => (clock.now = new Date(iso)) };
}

const tree = (xml: string): XmlElement => parseXml(xml, { maxElements: 100_000, maxDepth: 64 });
const text = (el: XmlElement | undefined, path: string) => {
	const found = descendant(el, path);
	return found?.text;
};
const names = (el: XmlElement | undefined) => (el?.children ?? []).map((c) => c.name);
const body = (xml: string) => child(tree(xml), "FatturaElettronicaBody");

/** The order FatturaPA 1.2.2 gives the children of each block (the subset written here). */
const ORDER: Record<string, readonly string[]> = {
	FatturaElettronica: ["FatturaElettronicaHeader", "FatturaElettronicaBody"],
	FatturaElettronicaHeader: ["DatiTrasmissione", "CedentePrestatore", "RappresentanteFiscale", "CessionarioCommittente"],
	DatiTrasmissione: ["IdTrasmittente", "ProgressivoInvio", "FormatoTrasmissione", "CodiceDestinatario", "ContattiTrasmittente", "PECDestinatario"],
	CedentePrestatore: ["DatiAnagrafici", "Sede", "StabileOrganizzazione", "IscrizioneREA", "Contatti", "RiferimentoAmministrazione"],
	DatiAnagrafici: ["IdFiscaleIVA", "CodiceFiscale", "Anagrafica", "AlboProfessionale", "ProvinciaAlbo", "NumeroIscrizioneAlbo", "DataIscrizioneAlbo", "RegimeFiscale"],
	Sede: ["Indirizzo", "NumeroCivico", "CAP", "Comune", "Provincia", "Nazione"],
	FatturaElettronicaBody: ["DatiGenerali", "DatiBeniServizi", "DatiVeicoli", "DatiPagamento", "Allegati"],
	DatiGenerali: ["DatiGeneraliDocumento", "DatiOrdineAcquisto", "DatiContratto", "DatiConvenzione", "DatiRicezione", "DatiFattureCollegate"],
	DatiGeneraliDocumento: ["TipoDocumento", "Divisa", "Data", "Numero", "DatiRitenuta", "DatiBollo", "DatiCassaPrevidenziale", "ScontoMaggiorazione", "ImportoTotaleDocumento", "Arrotondamento", "Causale", "Art73"],
	DatiRitenuta: ["TipoRitenuta", "ImportoRitenuta", "AliquotaRitenuta", "CausalePagamento"],
	DatiBollo: ["BolloVirtuale", "ImportoBollo"],
	DatiCassaPrevidenziale: ["TipoCassa", "AlCassa", "ImportoContributoCassa", "ImponibileCassa", "AliquotaIVA", "Ritenuta", "Natura", "RiferimentoAmministrazione"],
	DatiBeniServizi: ["DettaglioLinee", "DatiRiepilogo"],
	DettaglioLinee: ["NumeroLinea", "TipoCessionePrestazione", "CodiceArticolo", "Descrizione", "Quantita", "UnitaMisura", "DataInizioPeriodo", "DataFinePeriodo", "PrezzoUnitario", "ScontoMaggiorazione", "PrezzoTotale", "AliquotaIVA", "Ritenuta", "Natura", "RiferimentoAmministrazione", "AltriDatiGestionali"],
	DatiRiepilogo: ["AliquotaIVA", "Natura", "SpeseAccessorie", "Arrotondamento", "ImponibileImporto", "Imposta", "EsigibilitaIVA", "RiferimentoNormativo"],
	DatiPagamento: ["CondizioniPagamento", "DettaglioPagamento"],
	DettaglioPagamento: ["Beneficiario", "ModalitaPagamento", "DataRiferimentoTerminiPagamento", "GiorniTerminiPagamento", "DataScadenzaPagamento", "ImportoPagamento", "CodUfficioPostale", "CognomeQuietanzante", "NomeQuietanzante", "CFQuietanzante", "TitoloQuietanzante", "IstitutoFinanziario", "IBAN"],
};

/** Every block's children in the schema's order, recursively; repeated blocks kept together. */
function checkOrder(el: XmlElement, path = el.name): void {
	const order = ORDER[el.name];
	if (order !== undefined) {
		const seen = names(el);
		const positions = seen.map((n) => order.indexOf(n));
		expect(positions.every((p) => p >= 0), `${path}: ${seen.join(", ")}`).toBe(true);
		expect([...positions].sort((a, b) => a - b), `${path}: ${seen.join(", ")}`).toEqual(positions);
	}
	for (const c of el.children) checkOrder(c, `${path}/${c.name}`);
}

/** The XML read back by the reader: the same totals, VAT, ritenuta, bollo and due date as the sums. */
function roundTrip(inv: IssuedInvoice, xml: string): void {
	const t = salesTotals(inv);
	const data = Buffer.from(xml, "utf8");
	const read = fatturaData(data, false);
	const doc = read.documents[0];
	expect(doc?.number).toBe(inv.number);
	expect(doc?.date).toBe(inv.date);
	expect(doc?.type).toBe(inv.type);
	expect(doc?.total).toBe(amount2(t.total));
	expect(Number(doc?.taxable).toFixed(2)).toBe(amount2(t.taxable));
	expect(read.supplier.vat?.code).toBe(SELLER_VAT.slice(2));
	if (inv.type === "TD01") {
		expect(doc?.instalments).toHaveLength(1);
		expect(doc?.instalments[0]?.amount).toBe(amount2(t.toPay));
		expect(doc?.instalments[0]?.due).toBe(inv.due);
		if (inv.payment?.iban !== undefined) expect(doc?.instalments[0]?.iban).toBe(inv.payment.iban);
	}
	const b = body(xml);
	const vat = children(child(b, "DatiBeniServizi"), "DatiRiepilogo").reduce((s, r) => s + Number(text(r, "Imposta")), 0);
	expect(vat.toFixed(2)).toBe(amount2(t.vat));
	expect(text(b, "DatiGenerali/DatiGeneraliDocumento/DatiRitenuta/ImportoRitenuta")).toBe(t.ritenuta > 0n ? amount2(t.ritenuta) : undefined);
	expect(text(b, "DatiGenerali/DatiGeneraliDocumento/DatiBollo/ImportoBollo")).toBe(t.bollo.due ? "2.00" : undefined);
	// The reader's own summary agrees too.
	const summary = fatturaText(data, false).text;
	expect(summary).toContain(inv.number);
	checkOrder(tree(xml));
}

describe("forfettario", () => {
	it("writes no VAT, N2.2 and the dicitura; no bollo at 77,47", async () => {
		const s = setup({ company: FORFETTARIO });
		const { inv, answer } = await s.issued({ ...DELTA, lines: [line("Consulenza", "77.47")] });
		expect(answer).toContain("Fatto, ho emesso la fattura n. 1 del 18/10/2026.");
		expect(answer).toContain("Fatture e Corrispettivi");
		const xml = s.xmlOf(inv);
		expect(inv.file).toBe(`fatture/emesse/${SELLER_VAT}_00001.xml`);
		expect(xml).toContain("<RegimeFiscale>RF19</RegimeFiscale>");
		expect(xml).toContain("<Natura>N2.2</Natura>");
		expect(xml).toContain("<AliquotaIVA>0.00</AliquotaIVA>");
		expect(xml).toContain(`<Causale>${latin1(FORFETTARIO_DICITURA).replace("'", "&apos;")}</Causale>`);
		expect(xml).not.toContain("DatiBollo");
		expect(xml).not.toContain("DatiRitenuta");
		roundTrip(inv, xml);
	});

	it("declares the bollo past 77,47 and asks once who pays it", async () => {
		const s = setup({ company: FORFETTARIO });
		const asked = await s.run({ op: "draft", ...DELTA, lines: [line("Consulenza", "77.48")] });
		expect(asked).toContain("bollo virtuale da 2,00 €");
		expect(s.store.read().invoices).toHaveLength(0);
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", "77.48")], bollo_to_client: false });
		const xml = s.xmlOf(inv);
		expect(xml).toMatch(/<DatiBollo>\s*<BolloVirtuale>SI<\/BolloVirtuale>\s*<ImportoBollo>2.00<\/ImportoBollo>\s*<\/DatiBollo>/);
		expect(salesTotals(inv).total).toBe(7748n);
		roundTrip(inv, xml);
		// Said once: the next invoice does not ask again.
		expect(s.store.read().settings?.bolloToClient).toBe(false);
		const next = await s.run({ op: "draft", ...DELTA, lines: [line("Formazione", 300)] });
		expect(next).toContain("Bozza");
		expect(next).toContain("a carico tuo");
	});

	it("adds the bollo as a line when the customer pays it", async () => {
		const s = setup({ company: FORFETTARIO });
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", 500)], bollo_to_client: true });
		const t = salesTotals(inv);
		expect(t.total).toBe(50200n);
		expect(t.lines.at(-1)?.description).toBe("Imposta di bollo assolta in modo virtuale");
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<Natura>N1</Natura>");
		expect(xml).toContain("<ImportoBollo>2.00</ImportoBollo>");
		roundTrip(inv, xml);
	});

	it("refuses VAT and the ritenuta", async () => {
		const s = setup({ company: FORFETTARIO });
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("Consulenza", 100)], vat: 22 })).toContain("senza IVA");
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("Consulenza", 100)], ritenuta: true })).toContain("non hanno la ritenuta");
	});
});

describe("ordinario", () => {
	it("writes 22% VAT with the payment, the IBAN and the due date", async () => {
		const s = setup();
		const { inv, draft } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		expect(draft).toContain("se la emetti oggi avrà il numero 1");
		const t = salesTotals(inv);
		expect([t.taxable, t.vat, t.total, t.toPay]).toEqual([100000n, 22000n, 122000n, 122000n]);
		expect(inv.due).toBe("2026-11-17");
		const xml = s.xmlOf(inv);
		expect(xml).toContain('versione="FPR12"');
		expect(xml).toContain("<FormatoTrasmissione>FPR12</FormatoTrasmissione>");
		expect(xml).toContain("<CodiceDestinatario>M5UXCR1</CodiceDestinatario>");
		expect(xml).toContain("<RegimeFiscale>RF01</RegimeFiscale>");
		expect(xml).toContain("<ModalitaPagamento>MP05</ModalitaPagamento>");
		expect(xml).toContain("<EsigibilitaIVA>I</EsigibilitaIVA>");
		expect(xml).not.toContain("PECDestinatario");
		roundTrip(inv, xml);
	});

	it("groups mixed rates, a nature line and rounds per summary row", async () => {
		const s = setup();
		const lines = [line("Progetto", 1000), line("Libro", "19.99", { vat: 4, quantity: 3 }), line("Ristorazione", "33.33", { vat: 10, quantity: 3 }), line("Corso esente", 100, { vat: 0, natura: "N4" })];
		expect(await s.run({ op: "draft", ...DELTA, lines })).toContain("l'aliquota IVA delle voci");
		const { inv } = await s.issued({ ...DELTA, lines, vat: 22, bollo_to_client: false });
		const t = salesTotals(inv);
		expect(t.rows.map((r) => [r.vat, r.natura, r.taxable, r.tax])).toEqual([
			[22, undefined, 100000n, 22000n],
			[10, undefined, 9999n, 1000n],
			[4, undefined, 5997n, 240n],
			[0, "N4", 10000n, 0n],
		]);
		expect(t.bollo.due).toBe(true);
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<Natura>N4</Natura>");
		roundTrip(inv, xml);
	});

	it("takes the ritenuta at 20% on the fees", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", 1000)], vat: 22, ritenuta: true });
		const t = salesTotals(inv);
		expect([t.ritenuta, t.total, t.toPay]).toEqual([20000n, 122000n, 102000n]);
		const xml = s.xmlOf(inv);
		expect(xml).toMatch(/<DatiRitenuta>\s*<TipoRitenuta>RT02<\/TipoRitenuta>\s*<ImportoRitenuta>200.00<\/ImportoRitenuta>\s*<AliquotaRitenuta>20.00<\/AliquotaRitenuta>\s*<CausalePagamento>A<\/CausalePagamento>/);
		expect(xml).toContain("<Ritenuta>SI</Ritenuta>");
		roundTrip(inv, xml);
	});

	it("adds the rivalsa INPS at 4%, with VAT on it and in the ritenuta's base", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", 1000)], vat: 22, ritenuta: true, cassa: { kind: "rivalsa_inps" } });
		const t = salesTotals(inv);
		expect([t.cassaTotal, t.taxable, t.vat, t.total, t.ritenuta, t.toPay]).toEqual([4000n, 104000n, 22880n, 126880n, 20800n, 106080n]);
		const xml = s.xmlOf(inv);
		expect(xml).toMatch(/<DatiCassaPrevidenziale>\s*<TipoCassa>TC22<\/TipoCassa>\s*<AlCassa>4.00<\/AlCassa>\s*<ImportoContributoCassa>40.00<\/ImportoContributoCassa>\s*<ImponibileCassa>1000.00<\/ImponibileCassa>\s*<AliquotaIVA>22.00<\/AliquotaIVA>\s*<Ritenuta>SI<\/Ritenuta>/);
		roundTrip(inv, xml);
	});

	it("puts a cassa's contributo on the imponibile, VAT on both, and the ritenuta on the fees only", async () => {
		const s = setup();
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("Parere", 1000)], vat: 22, cassa: { kind: "contributo_integrativo" } })).toContain("di quale cassa professionale");
		const { inv } = await s.issued({ ...DELTA, lines: [line("Parere", 1000)], vat: 22, ritenuta: true, cassa: { kind: "contributo_integrativo", type: "TC01" } });
		const t = salesTotals(inv);
		expect([t.cassaTotal, t.taxable, t.vat, t.total, t.ritenutaBase, t.ritenuta, t.toPay]).toEqual([4000n, 104000n, 22880n, 126880n, 100000n, 20000n, 106880n]);
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<TipoCassa>TC01</TipoCassa>");
		expect(descendant(body(xml), "DatiGenerali/DatiGeneraliDocumento/DatiCassaPrevidenziale/Ritenuta")).toBeUndefined();
		roundTrip(inv, xml);
	});
});

describe("customers", () => {
	it("writes 0000000 for a private person and says the copy goes to them", async () => {
		const s = setup();
		const { inv, answer } = await s.issued({ customer: "Laura Bianchi", cf: "BNCLRA80A41H501D", address: "Via Dante 3, 40121 Bologna BO", lines: [line("Ripetizioni", 60)], vat: 22 });
		expect(inv.buyer.kind).toBe("private");
		expect(answer).toContain("una copia va data al cliente");
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<CodiceDestinatario>0000000</CodiceDestinatario>");
		const buyer = child(child(tree(xml), "FatturaElettronicaHeader"), "CessionarioCommittente");
		expect(text(buyer, "DatiAnagrafici/CodiceFiscale")).toBe("BNCLRA80A41H501D");
		expect(descendant(buyer, "DatiAnagrafici/IdFiscaleIVA")).toBeUndefined();
		expect(text(buyer, "DatiAnagrafici/Anagrafica/Denominazione")).toBe("Laura Bianchi");
		roundTrip(inv, xml);
	});

	it("writes the PEC only with 0000000", async () => {
		const s = setup();
		const { inv } = await s.issued({ customer: "Omega Srl", vat_number: "03311220036", address: "Corso Italia 9, 10121 Torino TO", pec: "omega@pec.example", lines: [line("Servizio", 100)], vat: 22 });
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<CodiceDestinatario>0000000</CodiceDestinatario>");
		expect(xml).toContain("<PECDestinatario>omega@pec.example</PECDestinatario>");
		checkOrder(tree(xml));
	});

	it("writes XXXXXXX for a foreign customer", async () => {
		const s = setup();
		const { inv } = await s.issued({ customer: "Muster GmbH", vat_number: "DE136695976", address: "Hauptstrasse 5, 10115 Berlin", lines: [line("Consulenza", 800)], vat: 0, natura: "N2.1", reference: "Art. 7-ter DPR 633/72", bollo_to_client: false });
		expect(inv.buyer).toMatchObject({ kind: "foreign", code: "XXXXXXX", address: { country: "DE", cap: "00000" } });
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<CodiceDestinatario>XXXXXXX</CodiceDestinatario>");
		expect(xml).toMatch(/<IdPaese>DE<\/IdPaese>\s*<IdCodice>136695976<\/IdCodice>/);
		expect(xml).toContain("<Nazione>DE</Nazione>");
		expect(xml).toContain("<RiferimentoNormativo>Art. 7-ter DPR 633/72</RiferimentoNormativo>");
		roundTrip(inv, xml);
	});

	it("writes FPA12 for a public office, with split payment and the order", async () => {
		const s = setup();
		const { inv } = await s.issued({ customer: "Comune di Esempio", cf: "80012345678", address: "Piazza Municipio 1, 80100 Napoli NA", recipient_code: "UFABCD", lines: [line("Manutenzione", 1000)], vat: 22, split_payment: true, order: { id: "DET-12", cig: "Z1234567890" } });
		expect(inv.buyer.kind).toBe("pa");
		const t = salesTotals(inv);
		expect([t.total, t.toPay]).toEqual([122000n, 100000n]);
		const xml = s.xmlOf(inv);
		expect(xml).toContain('versione="FPA12"');
		expect(xml).toContain("<FormatoTrasmissione>FPA12</FormatoTrasmissione>");
		expect(xml).toContain("<CodiceDestinatario>UFABCD</CodiceDestinatario>");
		expect(xml).toContain("<EsigibilitaIVA>S</EsigibilitaIVA>");
		expect(xml).toContain("<CodiceCIG>Z1234567890</CodiceCIG>");
		const read = fatturaData(Buffer.from(xml), false);
		expect(read.publicAdmin).toBe(true);
		expect(read.documents[0]?.splitVat).toBeDefined();
		roundTrip(inv, xml);
	});

	it("asks what FatturaPA needs of the customer, and never guesses it", async () => {
		const s = setup();
		const answer = await s.run({ op: "draft", customer: "Nuovo Cliente Srl", lines: [line("Servizio", 100)], vat: 22 });
		expect(answer).toContain("la partita IVA del cliente");
		expect(answer).toContain("CAP, comune e provincia");
		expect(answer).toContain("non inventarli");
		expect(s.store.read().invoices).toHaveLength(0);
		const bad = await s.run({ op: "draft", ...DELTA, address: "Via Verdi 2, Roma", lines: [line("Servizio", 100)], vat: 22 });
		expect(bad).toContain("«Via Roma 1, 20121 Milano MI»");
	});

	it("takes the customer from a client's card", async () => {
		const card: ClientCard = { id: "CL-0001", name: "Delta Servizi Srl", aliases: ["Delta"], vat: "IT00743110157", address: "Via Verdi 2, 00184 Roma RM", tags: [], contacts: [], notes: [], followUps: [], contactLog: [], by: "test:u", at: NOW.toISOString() } as unknown as ClientCard;
		const s = setup({ cards: [card] });
		const answer = await s.run({ op: "draft", customer: "Delta", recipient_code: "M5UXCR1", lines: [line("Servizio", 100)], vat: 22 });
		expect(answer).toContain("Bozza BZ-0001");
		expect(s.last().buyer).toMatchObject({ name: "Delta Servizi Srl", vat: "IT00743110157", card: "CL-0001" });
	});
});

describe("the seller", () => {
	it("asks for what is missing from the company's data", async () => {
		const s = setup({ company: { vat: SELLER_VAT, name: "Beta Studio Srl", by: "test:u", at: NOW.toISOString() } });
		const answer = await s.run({ op: "draft", ...DELTA, lines: [line("Servizio", 100)], vat: 22 });
		expect(answer).toContain("il codice fiscale");
		expect(answer).toContain("il regime fiscale");
		expect(answer).toContain("l'indirizzo della sede");
		expect(answer).toContain("non inventarli");
		expect(s.store.read().invoices).toHaveLength(0);
		const none = setup({ company: null });
		expect(await none.run({ op: "draft", ...DELTA, lines: [line("Servizio", 100)], vat: 22 })).toContain("la partita IVA");
	});

	it("reads the company's address in its parts", () => {
		expect(italianAddress("Via Roma 1, 20121 Milano (MI)")).toEqual({ street: "Via Roma 1", cap: "20121", town: "Milano", province: "MI", country: "IT" });
		expect(italianAddress("Viale dei Mille 10 - 50131 Firenze FI, Italia")).toMatchObject({ cap: "50131", town: "Firenze", province: "FI" });
		expect(italianAddress("Via Roma 1, Milano")).toBeUndefined();
	});
});

describe("credit notes", () => {
	it("makes a TD04 that refers to the invoice, and never credits more than its total", async () => {
		const s = setup();
		const { inv: original } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		const draft = await s.run({ op: "credit_note", invoice: "1" });
		expect(draft).toContain("nota di credito a Delta Servizi Srl");
		const id = s.last().id;
		const answer = await s.run({ op: "issue", draft: id, confirm: true });
		expect(answer).toContain("ho emesso la nota di credito n. 2 del 18/10/2026");
		const note = s.store.read().invoices.find((i) => i.id === id) as IssuedInvoice;
		const xml = s.xmlOf(note);
		expect(xml).toContain("<TipoDocumento>TD04</TipoDocumento>");
		expect(xml).toMatch(/<DatiFattureCollegate>\s*<IdDocumento>1<\/IdDocumento>\s*<Data>2026-10-18<\/Data>\s*<\/DatiFattureCollegate>/);
		expect(xml).not.toContain("DatiPagamento");
		expect(salesTotals(note).total).toBe(salesTotals(original).total);
		roundTrip(note, xml);
		expect(fatturaData(Buffer.from(xml), false).documents[0]?.credit).toBe(true);
		expect(await s.run({ op: "credit_note", invoice: "1", lines: [line("Altro", 10)] })).toContain("non si può stornare più del totale");
		expect(await s.run({ op: "credit_note", invoice: "7" })).toContain("non trovo una fattura emessa");
	});

	it("credits part of an invoice with the lines given", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000), line("Hosting", 200)], vat: 22 });
		await s.run({ op: "credit_note", invoice: "1", lines: [line("Sconto concordato sul sito", 100)] });
		expect(salesTotals(s.last()).total).toBe(12200n);
		expect(s.last().related?.number).toBe("1");
	});
});

describe("numbering", () => {
	it("starts again each calendar year and can be written with the year", async () => {
		const s = setup();
		expect((await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 })).inv.number).toBe("1");
		expect((await s.issued({ ...DELTA, lines: [line("B", 100)], vat: 22 })).inv.number).toBe("2");
		expect(await s.run({ op: "settings", numbering: "year" })).toContain("lo cambio solo dall'anno prossimo");
		s.at("2027-01-04T09:00:00Z");
		expect(await s.run({ op: "settings", numbering: "year" })).toContain("Fatto, ho salvato.");
		const third = (await s.issued({ ...DELTA, lines: [line("C", 100)], vat: 22 })).inv;
		expect([third.number, third.year, third.seq]).toEqual(["2027/1", 2027, 1]);
		expect(third.progressive).toBe("00003");
		expect(await s.run({ op: "list", year: 2026 })).toContain("Nel 2026: 2 fatture");
		expect(await s.run({ op: "list" })).toContain("Nel 2027: una fattura");
	});

	it("never gives one number twice when two issues run at once", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		const [a, b] = s.store.read().invoices.map((i) => i.id);
		await Promise.all([s.run({ op: "issue", draft: a, confirm: true }), s.run({ op: "issue", draft: b, confirm: true })]);
		const issued = s.store.read().invoices.filter(isIssued);
		expect(issued.map((i) => i.number).sort()).toEqual(["1", "2"]);
		expect(new Set(issued.map((i) => i.file)).size).toBe(2);
	});

	it("gives a removed draft no number", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const first = s.last().id;
		const removed = await s.run({ op: "remove", draft: first });
		expect(removed).toContain("Nessun numero è stato usato");
		const { inv } = await s.issued({ ...DELTA, lines: [line("B", 100)], vat: 22 });
		expect(inv.number).toBe("1");
		expect(inv.id).toBe("BZ-0002");
		expect(await s.run({ op: "remove", draft: inv.id })).toContain("non si può togliere");
	});

	it("issues only after the yes", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const ask = await s.run({ op: "issue", draft: s.last().id });
		expect(ask).toContain("la emetto solo dopo il suo sì");
		expect(isIssued(s.last())).toBe(false);
		expect(readdirSync(s.root)).toEqual([]);
	});
});

describe("calls run again", () => {
	/** A context whose steps are kept, as the engine keeps them, for a call run again. */
	const durable = (callId: string): ToolContext => {
		const kept = new Map<string, unknown>();
		return {
			step: async (key, work) => {
				if (kept.has(key)) return kept.get(key) as never;
				const out = await work();
				kept.set(key, out);
				return out;
			},
			progress: () => {},
			signal: new AbortController().signal,
			callId,
			thread: { channel: "test", threadId: "t1" },
		};
	};

	it("makes one draft and issues one number per call id", async () => {
		const s = setup();
		const d = durable("draft-1");
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 }, d);
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 }, d);
		expect(s.store.read().invoices).toHaveLength(1);
		const i = durable("issue-1");
		const id = s.last().id;
		const first = await s.run({ op: "issue", draft: id, confirm: true }, i);
		const again = await s.run({ op: "issue", draft: id, confirm: true }, i);
		const unfenced = (t: string) => t.replace(/fatture emesse [0-9a-f]{12}/g, "fatture emesse");
		expect(unfenced(again)).toBe(unfenced(first));
		expect(s.store.read().next).toEqual({ 2026: 2 });
		expect(s.events.filter((e) => e.op === "issue")).toHaveLength(1);
	});

	it("finishes an invoice issued whose file was never written", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const draft = s.last();
		// Stopped right after the number was taken.
		const { inv } = { inv: s.store.issue(draft.id, "lost-call", "2026-10-18", (d, number, seq, progressive) => ({ ...d, number, year: 2026, seq, date: "2026-10-18", due: "2026-11-17", seller: { name: "Beta Studio Srl", vat: SELLER_VAT, cf: "03311220036", regime: "RF01", address: { street: "Via Roma 1", cap: "20121", town: "Milano", province: "MI", country: "IT" } }, progressive, issued: { by: "test:u", at: NOW.toISOString() }, issueCall: "lost-call" })) };
		expect(inv.file).toBeUndefined();
		const answer = await s.run({ op: "issue", draft: draft.id, confirm: true });
		expect(answer).toContain("ho emesso la fattura n. 1");
		const done = s.store.read().invoices[0] as IssuedInvoice;
		expect(done.number).toBe("1");
		expect(existsSync(join(s.root, done.file as string))).toBe(true);
		expect(s.store.read().next).toEqual({ 2026: 2 });
	});
});

describe("files", () => {
	it("never writes over a file: a name taken gets the next progressive", async () => {
		const s = setup();
		mkdirSync(join(s.root, "fatture/emesse"), { recursive: true });
		const theirs = join(s.root, `fatture/emesse/${SELLER_VAT}_00001.xml`);
		writeFileSync(theirs, "<x>altro</x>");
		const { inv } = await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(readFileSync(theirs, "utf8")).toBe("<x>altro</x>");
		expect(inv.file).toBe(`fatture/emesse/${SELLER_VAT}_00002.xml`);
		expect(inv.pdf).toBe(`fatture/emesse/${SELLER_VAT}_00002.pdf`);
		expect(progressiveCode(36)).toBe("00010");
	});

	it("writes a courtesy PDF that says it is not valid for tax purposes", async () => {
		const s = setup({ real: true });
		const { inv, answer } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		expect(answer).toContain("non è valida ai fini fiscali");
		const pdf = readFileSync(join(s.root, inv.pdf as string));
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(s.made[0]).toContain("Copia di cortesia, non valida ai fini fiscali.");
	});

	it("escapes hostile text and drops control characters", async () => {
		const s = setup();
		const hostile = "Lavori <script>alert(1)</script> & \"altro\" 'x' ]]> fine\u0001\u0007 ok";
		const { inv } = await s.issued({ customer: "Rossi & Figli <Srl>", vat_number: "03311220036", address: "Via <Roma> 1, 20121 Milano MI", recipient_code: "M5UXCR1", lines: [line(hostile, 100)], vat: 22, notes: "Nota ]]> <b>" });
		const xml = s.xmlOf(inv);
		expect(xml).toContain("Lavori &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;altro&quot; &apos;x&apos; ]]&gt; fine ok");
		expect(xml).toContain("<Denominazione>Rossi &amp; Figli &lt;Srl&gt;</Denominazione>");
		expect(xml).not.toContain("]]>");
		expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
		const read = fatturaData(Buffer.from(xml), false);
		expect(read.customer.name).toBe("Rossi & Figli <Srl>");
		expect(text(body(xml), "DatiBeniServizi/DettaglioLinee/Descrizione")).toBe("Lavori <script>alert(1)</script> & \"altro\" 'x' ]]> fine ok");
		roundTrip(inv, xml);
	});

	it("keeps to FatturaPA's field lengths", async () => {
		const s = setup();
		const long = await s.run({ op: "draft", ...DELTA, lines: [line("x".repeat(1001), 100)], vat: 22 });
		expect(long).toContain("al massimo 1000 caratteri");
		const dots = await s.run({ op: "draft", ...DELTA, lines: [line("…".repeat(500), 100)], vat: 22 });
		expect(dots).toContain("troppo lunga per la fattura");
		const name = await s.run({ op: "draft", ...DELTA, customer: `Ditta ${"A".repeat(80)}`, lines: [line("Servizio", 100)], vat: 22 });
		expect(name).toContain(`al massimo ${FIELD_LIMITS.denominazione} caratteri`);
		const { inv } = await s.issued({ ...DELTA, lines: [line("y".repeat(1000), 100)], vat: 22 });
		expect(text(body(s.xmlOf(inv)), "DatiBeniServizi/DettaglioLinee/Descrizione")).toHaveLength(1000);
		expect(s.store.read().invoices).toHaveLength(1);
	});

	it("writes typographic marks as Latin-1", () => {
		expect(latin1("L’offerta “speciale” – 10 € … ok")).toBe("L'offerta \"speciale\" - 10 EUR ... ok");
		expect(latin1("Šárka Łódź")).toBe("Sárka ?ódz");
		expect(NATURE.every((n) => n in NATURA)).toBe(true);
	});
});

describe("hours and quotes", () => {
	it("bills the hours not yet billed and marks them with the invoice", async () => {
		const s = setup({ entries: [entry(1, 120), entry(2, 90), entry(3, 60, { client: "Altro Srl" })] });
		const { inv, draft, answer } = await s.issued({ ...DELTA, lines: undefined, hours: true, vat: 22 });
		expect(draft).toContain("Ore in fattura: 2 voci, 3 ore e 30 minuti fatturabili");
		expect(inv.hours?.map((h) => h.id)).toEqual(["O-2026-0001", "O-2026-0002"]);
		expect(salesTotals(inv).taxable).toBe(17500n);
		expect(answer).toContain("Ho segnato come fatturate 2 voci di ore");
		const entries = s.timesheet.read().entries;
		expect(entries.filter((e) => e.billed?.ref === "fattura 1").map((e) => e.id)).toEqual(["O-2026-0001", "O-2026-0002"]);
		expect(entries.find((e) => e.id === "O-2026-0003")?.billed).toBeUndefined();
		expect(await s.run({ op: "draft", ...DELTA, lines: undefined, hours: true, vat: 22 })).toContain("Nessuna ora da fatturare");
	});

	it("refuses to issue when the hours changed since the draft", async () => {
		const s = setup({ entries: [entry(1, 120)] });
		await s.run({ op: "draft", ...DELTA, hours: true, vat: 22 });
		const id = s.last().id;
		s.timesheet.setBilled(["O-2026-0001"], () => ({ by: "test:u", at: NOW.toISOString(), ref: "a mano" }));
		const answer = await s.run({ op: "issue", draft: id, confirm: true });
		expect(answer).toContain("va rifatta la bozza");
		expect(isIssued(s.last())).toBe(false);
		expect(s.store.read().next).toEqual({});
	});

	it("bills an accepted quote and marks it invoiced, with its hours", async () => {
		const quoted = entry(4, 60, { billed: { by: "test:u", at: NOW.toISOString(), quote: "2026-004", rate: "50", rounding: 0 } });
		const s = setup({ quotes: [quote()], entries: [quoted] });
		const { inv, answer } = await s.issued({ quote: "2026-004", recipient_code: "M5UXCR1", vat: 22 });
		expect(inv.quote).toBe("2026-004");
		expect(inv.buyer).toMatchObject({ name: "Delta Servizi Srl", vat: "IT00743110157" });
		expect(inv.payment).toMatchObject({ days: 60, endOfMonth: true });
		expect(inv.due).toBe("2026-12-31");
		expect(answer).toContain("Il preventivo 2026-004 ora risulta fatturato");
		expect(s.quotes.read().quotes[0]?.invoice).toBe("1");
		expect(s.timesheet.read().entries[0]?.billed).toMatchObject({ quote: "2026-004", ref: "fattura 1" });
		roundTrip(inv, s.xmlOf(inv));
		expect(await s.run({ op: "draft", quote: "2026-004", recipient_code: "M5UXCR1" })).toContain("già stato fatturato");
	});

	it("bills only an accepted quote", async () => {
		const s = setup({ quotes: [quote({ status: "open" })] });
		expect(await s.run({ op: "draft", quote: "4", recipient_code: "M5UXCR1" })).toContain("non risulta accettato (è aperto)");
		expect(s.store.read().invoices).toHaveLength(0);
	});
});

describe("the scadenzario", () => {
	it("finds the invoice issued as one to collect, and the credit note against it", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		await s.run({ op: "credit_note", invoice: "1", lines: [line("Sconto", 100)] });
		await s.run({ op: "issue", draft: s.last().id, confirm: true });
		const scanner = new InvoiceScanner(s.workspace, { read: async (_name, data) => documentFattura(data) });
		const found = register((await scanner.scan(new AbortController().signal)).invoices, [], s.invoices.read().company);
		const invoice = found.find((i) => i.doc.number === "1");
		const credit = found.find((i) => i.doc.number === "2");
		expect(found).toHaveLength(2);
		expect(invoice).toMatchObject({ side: "active", credit: false, paid: false });
		expect(invoice?.instalments[0]).toMatchObject({ due: inv.due });
		expect(credit).toMatchObject({ side: "active", credit: true });
	});
});

describe("who may ask", () => {
	it("gives another agente only counts and totals", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		const agent = fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" });
		const list = await s.run({ op: "list" }, agent);
		expect(list).toContain("Nel 2026: una fattura");
		expect(list).toContain("1.220,00 €");
		expect(list).not.toContain("Delta");
		for (const op of ["draft", "issue", "show", "remove", "credit_note", "settings"]) {
			expect(await s.run({ op, ...DELTA, lines: [line("A", 1)] }, fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" }))).toContain("a un altro agente non preparo");
		}
		expect([salesAgentReads({ op: "list" }), salesAgentReads({ op: "show" })]).toEqual([true, false]);
	});

	it("only reads in the brief's thread", async () => {
		const s = setup();
		const [tool] = readOnlyInBriefs([s.tool as AnnieTool], async () => true);
		const brief = fresh(undefined, { channel: "web", threadId: "w1" });
		expect(String(await tool?.execute({ op: "draft", ...DELTA, lines: [line("A", 1)], vat: 22 }, brief))).toContain("legge soltanto");
		expect(String(await tool?.execute({ op: "list" }, brief))).toContain("Nessuna fattura emessa nel 2026");
		expect([salesCallReads({ op: "list" }), salesCallReads({ op: "show" }), salesCallReads({ op: "issue" })]).toEqual([true, true, false]);
	});

	it("audits the op and a count, never names or amounts", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		await s.run({ op: "credit_note", invoice: "1" });
		await s.run({ op: "remove", draft: s.last().id });
		await s.run({ op: "settings", bollo_to_client: true });
		expect(s.events).toEqual([
			{ type: "sales_invoices.changed", op: "draft", count: 1 },
			{ type: "sales_invoices.changed", op: "issue", count: 1 },
			{ type: "sales_invoices.changed", op: "credit_note", count: 1 },
			{ type: "sales_invoices.changed", op: "remove", count: 1 },
			{ type: "sales_invoices.changed", op: "settings", count: 1 },
		]);
		expect(JSON.stringify(s.events)).not.toMatch(/Delta|1000|1220|00743110157/);
	});
});

describe("the archive", () => {
	it("never writes over a file that does not read", async () => {
		const s = setup();
		const file = join(s.dir, "sales-invoices.json");
		writeFileSync(file, "{ rotto");
		const answer = await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(answer).toBe(`Errore: ${SALES_BROKEN}.`);
		expect(await s.run({ op: "list" })).toBe(`Errore: ${SALES_BROKEN}.`);
		expect(readFileSync(file, "utf8")).toBe("{ rotto");
	});

	it("keeps a copy of the last state written", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		expect(existsSync(join(s.dir, "sales-invoices.json.bak"))).toBe(true);
	});

	it("shows and lists, with the drafts waiting", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		await s.run({ op: "draft", ...DELTA, lines: [line("Altro", 50)], vat: 22 });
		const list = await s.run({ op: "list" });
		expect(list).toContain("Nel 2026: una fattura; imponibile 1.000,00 €, IVA 220,00 €, totale 1.220,00 €.");
		expect(list).toContain("bozza BZ-0002");
		expect(await s.run({ op: "show", invoice: "1" })).toContain("Fattura n. 1 del 18/10/2026 a Delta Servizi Srl");
		expect(await s.run({ op: "list", compact: true })).toBe("Niente da segnalare sulle fatture.");
		s.at("2026-10-30T08:00:00Z");
		expect(await s.run({ op: "list", compact: true })).toContain("Una bozza di fattura è ferma da più di 7 giorni");
	});

	it("writes the same XML for the same invoice", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		expect(fatturaXml(inv, salesTotals(inv))).toBe(s.xmlOf(inv));
	});
});
