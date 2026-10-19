import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { fatturaData, fatturaText } from "../src/core/fattura-pa.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { type Company, register } from "../src/core/invoices.ts";
import { increasesOf, priceWords, purchaseCallReads, purchaseRows, riseTenths, risesBy, tenthsWords } from "../src/core/purchase-prices.ts";
import { PurchaseStore } from "../src/core/purchase-store.ts";
import { StockStore } from "../src/core/stock-store.ts";
import { stateOf } from "../src/core/stock-sums.ts";
import { createPurchasePriceTools, type PurchaseEvent } from "../src/core/tools/purchase-price-tools.ts";
import { createStockTools, type StockEvent } from "../src/core/tools/stock-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic data only: checksum-valid fake partite IVA, invented names.
const NOW = new Date("2026-10-19T08:00:00Z");
const COMPANY: Company = { vat: "IT00000010017", name: "Bottega Prova Srl", by: "test:u", at: NOW.toISOString() };
const ME = { name: "Bottega Prova Srl", vat: "00000010017" };
const BETA = { name: "Beta Forniture Srl", vat: "00000030015" };
const GAMMA = { name: "Gamma Carta Spa", vat: "00000040014" };

let calls = 0;
const fresh = (callId = `p${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });
/** A call run again the durable way: each step's result kept. */
const durable = (callId: string, memo: Map<string, unknown>): ToolContext => ({
	...fresh(callId),
	step: async (key, work) => {
		if (memo.has(key)) return memo.get(key) as never;
		const v = await work();
		memo.set(key, v);
		return v;
	},
});

const FENCE = /<<<dati (?:degli acquisti|del magazzino) ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati (?:degli acquisti|del magazzino) \1>>>/g;
const outside = (text: string) => text.replace(FENCE, "");
const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "annie-purchases-"));
	dirs.push(dir);
	return dir;
}

type Party = { name: string; vat: string };
type Line = { desc?: string; qty?: string; unit?: string; price?: string; total?: string; rate?: string; natura?: string; code?: string; discount?: string; kind?: string; raw?: string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A received FatturaPA with its DettaglioLinee (total: quantity times price, less the discount, unless given). */
function xml(from: Party, to: Party, o: { number: string; date: string; type?: string; currency?: string; lines: Line[] }): string {
	const party = (p: Party) => `<DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${p.vat}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>${esc(p.name)}</Denominazione></Anagrafica></DatiAnagrafici>`;
	const lines = o.lines
		.map((l, i) => {
			if (l.raw !== undefined) return `<DettaglioLinee><NumeroLinea>${i + 1}</NumeroLinea>${l.raw}</DettaglioLinee>`;
			const gross = Number(l.price ?? "0") * Number(l.qty ?? "1");
			const total = l.total ?? (l.discount === undefined ? gross : gross * (1 - Number(l.discount) / 100)).toFixed(2);
			return `<DettaglioLinee><NumeroLinea>${i + 1}</NumeroLinea>${l.kind === undefined ? "" : `<TipoCessionePrestazione>${l.kind}</TipoCessionePrestazione>`}${l.code === undefined ? "" : `<CodiceArticolo><CodiceTipo>FORN</CodiceTipo><CodiceValore>${esc(l.code)}</CodiceValore></CodiceArticolo>`}<Descrizione>${esc(l.desc ?? "Voce")}</Descrizione>${l.qty === undefined ? "" : `<Quantita>${l.qty}</Quantita>`}${l.unit === undefined ? "" : `<UnitaMisura>${l.unit}</UnitaMisura>`}<PrezzoUnitario>${l.price ?? "0"}</PrezzoUnitario>${l.discount === undefined ? "" : `<ScontoMaggiorazione><Tipo>SC</Tipo><Percentuale>${l.discount}</Percentuale></ScontoMaggiorazione>`}<PrezzoTotale>${total}</PrezzoTotale><AliquotaIVA>${l.rate ?? "22.00"}</AliquotaIVA>${l.natura === undefined ? "" : `<Natura>${l.natura}</Natura>`}</DettaglioLinee>`;
		})
		.join("");
	const generali = `<TipoDocumento>${o.type ?? "TD01"}</TipoDocumento><Divisa>${o.currency ?? "EUR"}</Divisa><Data>${o.date}</Data><Numero>${esc(o.number)}</Numero><ImportoTotaleDocumento>100.00</ImportoTotaleDocumento>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"><FatturaElettronicaHeader><DatiTrasmissione><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione><CedentePrestatore>${party(from)}</CedentePrestatore><CessionarioCommittente>${party(to)}</CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>${generali}</DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi>${lines}<DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>100.00</ImponibileImporto><Imposta>22.00</Imposta></DatiRiepilogo></DatiBeniServizi></FatturaElettronicaBody></p:FatturaElettronica>`;
}

