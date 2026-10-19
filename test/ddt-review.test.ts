import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import type { Ddt } from "../src/core/ddt.ts";
import { dayOfIn } from "../src/core/italian-calendar.ts";
import { marginLines } from "../src/core/margins.ts";
import { paceOf } from "../src/core/order-suggest.ts";
import { isIssued, type SalesInvoice, validInvoice } from "../src/core/sales-invoices.ts";
import type { Movement, StockItem } from "../src/core/stock.ts";
import { unstock } from "../src/core/tools/ddt-stock.ts";
import { vatDocs } from "../src/core/vat-docs.ts";
import { figuresOf } from "../src/core/vat-sums.ts";
import { checkIn, cleanup, EMDASH, fresh, inside, LISTINO, MARK, onHand, outside, PAPER_AND_TONER, type S, setup, shipped } from "./ddt-fixtures.ts";

afterEach(cleanup);

const lastDraft = (s: S) => s.store.read().ddts.filter((d) => d.status === "draft").at(-1) as Ddt;
const invoice = (s: S, id: string) => s.sales.read().invoices.find((i) => i.id === id) as SalesInvoice;
const NOV = new Date("2026-11-03T08:00:00Z");

describe("the fattura differita is TD24 (M2)", () => {
	it("TipoDocumento TD24 in the XML, one DDT for every line with no RiferimentoNumeroLinea, the draft says the DDTs", async () => {
		const s = setup();
		await shipped(s, "Verdi Prova Spa", [{ item: "Toner XL", quantity: 1 }]);
		s.clock.now = NOV;
		const text = await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		expect(text).toContain("Fattura differita (TD24) del DDT n. 1/2026 del 5 ottobre");
		const draft = invoice(s, "BZ-0001");
		expect(draft.type).toBe("TD24");
		expect(validInvoice(draft)).toBe(true);
		// TD24 goes with its DDTs, TD01 without.
		expect(validInvoice({ ...draft, type: "TD01" })).toBe(false);
		const { ddt: _, ...plain } = draft;
		expect(validInvoice({ ...plain, lines: plain.lines.map(({ ddt: _d, ...l }) => l) })).toBe(false);
		await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		const xml = readFileSync(join(s.root, invoice(s, "BZ-0001").file as string), "utf8");
		expect(xml).toContain("<TipoDocumento>TD24</TipoDocumento>");
		expect(xml).toContain("<DatiDDT>\n\t\t\t\t<NumeroDDT>1/2026</NumeroDDT>\n\t\t\t\t<DataDDT>2026-10-05</DataDDT>\n\t\t\t</DatiDDT>");
		expect(xml).not.toContain("RiferimentoNumeroLinea");
	});
});

describe("the VAT of a differita goes to its DDTs' month (M3)", () => {
	it("a September DDT invoiced on 10 October counts in September and in Q3; the invoice keeps its date", async () => {
		const s = setup();
		s.clock.now = new Date("2026-09-28T08:00:00Z");
		await shipped(s, "Verdi Prova Spa", [{ item: "Toner XL", quantity: 1 }]);
		s.clock.now = new Date("2026-10-10T08:00:00Z");
		await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, period: "settembre", recipient_code: "ZZZ0001" });
		await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		const inv = invoice(s, "BZ-0001");
		expect(inv.date).toBe("2026-10-10");
		const { docs } = vatDocs(s.sales.read().invoices, [], [], dayOfIn("Europe/Rome"));
		expect(docs[0]).toMatchObject({ date: "2026-10-10", taxDay: "2026-09-28" });
		const sept = figuresOf(docs, "2026-09-01", "2026-09-30");
		expect(sept).toMatchObject({ sales: 1, debito: 660n, deferredInvoices: 1 });
		expect(figuresOf(docs, "2026-07-01", "2026-09-30")).toMatchObject({ sales: 1, deferredInvoices: 1 });
		expect(figuresOf(docs, "2026-10-01", "2026-10-31")).toMatchObject({ sales: 0, debito: 0n });
	});
});

