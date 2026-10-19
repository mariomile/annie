import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import type { Company } from "../src/core/invoices.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import { matchInvoice, orderLink } from "../src/core/order-receive.ts";
import { OrderStore } from "../src/core/order-store.ts";
import { paceOf, sellersOf, suggestions } from "../src/core/order-suggest.ts";
import { type Order, orderCallReads, orderState } from "../src/core/orders.ts";
import { lineKey } from "../src/core/purchase-prices.ts";
import type { Movement, StockItem } from "../src/core/stock.ts";
import { StockStore } from "../src/core/stock-store.ts";
import { createOrderTools, type OrderEvent } from "../src/core/tools/order-tools.ts";
import { createStockTools, type StockEvent } from "../src/core/tools/stock-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic data only: checksum-valid fake partite IVA, invented names.
const NOW = new Date("2026-10-19T08:00:00Z");
const COMPANY: Company = { vat: "IT00000010017", name: "Bottega Prova Srl", address: "Via Prova 1, Torino", by: "test:u", at: NOW.toISOString() };
const ME = { name: "Bottega Prova Srl", vat: "00000010017" };
const BETA = { name: "Beta Forniture Srl", vat: "00000030015" };
const GAMMA = { name: "Gamma Carta Spa", vat: "00000040014" };
const MARK = { by: "test:u", at: NOW.toISOString() };

let calls = 0;
const fresh = (callId = `o${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });
const durable = (callId: string, memo: Map<string, unknown>): ToolContext => ({
	...fresh(callId),
	step: async (key, work) => {
		if (memo.has(key)) return memo.get(key) as never;
		const v = await work();
		memo.set(key, v);
		return v;
	},
});

const FENCE = /<<<dati (?:degli ordini|del magazzino) ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati (?:degli ordini|del magazzino) \1>>>/g;
const outside = (text: string) => text.replace(FENCE, "");
const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
const checkIn = (answer: string) => /il controllo ([0-9a-f]{16})/.exec(answer)?.[1] as string;

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Party = { name: string; vat: string };
type Line = { desc: string; qty: string; unit: string; price: string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A received FatturaPA with its lines and the riepilogo IVA at 22%. */
function xml(from: Party, to: Party, o: { number: string; date: string; lines: Line[] }): string {
	const party = (p: Party) => `<DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${p.vat}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>${esc(p.name)}</Denominazione></Anagrafica></DatiAnagrafici>`;
	let taxable = 0;
	const lines = o.lines
		.map((l, i) => {
			const total = (Number(l.price) * Number(l.qty)).toFixed(2);
			taxable += Number(total);
			return `<DettaglioLinee><NumeroLinea>${i + 1}</NumeroLinea><Descrizione>${esc(l.desc)}</Descrizione><Quantita>${l.qty}</Quantita><UnitaMisura>${l.unit}</UnitaMisura><PrezzoUnitario>${l.price}</PrezzoUnitario><PrezzoTotale>${total}</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>`;
		})
		.join("");
	const riepilogo = `<DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>${taxable.toFixed(2)}</ImponibileImporto><Imposta>${(taxable * 0.22).toFixed(2)}</Imposta></DatiRiepilogo>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"><FatturaElettronicaHeader><DatiTrasmissione><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione><CedentePrestatore>${party(from)}</CedentePrestatore><CessionarioCommittente>${party(to)}</CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>${o.date}</Data><Numero>${esc(o.number)}</Numero></DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi>${lines}${riepilogo}</DatiBeniServizi></FatturaElettronicaBody></p:FatturaElettronica>`;
}

