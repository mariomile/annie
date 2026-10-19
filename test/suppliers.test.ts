import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import type { BankMatch, BankMovement } from "../src/core/bank.ts";
import { BRIEF_INSTRUCTION } from "../src/core/brief.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import type { Expense } from "../src/core/expenses.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { register } from "../src/core/invoices.ts";
import type { Renewal } from "../src/core/renewals.ts";
import { SUPPLIERS_BROKEN, SupplierStore } from "../src/core/supplier-store.ts";
import { supplierAgentReads, supplierCallReads } from "../src/core/suppliers.ts";
import { createSupplierTools, type SupplierEvent } from "../src/core/tools/supplier-tools.ts";
import { Workspace } from "../src/core/workspace.ts";
import { BETA, fattura, type Party } from "./solleciti-fixtures.ts";

const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday 18 October 2026, in Rome
const NO_EM_DASH = /\u2014/;
/** No op or parameter name in what the person reads. */
const NO_OPS = /\b(?:summary|note_add|note_remove|contact_set|merge|export|compact|confirm|remove_contact)\b/;

/** Synthetic ids only: partite IVA with a good check digit, IBAN with a good mod-97. */
const UNO: Party = { name: "Fornitore Uno S.r.l.", vat: "00000010017" };
const ROSSI: Party = { name: "Rossi Srl", vat: "00000020016" };
const ARUBA: Party = { name: "Aruba S.p.A.", vat: "00000030015" };
const ROSSI_SPA: Party = { name: "Rossi SpA", vat: "00000040014" };
const IBAN_A = "IT51X0000000000000000000001";
const IBAN_B = "IT24X0000000000000000000002";
const IBAN_C = "IT94X0000000000000000000003";
const IBAN_D = "IT67X0000000000000000000004";

const rec = (from: Party, number: string, date: string, total: string, due: string, iban?: string) => fattura(from, BETA, { number, date, total, rate: [{ amount: total, due, ...(iban === undefined ? {} : { iban }) }] });
/** Fornitore Uno: paid 5 days late in April, on time in July, the October one open with another IBAN. */
const U1 = rec(UNO, "U-1", "2026-03-01", "1220.00", "2026-03-31", IBAN_A);
const U2 = rec(UNO, "U-2", "2026-06-01", "610.00", "2026-07-01", IBAN_A);
const U3 = rec(UNO, "U-3", "2026-10-01", "400.00", "2026-10-22", IBAN_B);
/** Rossi Srl: one overdue since 31 August, one paid 19 days late (due Sunday 31 May, payable Monday 1 June). */
const R1 = rec(ROSSI, "R-1", "2026-08-01", "244.00", "2026-08-31");
const R2 = rec(ROSSI, "R-2", "2026-05-01", "122.00", "2026-05-31");
const RS1 = rec(ROSSI_SPA, "RS-1", "2026-04-01", "61.00", "2026-04-30");
/** Aruba's invoice, paid, and recorded as an expense too (same partita IVA and number): counted once. */
const A1 = rec(ARUBA, "A-1", "2026-02-10", "122.00", "2026-02-10");
const FILES: Record<string, string> = { "f/u1.xml": U1, "f/u2.xml": U2, "f/u3.xml": U3, "f/r1.xml": R1, "f/r2.xml": R2, "f/rs1.xml": RS1, "f/a1.xml": A1 };
const PAID: Record<string, string> = { "U-1": "2026-04-05T10:00:00.000Z", "U-2": "2026-07-01T10:00:00.000Z", "R-2": "2026-06-20T10:00:00.000Z", "RS-1": "2026-04-30T10:00:00.000Z", "A-1": "2026-02-10T10:00:00.000Z" };

const expense = (id: string, date: string, amount: string, o: Partial<Expense> = {}): Expense => ({ id, date, amount, category: "software e abbonamenti", by: "test:u", at: NOW.toISOString(), ...o });
const EXPENSES: Expense[] = [
	expense("S-2026-0001", "2026-02-10", "122", { supplier: "Aruba", supplierVat: "00000030015", docType: "fattura", docNumber: "A-1" }),
	expense("S-2026-0002", "2026-09-01", "50", { supplier: "Aruba S.p.A.", supplierVat: "IT00000030015" }),
	expense("S-2026-0003", "2026-07-15", "80", { supplier: "Uno Forniture" }),
	expense("S-2026-0004", "2026-03-03", "15"),
];
const renewal = (id: string, name: string, amount: string, months: number, due: string, o: Partial<Renewal> = {}): Renewal =>
	({ id, name, category: "software e abbonamenti", amount, months, due, day: Number(due.slice(8, 10)), autoRenew: true, status: "active", by: "test:u", at: NOW.toISOString(), ...o }) as Renewal;
const RENEWALS: Renewal[] = [
	renewal("R-0001", "Creative Cloud", "60", 1, "2026-11-01", { provider: "Adobe" }),
	renewal("R-0002", "Adobe Stock", "120", 12, "2027-01-15"),
	renewal("R-0003", "Dominio Aruba", "15", 12, "2027-03-01", { status: "cancelled" }),
];

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let calls = 0;
const fresh = (callId = `c${++calls}`, thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, signal: new AbortController().signal, callId, thread });
/** A context whose steps are kept, as the engine keeps them: a call run again gets them back. */
const kept = new Map<string, unknown>();
const durable = (callId: string): ToolContext => ({
	step: (async (key: string, work: () => Promise<unknown>) => {
		const k = `${callId}:${key}`;
		if (kept.has(k)) return kept.get(k);
		const v = await work();
		kept.set(k, v);
		return v;
	}) as ToolContext["step"],
	progress: () => {},
	signal: new AbortController().signal,
	callId,
	thread: { channel: "test", threadId: "t1" },
});
const agent = () => fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" });