describe("goods a DDT took out, never unloaded twice (M1)", () => {
	it("dictated lines a DDT shipped: asked before the yes; bound to the DDT they move nothing and bill it; apart they are other goods", async () => {
		const s = setup();
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 10 }]);
		const asked = await s.sell({ op: "draft", customer: "Rossi Prova Srl", lines: [{ item: "Carta A4", quantity: 10 }], recipient_code: "ZZZ0001" });
		expect(outside(asked)).toContain("Una voce è già partita con un DDT, come nel riquadro: le fatturo come fattura differita di quel DDT, così non le scarico due volte dal magazzino?");
		expect(inside(asked)).toContain("• 10 risme di Carta A4: già partiti con il DDT n. 1/2026 del 5 ottobre");
		expect(s.sales.read().invoices).toEqual([]);
		const bound = await s.sell({ op: "draft", customer: "Rossi Prova Srl", lines: [{ item: "Carta A4", quantity: 10 }], recipient_code: "ZZZ0001", shipped: "ddt" });
		expect(bound).toContain("È la fattura differita (TD24) di un DDT");
		const d = invoice(s, "BZ-0001");
		expect(d).toMatchObject({ type: "TD24", ddt: [{ id: "DT-0001", number: "1/2026", date: "2026-10-05" }] });
		expect(d.lines[0]?.ddt).toEqual({ id: "DT-0001", line: 1 });
		await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		expect(onHand(s, "MG-0001")).toBe(40);
		expect(s.store.read().ddts[0]?.billed?.number).toBe("1");
		// Other goods: a TD01 that unloads them.
		await shipped(s, "Rossi Prova Srl", [{ item: "Toner XL", quantity: 2 }]);
		const apart = await s.sell({ op: "draft", customer: "Rossi Prova Srl", lines: [{ item: "Toner XL", quantity: 2 }], recipient_code: "ZZZ0001", shipped: "apart" });
		expect(apart).toContain("Fatturo le voci come merce a parte");
		expect(invoice(s, "BZ-0002")).toMatchObject({ type: "TD01" });
		expect(invoice(s, "BZ-0002").ddt).toBeUndefined();
	});

	it("probe A: a differita to the wrong customer, its credit note and the redo: the DDT is billed again, Carta ends at 40, not 30", async () => {
		const s = setup();
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 10 }]);
		s.clock.now = NOV;
		await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		expect(onHand(s, "MG-0001")).toBe(40);
		// Before the credit note: the redo is refused.
		expect(await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, redo: "1", recipient_code: "ZZZ0001" })).toContain("non ha una nota di credito per il cliente sbagliato");
		const credit = await s.sell({ op: "credit_note", invoice: "1", wrong_customer: true });
		expect(credit).not.toContain("Errore");
		const note = s.sales.read().invoices.find((i) => i.type === "TD04") as SalesInvoice;
		expect(note).toMatchObject({ release: true });
		expect(note.lines[0]?.ddt).toEqual({ id: "DT-0001", line: 1 });
		const issued = await s.sell({ op: "issue", draft: note.id, confirm: true });
		expect(issued).toContain("tornano da fatturare");
		expect(s.store.read().ddts[0]?.billed).toBeUndefined();
		expect(onHand(s, "MG-0001")).toBe(40);
		// Dictated to the right customer, the same goods are found on the DDT given back.
		const dictated = await s.sell({ op: "draft", customer: "Verdi Prova Spa", lines: [{ item: "Carta A4", quantity: 10 }], recipient_code: "ZZZ0001" });
		expect(dictated).toContain("già partita con un DDT");
		const redo = await s.sell({ op: "draft", customer: "Verdi Prova Spa", ddt: true, redo: "1", recipient_code: "ZZZ0001" });
		expect(redo).toContain("Rifaccio la fattura n. 1 al cliente giusto, come fattura differita (TD24) degli stessi DDT");
		const again = s.sales.read().invoices.find((i) => !isIssued(i)) as SalesInvoice;
		expect(again).toMatchObject({ type: "TD24", buyer: { name: "Verdi Prova Spa" } });
		await s.sell({ op: "issue", draft: again.id, confirm: true });
		expect(onHand(s, "MG-0001")).toBe(40);
		expect(s.store.read().ddts[0]?.billed?.invoice).toBe(again.id);
	});

	it("a conto visione DDT: flagged in the list and asked in the differita; kept, it is billed; returned, it is left out", async () => {
		const s = setup();
		await shipped(s, "Rossi Prova Srl", [{ item: "Toner XL", quantity: 1 }], { causale: "conto visione" });
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 2 }]);
		s.clock.now = new Date("2026-10-25T08:00:00Z");
		const list = await s.run({ op: "list", unbilled: true });
		expect(inside(list)).toContain("conto visione da 20 giorni");
		const asked = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		expect(outside(asked)).toContain("uno è in conto visione (nel riquadro): il cliente tiene la merce (la fatturo) o la rende (si fa un DDT di reso)?");
		expect(inside(asked)).toContain("conto visione da 20 giorni");
		expect(s.sales.read().invoices).toEqual([]);
		const out = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001", kept: false });
		expect(out).toContain("È la fattura differita (TD24) di un DDT");
		await s.sell({ op: "remove", draft: "BZ-0001" });
		const kept = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001", kept: true });
		expect(kept).toContain("Fatturo anche il DDT in conto visione: chi ti scrive ha detto che il cliente tiene la merce.");
		expect(invoice(s, "BZ-0002").ddt?.map((d) => d.id)).toEqual(["DT-0001", "DT-0002"]);
	});
});