const item = (n: number, name: string, unit: string, more: Partial<StockItem> = {}): StockItem => ({ id: `MG-000${n}`, name, unit, ...more, ...MARK });

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "annie-orders-"));
	dirs.push(dir);
	const root = join(dir, "workspace");
	mkdirSync(join(root, "fatture"), { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const stock = new StockStore(dir);
	const store = new OrderStore(dir);
	const events: (OrderEvent | StockEvent)[] = [];
	const clock = { now: NOW };
	const made: MakeInput[] = [];
	const make = async (input: MakeInput) => {
		made.push(input);
		return { data: new TextEncoder().encode(input.text), notes: [] };
	};
	const [tool] = createOrderTools({ workspace, store, stock, invoices, scanner, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	const [stockTool] = createStockTools({ workspace, store: stock, invoices, scanner, orders: orderLink(store), timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now });
	if (tool === undefined || stockTool === undefined) throw new Error("no tool");
	let files = 0;
	const file = (text: string) => writeFileSync(join(root, "fatture", `f${++files}.xml`), text);
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const stockRun = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await stockTool.execute(args, c));
	return { dir, root, workspace, stock, store, events, clock, made, tool, file, run, stockRun };
}

/**
 * The shop: cartridges (minimum 10, in boxes of 12) went out 45 in the last 90 days and 5 are
 * left; paper (minimum 5) went out 30 in two sales and 6 are left; glue has no minimum and no
 * sales. Beta sold the cartridges twice (12,00 then 12,50) and the paper; Gamma once, cheaper.
 */
function shop(s: ReturnType<typeof setup>) {
	const moves: Movement[] = [];
	let n = 0;
	const mv = (m: Omit<Movement, "id" | "by" | "at">) => moves.push({ id: `MV-${String(++n).padStart(6, "0")}`, ...m, ...MARK } as Movement);
	mv({ item: "MG-0001", kind: "carico", qty: "50", day: "2026-07-01", cost: "12", supplier: { name: "Beta Forniture Srl", vat: "IT00000030015" } });
	for (let i = 0; i < 9; i++) mv({ item: "MG-0001", kind: "scarico", qty: "5", day: `2026-${i < 4 ? "08" : "09"}-${String(10 + i).padStart(2, "0")}`, reason: "vendita" });
	mv({ item: "MG-0002", kind: "carico", qty: "36", day: "2026-07-01", cost: "4.5" });
	mv({ item: "MG-0002", kind: "scarico", qty: "15", day: "2026-09-01", reason: "uso_interno" });
	mv({ item: "MG-0002", kind: "scarico", qty: "15", day: "2026-10-01", reason: "vendita" });
	// An old sale, before the window: not in the pace.
	mv({ item: "MG-0003", kind: "carico", qty: "10", day: "2026-01-01", cost: "1" });
	mv({ item: "MG-0003", kind: "scarico", qty: "2", day: "2026-02-01", reason: "vendita" });
	s.stock.update("seed", (st) => ({ ...st, nextItem: 4, nextMove: n + 1, items: [item(1, "Cartucce XL", "pezzo", { min: "10", pack: { unit: "scatola", size: "12" } }), item(2, "Carta A4", "risma", { min: "5" }), item(3, "Colla stick", "pezzo")], moves }));
	s.file(xml(BETA, ME, { number: "B-1", date: "2026-09-01", lines: [{ desc: "Cartucce XL", qty: "20.00", unit: "PZ", price: "12.00" }, { desc: "Carta A4", qty: "10.00", unit: "RISMA", price: "4.50" }] }));
	s.file(xml(BETA, ME, { number: "B-2", date: "2026-10-01", lines: [{ desc: "Cartucce XL", qty: "10.00", unit: "PZ", price: "12.50" }] }));
	s.file(xml(GAMMA, ME, { number: "G-1", date: "2026-10-10", lines: [{ desc: "Cartucce XL", qty: "5.00", unit: "PZ", price: "11.80" }] }));
}

describe("what to reorder", () => {
	it("under the minimum or soon under it, from the pace of the scarichi; whole packs; the cheapest and the usual supplier; an estimate said when sales are few", async () => {
		const s = setup();
		shop(s);
		const text = await s.run({ op: "suggest" });
		expect(outside(text)).toContain("2 articoli sono da riordinare: nel riquadro perché, quanti e da chi, con i conti");
		const rows = inside(text).split("\n");
		// 45 in 90 days: half a cartridge a day; 30 days more are 15, past the minimum of 10: 25, 20 missing, two boxes of 12.
		expect(rows[0]).toBe(
			"• Cartucce XL (MG-0001): è sotto il minimo; ne hai 5 pezzi, il minimo è 10 pezzi; ne esce circa 0,5 pezzi al giorno (45 pezzi negli ultimi 90 giorni); per tornare sopra il minimo con 30 giorni di uscite servono 25 pezzi, ne mancano 20 pezzi: ordinane 24 pezzi (2 scatole da 12 pezzi). Il più conveniente di recente: Gamma Carta Spa, 11,80 € (fattura del 10/10/2026). Di solito lo compri da Beta Forniture Srl, 12,50 € (fattura del 01/10/2026).",
		);
		// 30 in two scarichi: in 7 days it goes under 5; an estimate.
		expect(rows[1]).toBe(
			"• Carta A4 (MG-0002): a questo ritmo scende sotto il minimo entro 7 giorni, il tempo di consegna; ne hai 6 risme, il minimo è 5 risme; ne esce circa 0,3 risme al giorno (30 risme negli ultimi 90 giorni); per tornare sopra il minimo con 30 giorni di uscite servono 15 risme, ne mancano 9 risme: ordinane 9 risme; è una stima: solo 2 uscite negli ultimi 90 giorni. Il più conveniente di recente: Beta Forniture Srl, 4,50 € (fattura del 01/09/2026).",
		);
		expect(outside(text)).not.toMatch(/Beta|Gamma|Cartucce/);
		expect(s.events).toEqual([{ type: "orders.used", op: "suggest", count: 2 }]);
		expect(orderCallReads({ op: "suggest" })).toBe(true);
		expect(orderCallReads({ op: "create" })).toBe(false);
	});

	it("the pace: sales and internal use less the returns, inside the window; the usual supplier is the one bought from most", () => {
		const it1 = item(1, "X", "pezzo");
		const m = (id: number, kind: Movement["kind"], qty: string, day: string, more: Partial<Movement> = {}): Movement => ({ id: `MV-00000${id}`, item: "MG-0001", kind, qty, day, ...more, ...MARK }) as Movement;
		const moves = [m(1, "scarico", "4", "2026-10-01", { reason: "vendita" }), m(2, "scarico", "1", "2026-10-02", { reason: "scarto" }), m(3, "storno", "1", "2026-10-03"), m(4, "scarico", "2", "2026-01-01", { reason: "vendita" })];
		expect(paceOf(it1, moves, "2026-07-22", "2026-10-19")).toEqual({ sold: 3000n, sales: 1 });
		const o = (key: string, cost: bigint, day: string) => ({ key, supplier: key, cost, day, from: "invoice" as const });
		const s = sellersOf([o("A", 100n, "2026-10-01"), o("A", 110n, "2026-10-05"), o("B", 105n, "2026-10-02"), o("C", 50n, "2025-01-01")], "2026-10-19");
		expect(s.cheapest?.key).toBe("B");
		expect(s.usual).toMatchObject({ key: "A", cost: 110n, count: 2 });
		// No minimum and no sales: nothing to say.
		expect(suggestions({ items: [it1], moves: [], purchases: [], codes: [], units: [] }, "2026-10-19", { cover: 30, lead: () => 7 })).toEqual([]);
	});
});

describe("drafts, documents, sent", () => {
	it("«fammi l'ordine per Beta»: a proposal with a check, a draft only with the person's yes; changed while a draft; the document without sending it; sent only by the person", async () => {
		const s = setup();
		shop(s);
		const asked = await s.run({ op: "create", supplier: "Beta" });
		expect(outside(asked)).toContain("Preparerei una bozza d'ordine, come nel riquadro (prezzi per unità, senza IVA).");
		expect(inside(asked).split("\n")).toEqual(["Fornitore: Beta Forniture Srl", "  1. Cartucce XL: 24 pezzi a 12,50 € (l'ultimo pagato, 01/10/2026)", "  2. Carta A4: 9 risme a 4,50 € (l'ultimo pagato, 01/09/2026)", "  Totale previsto: 340,50 € senza IVA"]);
		expect(outside(asked)).toContain("Non mando niente a nessuno");
		expect(s.store.read().orders).toEqual([]);
		const check = checkIn(asked);
		expect(await s.run({ op: "create", supplier: "Beta", confirm: true, check }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "create", supplier: "Beta", confirm: true })).toContain("Errore: per preparare le bozze serve il controllo");
		expect(await s.run({ op: "create", supplier: "Beta", confirm: true, check: "0123456789abcdef" })).toContain("La proposta è cambiata");
		const memo = new Map<string, unknown>();
		const done = await s.run({ op: "create", supplier: "Beta", confirm: true, check }, durable("c-1", memo));
		expect(outside(done)).toContain("Fatto: ho preparato la bozza d'ordine OR-0001, come nel riquadro. Non l'ho mandata a nessuno.");
		// Run again: nothing twice.
		await s.run({ op: "create", supplier: "Beta", confirm: true, check }, durable("c-1", memo));
		const [o] = s.store.read().orders;
		expect(o).toMatchObject({ id: "OR-0001", status: "draft", day: "2026-10-19", supplier: { key: "IT00000030015", name: "Beta Forniture Srl", vat: "IT00000030015" } });
		expect(o?.lines).toEqual([
			{ n: 1, item: "MG-0001", name: "Cartucce XL", qty: "24", unit: "pezzo", price: "12.5", priceFrom: "purchase", priceDay: "2026-10-01" },
			{ n: 2, item: "MG-0002", name: "Carta A4", qty: "9", unit: "risma", price: "4.5", priceFrom: "purchase", priceDay: "2026-09-01" },
		]);
		// Two boxes more, the paper off, a note.
		const changed = await s.run({ op: "change", supplier: "Beta", lines: [{ item: "cartucce xl", quantity: 4, unit: "scatole" }, { item: "Carta A4", quantity: 0 }], notes: "Consegna al mattino" });
		expect(inside(changed)).toContain("  1. Cartucce XL: 48 pezzi a 12,50 €");
		expect(inside(changed)).not.toContain("Carta A4");
		expect(inside(changed)).toContain("  Note: Consegna al mattino");
		// The document, without prices: written, never sent.
		const doc = await s.run({ op: "document", order: "OR-0001", no_prices: true });
		expect(outside(doc)).toContain("Fatto: ho fatto il documento dell'ordine OR-0001, senza prezzi; il file è nel riquadro. Non l'ho mandato a nessuno.");
		expect(inside(doc)).toBe("File: ordini/Ordine-OR-0001-Beta-Forniture-Srl.pdf");
		expect(outside(doc)).not.toMatch(/Beta/);
		expect(outside(doc)).toContain("file_send");
		const md = s.made[0]?.text ?? "";
		expect(md).toContain("# Ordine n. OR-0001");
		expect(md).toContain("**Bottega Prova Srl**");
		expect(md).toContain("P\\.IVA 00000030015");
		expect(md).toContain("| 1 | Cartucce XL | 48 pezzi |");
		expect(md).not.toContain("12,50");
		expect(readFileSync(join(s.root, "ordini", "Ordine-OR-0001-Beta-Forniture-Srl.pdf"), "utf8")).toBe(md);
		expect(s.store.read().orders[0]).toMatchObject({ file: "ordini/Ordine-OR-0001-Beta-Forniture-Srl.pdf", noPrices: true });
		// Sent: only the person says it.
		expect(await s.run({ op: "mark_sent", supplier: "Beta" }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "mark_sent", supplier: "Beta" })).toContain("Segnato: l'ordine OR-0001 è inviato da oggi.");
		expect(s.store.read().orders[0]).toMatchObject({ status: "sent", sentDay: "2026-10-19" });
		expect(await s.run({ op: "change", order: "OR-0001", lines: [{ item: "Carta A4", quantity: 1 }] })).toContain("si cambia solo una bozza");
		const st = await s.run({ op: "status", supplier: "beta forniture" });
		expect(outside(st)).toContain("L'ordine OR-0001 non è ancora arrivato");
		expect(s.events.filter((e) => e.type === "orders.used").map((e) => e.op)).toEqual(["create", "change", "document", "mark_sent", "status"]);
	});

	it("«ordina 50 cartucce dal fornitore che le fa pagare meno»: the line to the cheapest, at its price; one said with a price keeps it; cancelled only by the person", async () => {
		const s = setup();
		shop(s);
		const lines = [{ item: "cartucce xl", quantity: 50 }];
		const asked = await s.run({ op: "create", lines, prefer: "cheapest" });
		expect(inside(asked).split("\n").slice(0, 2)).toEqual(["Fornitore: Gamma Carta Spa", "  1. Cartucce XL: 50 pezzi a 11,80 € (l'ultimo pagato, 10/10/2026)"]);
		const usual = await s.run({ op: "create", lines: [{ item: "cartucce xl", quantity: 50, price: "12" }] });
		expect(inside(usual)).toContain("Fornitore: Beta Forniture Srl\n  1. Cartucce XL: 50 pezzi a 12,00 € (prezzo detto da te)");
		await s.run({ op: "create", lines, prefer: "cheapest", confirm: true, check: checkIn(asked) });
		expect(s.store.read().orders[0]?.supplier.name).toBe("Gamma Carta Spa");
		// An article not in the magazzino is not ordered here.
		expect(await s.run({ op: "create", lines: [{ item: "Penne blu", quantity: 3 }] })).toContain("va prima aggiunto al magazzino");
		expect(await s.run({ op: "cancel", order: "OR-0001" }, agent())).toContain("a un altro agente do solo quanti sono");
		expect(await s.run({ op: "cancel", order: "or 1" })).toBe("Annullato l'ordine OR-0001.");
		expect(orderState(s.store.read().orders[0] as Order)).toBe("cancelled");
	});
});