type Setup = { files?: Record<string, string>; paid?: Record<string, string>; expenses?: Expense[]; renewals?: Renewal[]; bank?: { movements: BankMovement[]; matches: BankMatch[] } };

async function setup(o: Setup = {}) {
	const dir = mkdtempSync(join(tmpdir(), "annie-suppliers-"));
	dirs.push(dir);
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	const write = (files: Record<string, string>) => {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), content);
		}
	};
	write(o.files ?? FILES);
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	const company = { vat: "IT00000520031", name: "Beta Ristorazione Srl", by: "test:u", at: NOW.toISOString() };
	invoices.setCompany(company);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const keys = new Map<string, string>();
	for (const i of register((await scanner.scan(new AbortController().signal)).invoices, [], company)) {
		keys.set(i.doc.number ?? "", i.key);
		const at = (o.paid ?? PAID)[i.doc.number ?? ""];
		if (at !== undefined) invoices.mark({ invoice: i.key, count: i.instalments.length, paid: true, by: "test:u", at });
	}
	const store = new SupplierStore(dir);
	const events: SupplierEvent[] = [];
	const clock = { now: NOW };
	const [tool] = createSupplierTools({
		workspace,
		store,
		invoices,
		scanner,
		expenses: { read: () => ({ expenses: o.expenses ?? EXPENSES, broken: false }) },
		renewals: { read: () => ({ renewals: o.renewals ?? RENEWALS, broken: false }) },
		...(o.bank === undefined ? {} : { bank: { read: () => ({ next: { movement: 9, import: 2 }, movements: o.bank?.movements ?? [], imports: [], matches: o.bank?.matches ?? [], calls: [], broken: false }) } }),
		timeZone: "Europe/Rome",
		whoIs: () => "test:u",
		record: async (e) => {
			events.push(e);
		},
		now: () => clock.now,
	});
	if (tool === undefined) throw new Error("no tool");
	const answers: string[] = [];
	return {
		dir,
		root,
		store,
		keys,
		events,
		tool,
		answers,
		write,
		at: (iso: string) => {
			clock.now = new Date(iso);
		},
		run: async (args: Record<string, unknown>, c: ToolContext = fresh()) => {
			const a = String(await tool.execute(args, c));
			answers.push(a);
			return a;
		},
	};
}

const FENCE = /<<<dati dei fornitori ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati dei fornitori \1>>>/g;
const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
const outside = (text: string) => text.replace(FENCE, "");
const untagged = (text: string) => text.replace(/(dati dei fornitori) [0-9a-f]{12}/g, "$1");

/** Every answer the person reads: no em dash, no op or parameter name. */
function clean(answers: readonly string[]) {
	for (const a of answers) {
		expect(a).not.toMatch(NO_EM_DASH);
		expect(outside(a)).not.toMatch(NO_OPS);
	}
}

describe("suppliers: spend, counted once", () => {
	it("counts an expense and the invoice it pays once, and adds the expenses of the supplier", async () => {
		const s = await setup();
		const aruba = await s.run({ op: "summary", supplier: "Aruba", period: "anno" });
		// 122 (the invoice, which the expense with its number stands for) + 50: never 294.
		expect(outside(aruba)).toContain("hai speso con lui 172,00 €, IVA inclusa (2 spese)");
		expect(aruba).not.toContain("294,00");
		expect(inside(aruba)).toContain("Fornitore: Aruba");
		expect(inside(aruba)).toContain("Partita IVA: IT00000030015");
		clean(s.answers);
	});

	it("ranks the main suppliers by what was spent, as numbers, the names in the fence", async () => {
		const s = await setup();
		const top = await s.run({ op: "top", period: "anno" });
		expect(outside(top)).toContain("hai speso 2.265,00 €, IVA inclusa, con 5 fornitori");
		expect(inside(top).split("\n")).toEqual(["1. Fornitore Uno S.r.l.: 1.830,00 € (81%)", "2. Aruba: 172,00 € (8%)", "3. Rossi Srl: 122,00 € (5%)", "4. Uno Forniture: 80,00 € (4%)", "5. Rossi SpA: 61,00 € (3%)"]);
		// The expense without a supplier is said, not guessed.
		expect(outside(top)).toContain("Una spesa senza fornitore non è contata.");
		expect(outside(top)).not.toMatch(/Fornitore Uno|Aruba|Rossi/);
		clean(s.answers);
	});

	it("lists the subscriptions with a supplier, by provider or by the name, a cancelled one left out", async () => {
		const s = await setup();
		const adobe = await s.run({ op: "summary", supplier: "Adobe" });
		expect(outside(adobe)).toContain("Abbonamenti attivi con lui: 2, per 840,00 € all'anno");
		expect(inside(adobe)).toContain("Abbonamento: Creative Cloud, 60,00 € al mese");
		expect(inside(adobe)).toContain("Abbonamento: Adobe Stock, 120,00 € all'anno");
		// A renewal counts through its expense, never on its own.
		expect(outside(adobe)).toContain("non risultano soldi spesi con lui");
		const aruba = await s.run({ op: "summary", supplier: "Aruba" });
		expect(aruba).not.toContain("Dominio Aruba");
		clean(s.answers);
	});
});