const bytes = (s: string) => new TextEncoder().encode(s);

function setup() {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(join(root, "fatture"), { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const purchases = new PurchaseStore(dir);
	const stock = new StockStore(dir);
	const events: (PurchaseEvent | StockEvent)[] = [];
	const clock = { now: NOW };
	const [tool] = createPurchasePriceTools({ workspace, store: purchases, invoices, scanner, timeZone: "Europe/Rome", record: async (e) => void events.push(e), now: () => clock.now });
	const [stockTool] = createStockTools({ workspace, store: stock, invoices, scanner, purchases, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now });
	if (tool === undefined || stockTool === undefined) throw new Error("no tool");
	let files = 0;
	const file = (text: string, name = `f${++files}.xml`) => writeFileSync(join(root, "fatture", name), text);
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const stockRun = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await stockTool.execute(args, c));
	return { dir, root, workspace, invoices, scanner, purchases, stock, events, clock, tool, stockTool, file, run, stockRun };
}

/** Beta's paper in September and October (+8%), Gamma's paper cheaper; toner from Beta without a quantity. */
function paper(s: ReturnType<typeof setup>) {
	s.file(xml(BETA, ME, { number: "B-1", date: "2026-09-01", lines: [{ desc: "Carta A4 80g risma", qty: "10.00", unit: "RISMA", price: "4.50", code: "CA-80" }, { desc: "Toner nero", price: "60.00" }] }));
	s.file(xml(BETA, ME, { number: "B-2", date: "2026-10-15", lines: [{ desc: "Carta A4 80g risme", qty: "10.00", unit: "RISMA", price: "5.40", discount: "10.00", code: "CA-80" }] }));
	s.file(xml(GAMMA, ME, { number: "G-7", date: "2026-10-10", lines: [{ desc: "Carta A4 80g risma", qty: "20.00", unit: "RISMA", price: "4.40" }] }));
}

describe("FatturaPA lines", () => {
	it("reads the lines: discounts in the total, a missing quantity, a natura, the code; a malformed line is skipped and counted", () => {
		const text = xml(BETA, ME, {
			number: "1",
			date: "2026-10-01",
			lines: [
				{ desc: "Carta A4", qty: "10.00", unit: "RISMA", price: "5.00", discount: "10.00", code: "CA-80" },
				{ desc: "Trasporto", price: "15.00" },
				{ desc: "Bollo", price: "2.00", rate: "0.00", natura: "N1" },
				{ raw: "<PrezzoUnitario>1.00</PrezzoUnitario><PrezzoTotale>1.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA>" },
				{ raw: "<Descrizione>Rotto</Descrizione><PrezzoUnitario>1.00</PrezzoUnitario><PrezzoTotale>uno</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA>" },
				{ raw: "<Descrizione>Virgola</Descrizione><Quantita>1,5</Quantita><PrezzoUnitario>1.00</PrezzoUnitario><PrezzoTotale>1.50</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA>" },
				{ raw: "<Descrizione>Natura strana</Descrizione><PrezzoUnitario>1.00</PrezzoUnitario><PrezzoTotale>1.00</PrezzoTotale><AliquotaIVA>0.00</AliquotaIVA><Natura>N99</Natura>" },
			],
		});
		const doc = fatturaData(bytes(text), false).documents[0];
		expect(doc?.lines).toEqual([
			{ n: 1, description: "Carta A4", quantity: "10", unit: "RISMA", unitPrice: "5", total: "45", vat: "22", code: { value: "CA-80", type: "FORN" } },
			{ n: 2, description: "Trasporto", unitPrice: "15", total: "15", vat: "22" },
			{ n: 3, description: "Bollo", unitPrice: "2", total: "2", vat: "0", natura: "N1" },
		]);
		expect(doc?.linesSkipped).toBe(4);
		// The summary is written as before.
		expect(fatturaText(bytes(text), false).text).toContain("Righe (7):");
		expect(fatturaText(bytes(text), false).text).toContain("1. Carta A4; quantità 10 RISMA; prezzo unitario 5,00 €; sconto 10%; IVA 22%; totale 45,00 €");
	});

	it("keeps at most 2000 lines of a document, the rest counted", () => {
		const lines = Array.from({ length: 2005 }, (_, i) => ({ desc: `Articolo ${i + 1}`, qty: "1", price: "1.00" }));
		const doc = fatturaData(bytes(xml(BETA, ME, { number: "2", date: "2026-10-01", lines })), false).documents[0];
		expect(doc?.lines).toHaveLength(2000);
		expect(doc?.linesCut).toBe(5);
		expect(doc?.linesSkipped).toBeUndefined();
	});

	it("the register keeps the lines of an invoice received only", () => {
		const received = fatturaData(bytes(xml(BETA, ME, { number: "3", date: "2026-10-01", lines: [{ desc: "Carta", qty: "1", price: "1.00" }] })), false);
		const issued = fatturaData(bytes(xml(ME, BETA, { number: "4", date: "2026-10-01", lines: [{ desc: "Consulenza", qty: "1", price: "1.00" }] })), false);
		const reg = register([{ path: "a.xml", modifiedAt: NOW.toISOString(), fattura: received }, { path: "b.xml", modifiedAt: NOW.toISOString(), fattura: issued }], [], COMPANY);
		expect(reg.find((i) => i.side === "passive")?.doc.lines).toHaveLength(1);
		expect(reg.find((i) => i.side === "active")?.doc.lines).toBeUndefined();
	});
});

describe("the math", () => {
	it("prices per unit from the line's total, rises in tenths of a percent, thresholds exact", () => {
		const E = 100_000_000n;
		expect(riseTenths(450n * E, 486n * E)).toBe(80n);
		expect(tenthsWords(80n)).toBe("8%");
		expect(tenthsWords(125n)).toBe("12,5%");
		// 4,75 to 5,00 is 5,26…%: over 5%, under 5,3%.
		expect(risesBy(475n * E, 500n * E, 500n)).toBe(true);
		expect(risesBy(475n * E, 500n * E, 530n)).toBe(false);
		// Exactly 5%: in.
		expect(risesBy(400n * E, 420n * E, 500n)).toBe(true);
		expect(risesBy(400n * E, 41_999n * (E / 100n), 500n)).toBe(false);
		expect(priceWords(486_000_000n)).toBe("4,86 €");
		expect(priceWords(1_250_000n)).toBe("0,0125 €");
		expect(priceWords(1_234_500_000_000n)).toBe("12.345,00 €");
	});

	it("rows: unit prices with the discount in, a price per line without quantity, credit notes and other currencies out; increases against the previous invoice", () => {
		const read = (t: string) => fatturaData(bytes(t), false);
		const found = [
			read(xml(BETA, ME, { number: "B-1", date: "2026-09-01", lines: [{ desc: "Carta A4", qty: "10", unit: "RISMA", price: "4.50" }, { desc: "Toner", price: "60.00" }] })),
			read(xml(BETA, ME, { number: "B-2", date: "2026-10-15", lines: [{ desc: "Carta A4", qty: "10", unit: "RISMA", price: "5.40", discount: "10.00" }] })),
			read(xml(BETA, ME, { number: "NC-1", date: "2026-10-16", type: "TD04", lines: [{ desc: "Carta A4", qty: "1", unit: "RISMA", price: "9.00" }] })),
			read(xml(BETA, ME, { number: "USD-1", date: "2026-10-16", currency: "USD", lines: [{ desc: "Carta A4", qty: "1", unit: "RISMA", price: "9.00" }] })),
			// The same paper in boxes: never compared with the reams.
			read(xml(BETA, ME, { number: "B-3", date: "2026-10-17", lines: [{ desc: "Carta A4", qty: "1", unit: "SCATOLA", price: "30.00" }] })),
		].map((fattura, i) => ({ path: `${i}.xml`, modifiedAt: NOW.toISOString(), fattura }));
		const got = purchaseRows(register(found, [], COMPANY), []);
		expect(got.otherCurrency).toBe(1);
		expect(got.rows.map((r) => [r.description, r.unit ?? null, priceWords(r.price), r.perLine])).toEqual([
			["Carta A4", "risma", "4,50 €", false],
			["Toner", null, "60,00 €", true],
			["Carta A4", "risma", "4,86 €", false],
			["Carta A4", "scatola", "30,00 €", false],
		]);
		const up = increasesOf(got.rows, 500n, "2026-01-01", "2026-12-31");
		expect(up.map((i) => [i.product.unit, tenthsWords(i.tenths)])).toEqual([["risma", "8%"]]);
		expect(increasesOf(got.rows, 900n, "2026-01-01", "2026-12-31")).toEqual([]);
	});
});

describe("purchase_prices", () => {
	it("item: each supplier's latest price, the cheapest first; a supplier said narrows it", async () => {
		const s = setup();
		paper(s);
		const answer = await s.run({ op: "item", item: "carta A4" });
		expect(outside(answer)).toContain("Un prodotto con queste parole, da 2 fornitori");
		expect(outside(answer)).not.toContain("Beta");
		const rows = inside(answer).split("\n");
		expect(rows[0]).toBe("• Carta A4 80g risma (per risma)");
		expect(rows[1]).toBe("  - Gamma Carta Spa: 4,40 € per risma il 10/10/2026 (fattura n. G-7 del 10/10/2026); un acquisto");
		expect(rows[2]).toBe("  - Beta Forniture Srl: 4,86 € per risma il 15/10/2026 (fattura n. B-2 del 15/10/2026); prima 4,50 € (+8%); 2 acquisti");
		const beta = await s.run({ op: "item", item: "carta A4", supplier: "beta" });
		expect(inside(beta)).not.toContain("Gamma");
		const toner = await s.run({ op: "item", item: "toner" });
		expect(inside(toner)).toContain("Toner nero (per riga (la fattura non dice la quantità))");
		expect(await s.run({ op: "item", item: "CA-80" })).toContain("Beta Forniture Srl: 4,86 €");
	});

	it("supplier, compare and increases", async () => {
		const s = setup();
		paper(s);
		const beta = await s.run({ op: "supplier", supplier: "00000030015" });
		expect(outside(beta)).toContain("Da questo fornitore hai comprato 2 prodotti");
		expect(inside(beta)).toContain("Fornitore: Beta Forniture Srl");
		const cheap = await s.run({ op: "compare", item: "carta" });
		expect(inside(cheap)).toContain("• Carta A4 80g risma (per risma): il meno caro è Gamma Carta Spa, 4,40 € il 10/10/2026");
		expect(inside(cheap)).toContain("  - Beta Forniture Srl: 4,86 € il 15/10/2026 (+10,5%)");
		const up = await s.run({ op: "increases", period: "quest'anno" });
		expect(outside(up)).toContain("Un prezzo è aumentato di almeno il 5% nel 2026");
		expect(inside(up)).toContain("• Beta Forniture Srl: Carta A4 80g risma, +8% (da 4,50 € a 4,86 € per risma; fattura n. B-2 del 15/10/2026)");
		expect(await s.run({ op: "increases", threshold: 9 })).toContain("Nessun prezzo è aumentato di almeno il 9%");
		expect(await s.run({ op: "increases", period: "2025" })).toContain("Nessun prezzo è aumentato");
	});

	it("another agente gets counts only: no price, no supplier, no file", async () => {
		const s = setup();
		paper(s);
		const count = await s.run({ op: "item", item: "carta A4" }, agent());
		expect(count).toContain("3 acquisti di prodotti con queste parole, da 2 fornitori");
		expect(count).not.toMatch(/€|Beta|Gamma/);
		const up = await s.run({ op: "increases" }, agent());
		expect(up).toContain("Un prodotto costa almeno il 5% in più");
		expect(up).not.toMatch(/€|Beta|Carta/);
		for (const op of ["supplier", "compare", "export"]) expect(await s.run({ op, supplier: "beta" }, agent())).toContain("a un altro agente dico solo");
		expect(await s.run({ op: "increases", compact: true }, agent())).toContain("a un altro agente dico solo");
	});

	it("export: a CSV safe for a spreadsheet, the audit with the op and the count only", async () => {
		const s = setup();
		s.file(xml(BETA, ME, { number: "B-9", date: "2026-10-01", lines: [{ desc: "=HYPERLINK(\"http://x.example\")", qty: "2", unit: "PZ", price: "1.25" }] }));
		const answer = await s.run({ op: "export" });
		const path = /Salvato (\S+):/.exec(answer)?.[1] as string;
		const csv = readFileSync(join(s.root, path), "utf8");
		expect(csv.split("\r\n")[0]).toBe("﻿Data;Fornitore;Partita IVA;Fattura;Riga;Descrizione;Codice;Quantità;Unità;Prezzo;Prezzo è;Totale riga");
		expect(csv.split("\r\n")[1]).toBe(`2026-10-01;Beta Forniture Srl;IT00000030015;B-9;1;"'=HYPERLINK(""http://x.example"")";;2;pezzo;1,25;per unità;2,5`);
		expect(s.events).toEqual([{ type: "purchase_prices.used", op: "export", count: 1 }]);
		expect(JSON.stringify(s.events)).not.toMatch(/Beta|HYPERLINK|1,25/);
	});

	it("says what it cannot read: no company, lines that do not read", async () => {
		const s = setup();
		s.invoices.setCompany(undefined);
		paper(s);
		expect(await s.run({ op: "item", item: "carta" })).toContain("non distinguo le fatture ricevute da quelle emesse");
		const t = setup();
		t.file(xml(BETA, ME, { number: "B-5", date: "2026-10-01", lines: [{ desc: "Carta", qty: "1", price: "1.00" }, { raw: "<PrezzoUnitario>1.00</PrezzoUnitario><PrezzoTotale>1.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA>" }] }));
		expect(await t.run({ op: "item", item: "carta" })).toContain("Una riga di fattura non si legge (manca la descrizione, o un prezzo o una quantità non è un numero): l'ho lasciata fuori, senza indovinare.");
	});

	it("the brief: each invoice line's increase said once, at most 3 a day, the rest as a count and on the next days", async () => {
		const s = setup();
		const products = ["Carta", "Penne", "Buste", "Toner"];
		s.file(xml(BETA, ME, { number: "B-1", date: "2026-08-01", lines: products.map((desc) => ({ desc, qty: "1", unit: "PZ", price: "10.00" })) }));
		s.file(xml(BETA, ME, { number: "B-2", date: "2026-10-12", lines: products.map((desc, i) => ({ desc, qty: "1", unit: "PZ", price: (11 + i).toFixed(2) })) }));
		const memo = new Map<string, unknown>();
		const first = await s.run({ op: "increases", compact: true }, durable("brief-1", memo));
		expect(outside(first)).toContain("Prezzi d'acquisto: 3 aumenti di almeno il 5% nelle fatture ricevute (nel riquadro), e un altro nei prossimi giorni.");
		expect(inside(first)).toContain("• Beta Forniture Srl ti ha fatto pagare Toner 40% in più dell'ultima volta (14,00 € invece di 10,00 € per pezzo)");
		expect(inside(first)).not.toContain("Carta");
		// The same call again: the same lines.
		expect(inside(await s.run({ op: "increases", compact: true }, durable("brief-1", memo)))).toBe(inside(first));
		// Another call the same day: the cap is reached.
		expect(await s.run({ op: "increases", compact: true })).toBe("Prezzi d'acquisto: un altro aumento da dire, nei prossimi giorni.");
		s.clock.now = new Date("2026-10-20T08:00:00Z");
		const next = await s.run({ op: "increases", compact: true });
		expect(inside(next)).toContain("Carta 10% in più");
		expect(await s.run({ op: "increases", compact: true })).toBe("Prezzi d'acquisto: niente da segnalare.");
		expect(s.events.filter((e) => e.type === "purchase_prices.used")).toEqual([
			{ type: "purchase_prices.used", op: "brief", count: 3 },
			{ type: "purchase_prices.used", op: "brief", count: 1 },
		]);
		// The brief runs it; only the export is refused in a brief's thread.
		expect(purchaseCallReads({ op: "increases", compact: true })).toBe(true);
		expect(purchaseCallReads({ op: "export" })).toBe(false);
		const [guarded] = readOnlyInBriefs([s.tool], async () => true);
		expect(await guarded?.execute({ op: "export" }, fresh())).toContain("nella chat del brief del mattino Annie legge soltanto");
		expect(BRIEF_INSTRUCTION).toContain("purchase_prices (increases)");
	});

	it("an old increase is not the brief's: only invoices of the last 30 days", async () => {
		const s = setup();
		s.file(xml(BETA, ME, { number: "B-1", date: "2026-06-01", lines: [{ desc: "Carta", qty: "1", unit: "PZ", price: "10.00" }] }));
		s.file(xml(BETA, ME, { number: "B-2", date: "2026-08-01", lines: [{ desc: "Carta", qty: "1", unit: "PZ", price: "12.00" }] }));
		expect(await s.run({ op: "increases", compact: true })).toBe("Prezzi d'acquisto: niente da segnalare.");
		expect(await s.run({ op: "increases" })).toContain("Un prezzo è aumentato");
	});

	it("the instructions route selling prices, prices paid and quantities", () => {
		expect(DEFAULT_INSTRUCTIONS).toContain("il listino sono i prezzi a cui vende, purchase_prices quello che paga lui, il magazzino le quantità");
		expect(DEFAULT_INSTRUCTIONS).toContain("sapere quanto paga quello che compra (purchase_prices:");
		expect(DEFAULT_INSTRUCTIONS).not.toMatch(/\u2014/);
	});
});

describe("stock receive_invoice", () => {
	it("proposes each line's article with quantity and cost, loads only with the person's yes, each line once", async () => {
		const s = setup();
		await s.stockRun({ op: "add_item", item: "Carta A4 80g risma", unit: "risma" });
		await s.stockRun({ op: "add_item", item: "Toner nero" });
		s.file(xml(BETA, ME, { number: "B-1", date: "2026-10-15", lines: [{ desc: "Carta A4 80g risme", qty: "10", unit: "RISMA", price: "5.40", discount: "10.00" }, { desc: "Toner originale XL", qty: "2", unit: "PZ", price: "60.00", code: "TN-1" }, { desc: "Sconto fedeltà", price: "5.00", kind: "SC" }] }));
		const asked = await s.stockRun({ op: "receive_invoice", supplier: "Beta Forniture Srl", invoice: "B-1" });
		expect(outside(asked)).toContain("Fattura n. B-1 del 15/10/2026 (fornitore nel riquadro): una riga si può caricare in magazzino, come nel riquadro; 2 no, con il motivo.");
		expect(inside(asked)).toContain("• riga 1, Carta A4 80g risme → MG-0001 Carta A4 80g risma: 10 risme a 4,86 € per unità, senza IVA (stesso nome, al singolare o al plurale)");
		expect(s.stock.read().items[0]?.unit).toBe("risma");
		expect(inside(asked)).toContain("• riga 2, Toner originale XL [TN-1]: nessun articolo del magazzino con questo nome o codice");
		expect(inside(asked)).toContain("• riga 3, Sconto fedeltà: non è merce");
		expect(outside(asked)).toContain("Niente si carica da solo.");
		expect(outside(asked)).not.toMatch(/Beta|Carta|Toner/);
		expect(s.stock.read().moves).toHaveLength(0);
		// Not the person's own turn: refused.
		expect(await s.stockRun({ op: "receive_invoice", supplier: "Beta Forniture Srl", invoice: "B-1", confirm: true }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(await s.stockRun({ op: "receive_invoice", supplier: "Beta Forniture Srl", invoice: "B-1", confirm: true }, agent())).toContain("a un altro agente");
		expect(s.stock.read().moves).toHaveLength(0);
		// The person's yes, the toner given its article.
		const done = await s.stockRun({ op: "receive_invoice", supplier: "Beta Forniture Srl", invoice: "B-1", confirm: true, lines: [{ line: 1 }, { line: 2, item: "MG-0002" }] });
		expect(outside(done)).toContain("Fatto, ho caricato in magazzino 2 righe della fattura n. B-1 del 15/10/2026");
		const b = s.stock.read();
		const paperState = stateOf(b.items[0] as never, b.moves);
		expect([paperState.onHand, paperState.average]).toEqual([10_000n, 48_600n]);
		expect(stateOf(b.items[1] as never, b.moves).onHand).toBe(2000n);
		expect(b.moves[0]).toMatchObject({ kind: "carico", day: "2026-10-15", doc: "fattura n. B-1", supplier: { name: "Beta Forniture Srl", vat: "IT00000030015" } });
		expect(b.codes).toEqual([{ s: "IT00000030015", c: "TN-1", i: "MG-0002" }]);
		expect(s.events.filter((e) => e.type === "stock.changed" && e.op === "receive_invoice")).toEqual([{ type: "stock.changed", op: "receive_invoice", count: 2 }]);
		// Asked again: nothing twice.
		const again = await s.stockRun({ op: "receive_invoice", supplier: "Beta Forniture Srl", invoice: "B-1", confirm: true });
		expect(again).toContain("non ho caricato niente");
		expect(inside(again)).toContain("già caricata in magazzino");
		expect(s.stock.read().moves).toHaveLength(2);
		// The code learned: the next invoice's toner, whatever its description, is that article.
		s.file(xml(BETA, ME, { number: "B-2", date: "2026-10-18", lines: [{ desc: "Cartuccia toner nera", qty: "1", unit: "PZ", price: "66.00", code: "tn-1" }] }));
		const next = await s.stockRun({ op: "receive_invoice", supplier: "Beta Forniture Srl", invoice: "B-2" });
		expect(inside(next)).toContain("→ MG-0002 Toner nero: 1 pezzo a 66,00 € per unità, senza IVA (codice del fornitore già confermato)");
		// And the rise of its price is said here, once: not again in the brief.
		expect(outside(next)).toContain("Un prezzo di questa fattura è aumentato rispetto all'acquisto precedente dallo stesso fornitore: dillo a chi ti scrive.");
		expect(inside(next)).toContain("Beta Forniture Srl ti ha fatto pagare Toner originale XL 10% in più dell'ultima volta (66,00 € invece di 60,00 € per pezzo)");
		expect(await s.run({ op: "increases", compact: true })).toBe("Prezzi d'acquisto: niente da segnalare.");
	});

	it("asks which invoice when the words fit more than one, finds one by its file, and says a line in another unit", async () => {
		const s = setup();
		await s.stockRun({ op: "add_item", item: "Carta A4", unit: "risma" });
		s.file(xml(BETA, ME, { number: "B-1", date: "2026-10-01", lines: [{ desc: "Carta A4", qty: "1", unit: "KG", price: "5.00" }] }), "beta-1.xml");
		s.file(xml(BETA, ME, { number: "B-2", date: "2026-10-02", lines: [{ desc: "Carta A4", qty: "1", unit: "RISMA", price: "5.00" }] }), "beta-2.xml");
		const which = await s.stockRun({ op: "receive_invoice", supplier: "Beta Forniture Srl" });
		expect(which).toContain("2 fatture ricevute vanno bene");
		expect(inside(which)).toContain("• n. B-2 del 02/10/2026 da Beta Forniture Srl");
		const byFile = await s.stockRun({ op: "receive_invoice", file: "./fatture/beta-1.xml" });
		expect(inside(byFile)).toContain("l'unità della riga non è quella dell'articolo, né della sua confezione");
		expect(outside(byFile)).toContain("nessuna riga da caricare in magazzino");
	});
});