describe("resi netted, or a credit note (UX 3)", () => {
	it("a reso finds its DDT, is netted from the differita; a reso of a billed DDT offers the credit note, at the invoice's prices, with the reso's cost in the margins", async () => {
		const s = setup();
		await shipped(s);
		// «Rossi mi ha reso 1 toner»: the source proposed, the yes with the check.
		const proposed = await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Toner XL", quantity: 1 }], causale: "reso", transport: "destinatario" });
		expect(outside(proposed)).toContain("il reso l'ho legato all'ultimo DDT di questo cliente con questa merce, il DDT n. 1/2026 del 5 ottobre");
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Toner XL", quantity: 1 }], causale: "reso", transport: "destinatario", confirm: true, check: checkIn(proposed) });
		expect(lastDraft(s)).toMatchObject({ causale: "reso", of: "DT-0001" });
		const issued = await s.run({ op: "issue", ddt: lastDraft(s).id, confirm: true });
		expect(issued).toContain("Il reso lo tolgo dalla fattura differita del DDT n. 1/2026");
		expect(onHand(s, "MG-0002")).toBe(9);
		s.clock.now = NOV;
		const text = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001" });
		expect(inside(text)).toContain("Rossi Prova Srl ti ha reso 1 pezzo di Toner XL del DDT n. 1/2026 (reso n. 2/2026): li tolgo dalla fattura, così fatturo 1 pezzo.");
		const draft = invoice(s, "BZ-0001");
		expect(draft.lines.map((l) => [l.description, l.quantity])).toEqual([
			["Carta A4", "10"],
			["Toner XL", "1"],
		]);
		await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		// Another toner back, now that the DDT is billed: the credit note offered.
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Toner XL", quantity: 1 }], causale: "reso", of: "1/2026", transport: "destinatario" });
		const back = await s.run({ op: "issue", ddt: lastDraft(s).id, confirm: true });
		expect(inside(back)).toContain("Il DDT n. 1/2026 è già fatturato (fattura n. 1): per 1 pezzo di Toner XL resi serve una nota di credito.");
		expect(outside(back)).toContain("Vuoi che la prepari?");
		expect(onHand(s, "MG-0002")).toBe(10);
		const credit = await s.sell({ op: "credit_note", invoice: "1", reso: "3/2026" });
		expect(credit).toContain("È la nota di credito della merce tornata con il reso n. 3/2026, ai prezzi della fattura n. 1");
		const note = s.sales.read().invoices.find((i) => i.type === "TD04") as SalesInvoice;
		expect(note.lines.map((l) => [l.description, l.quantity, l.price, l.ddt?.id])).toEqual([["Toner XL", "1", "30", "DT-0003"]]);
		await s.sell({ op: "issue", draft: note.id, confirm: true });
		expect(onHand(s, "MG-0002")).toBe(10);
		const stock = s.stock.read();
		const lines = marginLines({ invoices: s.sales.read().invoices, items: stock.items, moves: stock.moves, archived: stock.archived, codes: stock.codes, units: stock.units, listino: LISTINO, purchases: [] }, "2026-11-01", "2026-11-30");
		const back_ = lines.find((l) => l.credit);
		expect(back_).toMatchObject({ revenue: -3000n, cost: -1800n });
		// The reso the differita netted already needs no credit note.
		expect(await s.sell({ op: "credit_note", invoice: "1", reso: "2/2026" })).toContain("Questo reso l'ho già tolto dalla fattura n. 1");
	});
});