describe("suppliers: who is who", () => {
	it("finds a supplier by partita IVA first, its expenses joined by the same number", async () => {
		const s = await setup();
		const byVat = await s.run({ op: "summary", supplier: "P.IVA IT 00000010017" });
		expect(inside(byVat)).toContain("Fornitore: Fornitore Uno S.r.l.");
		const aruba = await s.run({ op: "summary", supplier: "IT00000030015", period: "anno" });
		expect(inside(aruba)).toContain("Fornitore: Aruba");
		expect(outside(aruba)).toContain("172,00 €");
		clean(s.answers);
	});

	it("asks when a name fits two suppliers, and never merges two partite IVA", async () => {
		const s = await setup();
		const asked = await s.run({ op: "summary", supplier: "Rossi" });
		expect(outside(asked)).toContain("Intendi uno di questi?");
		expect(inside(asked)).toContain("• Rossi Srl (partita IVA IT00000020016)");
		expect(inside(asked)).toContain("• Rossi SpA (partita IVA IT00000040014)");
		const refused = await s.run({ op: "merge", supplier: "Rossi Srl", into: "Rossi SpA", confirm: true });
		expect(outside(refused)).toContain("Non li unisco: hanno due partite IVA diverse");
		expect(existsSync(join(s.dir, "suppliers.json"))).toBe(false);
		// A partita IVA dictated that is not the invoices' one is not written silently.
		const other = await s.run({ op: "contact_set", supplier: "Fornitore Uno S.r.l.", vat: "00000050013" });
		expect(outside(other)).toContain("Non la segno");
		expect(s.store.read().cards).toEqual([]);
		clean(s.answers);
	});

	it("merges two spellings after a preview and a yes, once", async () => {
		const s = await setup();
		const preview = await s.run({ op: "merge", supplier: "Uno Forniture", into: "Fornitore Uno S.r.l." });
		expect(outside(preview)).toContain("l'IBAN che mi hai dato per il primo passano al secondo");
		expect(inside(preview)).toContain("Da unire: Uno Forniture (senza scheda; nessuna partita IVA; nessuna fattura, 1 spesa, 80,00 € spesi in tutto)");
		expect(s.store.read().cards).toEqual([]);
		const c = fresh("merge-1");
		const done = await s.run({ op: "merge", supplier: "Uno Forniture", into: "Fornitore Uno S.r.l.", confirm: true }, c);
		expect(outside(done)).toContain("Fatto, ho unito i due fornitori nella scheda FO-0001");
		const [card] = s.store.read().cards;
		expect(card).toMatchObject({ id: "FO-0001", name: "Fornitore Uno S.r.l.", vat: "IT00000010017", aliases: ["Uno Forniture"] });
		expect(card?.iban).toBeUndefined();
		const summary = await s.run({ op: "summary", supplier: "Uno Forniture", period: "anno" });
		expect(outside(summary)).toContain("hai speso con lui 1.910,00 €");
		// Run again: one card, the same number.
		const again = await s.run({ op: "merge", supplier: "Uno Forniture", into: "Fornitore Uno S.r.l.", confirm: true }, c);
		expect(outside(again)).toContain("i due fornitori sono una sola scheda: FO-0001");
		expect(s.store.read().nextCard).toBe(2);
		clean(s.answers);
	});
});

describe("suppliers: IBAN", () => {
	it("flags an IBAN that changed on the latest invoice, the IBAN only in the fence", async () => {
		const s = await setup();
		const uno = await s.run({ op: "summary", supplier: "Fornitore Uno" });
		expect(outside(uno)).toContain("Attenzione: l'IBAN di una fattura da pagare è diverso da quello delle fatture già pagate. Prima di pagare, verificalo con il fornitore per telefono, a un numero che conosci già e non a quello scritto nella fattura o nella mail. Gli IBAN sono nel riquadro.");
		expect(inside(uno)).toContain(`IBAN dell'ultima fattura pagata (U-2): ${IBAN_A}`);
		expect(inside(uno)).toContain(`IBAN da verificare sulla fattura U-3: ${IBAN_B}`);
		// Said as the person asked: no note on the legal form when the card shows the name.
		expect(outside(uno).split("\n")[0]).toBe("Il fornitore è nel riquadro.");
		expect(uno).not.toContain("forma societaria");
		expect(outside(uno)).not.toMatch(/IT\d{2}X/);
		clean(s.answers);
	});

	it("keeps the IBAN the person dictated: a newer invoice never changes it, and the difference is said", async () => {
		const s = await setup();
		const pinned = await s.run({ op: "contact_set", supplier: "Fornitore Uno", iban: "it51 x000 0000 0000 0000 0000 001" });
		expect(outside(pinned)).toContain("L'IBAN che mi hai dato resta questo finché non me lo cambi tu");
		expect(outside(pinned)).toContain("Attenzione: l'IBAN dell'ultima fattura è diverso da quello di prima e da quello che mi hai dato tu. Prima di pagare, verificalo con il fornitore per telefono, a un numero che conosci già. Quello che mi hai dato resta com'è.");
		expect(outside(pinned)).toContain("Ho preso il fornitore che si chiama così con la forma societaria (S.r.l., SpA…), nel riquadro.");
		expect(s.store.read().cards[0]?.iban).toBe(IBAN_A);
		s.write({ "f/u4.xml": rec(UNO, "U-4", "2026-10-10", "100.00", "2026-11-10", IBAN_C) });
		const uno = await s.run({ op: "summary", supplier: "Fornitore Uno" });
		expect(inside(uno)).toContain(`IBAN da verificare sulla fattura U-4: ${IBAN_C}`);
		expect(inside(uno)).toContain(`IBAN che mi hai dato tu: ${IBAN_A}`);
		expect(outside(uno)).toContain("Quello che mi hai dato resta com'è");
		expect(s.store.read().cards[0]?.iban).toBe(IBAN_A);
		// One that fails the check is refused, nothing written.
		const bad = await s.run({ op: "contact_set", supplier: "Fornitore Uno", iban: "IT52X0000000000000000000001" });
		expect(bad).toContain("Errore: l'IBAN non passa il controllo delle cifre");
		expect(s.store.read().cards[0]?.iban).toBe(IBAN_A);
		clean(s.answers);
	});
});

