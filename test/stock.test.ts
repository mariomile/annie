import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { PriceListStore } from "../src/core/price-list-store.ts";
import { SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import { isIssued } from "../src/core/sales-invoices.ts";
import { SCHEDULE_LIMITS } from "../src/core/schedules.ts";
import { stockAgentReads, stockCallReads } from "../src/core/stock.ts";
import { STOCK_BROKEN, StockStore } from "../src/core/stock-store.ts";
import { stateOf } from "../src/core/stock-sums.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { createSalesInvoiceTools } from "../src/core/tools/sales-invoice-tools.ts";
import { createStockTools, type StockEvent } from "../src/core/tools/stock-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic data only: checksum-valid fake partite IVA, invented names and suppliers.
const NOW = new Date("2026-10-19T08:00:00Z"); // Monday 19 October 2026, in Rome
const ORDINARIO: Company = { vat: "IT00000010017", name: "Bottega Prova Srl", cf: "00000010017", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: ["IT51X0000000000000000000001"], by: "test:u", at: NOW.toISOString() };
const DELTA = { customer: "Delta Servizi Srl", vat_number: "00000020016", address: "Via Verdi 2, 00184 Roma RM", recipient_code: "ZZZ0001" };

let calls = 0;
const fresh = (callId = `s${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });

const FENCE = /<<<dati del magazzino ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati del magazzino \1>>>/g;
const outside = (text: string) => text.replace(FENCE, "");
const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
const NO_EM_DASH = /\u2014/;
/** Text for the person never names an op or a parameter. */
const NO_OPS = /\b(add_item|receive|unload|remove_item|movements|compact|confirm|uso_interno)\b/;

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "annie-stock-"));
	dirs.push(dir);
	return dir;
}

function setup() {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(ORDINARIO);
	const priceList = new PriceListStore(dir);
	priceList.addMany("seed", 2, (id, n) => (n === 0 ? { id, name: "Cartucce XL", unit: "pezzo", price: "25", vat: 22, by: "test:u", at: NOW.toISOString() } : { id, name: "Consulenza", unit: "ora", price: "60", vat: 22, by: "test:u", at: NOW.toISOString() }));
	const store = new StockStore(dir);
	const events: StockEvent[] = [];
	const [tool] = createStockTools({ workspace, store, priceList, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => NOW });
	if (tool === undefined) throw new Error("no tool");
	const sales = new SalesInvoiceStore(dir);
	sales.update("seed", (state) => ({ ...state, settings: { by: "test:u", at: NOW.toISOString(), lastBefore: { 2026: 0 } } }));
	const [salesTool] = createSalesInvoiceTools({
		workspace,
		store: sales,
		company: invoices,
		taxes: new TaxStore(dir),
		priceList,
		stock: store,
		scanner: new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) }),
		timeZone: "Europe/Rome",
		whoIs: () => "test:u",
		now: () => NOW,
		make: async (input) => ({ data: Buffer.from(`%PDF-1.4 finta\n${input.text}`), notes: [] }),
	});
	if (salesTool === undefined) throw new Error("no sales tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const sell = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await salesTool.execute(args, c));
	const onHand = (id = "MG-0001") => {
		const b = store.read();
		const item = b.items.find((i) => i.id === id);
		if (item === undefined) throw new Error(`no ${id}`);
		return stateOf(item, b.moves);
	};
	return { dir, root, store, events, run, sell, sales, onHand };
}

describe("il magazzino: carichi, scarichi e costo medio", () => {
	it("recomputes the weighted average on every carico, and a scarico never changes it", async () => {
		const s = setup();
		const added = await s.run({ op: "add_item", item: "Toner nero", unit: "pezzi", min: 10 });
		expect(added).toContain("nuovo articolo MG-0001");
		expect(inside(added)).toContain("Toner nero");
		const first = await s.run({ op: "receive", item: "toner nero", quantity: 10, cost: "12" });
		expect(first).toContain("+10 pezzi a 12,00 €");
		const second = await s.run({ op: "receive", item: "MG-0001", quantity: 30, cost: "8", supplier: "Beta Forniture Srl", doc: "DDT 45" });
		// (10 × 12 + 30 × 8) / 40 = 9.
		expect(second).toContain("costo medio 9,00 € (era 12,00 €)");
		expect(second).toContain("valore 360,00 €");
		expect(inside(second)).toContain("Beta Forniture Srl");
		expect(outside(second)).not.toContain("Beta");
		const out = await s.run({ op: "unload", item: "toner nero", quantity: 5, reason: "uso_interno" });
		expect(out).toContain("−5 pezzi, uso interno. Ora 35 pezzi.");
		expect(s.onHand().average).toBe(90_000n);
		expect(s.onHand().value).toBe(31_500n);
		expect(await s.run({ op: "status", item: "toner nero" })).toContain("costo medio ponderato 9,00 € per unità, valore 315,00 €");
		expect(await s.run({ op: "value" })).toContain("Il magazzino vale 315,00 €");
		// Each movement once: the call run again writes nothing twice.
		const again = fresh("same-call");
		await s.run({ op: "receive", item: "toner nero", quantity: 1, cost: 9 }, again);
		await s.run({ op: "receive", item: "toner nero", quantity: 1, cost: 9 }, again);
		expect(s.onHand().onHand).toBe(36_000n);
		for (const text of [added, first, second, out]) {
			expect(text).not.toMatch(NO_EM_DASH);
			expect(outside(text)).not.toMatch(NO_OPS);
		}
	});

	it("keeps quantities to three decimals (kg, m, l) and refuses a fourth", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Filo di rame", unit: "metri" });
		expect(s.store.read().items[0]?.unit).toBe("m");
		expect(await s.run({ op: "receive", item: "filo di rame", quantity: 2.125, cost: "3,2" })).toContain("+2,125 m a 3,20 €");
		await s.run({ op: "unload", item: "filo di rame", quantity: "0,5", reason: "vendita" });
		expect(s.onHand().onHand).toBe(1625n);
		expect(await s.run({ op: "status", item: "filo di rame" })).toContain("1,625 m in magazzino");
		expect(await s.run({ op: "receive", item: "filo di rame", quantity: 1.2345, cost: 1 })).toMatch(/^Errore: .*al più 3 decimali/);
		// «1.250» reads two ways: asked, never guessed.
		expect(await s.run({ op: "receive", item: "filo di rame", quantity: "1.250", cost: 1 })).toContain("migliaia o decimali");
		expect(s.store.read().moves).toHaveLength(2);
	});

	it("asks once before going under zero; only a person's yes records it, and it stays in negativo until a count", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 5, cost: 12 });
		const asked = await s.run({ op: "unload", item: "cartucce xl", quantity: 8, reason: "vendita" });
		expect(asked).toContain("andrebbe in negativo di 3 pezzi");
		expect(asked).not.toMatch(/^Errore/);
		expect(s.store.read().moves).toHaveLength(1);
		// The yes from a scheduled turn or another agente is no person's yes.
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 8, reason: "vendita", confirm: true }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 8, reason: "vendita", confirm: true }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(s.store.read().moves).toHaveLength(1);
		// A scarico within what there is stays open (bookkeeping).
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 1, reason: "scarto" }, fresh(undefined, "scheduled"))).toContain("Fatto, scarico");
		const done = await s.run({ op: "unload", item: "cartucce xl", quantity: 7, reason: "vendita", confirm: true });
		expect(done).toContain("Ora −3 pezzi");
		expect(done).toContain("in negativo");
		expect(s.onHand().negative).toBe(true);
		// A carico back above zero does not clear it: only a count does.
		await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 12 });
		expect(s.onHand().negative).toBe(true);
		expect(await s.run({ op: "low" })).toContain("in negativo, da ricontare");
		const counted = await s.run({ op: "count", item: "cartucce xl", quantity: 7 });
		expect(counted).toContain("Non è più in negativo.");
		expect(s.onHand().negative).toBe(false);
	});

	it("a count adds a rettifica with the difference and never edits a movement; only the person asks it", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12 });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 10, reason: "vendita" });
		const before = JSON.stringify(s.store.read().moves);
		expect(await s.run({ op: "count", item: "cartucce xl", quantity: 37 }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "count", item: "cartucce xl", quantity: 37 }, agent())).toMatch(/^Errore: a un altro agente/);
		const answer = await s.run({ op: "count", item: "cartucce xl", quantity: 37 });
		expect(answer).toContain("contati 37 pezzi, ne risultavano 40 pezzi, quindi −3 pezzi");
		const moves = s.store.read().moves;
		expect(JSON.stringify(moves.slice(0, 2))).toBe(before);
		expect(moves).toHaveLength(3);
		expect(moves[2]).toMatchObject({ kind: "rettifica", qty: "-3", counted: "37" });
		expect(s.onHand().onHand).toBe(37_000n);
		// The average stays: a rettifica goes at it.
		expect(s.onHand().average).toBe(120_000n);
		// The same count again matches, and is recorded as such.
		expect(await s.run({ op: "count", item: "cartucce xl", quantity: 37 })).toContain("torna con quello che risultava");
	});
});

describe("il magazzino e le fatture emesse", () => {
	async function linked() {
		const s = setup();
		const added = await s.run({ op: "add_item", item: "LS-0001", min: 10 });
		expect(added).toContain("È la voce LS-0001 del listino");
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12 });
		return s;
	}
	const draftOf = async (s: Awaited<ReturnType<typeof linked>>, lines: unknown[]) => {
		const answer = await s.sell({ op: "draft", ...DELTA, lines });
		const id = s.sales.read().invoices.at(-1)?.id as string;
		return { answer, id };
	};

	it("a draft never unloads; the issue unloads once, however many times it runs; a credit note puts back", async () => {
		const s = await linked();
		const { answer, id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 5 }, { item: "Consulenza", quantity: 2 }]);
		expect(answer).not.toMatch(/^Errore/);
		const lines = s.sales.read().invoices.at(-1)?.lines ?? [];
		expect(lines.map((l) => l.item)).toEqual(["LS-0001", "LS-0002"]);
		expect(s.onHand().onHand).toBe(50_000n);
		const call = fresh("issue-1");
		const issued = await s.sell({ op: "issue", draft: id, confirm: true }, call);
		expect(issued).toContain("Ho scaricato dal magazzino un articolo venduto");
		expect(inside(issued)).toContain("Cartucce XL (MG-0001): −5 pezzi");
		expect(s.onHand().onHand).toBe(45_000n);
		// Run again (a replay), and named again: nothing moves twice.
		await s.sell({ op: "issue", draft: id, confirm: true }, call);
		await s.sell({ op: "issue", draft: id, confirm: true });
		expect(s.onHand().onHand).toBe(45_000n);
		expect(s.store.read().moves.filter((m) => m.kind === "scarico")).toHaveLength(1);
		// The average never moves on a sale.
		expect(s.onHand().average).toBe(120_000n);
		const inv = s.sales.read().invoices.find((i) => i.id === id);
		if (inv === undefined || !isIssued(inv)) throw new Error("not issued");
		const credit = await s.sell({ op: "credit_note", invoice: inv.number });
		expect(credit).not.toMatch(/^Errore/);
		expect(s.onHand().onHand).toBe(45_000n);
		const creditId = s.sales.read().invoices.at(-1)?.id as string;
		const back = await s.sell({ op: "issue", draft: creditId, confirm: true });
		expect(back).toContain("Ho rimesso in magazzino");
		expect(s.onHand().onHand).toBe(50_000n);
		await s.sell({ op: "issue", draft: creditId, confirm: true });
		expect(s.onHand().onHand).toBe(50_000n);
	});

	it("a line in another unit is left out and said; a sale past what there is goes in negativo and is said", async () => {
		const s = await linked();
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 2, unit: "scatole" }, { item: "Cartucce XL", quantity: 60 }]);
		const issued = await s.sell({ op: "issue", draft: id, confirm: true });
		expect(issued).toContain("Una riga non l'ho scaricata dal magazzino");
		expect(issued).toContain("l'unità della riga non è quella dell'articolo");
		expect(issued).toContain("in negativo in magazzino");
		expect(s.onHand().onHand).toBe(-10_000n);
		expect(s.onHand().negative).toBe(true);
	});

	it("a credit note never puts back more than its invoice took out", async () => {
		const s = await linked();
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 4 }]);
		await s.sell({ op: "issue", draft: id, confirm: true });
		const inv = s.sales.read().invoices.find((i) => i.id === id);
		if (inv === undefined || !isIssued(inv)) throw new Error("not issued");
		// 9 at a lower price: within what was invoiced in money, past it in pieces.
		expect(await s.sell({ op: "credit_note", invoice: inv.number, lines: [{ description: "Cartucce XL", quantity: 9, price: 5, vat: 22, item: "LS-0001" }] })).not.toMatch(/^Errore/);
		const creditId = s.sales.read().invoices.at(-1)?.id as string;
		expect(await s.sell({ op: "issue", draft: creditId, confirm: true })).toContain("Cartucce XL (MG-0001): +4 pezzi");
		expect(s.onHand().onHand).toBe(50_000n);
	});
});

describe("il magazzino: sottoscorta, elenco, togliere, file", () => {
	it("says a sottoscorta in the brief once per crossing, and again only after it went back above", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL", min: 10 });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 12, cost: 12 });
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		await s.run({ op: "unload", item: "cartucce xl", quantity: 4, reason: "vendita" });
		const first = await s.run({ op: "low", compact: true });
		expect(first).toContain("Magazzino: un articolo è sceso sotto il minimo.");
		expect(inside(first)).toContain("Cartucce XL: 8 pezzi, minimo 10 pezzi");
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		// Lower still: the same crossing, not said again.
		await s.run({ op: "unload", item: "cartucce xl", quantity: 1, reason: "vendita" });
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		// Back above, then under again: a new crossing, said once.
		await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 12 });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 10, reason: "vendita" });
		expect(await s.run({ op: "low", compact: true })).toContain("un articolo è sceso");
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		// «avvisami sotto le 10» said again with another level: said once with it.
		await s.run({ op: "add_item", item: "cartucce xl", min: 20 });
		expect(await s.run({ op: "low", compact: true })).toContain("un articolo è sceso");
		// The brief's call is a read: it runs in a brief's thread.
		expect(stockCallReads({ op: "low", compact: true })).toBe(true);
		expect(stockCallReads({ op: "receive" })).toBe(false);
		expect(BRIEF_INSTRUCTION).toContain("stock (low)");
		expect(BRIEF_INSTRUCTION.length).toBeLessThanOrEqual(SCHEDULE_LIMITS.maxInstructionChars);
	});

	it("lists what is running low first", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Viti", min: 100 });
		await s.run({ op: "add_item", item: "Bulloni", min: 5 });
		await s.run({ op: "receive", item: "viti", quantity: 500, cost: "0,02" });
		await s.run({ op: "receive", item: "bulloni", quantity: 2, cost: "0,1" });
		const list = await s.run({ op: "list" });
		expect(list).toContain("2 articoli in magazzino, uno sottoscorta o in negativo (in cima)");
		expect(inside(list).indexOf("Bulloni")).toBeLessThan(inside(list).indexOf("Viti"));
		const low = await s.run({ op: "low" });
		expect(inside(low)).toContain("Bulloni");
		expect(inside(low)).not.toContain("Viti");
	});

	it("removes an article only with nothing on hand, and only for the person; its movements stay", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 3, cost: 12 });
		expect(await s.run({ op: "remove_item", item: "cartucce xl" })).toContain("Non lo tolgo: di MG-0001 risultano ancora 3 pezzi");
		await s.run({ op: "count", item: "cartucce xl", quantity: 0 });
		expect(await s.run({ op: "remove_item", item: "cartucce xl" }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		const removed = await s.run({ op: "remove_item", item: "cartucce xl" });
		expect(removed).toContain("Fatto, ho tolto MG-0001");
		expect(s.store.read().moves).toHaveLength(2);
		expect(await s.run({ op: "list" })).toContain("Il magazzino è vuoto");
		// The name is free again, with a new number.
		expect(await s.run({ op: "add_item", item: "Cartucce XL" })).toContain("MG-0002");
		expect(s.events.map((e) => e.op)).toEqual(["add_item", "receive", "count", "remove_item", "add_item"]);
	});

	it("exports a CSV with hostile cells made inert, never over another file", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "=HYPERLINK(\"http://x.example\")", code: "+SKU1", place: "@scaffale", category: "-cat" });
		await s.run({ op: "receive", item: "MG-0001", quantity: 4, cost: "2,5" });
		const first = await s.run({ op: "export" });
		expect(first).toContain("Salvato magazzino/magazzino-al-2026-10-19.csv");
		const second = await s.run({ op: "export" });
		expect(second).toContain("magazzino/magazzino-al-2026-10-19-2.csv");
		const csv = readFileSync(join(s.root, "magazzino/magazzino-al-2026-10-19.csv"), "utf8");
		expect(csv).toContain(`"'=HYPERLINK(""http://x.example"")"`);
		expect(csv).toContain("'+SKU1");
		expect(csv).toContain("'@scaffale");
		expect(csv).toContain("'-cat");
		expect(csv).toContain(";4;;2,5;10,00;");
		expect(csv).not.toMatch(/;[=+@-][^0-9]/);
	});

	it("never writes over a file that does not read", async () => {
		const s = setup();
		writeFileSync(join(s.dir, "stock.json"), "{ non è json");
		expect(s.store.read().broken).toBe(true);
		expect(await s.run({ op: "add_item", item: "Viti" })).toBe(`Errore: ${STOCK_BROKEN}.`);
		expect(await s.run({ op: "list" })).toBe(`Errore: ${STOCK_BROKEN}.`);
		expect(readFileSync(join(s.dir, "stock.json"), "utf8")).toBe("{ non è json");
		// A movement edited by hand into a shape it cannot have: unreadable too.
		const t = setup();
		await t.run({ op: "add_item", item: "Viti" });
		await t.run({ op: "receive", item: "viti", quantity: 10, cost: 1 });
		const raw = JSON.parse(readFileSync(join(t.dir, "stock.json"), "utf8"));
		raw.moves[0].qty = "-10";
		writeFileSync(join(t.dir, "stock.json"), JSON.stringify(raw));
		expect(t.store.read().broken).toBe(true);
		expect(existsSync(join(t.dir, "stock.json.bak"))).toBe(true);
	});

	it("gives another agente names and quantities only: no cost, value, supplier, movement or change", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL", min: 10 });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 5, cost: 12, supplier: "Beta Forniture Srl" });
		const list = await s.run({ op: "list" }, agent());
		expect(inside(list)).toContain("Cartucce XL (MG-0001): 5 pezzi, minimo 10 pezzi (sottoscorta)");
		expect(list).not.toContain("€");
		expect(list).not.toContain("Beta");
		const low = await s.run({ op: "low" }, agent());
		expect(inside(low)).toContain("Cartucce XL");
		expect(low).not.toContain("€");
		for (const op of ["status", "value", "movements", "export", "receive", "unload", "add_item", "count", "remove_item"]) expect(await s.run({ op, item: "cartucce xl" }, agent())).toMatch(/^Errore: a un altro agente/);
		expect(await s.run({ op: "low", compact: true }, agent())).toMatch(/^Errore: a un altro agente/);
		expect(stockAgentReads({ op: "list" })).toBe(true);
		expect(stockAgentReads({ op: "status" })).toBe(false);
	});

	it("audits the op and the count only, never names, quantities, costs or suppliers", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12, supplier: "Beta Forniture Srl", doc: "DDT 7" });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 2, reason: "scarto", note: "rotte" });
		await s.run({ op: "export" });
		expect(s.events).toEqual([
			{ type: "stock.changed", op: "add_item", count: 1 },
			{ type: "stock.changed", op: "receive", count: 1 },
			{ type: "stock.changed", op: "unload", count: 1 },
			{ type: "stock.changed", op: "export", count: 1 },
		]);
		const all = JSON.stringify(s.events);
		for (const word of ["Cartucce", "Beta", "50", "12", "DDT", "rotte"]) expect(all).not.toContain(word);
	});

	it("runs only its reads in a brief's thread; the instructions route prices to the listino and quantities here", async () => {
		const s = setup();
		const store = new StockStore(s.dir);
		const [tool] = createStockTools({ workspace: new Workspace(s.root), store, timeZone: "Europe/Rome", whoIs: () => "test:u", now: () => NOW });
		if (tool === undefined) throw new Error("no tool");
		const [guarded] = readOnlyInBriefs([tool], async () => true);
		expect(await guarded?.execute({ op: "add_item", item: "Viti" }, fresh())).toContain("nella chat del brief del mattino Annie legge soltanto");
		expect(await guarded?.execute({ op: "list" }, fresh())).toContain("Il magazzino è vuoto");
		expect(DEFAULT_INSTRUCTIONS).toContain("il listino sono i prezzi, il magazzino le quantità");
		expect(DEFAULT_INSTRUCTIONS).toContain("tenere il magazzino (stock:");
		expect(DEFAULT_INSTRUCTIONS).not.toMatch(NO_EM_DASH);
	});
});