describe("the goods arrive", () => {
	it("an invoice of a supplier with an order sent: its lines matched in the proposal with the differences; the order marked only with the load, each line once", async () => {
		const s = setup();
		shop(s);
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		await s.run({ op: "mark_sent", order: "OR-0001" });
		s.clock.now = new Date("2026-10-23T08:00:00Z");
		s.file(xml(BETA, ME, { number: "B-9", date: "2026-10-22", lines: [{ desc: "Cartucce XL", qty: "20.00", unit: "PZ", price: "12.80" }, { desc: "Carta A4", qty: "9.00", unit: "RISMA", price: "4.50" }, { desc: "Colla stick", qty: "3.00", unit: "PZ", price: "1.00" }] }));
		const asked = await s.stockRun({ op: "receive_invoice", supplier: "Beta", date: "ieri" });
		expect(inside(asked)).toContain(
			["Ordini aperti di questo fornitore: OR-0001", "• riga 1 → ordine OR-0001, Cartucce XL: 20 pezzi; costa 12,80 €, più dei 12,50 € dell'ordine", "• riga 2 → ordine OR-0001, Carta A4: 9 risme", "• riga 3: Colla stick non è in un ordine aperto a questo fornitore", "• ordine OR-0001, Cartucce XL: ne mancano ancora 4 pezzi"].join("\n"),
		);
		expect(outside(asked)).toContain("Questo fornitore ha un ordine in arrivo: con il carico segno nell'ordine la merce arrivata. Ci sono differenze con l'ordine (nel riquadro): falle vedere a chi ti scrive.");
		// Only shown: the order is as it was.
		expect(s.store.read().orders[0]?.receipts).toEqual([]);
		const memo = new Map<string, unknown>();
		const done = await s.stockRun({ op: "receive_invoice", supplier: "Beta", date: "ieri", confirm: true, check: checkIn(asked) }, durable("r-1", memo));
		expect(outside(done)).toContain("Ho segnato la merce arrivata nel suo ordine, come nel riquadro, con le differenze: falle vedere a chi ti scrive.");
		const o = s.store.read().orders[0] as Order;
		const k = (line: number) => expect.stringMatching(new RegExp(`^[0-9a-f]{24}#${line}$`));
		expect(o.receipts).toEqual([
			{ k: k(1), n: 1, qty: "20", day: "2026-10-22" },
			{ k: k(2), n: 2, qty: "9", day: "2026-10-22" },
		]);
		expect(orderState(o)).toBe("partial");
		// The same call again, or the invoice asked again: nothing twice.
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", date: "ieri", confirm: true, check: checkIn(asked) }, durable("r-1", memo));
		const again = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9" });
		expect(inside(again)).not.toContain("Ordini aperti");
		expect(s.store.read().orders[0]?.receipts).toHaveLength(2);
		const st = await s.run({ op: "status", supplier: "Beta" });
		expect(outside(st)).toContain("L'ordine OR-0001 è arrivato in parte: nel riquadro cosa manca.");
		expect(inside(st)).toContain("  1. Cartucce XL: 24 pezzi a 12,50 €, arrivati 20 pezzi, ne mancano 4 pezzi");
		// The rest: received.
		s.file(xml(BETA, ME, { number: "B-10", date: "2026-10-23", lines: [{ desc: "Cartucce XL", qty: "4.00", unit: "PZ", price: "12.50" }] }));
		const rest = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-10" });
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-10", confirm: true, check: checkIn(rest) });
		expect(orderState(s.store.read().orders[0] as Order)).toBe("received");
	});

	it("the matching: the oldest order first, past the quantity said, an invoice line marked once", () => {
		const line = (n: number, itemId: string, qty: string, price?: string) => ({ n, item: itemId, name: itemId, qty, unit: "pezzo", ...(price === undefined ? {} : { price, priceFrom: "said" as const }) });
		const order = (id: string, sentDay: string, lines: Order["lines"], receipts: Order["receipts"] = []): Order => ({ id, supplier: { key: "IT00000030015", name: "Beta", vat: "IT00000030015" }, status: "sent", day: sentDay, sentDay, lines, receipts, ...MARK });
		const inv = "a".repeat(24);
		const orders = [order("OR-0002", "2026-10-10", [line(1, "MG-0001", "5", "2")]), order("OR-0001", "2026-10-01", [line(1, "MG-0001", "3", "2")])];
		const m = matchInvoice(orders, { name: "Beta Forniture Srl", vat: "IT00000030015" }, inv, "2026-10-20", [{ line: 1, item: "MG-0001", qty: "10", cost: "2" }]);
		expect(m?.matched.map((x) => [x.order, x.qty, x.over])).toEqual([
			["OR-0001", 3000n, 0n],
			["OR-0002", 7000n, 2000n],
		]);
		expect(matchInvoice(orders, { name: "Altro", vat: "IT00000050013" }, inv, "2026-10-20", [])).toBeUndefined();
		const marked = [order("OR-0001", "2026-10-01", [line(1, "MG-0001", "3")], [{ k: lineKey(inv, 1), n: 1, qty: "3", day: "2026-10-20" }])];
		expect(matchInvoice(marked, { name: "Beta", vat: "IT00000030015" }, inv, "2026-10-20", [{ line: 1, item: "MG-0001", qty: "3", cost: "2" }])).toBeUndefined();
	});
});