describe("suppliers: IBAN checked against what was paid, not the dates a file writes", () => {
	const base = { "f/u1.xml": U1, "f/u2.xml": U2 };

	it("flags a backdated invoice with a new IBAN, and the brief says it", async () => {
		const s = await setup({ files: { ...base, "f/u0.xml": rec(UNO, "U-0", "2025-01-15", "300.00", "2026-10-23", IBAN_D) } });
		const uno = await s.run({ op: "summary", supplier: "Fornitore Uno S.r.l." });
		expect(outside(uno)).toContain("Attenzione: l'IBAN di una fattura da pagare è diverso da quello delle fatture già pagate.");
		expect(inside(uno)).toContain(`IBAN da verificare sulla fattura U-0: ${IBAN_D}`);
		expect(inside(uno)).toContain(`IBAN dell'ultima fattura pagata (U-2): ${IBAN_A}`);
		expect(outside(await s.run({ op: "summary", compact: true }))).toContain("ha cambiato IBAN sull'ultima fattura");
		clean(s.answers);
	});

	it("flags an invoice without a date", async () => {
		const undated = rec(UNO, "U-6", "2026-10-05", "300.00", "2026-10-24", IBAN_D).replace("<Data>2026-10-05</Data>", "");
		const s = await setup({ files: { ...base, "f/u6.xml": undated } });
		const uno = await s.run({ op: "summary", supplier: "Fornitore Uno S.r.l." });
		expect(inside(uno)).toContain(`IBAN da verificare sulla fattura U-6: ${IBAN_D}`);
		expect(outside(uno)).toContain("Attenzione: l'IBAN di una fattura da pagare è diverso");
	});

	it("flags a second instalment on a new IBAN, the first on the known one", async () => {
		const split = fattura(UNO, BETA, { number: "U-7", date: "2026-10-05", total: "400.00", rate: [{ amount: "200.00", due: "2026-10-20", iban: IBAN_A }, { amount: "200.00", due: "2026-11-20", iban: IBAN_D }] });
		const s = await setup({ files: { ...base, "f/u7.xml": split } });
		const uno = await s.run({ op: "summary", supplier: "Fornitore Uno S.r.l." });
		expect(inside(uno)).toContain(`IBAN da verificare sulla fattura U-7 (rata 2 di 2): ${IBAN_D}`);
		expect(inside(uno)).not.toContain(`sulla fattura U-7 (rata 1 di 2)`);
	});

	it("without a payment, checks against the IBAN most invoices write, and with none, says they differ", async () => {
		const unpaid = await setup({ files: { ...base, "f/u3.xml": U3 }, paid: {} });
		const uno = await unpaid.run({ op: "summary", supplier: "Fornitore Uno S.r.l." });
		expect(inside(uno)).toContain(`IBAN scritto sulla maggior parte delle fatture: ${IBAN_A}`);
		expect(inside(uno)).toContain(`IBAN da verificare sulla fattura U-3: ${IBAN_B}`);
		expect(outside(uno)).toContain("da quello delle altre fatture");
		const two = await setup({ files: { "f/u2.xml": U2, "f/u3.xml": U3 }, paid: {} });
		const mixed = await two.run({ op: "summary", supplier: "Fornitore Uno S.r.l." });
		expect(outside(mixed)).toContain("Attenzione: le fatture da pagare di questo fornitore hanno IBAN diversi tra loro");
		expect(inside(mixed)).toContain(`IBAN da verificare sulla fattura U-2: ${IBAN_A}`);
		expect(inside(mixed)).toContain(`IBAN da verificare sulla fattura U-3: ${IBAN_B}`);
	});

	it("says once when the IBAN differs only from the one the person gave", async () => {
		const s = await setup({ files: { ...base, "f/u5.xml": rec(UNO, "U-5", "2026-10-05", "100.00", "2026-10-21", IBAN_A) } });
		const pinned = await s.run({ op: "contact_set", supplier: "Fornitore Uno S.r.l.", iban: IBAN_C });
		expect(outside(pinned)).toContain("Attenzione: una fattura da pagare ha un IBAN diverso da quello che mi hai dato tu. Prima di pagare, verificalo con il fornitore per telefono, a un numero che conosci già. Quello che mi hai dato resta com'è.");
		expect(outside(pinned).match(/Attenzione/g)).toHaveLength(1);
		const line = await s.run({ op: "summary", compact: true });
		expect(outside(line)).toContain("Un fornitore con una fattura da pagare entro 7 giorni ha sulla fattura un IBAN diverso da quello che conosci. Prima di pagarla, verificalo con lui per telefono. Il nome è nel riquadro.");
		expect(line).not.toMatch(/IT\d{2}X/);
	});

	it("flags a supplier with few invoices using the name of another with another partita IVA and IBAN", async () => {
		const impostor = rec({ name: "Fornitore Uno", vat: "00000050013" }, "X-1", "2026-10-12", "900.00", "2026-10-23", IBAN_D);
		const s = await setup({ files: { ...FILES, "f/x1.xml": impostor } });
		const card = await s.run({ op: "summary", supplier: "IT00000050013" });
		expect(outside(card)).toContain("Attenzione: c'è un altro fornitore con lo stesso nome ma un'altra partita IVA e un altro IBAN. Prima di pagare, verifica con il fornitore per telefono, a un numero che conosci già.");
		expect(inside(card)).toContain("Stesso nome, altro fornitore: Fornitore Uno S.r.l. (partita IVA IT00000010017)");
		// The real one, with its history, is not the suspect.
		expect(outside(await s.run({ op: "summary", supplier: "IT00000010017" }))).not.toContain("stesso nome");
		const line = await s.run({ op: "summary", compact: true });
		expect(outside(line)).toContain("Un fornitore con una fattura da pagare entro 7 giorni ha lo stesso nome di un altro fornitore ma un'altra partita IVA o un altro IBAN. Prima di pagare, verifica con il fornitore per telefono, a un numero che conosci già.");
		expect(outside(line)).toContain("I nomi sono nel riquadro.");
		expect(inside(line)).toContain("Stesso nome di un altro fornitore: Fornitore Uno");
		expect(inside(line)).toContain("IBAN cambiato: Fornitore Uno S.r.l.");
		expect(line).not.toMatch(/IT\d{2}X/);
		const csv = await s.run({ op: "export" }, durable("exp-imp"));
		expect(csv).toContain("Salvato");
		clean(s.answers);
	});
});