describe("drafts by name, cancel with a check (UX 4)", () => {
	it("an issued DDT annulled after the yes, the goods that never left put back once", async () => {
		const s = setup();
		await shipped(s);
		expect(onHand(s, "MG-0001")).toBe(40);
		const asked = await s.run({ op: "cancel", ddt: "1/2026" });
		expect(outside(asked)).toContain("Annullo il DDT n. 1/2026 del 5 ottobre (cliente e merce nel riquadro)? Il numero 1 non si potrà più usare. La merce è partita lo stesso?");
		expect(inside(asked)).toContain("Rossi Prova Srl: 10 risme di Carta A4, 2 pezzi di Toner XL");
		expect(await s.run({ op: "cancel", ddt: "1/2026", confirm: true, check: "0123456789abcdef", left: false })).toContain("serve il controllo");
		expect(await s.run({ op: "cancel", ddt: "1/2026", confirm: true, check: checkIn(asked) })).toContain("se la merce è partita lo stesso");
		expect(await s.run({ op: "cancel", ddt: "1/2026", confirm: true, check: checkIn(asked), left: false }, fresh(undefined, "notice"))).toContain("Non annullo il DDT n. 1/2026");
		const done = await s.run({ op: "cancel", ddt: "1/2026", confirm: true, check: checkIn(asked), left: false });
		expect(done).toContain("Ho rimesso in magazzino 2 righe del DDT annullato, perché la merce non è partita");
		expect(onHand(s, "MG-0001")).toBe(50);
		expect(onHand(s, "MG-0002")).toBe(10);
		// Again: nothing moves twice.
		const d = s.store.read().ddts[0] as Ddt;
		await unstock(s.stock, d, "2026-10-05", fresh(), MARK);
		expect(s.stock.read().moves.filter((m) => m.kind === "storno")).toHaveLength(2);
		expect(onHand(s, "MG-0001")).toBe(50);
		expect(s.stock.read().moves.find((m) => m.kind === "storno")).toMatchObject({ sale: { invoice: "DT-0001", of: "DT-0001" } });
		const movements = await (async () => {
			const { createStockTools } = await import("../src/core/tools/stock-tools.ts");
			const { Workspace } = await import("../src/core/workspace.ts");
			const [st] = createStockTools({ workspace: new Workspace(s.root), store: s.stock, timeZone: "Europe/Rome", whoIs: () => "test:u", now: () => s.clock.now });
			return String(await st?.execute({ op: "movements", item: "MG-0001" }, fresh()));
		})();
		expect(movements).toContain("DDT n. 1/2026 annullato (la merce non era partita)");
	});

	it("a draft is named by its day, the reference only in the fence; a draft annulled at once", async () => {
		const s = setup();
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER, transport: "mittente" });
		const st = await s.run({ op: "status", client: "Rossi Prova Srl" });
		expect(outside(st)).toContain("Ecco la bozza del DDT del 5 ottobre 2026:");
		expect(outside(st)).not.toContain("DT-");
		const gone = await s.run({ op: "cancel", client: "Rossi Prova Srl" });
		expect(gone).toBe("Annullata la bozza del DDT del 5 ottobre 2026: nessun numero è stato usato.");
	});
});

