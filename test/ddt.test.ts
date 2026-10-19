import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import type { ClientCard } from "../src/core/clients.ts";
import { type Ddt, ddtCallReads, dueDayOf, validDdt } from "../src/core/ddt.ts";
import { DdtStore } from "../src/core/ddt-store.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import type { Company } from "../src/core/invoices.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import { marginLines } from "../src/core/margins.ts";
import type { PriceItem } from "../src/core/price-list.ts";
import { SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import { isIssued, type SalesInvoice, validInvoice } from "../src/core/sales-invoices.ts";
import type { Movement, StockItem } from "../src/core/stock.ts";
import { StockStore } from "../src/core/stock-store.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { createDdtTools, type DdtEvent } from "../src/core/tools/ddt-tools.ts";
import { saleOf } from "../src/core/tools/sales-invoice-stock.ts";
import { createSalesInvoiceTools, type SalesEvent } from "../src/core/tools/sales-invoice-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic data only: checksum-valid fake partite IVA, invented names.
const NOW = new Date("2026-10-05T08:00:00Z");
const AT = NOW.toISOString();
const MARK = { by: "test:u", at: AT };
const IBAN = "IT51X0000000000000000000001";
const COMPANY: Company = { vat: "IT00000010017", name: "Bottega Prova Srl", cf: "00000010017", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: [IBAN], ...MARK };

const ROSSI: ClientCard = { id: "CL-0001", name: "Rossi Prova Srl", vat: "IT00000020016", aliases: [], contacts: [], address: "Via Verdi 2, 00184 Roma RM", tags: [], notes: [], followUps: [], ...MARK };
const VERDI: ClientCard = { id: "CL-0002", name: "Verdi Prova Spa", vat: "IT00000050013", aliases: [], contacts: [], address: "Via Neri 3, 10121 Torino TO", tags: [], notes: [], followUps: [], ...MARK };

const LISTINO: PriceItem[] = [
	{ id: "LS-0001", name: "Carta A4", unit: "risma", price: "5", vat: 22, ...MARK },
	{ id: "LS-0002", name: "Toner XL", unit: "pezzo", price: "30", vat: 22, ...MARK },
];
const ITEMS: StockItem[] = [
	{ id: "MG-0001", name: "Carta A4", unit: "risma", listino: "LS-0001", ...MARK },
	{ id: "MG-0002", name: "Toner XL", unit: "pezzo", listino: "LS-0002", ...MARK },
];

let calls = 0;
const fresh = (callId = `d${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
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

const FENCE = /<<<dati (?:dei DDT|del magazzino|delle fatture emesse|del listino) ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati (?:dei DDT|del magazzino|delle fatture emesse|del listino) \1>>>/g;
const outside = (text: string) => text.replace(FENCE, "");
const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
const checkIn = (answer: string) => /il controllo ([0-9a-f]{16})/.exec(answer)?.[1] as string;

const EMDASH = /\u2014/;
const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(o: { askFirst?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "annie-ddt-"));
	dirs.push(dir);
	const root = join(dir, "workspace");
	mkdirSync(join(root, "fatture"), { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const stock = new StockStore(dir);
	const moves: Movement[] = [
		{ id: "MV-000001", item: "MG-0001", kind: "carico", qty: "50", day: "2026-09-01", cost: "3.2", ...MARK },
		{ id: "MV-000002", item: "MG-0002", kind: "carico", qty: "10", day: "2026-09-01", cost: "18", ...MARK },
	];
	stock.update("seed", (st) => ({ ...st, nextItem: 3, nextMove: 3, items: ITEMS, moves }));
	const store = new DdtStore(dir);
	const sales = new SalesInvoiceStore(dir);
	sales.update("seed", (state) => ({ ...state, settings: { ...MARK, lastBefore: { 2026: 0 } } }));
	// The last DDT before Annie said already (none), unless the test is about asking it.
	if (!o.askFirst) store.update("seed", (state) => ({ ...state, settings: { ...MARK, lastBefore: { 2026: 0 } } }));
	const clients = { read: () => ({ cards: [ROSSI, VERDI], nextCard: 3, nextFollowUp: 1, calls: [], broken: false }) };
	const priceList = { read: () => ({ items: LISTINO, broken: false }) as never };
	const events: (DdtEvent | SalesEvent)[] = [];
	const clock = { now: NOW };
	const made: MakeInput[] = [];
	const make = async (input: MakeInput) => {
		made.push(input);
		return { data: new TextEncoder().encode(input.text), notes: [] };
	};
	const [tool] = createDdtTools({ workspace, store, sales, clients, priceList, stock, company: invoices, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	const [salesTool] = createSalesInvoiceTools({ workspace, store: sales, company: invoices, taxes: new TaxStore(dir), clients, priceList, stock, ddt: store, scanner, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	if (tool === undefined || salesTool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const sell = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await salesTool.execute(args, c));
	return { dir, root, stock, store, sales, events, clock, made, tool, run, sell };
}

type S = ReturnType<typeof setup>;

const PAPER_AND_TONER = [
	{ item: "Carta A4", quantity: 10 },
	{ item: "Toner XL", quantity: 2 },
];

/** A DDT made and issued for the client, on the clock's day: its number. */
async function shipped(s: S, client = "Rossi Prova Srl", lines: unknown[] = PAPER_AND_TONER, more: Record<string, unknown> = {}): Promise<string> {
	const made = await s.run({ op: "create", client, lines, transport: "mittente", ...more });
	if (!made.includes("Fatto")) throw new Error(made);
	const draft = s.store.read().ddts.filter((d) => d.status === "draft").at(-1) as Ddt;
	const text = await s.run({ op: "issue", ddt: draft.id, confirm: true });
	expect(text).toContain("Fatto: ho emesso il DDT n.");
	return s.store.read().ddts.find((d) => d.id === draft.id)?.number as string;
}

const onHand = (s: S, item: string) => s.stock.read().moves.filter((m) => m.item === item).reduce((n, m) => n + (m.kind === "carico" || m.kind === "storno" ? Number(m.qty) : m.kind === "scarico" ? -Number(m.qty) : 0), 0);

describe("the DDT drafts", () => {
	it("a client and voci dictated by their very names: the draft at once, no number, causale vendita said, the transport asked before the issue; the audit op and count only", async () => {
		const s = setup();
		const text = await s.run({ op: "create", client: "Rossi Prova Srl", lines: [...PAPER_AND_TONER, { description: "Cavo USB", quantity: 3, unit: "pz" }] });
		expect(outside(text)).toContain("Fatto: ho preparato la bozza del DDT (DT-0001), come nel riquadro, con causale vendita. Non ha ancora un numero");
		expect(outside(text)).toContain("Prima di emetterlo mi serve chi fa il trasporto");
		expect(outside(text)).not.toContain("Rossi");
		expect(inside(text)).toContain("Cliente: Rossi Prova Srl, P.IVA 00000020016");
		expect(inside(text)).toContain("1. Carta A4: 10 risme (voce LS-0001)");
		expect(inside(text)).toContain("3. Cavo USB: 3 pezzi");
		const d = s.store.read().ddts[0] as Ddt;
		expect(d).toMatchObject({ id: "DT-0001", status: "draft", client: { name: "Rossi Prova Srl", card: "CL-0001", vat: "IT00000020016" }, causale: "vendita" });
		expect(d.number).toBeUndefined();
		expect(validDdt(d)).toBe(true);
		expect(s.events).toEqual([{ type: "ddt.used", op: "create", count: 1 }]);
		expect(text).not.toMatch(EMDASH);
	});

	it("a client or a voce only close to what was said: a proposal with a check; the yes with the check makes it, a wrong check makes nothing", async () => {
		const s = setup();
		const text = await s.run({ op: "create", client: "Rossi Prova", lines: [{ item: "Toner", quantity: 2 }], transport: "vettore", carrier: "Corriere Prova" });
		expect(outside(text)).toContain("Preparerei questa bozza di DDT");
		expect(outside(text)).toContain("il cliente ha lo stesso nome a meno della forma societaria");
		expect(inside(text)).toContain("Trasporto: a cura del vettore (Corriere Prova)");
		expect(s.store.read().ddts).toEqual([]);
		const wrong = await s.run({ op: "create", client: "Rossi Prova", lines: [{ item: "Toner", quantity: 2 }], transport: "vettore", carrier: "Corriere Prova", confirm: true, check: "0123456789abcdef" });
		expect(wrong).toContain("La proposta è cambiata");
		expect(s.store.read().ddts).toEqual([]);
		const ok = await s.run({ op: "create", client: "Rossi Prova", lines: [{ item: "Toner", quantity: 2 }], transport: "vettore", carrier: "Corriere Prova", confirm: true, check: checkIn(text) });
		expect(ok).toContain("Fatto: ho preparato la bozza del DDT (DT-0001)");
		expect(s.store.read().ddts[0]?.lines[0]).toMatchObject({ item: "LS-0002", description: "Toner XL", qty: "2", unit: "pezzo" });
	});

	it("a change while a draft: a line added, one taken off with 0, the transport; an issued DDT is not changed", async () => {
		const s = setup();
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER });
		const text = await s.run({ op: "change", client: "Rossi Prova Srl", lines: [{ item: "Toner XL", quantity: 0 }, { description: "Cavo USB", quantity: 1 }], transport: "destinatario", packages: 2, weight: "12,5" });
		expect(outside(text)).toContain("Fatto: ho cambiato la bozza DT-0001");
		const d = s.store.read().ddts[0] as Ddt;
		expect(d.lines.map((l) => l.description)).toEqual(["Carta A4", "Cavo USB"]);
		expect(d).toMatchObject({ transport: { by: "destinatario" }, packages: 2, weight: "12.5" });
		await s.run({ op: "issue", ddt: "DT-0001", confirm: true });
		const again = await s.run({ op: "change", ddt: "1/2026", lines: [{ description: "Altro", quantity: 1 }] });
		expect(again).toContain("già emesso");
	});

	it("only the person: a notice cannot make or issue a DDT; another agente gets counts only", async () => {
		const s = setup();
		const notice = await s.run({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER }, fresh(undefined, "notice"));
		expect(notice).toContain("Non preparo il DDT");
		expect(s.store.read().ddts).toEqual([]);
		await shipped(s);
		await s.run({ op: "create", client: "Verdi Prova Spa", lines: PAPER_AND_TONER });
		const counts = await s.run({ op: "list" }, agent());
		expect(counts).toBe("DDT: una bozza, uno di vendita da fatturare. A un altro agente do solo i conteggi: clienti, merce e numeri no.");
		expect(await s.run({ op: "issue", ddt: "DT-0002", confirm: true }, agent())).toContain("a un altro agente do solo quanti sono");
		expect(s.store.read().ddts.find((d) => d.id === "DT-0002")?.status).toBe("draft");
	});
});

describe("issuing a DDT", () => {
	it("before the yes: the number it takes and what it unloads; with the yes the number of the year, the magazzino unloaded once per line however many times it runs", async () => {
		const s = setup();
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: [...PAPER_AND_TONER, { description: "Cavo USB", quantity: 3 }], transport: "mittente" });
		const preview = await s.run({ op: "issue", ddt: "DT-0001" });
		expect(outside(preview)).toContain("Emetterei questo DDT con la data di oggi: prende il numero 1/2026.");
		expect(outside(preview)).toContain("Effetti sul magazzino: questo DDT scarica gli articoli nel riquadro.");
		expect(inside(preview)).toContain("Scarica dal magazzino: Carta A4 −10 risme");
		expect(inside(preview)).toContain("Scarica dal magazzino: Toner XL −2 pezzi");
		expect(s.stock.read().moves).toHaveLength(2);
		const memo = new Map<string, unknown>();
		const text = await s.run({ op: "issue", ddt: "DT-0001", confirm: true }, durable("issue-1", memo));
		expect(outside(text)).toContain("Fatto: ho emesso il DDT n. 1/2026 del 05/10/2026");
		expect(outside(text)).toContain("Ho scaricato dal magazzino 2 righe del DDT:");
		const out = s.stock.read().moves.filter((m) => m.kind === "scarico");
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ item: "MG-0001", qty: "10", reason: "vendita", sale: { invoice: "DT-0001", line: 1, number: "1/2026" }, cost: "3.2" });
		// Run again (a crash after the stock step): nothing moves twice.
		await s.run({ op: "issue", ddt: "DT-0001", confirm: true }, durable("issue-1", memo));
		await s.run({ op: "issue", ddt: "DT-0001", confirm: true }, durable("issue-1", new Map()));
		expect(s.stock.read().moves.filter((m) => m.kind === "scarico")).toHaveLength(2);
		expect(onHand(s, "MG-0001")).toBe(40);
		expect(s.store.read().ddts[0]).toMatchObject({ status: "issued", number: "1/2026", year: 2026, seq: 1, stocked: true });
		expect(s.events.filter((e) => e.op === "issue")).toEqual([{ type: "ddt.used", op: "issue", count: 1 }]);
		const movements = await (async () => {
			const { createStockTools } = await import("../src/core/tools/stock-tools.ts");
			const [st] = createStockTools({ workspace: new Workspace(s.root), store: s.stock, timeZone: "Europe/Rome", whoIs: () => "test:u", now: () => s.clock.now });
			return String(await st?.execute({ op: "movements", item: "MG-0001" }, fresh()));
		})();
		expect(movements).toContain("vendita, DDT n. 1/2026");
	});

	it("a magazzino that does not read never stops the issue: the DDT takes its number and completes when issued again", async () => {
		const s = setup();
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER, transport: "mittente" });
		const file = join(s.dir, "stock.json");
		const good = readFileSync(file, "utf8");
		writeFileSync(file, "{ rotto");
		const preview = await s.run({ op: "issue", ddt: "DT-0001" });
		expect(preview).toContain("il magazzino non si legge");
		const text = await s.run({ op: "issue", ddt: "DT-0001", confirm: true });
		expect(outside(text)).toContain("Fatto: ho emesso il DDT n. 1/2026");
		expect(outside(text)).toContain("l'emissione resta da completare");
		expect(s.store.read().ddts[0]).toMatchObject({ status: "issued", number: "1/2026" });
		expect(s.store.read().ddts[0]?.stocked).toBeUndefined();
		writeFileSync(file, good);
		const done = await s.run({ op: "issue", ddt: "1/2026" });
		expect(done).toContain("Ho scaricato dal magazzino 2 righe del DDT");
		expect(s.store.read().ddts[0]?.stocked).toBe(true);
		expect(s.store.read().ddts[0]?.number).toBe("1/2026");
	});

	it("a reso of a DDT puts its goods back, never more than it took out; a conto visione unloads; a riparazione moves nothing", async () => {
		const s = setup();
		await shipped(s);
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 5 }], { causale: "riparazione" });
		expect(onHand(s, "MG-0001")).toBe(40);
		await shipped(s, "Rossi Prova Srl", [{ item: "Toner XL", quantity: 1 }], { causale: "conto visione" });
		expect(onHand(s, "MG-0002")).toBe(7);
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Carta A4", quantity: 30 }], causale: "reso", of: "1/2026", transport: "destinatario" });
		const draft = s.store.read().ddts.at(-1) as Ddt;
		expect(draft).toMatchObject({ causale: "reso", of: "DT-0001" });
		const preview = await s.run({ op: "issue", ddt: draft.id });
		expect(inside(preview)).toContain("Rimette in magazzino: Carta A4 +10 risme");
		await s.run({ op: "issue", ddt: draft.id, confirm: true });
		expect(onHand(s, "MG-0001")).toBe(50);
		const storno = s.stock.read().moves.find((m) => m.kind === "storno");
		expect(storno).toMatchObject({ qty: "10", sale: { invoice: draft.id, of: "DT-0001" } });
		// A reso from another client's DDT is refused.
		const other = await s.run({ op: "create", client: "Verdi Prova Spa", lines: [{ item: "Carta A4", quantity: 1 }], causale: "reso", of: "1/2026" });
		expect(other).toContain("è di un altro cliente");
	});

	it("the first DDT of the year asks the last number before Annie, the person's word only", async () => {
		const s = setup({ askFirst: true });
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER, transport: "mittente" });
		expect(await s.run({ op: "issue", ddt: "DT-0001", confirm: true })).toContain("È il primo DDT che emetti con me nel 2026: qual è il numero dell'ultimo DDT che hai fatto quest'anno?");
		expect(s.store.read().ddts[0]?.status).toBe("draft");
		expect(await s.run({ op: "issue", ddt: "DT-0001", last_number: 11, confirm: true }, fresh(undefined, "notice"))).toContain("Non fisso da che numero partono i DDT");
		const preview = await s.run({ op: "issue", ddt: "DT-0001", last_number: 11 });
		expect(preview).toContain("prende il numero 12/2026");
		const text = await s.run({ op: "issue", ddt: "DT-0001", confirm: true });
		expect(text).toContain("Fatto: ho emesso il DDT n. 12/2026");
	});

	it("the numbering: the last number before Annie, «12» or «12/2026», the person's word only; annulled keeps its number", async () => {
		const s = setup({ askFirst: true });
		expect(await s.run({ op: "settings", last_number: 40 }, fresh(undefined, "notice"))).toContain("Non cambio la numerazione dei DDT");
		const set = await s.run({ op: "settings", last_number: 40 });
		expect(set).toContain("il prossimo sarà il 41/2026");
		expect(await shipped(s)).toBe("41/2026");
		expect(await s.run({ op: "settings", numbering: "plain" })).toContain("Nel 2026 ho già emesso DDT");
		const cancelled = await s.run({ op: "cancel", ddt: "41/2026" });
		expect(cancelled).toContain("Annullato il DDT n. 41/2026: resta nell'elenco come annullato");
		expect(cancelled).toContain("era stata scaricata dal magazzino");
		expect(await shipped(s)).toBe("42/2026");
		expect(s.store.read().ddts.find((d) => d.id === "DT-0001")).toMatchObject({ status: "cancelled", number: "41/2026" });
	});
});

describe("documents and files", () => {
	it("the PDF of an issued DDT in ddt/, never sent; a draft is not printed; the CSV is formula-safe", async () => {
		const s = setup();
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ description: "=HYPERLINK(1)", quantity: 1 }], transport: "vettore", carrier: "Corriere Prova", packages: 1 });
		expect(await s.run({ op: "document", ddt: "DT-0001" })).toContain("è ancora una bozza: prima va emesso");
		await s.run({ op: "issue", ddt: "DT-0001", confirm: true });
		const text = await s.run({ op: "document", ddt: "1/2026" });
		expect(outside(text)).toContain("Ecco il PDF del DDT n. 1/2026: il file è nel riquadro. Non l'ho mandato a nessuno");
		expect(inside(text)).toContain("File: ddt/DDT-1-2026-Rossi-Prova-Srl.pdf");
		const doc = s.made[0]?.text ?? "";
		expect(doc).toContain("# Documento di trasporto n. 1/2026");
		expect(doc).toContain("**Causale del trasporto:** vendita");
		expect(doc).toContain("**Trasporto:** a cura del vettore \\(Corriere Prova\\)");
		expect(doc).toContain("Firma del vettore");
		const csv = await s.run({ op: "export" });
		expect(csv).toContain("Salvato il file dei DDT: un DDT");
		const file = readdirSync(join(s.root, "ddt")).find((f) => f.endsWith(".csv")) as string;
		const content = readFileSync(join(s.root, "ddt", file), "utf8");
		expect(content).toContain("'=HYPERLINK(1)");
		expect(content).not.toMatch(/;=HYPERLINK/);
	});
});

describe("the fattura differita", () => {
	/** October: two DDTs to Rossi (one with a free line), one to Verdi; then November 3rd. */
	async function october(s: S) {
		s.clock.now = new Date("2026-10-05T08:00:00Z");
		await shipped(s, "Rossi Prova Srl", [...PAPER_AND_TONER, { description: "Cavo USB", quantity: 3, unit: "pz" }]);
		s.clock.now = new Date("2026-10-20T08:00:00Z");
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 5 }]);
		await shipped(s, "Verdi Prova Spa", [{ item: "Toner XL", quantity: 1 }]);
		s.clock.now = new Date("2026-11-03T08:00:00Z");
	}

	it("the month's vendita DDTs of the client: a row with no voce asked, never priced; with its price the draft, DatiDDT in the XML, no second unload, billed only at issue", async () => {
		const s = setup();
		await october(s);
		const movesBefore = s.stock.read().moves.length;
		const asked = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		expect(outside(asked)).toContain("mi serve il prezzo per unità, senza IVA, di una riga dei DDT che non è una voce del listino");
		expect(inside(asked)).toContain("3. DDT n. 1/2026: Cavo USB, 3 pz");
		expect(s.sales.read().invoices).toEqual([]);
		const text = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001", vat: 22, prices: [{ row: 3, price: "4,5" }] });
		expect(outside(text)).toContain("È la fattura differita di 2 DDT di ottobre 2026: va emessa entro il 15 novembre 2026");
		const draft = s.sales.read().invoices[0] as SalesInvoice;
		expect(draft.ddt).toEqual([
			{ id: "DT-0001", number: "1/2026", date: "2026-10-05" },
			{ id: "DT-0002", number: "2/2026", date: "2026-10-20" },
		]);
		expect(draft.lines.map((l) => [l.description, l.quantity, l.price, l.item, l.ddt?.id, l.ddt?.line])).toEqual([
			["Carta A4", "10", "5", "LS-0001", "DT-0001", 1],
			["Toner XL", "2", "30", "LS-0002", "DT-0001", 2],
			["Cavo USB", "3", "4.5", undefined, "DT-0001", 3],
			["Carta A4", "5", "5", "LS-0001", "DT-0002", 1],
		]);
		expect(validInvoice(draft)).toBe(true);
		// The invoice moves nothing the DDTs moved.
		expect(saleOf(draft, "x", "2026-11-03")).toBeUndefined();
		// A draft bills nothing: the DDTs are held, not billed; a second draft for them is refused.
		expect(s.store.read().ddts.every((d) => d.billed === undefined)).toBe(true);
		const list = await s.run({ op: "list", unbilled: true });
		expect(inside(list)).toContain("nella bozza di fattura BZ-0001");
		const twice = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001", vat: 22, prices: [{ row: 3, price: "4,5" }] });
		expect(twice).toContain("sono già nella bozza BZ-0001");
		expect(await s.run({ op: "cancel", ddt: "1/2026" })).toContain("è nella bozza di fattura BZ-0001");
		const preview = await s.sell({ op: "issue", draft: "BZ-0001" });
		expect(preview).toContain("È una fattura differita di 2 DDT: emessa, li segno come fatturati; la merce è già uscita dal magazzino con i DDT e non la scarico di nuovo.");
		expect(preview).toContain("Va emessa entro il 15 novembre 2026.");
		const issued = await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		expect(issued).toContain("Ho segnato come fatturati i 2 DDT della fattura differita.");
		expect(s.stock.read().moves.length).toBe(movesBefore);
		const ddts = s.store.read().ddts;
		expect(ddts.find((d) => d.id === "DT-0001")?.billed).toEqual({ invoice: "BZ-0001", number: "1", day: "2026-11-03" });
		expect(ddts.find((d) => d.id === "DT-0003")?.billed).toBeUndefined();
		const inv = s.sales.read().invoices[0] as SalesInvoice;
		expect(isIssued(inv) && inv.finished).toBe(true);
		const xml = readFileSync(join(s.root, inv.file as string), "utf8");
		expect(xml).toContain("<DatiDDT>\n\t\t\t\t<NumeroDDT>1/2026</NumeroDDT>\n\t\t\t\t<DataDDT>2026-10-05</DataDDT>\n\t\t\t\t<RiferimentoNumeroLinea>1</RiferimentoNumeroLinea>\n\t\t\t\t<RiferimentoNumeroLinea>2</RiferimentoNumeroLinea>\n\t\t\t\t<RiferimentoNumeroLinea>3</RiferimentoNumeroLinea>\n\t\t\t</DatiDDT>");
		expect(xml).toContain("<NumeroDDT>2/2026</NumeroDDT>\n\t\t\t\t<DataDDT>2026-10-20</DataDDT>\n\t\t\t\t<RiferimentoNumeroLinea>4</RiferimentoNumeroLinea>");
		// The schema's order: DatiDDT after DatiGeneraliDocumento, before DatiBeniServizi.
		expect(xml.indexOf("<DatiDDT>")).toBeGreaterThan(xml.indexOf("</DatiGeneraliDocumento>"));
		expect(xml.indexOf("<DatiDDT>")).toBeLessThan(xml.indexOf("<DatiBeniServizi>"));
		const unbilled = await s.run({ op: "list", unbilled: true });
		expect(inside(unbilled)).toContain("Verdi Prova Spa");
		expect(inside(unbilled)).not.toContain("Rossi");
		expect(await s.run({ op: "cancel", ddt: "1/2026" })).toContain("è già fatturato con la fattura n. 1");
		// The margins find the cost on the DDT's scarico, never «none».
		const stock = s.stock.read();
		const lines = marginLines({ invoices: s.sales.read().invoices, items: stock.items, moves: stock.moves, archived: stock.archived, codes: stock.codes, units: stock.units, listino: LISTINO, purchases: [] }, "2026-11-01", "2026-11-30");
		const goods = lines.filter((l) => l.kind === "goods");
		expect(goods.map((l) => ("source" in l ? [l.source, "cost" in l ? l.cost : undefined] : []))).toEqual([
			["sale", 3200n],
			["sale", 3600n],
			["sale", 1600n],
		]);
	});

	it("removing the draft frees its DDTs; several months are asked; a month with nothing to bill said", async () => {
		const s = setup();
		await october(s);
		await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, recipient_code: "ZZZ0001" });
		expect(s.sales.read().invoices[0]?.ddt?.map((d) => d.id)).toEqual(["DT-0003"]);
		await s.sell({ op: "remove", draft: "BZ-0001" });
		const again = await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		expect(again).toContain("È la fattura differita di un DDT di ottobre 2026");
		await shipped(s, "Rossi Prova Srl", [{ item: "Toner XL", quantity: 1 }]);
		const months = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, recipient_code: "ZZZ0001" });
		expect(months).toContain("Questo cliente ha DDT da fatturare in più mesi (ottobre 2026, novembre 2026)");
		const none = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "settembre", recipient_code: "ZZZ0001" });
		expect(none).toContain("Nessun DDT da fatturare per questo cliente a settembre 2026");
		expect(await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "T3", recipient_code: "ZZZ0001" })).toContain("un mese solo");
	});

	it("a DDT file that does not read: never written over, the differita not issued before a number is taken; a credit note of it carries no DDT", async () => {
		const s = setup();
		await october(s);
		await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		const file = join(s.dir, "ddt.json");
		const good = readFileSync(file, "utf8");
		writeFileSync(file, "{ rotto");
		expect(await s.run({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER })).toContain("i DDT (ddt.json) non si leggono");
		expect(await s.sell({ op: "issue", draft: "BZ-0001", confirm: true })).toContain("i DDT (ddt.json) non si leggono");
		expect(readFileSync(file, "utf8")).toBe("{ rotto");
		expect(s.sales.read().invoices.some((i) => isIssued(i))).toBe(false);
		writeFileSync(file, good);
		expect(await s.sell({ op: "issue", draft: "BZ-0001", confirm: true })).toContain("Ho segnato come fatturato il DDT della fattura differita.");
		const credit = await s.sell({ op: "credit_note", invoice: "1" });
		expect(credit).not.toContain("Errore");
		const note = s.sales.read().invoices.find((i) => i.type === "TD04") as SalesInvoice;
		expect(note.ddt).toBeUndefined();
		expect(note.lines.every((l) => l.ddt === undefined)).toBe(true);
		expect(validInvoice(note)).toBe(true);
	});

	it("the 15th of the month after the DDTs: late said before the yes", async () => {
		const s = setup();
		await october(s);
		await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		s.clock.now = new Date("2026-11-18T08:00:00Z");
		const preview = await s.sell({ op: "issue", draft: "BZ-0001" });
		expect(preview).toContain("andava emessa entro il 15 novembre 2026: oggi è in ritardo");
		expect(dueDayOf("2026-12-09")).toBe("2027-01-15");
	});
});

describe("the brief and the routing", () => {
	it("last month's DDTs not invoiced: how many and the clients, once a day, the 15th after the 10th; drafts older than a week", async () => {
		const s = setup();
		s.clock.now = new Date("2026-10-05T08:00:00Z");
		await shipped(s);
		await shipped(s, "Verdi Prova Spa");
		await s.run({ op: "create", client: "Verdi Prova Spa", lines: PAPER_AND_TONER });
		s.clock.now = new Date("2026-11-12T08:00:00Z");
		const memo = new Map<string, unknown>();
		const text = await s.run({ op: "list", compact: true }, durable("brief-1", memo));
		expect(outside(text)).toContain("DDT di ottobre 2026 non ancora fatturati: 2, di 2 clienti (nel riquadro).");
		expect(inside(text)).toContain("• Rossi Prova Srl");
		expect(outside(text)).toContain("la fattura differita va emessa entro il 15 novembre 2026: mancano 3 giorni");
		expect(outside(text)).toContain("Una bozza di DDT è ferma da più di 7 giorni");
		expect(await s.run({ op: "list", compact: true }, fresh("brief-2"))).toBe("DDT: niente da segnalare.");
		// The same call again gets back what it claimed.
		expect(outside(await s.run({ op: "list", compact: true }, durable("brief-1", memo)))).toContain("non ancora fatturati: 2");
		expect(s.events.filter((e) => e.op === "brief")).toEqual([{ type: "ddt.used", op: "brief", count: 2 }]);
	});

	it("the instructions, the brief and its read-only thread", async () => {
		const s = setup();
		expect(DEFAULT_INSTRUCTIONS).toContain("fare i DDT per la merce che spedisce ai clienti (ddt:");
		expect(DEFAULT_INSTRUCTIONS).toContain("«fai la fattura differita di ottobre per Rossi», è sales_invoices con ddt e il mese");
		expect(BRIEF_INSTRUCTION).toContain("ddt (list)");
		expect(ddtCallReads({ op: "list" })).toBe(true);
		expect(ddtCallReads({ op: "issue" })).toBe(false);
		const [guarded] = readOnlyInBriefs([s.tool], async () => true);
		expect(String(await guarded?.execute({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER }, fresh()))).toContain("nella chat del brief del mattino Annie legge soltanto");
		expect(String(await guarded?.execute({ op: "list", compact: true }, fresh()))).toBe("DDT: niente da segnalare.");
		expect(s.tool.description).toContain("«fammi il DDT per Rossi: 10 risme e 2 toner» → create");
	});
});