describe("suppliers: payment days and late payments", () => {
	it("says how many days the supplier is paid after the invoice, against the terms", async () => {
		const s = await setup();
		const uno = await s.run({ op: "summary", supplier: "Fornitore Uno S.r.l.", period: "anno" });
		// 35 and 30 days from the invoice (33 on average), terms 30; April's paid 5 days after its due date.
		expect(outside(uno)).toContain("lo hai pagato in media a 33 giorni dalla data della fattura, con termini di pagamento medi di 30 giorni; 1 rata pagata dopo la scadenza su 2, in media di 5 giorni.");
		expect(outside(uno)).toContain("Da pagare: 400,00 € su 1 fattura; prossima scadenza il 22 ottobre, 400,00 €.");
		expect(outside(uno)).toContain("Ultimo pagamento: il 1º luglio, 610,00 € (una fattura).");
		expect(outside(uno)).toContain("ti ha fatturato 2.230,00 €, IVA inclusa, su 3 fatture");
		clean(s.answers);
	});

	it("lists who is overdue now and who was paid late", async () => {
		const s = await setup();
		const late = await s.run({ op: "late" });
		expect(outside(late)).toContain("Oggi hai 244,00 € di fatture scadute da pagare a 1 fornitore.");
		expect(outside(late)).toContain("Negli ultimi 12 mesi hai pagato in ritardo 2 fornitori.");
		expect(inside(late)).toContain("• Rossi Srl: 244,00 € (1 rata, la più vecchia da 48 giorni)");
		expect(inside(late)).toContain("• Rossi Srl: 1 rata pagata dopo la scadenza su 1, in media di 19 giorni");
		expect(inside(late)).toContain("• Fornitore Uno S.r.l.: 1 rata pagata dopo la scadenza su 2, in media di 5 giorni");
		expect(inside(late)).not.toContain("Rossi SpA");
		const rossi = await s.run({ op: "summary", supplier: "Rossi Srl" });
		expect(outside(rossi)).toContain("Da pagare: 244,00 € su 1 fattura, di cui 244,00 € scaduti (1 rata, la più vecchia da 48 giorni).");
		clean(s.answers);
	});

	it("reads a payment the bank statement confirmed as paid on the bank's day", async () => {
		const first = await setup();
		const key = first.keys.get("U-3") as string;
		const movement: BankMovement = { id: "B-000001", hash: "h1", seq: 1, date: "2026-10-10", amount: "-400", description: "BONIFICO", importId: "I-0001" };
		const match: BankMatch = { movement: "B-000001", state: "confirmed", kind: "invoice_in", target: key, instalment: 1, label: "U-3", by: "test:u", at: NOW.toISOString() };
		const s = await setup({ bank: { movements: [movement], matches: [match] } });
		const uno = await s.run({ op: "summary", supplier: "Fornitore Uno" });
		expect(outside(uno)).toContain("Da pagare: niente.");
		expect(outside(uno)).toContain("Ultimo pagamento: il 10 ottobre, 400,00 € (una fattura).");
		// Paid: no brief line about its IBAN.
		expect(await s.run({ op: "summary", compact: true })).toContain("Niente da segnalare sui fornitori");
		// A proposal is not a payment.
		const p = await setup({ bank: { movements: [movement], matches: [{ ...match, state: "proposed" }] } });
		expect(outside(await p.run({ op: "summary", supplier: "Fornitore Uno" }))).toContain("Da pagare: 400,00 €");
	});
});