describe("omaggio and conto visione (UX 5)", () => {
	it("each unloads on its own reason; omaggio is never a sale for the pace, conto visione only once billed; the omaggio note", async () => {
		const s = setup();
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Carta A4", quantity: 3 }], causale: "omaggio", transport: "mittente" });
		const gift = await s.run({ op: "issue", ddt: lastDraft(s).id, confirm: true });
		expect(gift).toContain("È un omaggio: niente fattura al cliente, ma per l'IVA di solito serve un'autofattura. Chiedi al commercialista come la vuole.");
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 4 }], { causale: "conto visione" });
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 5 }]);
		const moves = s.stock.read().moves.filter((m) => m.kind === "scarico");
		expect(moves.map((m) => [m.qty, m.reason])).toEqual([
			["3", "omaggio"],
			["4", "conto_visione"],
			["5", "vendita"],
		]);
		const item = s.stock.read().items[0] as StockItem;
		const all = s.stock.read().moves as Movement[];
		expect(paceOf(item, all, "2026-10-01", "2026-10-31")).toEqual({ sold: 5000n, sales: 1 });
		expect(paceOf(item, all, "2026-10-01", "2026-10-31", new Set(["DT-0002"]))).toEqual({ sold: 9000n, sales: 2 });
		expect(onHand(s, "MG-0001")).toBe(38);
	});
});