describe("the brief, the agents, the file", () => {
	it("the brief: orders sent past the lead time, once a week and three a day at most; the articles to reorder, once a day; the lead time said per supplier", async () => {
		const s = setup();
		shop(s);
		for (let i = 0; i < 4; i++) {
			await s.run({ op: "create", lines: [{ item: "Colla stick", quantity: i + 1 }], supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", lines: [{ item: "Colla stick", quantity: i + 1 }], supplier: "Beta" })) });
			await s.run({ op: "mark_sent", order: `OR-000${i + 1}` });
		}
		s.clock.now = new Date("2026-10-27T08:00:00Z");
		const first = await s.run({ op: "list", compact: true });
		expect(outside(first)).toContain("Ordini: 3 ordini inviati non sono ancora arrivati tutti, oltre il tempo di consegna (nel riquadro).");
		expect(inside(first).split("\n")).toHaveLength(3);
		expect(inside(first)).toContain("• OR-0001 a Beta Forniture Srl, inviato il 19/10/2026, 8 giorni fa: inviato, non ancora arrivato");
		expect(outside(first)).toContain("Da riordinare: 2 articoli; chiedimi cosa riordinare per vederli.");
		// The same day: three said already, and the line on reordering too.
		expect(await s.run({ op: "list", compact: true })).toBe("Ordini: niente da segnalare.");
		// The next day: the fourth, never the three said this week; the line on reordering again.
		s.clock.now = new Date("2026-10-28T08:00:00Z");
		const next = await s.run({ op: "list", compact: true });
		expect(inside(next).split("\n")).toEqual(["• OR-0004 a Beta Forniture Srl, inviato il 19/10/2026, 9 giorni fa: inviato, non ancora arrivato"]);
		expect(outside(next)).toContain("Da riordinare: 2 articoli");
		// Beta delivers in 10 days: a week on, not late any more until the tenth day is past.
		expect(outside(await s.run({ op: "lead_time", supplier: "Beta", days: 10 }))).toContain("questo fornitore consegna in 10 giorni");
		s.clock.now = new Date("2026-10-29T08:00:00Z");
		expect(outside(await s.run({ op: "list", compact: true }))).not.toContain("Ordini: ");
		const list = await s.run({ op: "list" });
		expect(inside(list)).not.toContain("in ritardo");
		s.clock.now = new Date("2026-11-03T08:00:00Z");
		const week = await s.run({ op: "list", compact: true });
		expect(inside(week).split("\n")).toHaveLength(3);
		expect(BRIEF_INSTRUCTION).toContain("orders (list)");
		const [guarded] = readOnlyInBriefs([s.tool], async () => true);
		expect(await guarded?.execute({ op: "create", supplier: "Beta" }, fresh())).toContain("nella chat del brief del mattino Annie legge soltanto");
	});

	it("another agente gets counts only; the audit has op and count; the CSV is made inert", async () => {
		const s = setup();
		shop(s);
		s.stock.update("rename", (st) => ({ ...st, items: st.items.map((i) => (i.id === "MG-0001" ? { ...i, name: "=Cartucce XL" } : i)) }));
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		for (const op of ["suggest", "list", "status"]) {
			const text = await s.run({ op, supplier: "Beta" }, agent());
			expect(text).toBe("Ordini ai fornitori: uno aperto (una bozza, 0 inviati), 0 oltre il tempo di consegna; 2 articoli da riordinare. A un altro agente do solo i conteggi: fornitori, articoli e prezzi no.");
		}
		for (const op of ["create", "change", "mark_sent", "document", "export", "lead_time"]) expect(await s.run({ op }, agent())).toContain("a un altro agente do solo quanti sono");
		const csvAnswer = await s.run({ op: "export" });
		expect(csvAnswer).toContain("Salvato ordini/ordini-al-2026-10-19.csv");
		const csv = readFileSync(join(s.root, "ordini", "ordini-al-2026-10-19.csv"), "utf8").replace(/^\uFEFF/, "").split("\r\n");
		expect(csv[0]).toBe("Ordine;Stato;Fornitore;Preparato il;Inviato il;Codice articolo;Articolo;Quantità;Unità;Arrivati;Prezzo previsto;Importo previsto");
		expect(csv[1]).toBe("OR-0001;bozza, non ancora inviato;Beta Forniture Srl;2026-10-19;;MG-0001;'=Cartucce XL;24;pezzo;0;12,5;300,00");
		const audited = s.events.filter((e) => e.type === "orders.used");
		expect(audited.every((e) => Object.keys(e).sort().join() === "count,op,type")).toBe(true);
		expect(JSON.stringify(audited)).not.toMatch(/Beta|Cartucce|12/);
	});

	it("the routing names the tool with Italian examples", () => {
		expect(DEFAULT_INSTRUCTIONS).toContain("fare gli ordini ai fornitori (orders: «cosa devo riordinare?»");
		expect(DEFAULT_INSTRUCTIONS).not.toMatch(/\u2014/);
	});
});