describe("suppliers: a partita IVA dictated never moves invoices", () => {
	it("refuses another supplier's partita IVA on a card, and one that splits the supplier from its invoices", async () => {
		const s = await setup();
		await s.run({ op: "contact_set", supplier: "Fornitore Uno S.r.l.", contact: { name: "Laura" } });
		const takeover = await s.run({ op: "contact_set", supplier: "Fornitore Uno S.r.l.", vat: "00000030015" });
		expect(outside(takeover)).toContain("Non la segno: questa partita IVA è già di un altro fornitore, nel riquadro. Se sono lo stesso fornitore, posso unirli.");
		expect(inside(takeover)).toContain("Aruba: IT00000030015");
		expect(s.store.read().cards[0]?.vat).toBe("IT00000010017");
		expect(outside(await s.run({ op: "summary", supplier: "Aruba", period: "anno" }))).toContain("172,00 €");
		const split = await s.run({ op: "contact_set", supplier: "Fornitore Uno S.r.l.", vat: "00000050013" });
		expect(outside(split)).toContain("Non la segno: le fatture o le spese di questo fornitore hanno un'altra partita IVA, nel riquadro. Chiedi a chi ti scrive quale è giusta");
		expect(inside(split)).toContain("Nelle fatture o nelle spese: IT00000010017");
		expect(inside(split)).toContain("Detta ora: IT00000050013");
		expect(s.store.read().cards[0]?.vat).toBe("IT00000010017");
		// A partita IVA only in the registers (Rossi Srl has no card) is another supplier's too.
		const theirs = await s.run({ op: "contact_set", supplier: "Uno Forniture", vat: "IT00000020016" });
		expect(outside(theirs)).toContain("questa partita IVA è già di un altro fornitore");
		expect(s.store.read().cards).toHaveLength(1);
		clean(s.answers);
	});
});

describe("suppliers: the same money that may be counted twice is said", () => {
	it("top and the totals say a payment that may be an expense too, and never claim it is counted once", async () => {
		const twin = [...EXPENSES, expense("S-2026-0006", "2026-07-02", "610", { supplier: "Cartoleria Verdi" })];
		const s = await setup({ expenses: twin });
		const top = await s.run({ op: "top", period: "anno" });
		expect(outside(top)).not.toContain("una volta sola");
		expect(outside(top)).toContain("Un pagamento di fattura potrebbe essere anche una spesa registrata: l'ho contato una volta come fattura e una come spesa.");
		const totals = await s.run({ op: "summary", period: "anno" });
		expect(outside(totals)).toContain("Un pagamento di fattura potrebbe essere anche una spesa registrata");
		expect(String(await s.tool.execute({ op: "top", period: "anno" }, agent()))).toContain("1 pagamento di fattura potrebbe essere anche una spesa registrata: contati entrambi.");
		const plain = await (await setup()).run({ op: "top", period: "anno" });
		expect(plain).toContain("gli stessi soldi una volta sola");
		clean(s.answers);
	});
});

describe("suppliers: copy", () => {
	it("asks on a name only close before showing anything, says a same-day payment, and words the card", async () => {
		const s = await setup();
		const close = await s.run({ op: "summary", supplier: "Fornitor Uno S.r.l." });
		expect(outside(close)).toContain("Intendi questo fornitore?");
		expect(close).not.toMatch(/IT\d{2}X|Da pagare/);
		const aruba = await s.run({ op: "summary", supplier: "Aruba" });
		expect(outside(aruba)).toContain("lo hai pagato in media il giorno stesso della fattura; mai in ritardo.");
		expect(outside(aruba)).not.toContain("termini di pagamento medi di 0");
		expect(outside(aruba).split("\n")[0]).toBe("Il fornitore è nel riquadro.");
		await s.run({ op: "note_add", supplier: "Aruba", note: "fattura a fine mese" });
		expect(outside(await s.run({ op: "summary", supplier: "Aruba" })).split("\n")[0]).toBe("Il fornitore è nel riquadro (scheda FO-0001).");
		// A name said with a legal form the supplier's has not: said even on the card.
		const form = await s.run({ op: "summary", supplier: "Adobe Srl" });
		expect(outside(form)).toContain("Ho preso il fornitore che si chiama così senza la forma societaria, nel riquadro.");
		clean(s.answers);
	});
});