describe("the brief, the prices, the reso's own DDT, the date (UX 6-12)", () => {
	it("every month before this one, oldest first, late said; on the 15th «oggi», never «mancano 0 giorni»", async () => {
		const s = setup();
		s.clock.now = new Date("2026-09-10T08:00:00Z");
		await shipped(s);
		s.clock.now = new Date("2026-10-05T08:00:00Z");
		await shipped(s, "Verdi Prova Spa");
		s.clock.now = new Date("2026-11-15T08:00:00Z");
		const text = await s.run({ op: "list", compact: true });
		expect(outside(text)).toContain("DDT ancora da fatturare: 1 di settembre (in ritardo: andava fatturato entro il 15 ottobre) e 1 di ottobre (entro il 15 novembre).");
		expect(outside(text)).toContain("Attenzione: la fattura differita di ottobre va emessa oggi, 15 novembre. Chiedimi «fai la fattura differita di ottobre».");
		expect(text).not.toContain("mancano 0");
		const list = await s.run({ op: "list", unbilled: true });
		expect(list).toContain("Sono in ritardo quelli di settembre");
		expect(await s.run({ op: "list", unbilled: true, client: "Rossi Prova Srl", month: "2026-10" })).toContain("Non hai DDT di vendita da fatturare per questo cliente.");
	});

	it("prices asked goods by goods, grouped, then the listino offered", async () => {
		const s = setup();
		await shipped(s, "Rossi Prova Srl", [{ description: "Risme A4 riciclate", quantity: 10, unit: "risme" }]);
		await shipped(s, "Rossi Prova Srl", [{ description: "Risme A4 riciclate", quantity: 20, unit: "risme" }, { description: "Toner HP 305A", quantity: 2, unit: "pz" }]);
		s.clock.now = NOV;
		const asked = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001", vat: 22 });
		expect(outside(asked)).toContain("Mi mancano 2 prezzi (per unità, senza IVA)");
		expect(inside(asked)).toContain("• Risme A4 riciclate: in 2 DDT, 30 risme in tutto");
		expect(inside(asked)).toContain("• Toner HP 305A: 2 pezzi");
		expect(asked).not.toMatch(/riga \d|row/);
		const text = await s.sell({ op: "draft", customer: "Rossi Prova Srl", ddt: true, period: "ottobre", recipient_code: "ZZZ0001", vat: 22, prices: [{ description: "risme a4 riciclate", price: "4" }, { description: "Toner HP 305A", price: "25,5" }] });
		expect(text).toContain("Li metto nel listino");
		expect(invoice(s, "BZ-0001").lines.map((l) => l.price)).toEqual(["4", "4", "25.5"]);
	});

	it("a reso with the client's own DDT: recorded with their number, the goods back; its source checked again at the issue", async () => {
		const s = setup();
		await shipped(s);
		s.clock.now = new Date("2026-10-19T08:00:00Z");
		const proposed = await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Toner XL", quantity: 2 }], causale: "reso", their_number: "R-7", their_date: "18/10/2026" });
		const made = await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Toner XL", quantity: 2 }], causale: "reso", their_number: "R-7", their_date: "18/10/2026", confirm: true, check: checkIn(proposed) });
		expect(made).toContain("Fatto: ho preparato il reso con il DDT del cliente");
		const preview = await s.run({ op: "issue", ddt: lastDraft(s).id });
		expect(outside(preview)).toContain("Registro questo reso con il DDT del cliente n. R-7 del 18 ottobre 2026");
		const done = await s.run({ op: "issue", ddt: lastDraft(s).id, confirm: true });
		expect(done).toContain("Fatto: ho registrato il reso con il DDT del cliente n. R-7");
		expect(done).not.toContain("PDF da stampare");
		const r = s.store.read().ddts[1] as Ddt;
		expect(r).toMatchObject({ status: "issued", day: "2026-10-18", theirs: { number: "R-7", date: "2026-10-18" } });
		expect(r.number).toBeUndefined();
		expect(onHand(s, "MG-0002")).toBe(10);
		// A reso whose source was annulled meanwhile is not issued.
		await shipped(s, "Rossi Prova Srl", [{ item: "Carta A4", quantity: 1 }]);
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Carta A4", quantity: 1 }], causale: "reso", of: "2/2026", transport: "destinatario" });
		const reso = lastDraft(s);
		const c = await s.run({ op: "cancel", ddt: "2/2026" });
		await s.run({ op: "cancel", ddt: "2/2026", confirm: true, check: checkIn(c), left: true });
		expect(await s.run({ op: "issue", ddt: reso.id, confirm: true })).toContain("Cambia la bozza del reso prima di emetterlo.");
		expect(s.store.read().ddts.find((d) => d.id === reso.id)?.status).toBe("draft");
	});

	it("issued tomorrow, never before the last DDT; the last carrier proposed; a free line said; the print note and the document's lines", async () => {
		const s = setup();
		await s.run({ op: "create", client: "Rossi Prova Srl", lines: PAPER_AND_TONER, transport: "vettore", carrier: "Corriere Prova" });
		const preview = await s.run({ op: "issue", ddt: lastDraft(s).id, date: "domani" });
		expect(outside(preview)).toContain("Lo emetto con la data di domani, 6 ottobre: prende il numero 1/2026.");
		const done = await s.run({ op: "issue", ddt: lastDraft(s).id, date: "domani", confirm: true });
		expect(done).toContain("Il DDT deve viaggiare con la merce: vuoi il PDF da stampare (due copie, una resta a te firmata)?");
		expect(s.store.read().ddts[0]).toMatchObject({ day: "2026-10-06", number: "1/2026" });
		const free = await s.run({ op: "create", client: "Rossi Prova Srl", lines: [{ item: "Cavo HDMI", quantity: 1 }] });
		expect(outside(free)).toContain("Una voce non è nel listino: l'ho scritta come descrizione libera");
		expect(outside(free)).toContain("Come l'ultima volta, a cura del vettore (nel riquadro)?");
		expect(inside(free)).toContain("Corriere Prova");
		await s.run({ op: "change", ddt: lastDraft(s).id, transport: "mittente" });
		expect(await s.run({ op: "issue", ddt: lastDraft(s).id, confirm: true })).toContain("non può avere una data prima di quella");
		expect(s.store.read().ddts[1]?.status).toBe("draft");
		await s.run({ op: "document", ddt: "1/2026" });
		expect(s.made[0]?.text).toContain("**Inizio trasporto:** 06/10/2026 ore ______");
	});

	it("the routing names the reso, the credit note and the carrier; no em dash", async () => {
		const s = setup();
		expect(DEFAULT_INSTRUCTIONS).toContain("«Rossi mi ha reso 2 toner»");
		expect(DEFAULT_INSTRUCTIONS).toContain("«lo porta il corriere BRT»");
		expect(s.tool.description).toContain("«lo porta il corriere BRT» → change with transport vettore and carrier");
		expect(s.tool.description).toContain("Never say a draft's reference (DT-…) to the person");
		expect(s.tool.description).not.toMatch(EMDASH);
	});
});