describe("suppliers: notes and referenti, only as said", () => {
	it("sets a referente and notes on a card made for the supplier, and takes a note off", async () => {
		const s = await setup();
		const set = await s.run({ op: "contact_set", supplier: "Fornitore Uno", contact: { name: "Laura", email: "laura@example.com" } });
		expect(outside(set)).toContain("Fatto, ho aggiornato la scheda FO-0001.");
		expect(inside(set)).toContain("Referente: Laura · laura@example.com");
		expect(outside(set)).not.toContain("laura@example.com");
		expect(s.store.read().cards[0]).toMatchObject({ id: "FO-0001", name: "Fornitore Uno S.r.l.", vat: "IT00000010017", contacts: [{ name: "Laura", email: "laura@example.com" }] });
		const note = await s.run({ op: "note_add", supplier: "Fornitore Uno", note: "sconto 5% sopra i 1.000 €" });
		expect(outside(note)).toContain("Fatto, nota salvata nella scheda FO-0001.");
		expect(inside(note)).toContain("Nota: sconto 5% sopra i 1.000 €");
		await s.run({ op: "note_add", supplier: "FO-0001", note: "sconto extra a dicembre" });
		const card = await s.run({ op: "summary", supplier: "Fornitore Uno" });
		expect(inside(card)).toContain("sconto 5% sopra i 1.000 €");
		const two = await s.run({ op: "note_remove", supplier: "Fornitore Uno", note: "sconto" });
		expect(outside(two)).toContain("Ci sono 2 note con queste parole");
		const gone = await s.run({ op: "note_remove", supplier: "Fornitore Uno", note: "sconto 5%" });
		expect(outside(gone)).toContain("Fatto, nota tolta dalla scheda FO-0001.");
		expect(s.store.read().cards[0]?.notes.map((n) => n.text)).toEqual(["sconto extra a dicembre"]);
		const none = await s.run({ op: "note_remove", supplier: "Fornitore Uno", note: "consegna" });
		expect(outside(none)).toContain("Non trovo una nota con queste parole");
		// A referente's field cleared, then the referente taken off.
		await s.run({ op: "contact_set", supplier: "Fornitore Uno", contact: { name: "Laura", phone: "333 1234567" } });
		expect(s.store.read().cards[0]?.contacts).toEqual([{ name: "Laura", email: "laura@example.com", phone: "333 1234567" }]);
		await s.run({ op: "contact_set", supplier: "Fornitore Uno", remove_contact: "Laura" });
		expect(s.store.read().cards[0]?.contacts).toEqual([]);
		clean(s.answers);
	});

	it("makes a card for a supplier never seen, and refuses a write with nothing to set", async () => {
		const s = await setup();
		const made = await s.run({ op: "note_add", supplier: "Tipografia Bianchi", note: "chiude ad agosto" });
		expect(outside(made)).toContain("Fatto, nota salvata nella scheda FO-0001.");
		expect(s.store.read().cards[0]).toMatchObject({ name: "Tipografia Bianchi", aliases: [], contacts: [] });
		expect(s.store.read().cards[0]?.vat).toBeUndefined();
		expect(await s.run({ op: "contact_set", supplier: "Tipografia Bianchi" })).toContain("Errore: dimmi il referente");
		expect(await s.run({ op: "contact_set", supplier: "Tipografia Bianchi", contact: { email: "non una mail" } })).toContain("Errore: l'indirizzo email non è valido");
	});
});

describe("suppliers: export", () => {
	it("writes a formula-safe CSV in fornitori/, never over another, once per call", async () => {
		const hostile = [...EXPENSES, expense("S-2026-0005", "2026-10-01", "10", { supplier: '=HYPERLINK("http://x.example","clic")' })];
		const s = await setup({ expenses: hostile });
		await s.run({ op: "contact_set", supplier: "Fornitore Uno", contact: { name: "@cmd", phone: "+39 333 1234567" } });
		const first = await s.run({ op: "export" }, durable("exp-1"));
		expect(first).toContain("Salvato fornitori/fornitori-al-2026-10-18.csv: 7 fornitori");
		const csv = readFileSync(join(s.root, "fornitori/fornitori-al-2026-10-18.csv"), "utf8");
		expect(csv).toContain(`"'=HYPERLINK(""http://x.example"",""clic"")"`);
		expect(csv).toContain(";'@cmd;'+39 333 1234567;");
		expect(csv).toContain("Fornitore Uno S.r.l.;FO-0001;IT00000010017;");
		expect(csv).toContain(`;${IBAN_A};${IBAN_B};sì;`);
		expect(csv).toContain(";1830,00;");
		// Run again: the same file, not a second.
		expect(untagged(await s.run({ op: "export" }, durable("exp-1")))).toBe(untagged(first));
		expect(existsSync(join(s.root, "fornitori/fornitori-al-2026-10-18-2.csv"))).toBe(false);
		// Another call: a new file, the first untouched.
		const second = await s.run({ op: "export" }, durable("exp-2"));
		expect(second).toContain("fornitori/fornitori-al-2026-10-18-2.csv");
		expect(readFileSync(join(s.root, "fornitori/fornitori-al-2026-10-18.csv"), "utf8")).toBe(csv);
		clean(s.answers);
	});
});

describe("suppliers: another agente", () => {
	it("gives the ranking and the totals as numbers only, and refuses the rest", async () => {
		const s = await setup();
		await s.run({ op: "contact_set", supplier: "Fornitore Uno", contact: { name: "Laura", email: "laura@example.com" }, iban: IBAN_A });
		const top = String(await s.tool.execute({ op: "top", period: "anno" }, agent()));
		expect(top).toContain("2.265,00 €");
		expect(top).toContain("5 fornitori");
		const totals = String(await s.tool.execute({ op: "summary", supplier: "Fornitore Uno" }, agent()));
		expect(totals).toContain("A un altro agente non do i dati di un fornitore solo");
		expect(totals).toContain("Da pagare ai fornitori: 644,00 €, di cui 244,00 € scaduti con 1 fornitore.");
		for (const a of [top, totals]) {
			expect(a).not.toMatch(/Fornitore Uno|Aruba|Rossi|Adobe|Laura|example\.com|IT\d{2}X|<<</);
			expect(a).not.toMatch(NO_EM_DASH);
		}
		for (const args of [{ op: "late" }, { op: "note_add", supplier: "Aruba", note: "x" }, { op: "export" }, { op: "summary", compact: true }, { op: "merge", supplier: "Rossi Srl", into: "Rossi SpA", confirm: true }]) {
			expect(String(await s.tool.execute(args, agent()))).toContain("Errore: a un altro agente non mostro le schede dei fornitori");
		}
		expect(s.store.read().cards).toHaveLength(1);
		expect(supplierAgentReads({ op: "top" })).toBe(true);
		expect(supplierAgentReads({ op: "late" })).toBe(false);
	});
});

describe("suppliers: the brief", () => {
	it("says a changed IBAN only when an invoice of that supplier is due within 7 days, never the IBAN", async () => {
		const s = await setup();
		const line = await s.run({ op: "summary", compact: true });
		expect(outside(line)).toContain("Un fornitore con una fattura da pagare entro 7 giorni ha cambiato IBAN sull'ultima fattura. Prima di pagarla, verificalo con lui per telefono. Il nome è nel riquadro.");
		expect(inside(line)).toBe("IBAN cambiato: Fornitore Uno S.r.l.");
		expect(outside(line)).not.toContain("Fornitore Uno");
		expect(line).not.toMatch(/IT\d{2}X/);
		// The due date and the amount are the fiscal agenda's: not repeated.
		expect(outside(line)).not.toMatch(/400|22 ottobre/);
		s.at("2026-10-01T08:00:00Z");
		expect(await s.run({ op: "summary", compact: true })).toBe("Niente da segnalare sui fornitori: nel brief non scrivere niente sui fornitori.");
		expect(BRIEF_INSTRUCTION).toMatch(/\n9\. Chiama ognuno di questi tool con l'op tra parentesi e compact true, e riporta la sua riga solo se segnala qualcosa: [^\n]*\bsuppliers \(summary\)[,.]/);
		expect(supplierCallReads({ op: "summary", compact: true })).toBe(true);
		expect(supplierCallReads({ op: "late" })).toBe(true);
		for (const op of ["note_add", "note_remove", "contact_set", "merge", "export"]) expect(supplierCallReads({ op })).toBe(false);
		clean(s.answers);
	});
});

describe("suppliers: store, audit, reruns", () => {
	it("never writes over a file that does not read", async () => {
		const s = await setup();
		writeFileSync(join(s.dir, "suppliers.json"), "{ non è json");
		expect(await s.run({ op: "summary", supplier: "Aruba" })).toBe(`Errore: ${SUPPLIERS_BROKEN}.`);
		expect(await s.run({ op: "note_add", supplier: "Aruba", note: "x" })).toBe(`Errore: ${SUPPLIERS_BROKEN}.`);
		expect(readFileSync(join(s.dir, "suppliers.json"), "utf8")).toBe("{ non è json");
		expect(existsSync(join(s.dir, "suppliers.json.bak"))).toBe(false);
		expect(s.events).toEqual([]);
		// A card with an IBAN that fails its check is a broken file too.
		writeFileSync(join(s.dir, "suppliers.json"), JSON.stringify({ nextCard: 2, cards: [{ id: "FO-0001", name: "X", iban: "IT00X0000000000000000000001", aliases: [], contacts: [], notes: [], by: "a", at: "b" }], calls: [] }));
		expect(s.store.read().broken).toBe(true);
	});

	it("audits the op and the count only, and a call run again writes once", async () => {
		const s = await setup();
		const c = fresh("note-1");
		const first = await s.run({ op: "note_add", supplier: "Fornitore Uno", note: "sconto 5% sopra i 1.000 €" }, c);
		const again = await s.run({ op: "note_add", supplier: "Fornitore Uno", note: "sconto 5% sopra i 1.000 €" }, c);
		expect(untagged(again)).toBe(untagged(first));
		expect(s.store.read().cards[0]?.notes).toHaveLength(1);
		const k = fresh("contact-1");
		const set = await s.run({ op: "contact_set", supplier: "Fornitore Uno", contact: { name: "Laura", email: "laura@example.com" } }, k);
		expect(untagged(await s.run({ op: "contact_set", supplier: "Fornitore Uno", contact: { name: "Laura", email: "laura@example.com" } }, k))).toBe(untagged(set));
		expect(s.store.read().cards[0]?.contacts).toHaveLength(1);
		const r = fresh("remove-1");
		await s.run({ op: "note_remove", supplier: "Fornitore Uno", note: "sconto" }, r);
		expect(await s.run({ op: "note_remove", supplier: "Fornitore Uno", note: "sconto" }, r)).toBe("Fatto, nota tolta dalla scheda FO-0001.");
		expect(s.store.read().nextCard).toBe(2);
		expect(existsSync(join(s.dir, "suppliers.json.bak"))).toBe(true);
		expect(s.events).toEqual([
			{ type: "suppliers.changed", op: "note_add", count: 1 },
			{ type: "suppliers.changed", op: "note_add", count: 1 },
			{ type: "suppliers.changed", op: "contact_set", count: 1 },
			{ type: "suppliers.changed", op: "contact_set", count: 1 },
			{ type: "suppliers.changed", op: "note_remove", count: 1 },
			{ type: "suppliers.changed", op: "note_remove", count: 1 },
		]);
		expect(JSON.stringify(s.events)).not.toMatch(/Laura|sconto|Uno|IT\d/);
		clean(s.answers);
	});
});

describe("suppliers: wiring", () => {
	it("is in the system prompt next to the clients, and its text has no em dash", async () => {
		expect(DEFAULT_INSTRUCTIONS).toContain("tenere le schede dei fornitori (suppliers: clients è per chi lo paga, suppliers per chi paga lui;");
		expect(DEFAULT_INSTRUCTIONS).not.toMatch(NO_EM_DASH);
		const s = await setup();
		expect(s.tool.description).not.toMatch(NO_EM_DASH);
		expect(s.tool.description).toContain("The list of invoices to pay and their due dates, and marking one paid, is invoices");
	});
});
