import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "../src/app.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import type { ClientCard } from "../src/core/clients.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import type { Company } from "../src/core/invoices.ts";
import { PriceListStore } from "../src/core/price-list-store.ts";
import { RECURRING_BROKEN, RecurringStore } from "../src/core/recurring-invoice-store.ts";
import { addMonths, dueDate, duePeriod, finished, periodLabel, periodOn, recurringAgentReads, recurringCallReads, type Schedule, within } from "../src/core/recurring-invoices.ts";
import { SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import { isIssued, type SalesInvoice } from "../src/core/sales-invoices.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { createPriceListTools } from "../src/core/tools/price-list-tools.ts";
import { type RecurringEnv, type RecurringEvent, sweepRecurring } from "../src/core/tools/recurring-invoice-run.ts";
import { createRecurringInvoiceTools } from "../src/core/tools/recurring-invoice-tools.ts";
import { salesEnvOf, type SalesStores } from "../src/core/tools/sales-invoice-env.ts";
import { createSalesInvoiceTools, type SalesEvent } from "../src/core/tools/sales-invoice-tools.ts";
import { Workspace } from "../src/core/workspace.ts";

// Every tax id here is made up and passes its checksum; every name is invented.
const SELLER_VAT = "IT00000010017";
const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday 18 October 2026, in Rome
const IBAN = "IT51X0000000000000000000001";
const ORDINARIO: Company = { vat: SELLER_VAT, name: "Beta Studio Srl", cf: "00000010017", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: [IBAN], by: "test:u", at: NOW.toISOString() };
const FORFETTARIO: Company = { ...ORDINARIO, name: "Kevin Wojtq", cf: "KWJXQZ75C10F205V", regime: "forfettario" };
const DELTA = { customer: "Delta Servizi Srl", vat_number: "00000020016", address: "Via Verdi 2, 00184 Roma RM", recipient_code: "ZZZ0001" };
const DELTA_CARD = { id: "CL-0001", name: "Delta Servizi Srl", aliases: [], vat: "IT00000020016", address: "Via Verdi 2, 00184 Roma RM", tags: [], contacts: [], notes: [], followUps: [], by: "test:u", at: NOW.toISOString() } as unknown as ClientCard;

let calls = 0;
const THREAD = { channel: "test", threadId: "t1" };
const fresh = (callId = `c${++calls}`, thread: ToolContext["thread"] = THREAD): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, signal: new AbortController().signal, callId, ...(thread === undefined ? {} : { thread }) });
const agent = () => fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" });

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "annie-recurring-"));
	dirs.push(dir);
	return dir;
}

type Notice = { thread: { channel: string; threadId: string }; text: string; key: string };

function setup(o: { company?: Company; cards?: ClientCard[]; known?: boolean } = {}) {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(o.company ?? ORDINARIO);
	const store = new SalesInvoiceStore(dir);
	store.update("seed", (state) => ({ ...state, settings: { by: "test:u", at: NOW.toISOString(), lastBefore: { 2026: 0, 2027: 0 } } }));
	const priceList = new PriceListStore(dir);
	const taxes = new TaxStore(dir);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const clock = { now: NOW };
	const cards = { list: o.cards ?? [] };
	const stores: SalesStores = {
		workspace,
		store,
		company: invoices,
		taxes,
		clients: { read: () => ({ cards: cards.list, nextCard: 2, nextFollowUp: 1, calls: [], broken: false }) as never },
		priceList,
		scanner,
		timeZone: "Europe/Rome",
	};
	const salesEvents: SalesEvent[] = [];
	const make = async () => ({ data: Buffer.from("%PDF-1.4 finta"), notes: [] });
	const salesOptions = { ...stores, whoIs: () => "test:u", record: async (e: SalesEvent) => void salesEvents.push(e), now: () => clock.now, make };
	const [salesTool] = createSalesInvoiceTools(salesOptions);
	const [priceTool] = createPriceListTools({ workspace, store: priceList, company: invoices, taxes, timeZone: "Europe/Rome", whoIs: () => "test:u", now: () => clock.now });
	const recurring = new RecurringStore(dir);
	const events: RecurringEvent[] = [];
	const notices: Notice[] = [];
	const notify = { fails: false };
	const env: RecurringEnv = {
		store: recurring,
		sales: salesEnvOf(salesOptions),
		timeZone: "Europe/Rome",
		now: () => clock.now,
		record: async (e) => void events.push(e),
		notify: async (thread, text, key) => {
			if (notify.fails) throw new Error("canale giù");
			notices.push({ thread, text, key });
		},
		log: () => {},
	};
	const [tool] = createRecurringInvoiceTools({ ...env, whoIs: () => "test:u" });
	if (tool === undefined || salesTool === undefined || priceTool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const sales = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await salesTool.execute(args, c));
	const price = async (args: Record<string, unknown>) => String(await priceTool.execute(args, fresh()));
	const drafts = (): SalesInvoice[] => store.read().invoices.filter((i) => i.callId.startsWith("recurring:"));
	const at = (iso: string) => (clock.now = new Date(iso));
	return { dir, store, recurring, events, salesEvents, notices, notify, cards, clock, env, tool, run, sales, price, drafts, at, sweep: () => sweepRecurring(env) };
}

/** A customer invoiced once already (its draft gives the data FatturaPA needs). */
async function known(s: ReturnType<typeof setup>, company: Company = ORDINARIO): Promise<void> {
	const answer = await s.sales({ op: "draft", ...DELTA, lines: [{ description: "Primo lavoro", price: 100 }], ...(company.regime === "ordinario" ? { vat: 22 } : { bollo_to_client: true }) });
	expect(answer).toContain("BZ-0001");
}

const CANONE = { op: "add", customer: "Delta Servizi Srl", lines: [{ description: "Canone di manutenzione", price: 300 }], vat: 22, cadence: "monthly", day: 1, start: "ottobre" };

const schedule = (o: Partial<Schedule> = {}): Schedule => ({ id: "RI-0001", customer: { name: "Delta" }, lines: [{ description: "A", price: "1" }], terms: {}, cadence: "monthly", day: 1, start: "2026-01", status: "active", from: "2026-01-01", by: "test:u", at: NOW.toISOString(), ...o });

describe("cadence math", () => {
	it("the day of a period: 28 and «fine mese», February and the leap year", () => {
		expect(dueDate("2026-02", 28)).toBe("2026-02-28");
		expect(dueDate("2026-02", "end")).toBe("2026-02-28");
		expect(dueDate("2028-02", "end")).toBe("2028-02-29");
		expect(dueDate("2026-10", "end")).toBe("2026-10-31");
		expect(dueDate("2026-04", "end")).toBe("2026-04-30");
		expect(addMonths("2026-11", 3)).toBe("2027-02");
	});

	it("periods: the one a day falls in, its words", () => {
		const q = schedule({ cadence: "quarterly", start: "2026-10" });
		expect(periodOn(q, "2026-09-30")).toBeUndefined();
		expect(periodOn(q, "2026-12-31")).toBe("2026-10");
		expect(periodOn(q, "2027-01-01")).toBe("2027-01");
		expect(periodLabel({ cadence: "monthly" }, "2026-10")).toBe("ottobre 2026");
		expect(periodLabel({ cadence: "quarterly" }, "2026-10")).toBe("4º trimestre 2026");
		expect(periodLabel({ cadence: "quarterly" }, "2026-11")).toBe("novembre 2026 - gennaio 2027");
		expect(periodLabel({ cadence: "bimonthly" }, "2026-10")).toBe("ottobre-novembre 2026");
		expect(periodLabel({ cadence: "semiannual" }, "2026-07")).toBe("2º semestre 2026");
		expect(periodLabel({ cadence: "yearly" }, "2027-01")).toBe("2027");
		expect(periodLabel({ cadence: "yearly" }, "2026-10")).toBe("ottobre 2026 - settembre 2027");
	});

	it("what is due: «fine mese» in February, day 28, never a period before the schedule was set", () => {
		const end = schedule({ day: "end", start: "2026-01", from: "2026-02-15" });
		// January was before it was set; February is due on the 28th.
		expect(duePeriod(end, "2026-02-27", new Set())).toBeUndefined();
		expect(duePeriod(end, "2026-02-28", new Set())).toEqual({ period: "2026-02", skipped: 0 });
		expect(duePeriod(end, "2026-03-30", new Set(["2026-02"]))).toBeUndefined();
		expect(duePeriod(end, "2026-03-31", new Set(["2026-02"]))).toEqual({ period: "2026-03", skipped: 0 });
		const d28 = schedule({ day: 28, start: "2026-02", from: "2026-02-01" });
		expect(duePeriod(d28, "2026-02-27", new Set())).toBeUndefined();
		expect(duePeriod(d28, "2026-02-28", new Set())).toEqual({ period: "2026-02", skipped: 0 });
		// The server down for months: only the latest, and how many before it.
		expect(duePeriod(d28, "2026-06-28", new Set(["2026-02"]))).toEqual({ period: "2026-06", skipped: 3 });
		expect(duePeriod(d28, "2026-06-28", new Set(["2026-06"]))).toBeUndefined();
	});

	it("an end month and a number of invoices", () => {
		const count = schedule({ start: "2026-10", count: 3 });
		expect(within(count, "2026-12")).toBe(true);
		expect(within(count, "2027-01")).toBe(false);
		expect(finished(count, "2026-12-15")).toBe(false);
		expect(finished(count, "2027-01-15")).toBe(true);
		const end = schedule({ cadence: "quarterly", start: "2026-10", end: "2027-01" });
		expect(within(end, "2027-01")).toBe(true);
		expect(within(end, "2027-04")).toBe(false);
	});

	it("the brief reads list and show; another agente only the list", () => {
		expect(recurringCallReads({ op: "list" })).toBe(true);
		expect(recurringCallReads({ op: "show" })).toBe(true);
		expect(recurringCallReads({ op: "add" })).toBe(false);
		expect(recurringCallReads({ op: "run_now" })).toBe(false);
		expect(recurringAgentReads({ op: "list" })).toBe(true);
		expect(recurringAgentReads({ op: "show" })).toBe(false);
	});
});

describe("recurring invoices: add and the sweep", () => {
	it("«canone mensile di manutenzione 300 € a Delta»: a draft each period, never issued, told once", async () => {
		const s = setup();
		await known(s);
		const added = await s.run(CANONE);
		expect(added).toContain("Fatto, nuova fattura ricorrente RI-0001");
		expect(added).toContain("ogni mese, il giorno 1, da ottobre 2026");
		expect(added).toContain("300,00 €");
		expect(added).not.toMatch(/\u2014/);
		expect(await s.sweep()).toBe(1);
		const [d] = s.drafts();
		expect(d?.lines[0]?.description).toBe("Canone di manutenzione, ottobre 2026");
		expect(d?.lines[0]?.price).toBe("300");
		expect(d !== undefined && isIssued(d)).toBe(false);
		expect(d?.buyer).toMatchObject({ name: "Delta Servizi Srl", code: "ZZZ0001" });
		expect(s.notices).toHaveLength(1);
		const n = s.notices[0] as Notice;
		expect(n.thread).toEqual(THREAD);
		expect(n.key).toBe("recurring-invoice:RI-0001:2026-10");
		expect(n.text).toContain(`È pronta la bozza ${d?.id} del canone di ottobre 2026`);
		expect(n.text).toContain("366,00 € da pagare");
		expect(n.text).toContain("Non emetterla da sola");
		// The customer's name only inside the fence.
		const outside = n.text.replace(/<<<dati delle fatture ricorrenti[\s\S]*?<<<fine dati delle fatture ricorrenti [0-9a-f]+>>>/g, "");
		expect(outside).not.toContain("Delta");
		expect(n.text).not.toMatch(/\u2014/);
		// Again the same day: nothing.
		expect(await s.sweep()).toBe(0);
		expect(s.drafts()).toHaveLength(1);
		expect(s.notices).toHaveLength(1);
		// November.
		s.at("2026-11-01T07:00:00Z");
		expect(await s.sweep()).toBe(1);
		expect(s.drafts().map((x) => x.lines[0]?.description)).toEqual(["Canone di manutenzione, ottobre 2026", "Canone di manutenzione, novembre 2026"]);
		expect(s.notices.map((x) => x.key)).toEqual(["recurring-invoice:RI-0001:2026-10", "recurring-invoice:RI-0001:2026-11"]);
	});

	it("two sweeps at once, and a claim left by a process that stopped: never two drafts", async () => {
		const s = setup();
		await known(s);
		await s.run(CANONE);
		await Promise.all([s.sweep(), s.sweep()]);
		expect(s.drafts()).toHaveLength(1);
		expect(new Set(s.notices.map((n) => n.key)).size).toBe(1);
		// November claimed, then the process stopped before the draft: the next sweep makes it, once.
		s.at("2026-11-02T08:00:00Z");
		expect(s.recurring.claim("RI-0001", "2026-11", s.clock.now.toISOString()).mine).toBe(true);
		await s.sweep();
		await s.sweep();
		expect(s.drafts()).toHaveLength(2);
		expect(s.recurring.read().runs.map((r) => [r.period, r.state])).toEqual([
			["2026-10", "drafted"],
			["2026-11", "drafted"],
		]);
	});

	it("the server down for months: only the latest period, and the skipped ones said", async () => {
		const s = setup();
		await known(s);
		await s.run(CANONE);
		s.at("2027-01-15T09:00:00Z");
		expect(await s.sweep()).toBe(1);
		expect(s.drafts().map((x) => x.lines[0]?.description)).toEqual(["Canone di manutenzione, gennaio 2027"]);
		expect(s.recurring.read().runs).toMatchObject([{ period: "2027-01", state: "drafted", skipped: 3 }]);
		expect(s.notices[0]?.text).toContain("3 periodi prima di questo non sono stati preparati");
		expect(await s.sweep()).toBe(0);
	});

	it("paused: no draft; resumed: the periods paused are not made up", async () => {
		const s = setup();
		await known(s);
		await s.run({ ...CANONE, start: "novembre" });
		expect(await s.run({ op: "pause", customer: "Delta" })).toContain("RI-0001 è in pausa");
		s.at("2026-12-01T08:00:00Z");
		expect(await s.sweep()).toBe(0);
		s.at("2027-01-10T08:00:00Z");
		expect(await s.sweep()).toBe(0);
		const resumed = await s.run({ op: "resume", id: "RI-0001" });
		expect(resumed).toContain("RI-0001 riprende: la prossima bozza è di gennaio 2027, oggi stesso");
		expect(await s.sweep()).toBe(1);
		expect(s.recurring.read().runs).toMatchObject([{ period: "2027-01", state: "drafted" }]);
		expect(s.recurring.read().runs[0]?.skipped).toBeUndefined();
	});

	it("a number of invoices, or an end month: no draft after it", async () => {
		const s = setup();
		await known(s);
		await s.run({ ...CANONE, count: 2 });
		await s.run({ ...CANONE, lines: [{ description: "Hosting", price: 20 }], end: "ottobre 2026" });
		expect(await s.sweep()).toBe(2);
		s.at("2026-11-01T08:00:00Z");
		expect(await s.sweep()).toBe(1);
		s.at("2026-12-01T08:00:00Z");
		expect(await s.sweep()).toBe(0);
		s.at("2027-06-01T08:00:00Z");
		expect(await s.sweep()).toBe(0);
		expect(s.drafts()).toHaveLength(3);
		expect(await s.run({ op: "show", id: "RI-0001" })).toContain("Non ci sono altre bozze da preparare");
	});

	it("a quarter at «fine mese»: due on the last day, the quarter in the description", async () => {
		const s = setup();
		await known(s);
		await s.run({ ...CANONE, cadence: "quarterly", day: "fine mese", start: "ottobre" });
		expect(await s.sweep()).toBe(0);
		s.at("2026-10-31T08:00:00Z");
		expect(await s.sweep()).toBe(1);
		expect(s.drafts()[0]?.lines[0]?.description).toBe("Canone di manutenzione, 4º trimestre 2026");
	});
});

describe("the draft is sales_invoices' own", () => {
	for (const company of [ORDINARIO, FORFETTARIO]) {
		it(`the same draft as one made by hand with the same data (${company.regime})`, async () => {
			const s = setup({ company });
			await known(s, company);
			const vat = company.regime === "ordinario" ? { vat: 22 } : {};
			const manual = await s.sales({ op: "draft", customer: "Delta Servizi Srl", lines: [{ description: "Canone di manutenzione, ottobre 2026", price: 300 }], payment_days: 60, notes: "Canone di ottobre 2026", ...vat });
			expect(manual).toContain("BZ-0002");
			const { vat: _v, ...plain } = CANONE;
			await s.run({ ...plain, ...vat, payment_days: 60, note: "Canone di {mese}" });
			expect(await s.sweep()).toBe(1);
			const all = s.store.read().invoices;
			const strip = (i: SalesInvoice | undefined) => {
				const { id: _id, callId: _c, by: _b, at: _a, ...rest } = i as SalesInvoice;
				return rest;
			};
			const byHand = all.find((i) => i.id === "BZ-0002");
			const recurring = s.drafts()[0];
			expect(recurring?.by).toBe("annie");
			expect(strip(recurring)).toEqual(strip(byHand));
		});
	}

	it("a voce of the listino: its price at each draft; a voce gone is a failure said once", async () => {
		const s = setup();
		await known(s);
		expect(await s.price({ op: "add", name: "Manutenzione sito", price: 250, unit: "mese", vat: 22 })).toContain("LS-0001");
		expect(await s.run({ ...CANONE, lines: [{ item: "Manutenzione sito" }] })).toContain("250,00 €");
		await s.sweep();
		expect(s.drafts()[0]?.lines[0]).toMatchObject({ description: "Manutenzione sito, ottobre 2026", price: "250", vat: 22 });
		await s.price({ op: "remove", id: "LS-0001" });
		s.at("2026-11-01T08:00:00Z");
		await s.sweep();
		expect(s.recurring.read().runs.at(-1)).toMatchObject({ period: "2026-11", state: "failed" });
		expect(s.notices.at(-1)?.text).toContain("non c'è nel listino");
		await s.sweep();
		expect(s.notices).toHaveLength(2);
	});

	it("a voce not in the listino or not clear is asked when the recurring invoice is set", async () => {
		const s = setup();
		await known(s);
		const answer = await s.run({ ...CANONE, lines: [{ item: "Assistenza" }] });
		expect(answer).toContain("non c'è nel listino");
		expect(s.recurring.read().schedules).toHaveLength(0);
	});
});

describe("failures", () => {
	it("the customer's card gone: failed for that period, said once, not tried again; run_now tries again", async () => {
		const s = setup({ cards: [DELTA_CARD] });
		await known(s);
		const added = await s.run({ ...CANONE, customer: "CL-0001" });
		expect(added).toContain("RI-0001");
		expect(s.recurring.read().schedules[0]?.customer).toEqual({ name: "Delta Servizi Srl", card: "CL-0001" });
		s.cards.list = [];
		expect(await s.sweep()).toBe(0);
		expect(s.recurring.read().runs).toMatchObject([{ period: "2026-10", state: "failed", told: true }]);
		expect(s.notices).toHaveLength(1);
		expect(s.notices[0]?.text).toContain("La scheda del cliente (CL-0001) non c'è più");
		expect(s.notices[0]?.text).toContain("Non riprovo da sola");
		await s.sweep();
		await s.sweep();
		expect(s.notices).toHaveLength(1);
		expect(s.drafts()).toHaveLength(0);
		// Put right, and asked again.
		s.cards.list = [DELTA_CARD];
		const again = await s.run({ op: "run_now", customer: "Delta" });
		expect(again).toContain("Fatto, ho preparato la bozza BZ-0002 del canone di ottobre 2026");
		expect(s.drafts()).toHaveLength(1);
		await s.sweep();
		expect(s.notices).toHaveLength(1);
	});

	it("data missing for the draft: the builder's question, said once", async () => {
		const s = setup();
		await known(s);
		await s.run(CANONE);
		// The company's data lost: the draft cannot be made.
		writeFileSync(join(s.dir, "invoices.json"), JSON.stringify({ paid: [], reminders: [], calls: [] }));
		await s.sweep();
		const run = s.recurring.read().runs[0];
		expect(run?.state).toBe("failed");
		expect(s.notices).toHaveLength(1);
		expect(s.notices[0]?.text).toContain("mi servono ancora questi dati");
		await s.sweep();
		expect(s.notices).toHaveLength(1);
	});

	it("telling failed: told on the next sweep, once", async () => {
		const s = setup();
		await known(s);
		await s.run(CANONE);
		s.notify.fails = true;
		await s.sweep();
		expect(s.notices).toHaveLength(0);
		expect(s.recurring.read().runs[0]).toMatchObject({ state: "drafted" });
		expect(s.recurring.read().runs[0]?.told).toBeUndefined();
		s.notify.fails = false;
		await s.sweep();
		await s.sweep();
		expect(s.notices).toHaveLength(1);
		expect(s.drafts()).toHaveLength(1);
	});

	it("a file that does not read is never written over, and nothing is prepared", async () => {
		const s = setup();
		writeFileSync(join(s.dir, "recurring-invoices.json"), "{ rotto");
		expect(await s.run({ op: "list" })).toContain(RECURRING_BROKEN);
		expect(await s.sweep()).toBe(0);
	});
});

describe("the tool", () => {
	it("run_now: today's period at once, never twice", async () => {
		const s = setup();
		await known(s);
		await s.run({ ...CANONE, day: 25 });
		expect(await s.sweep()).toBe(0);
		const first = await s.run({ op: "run_now", id: "RI-0001" });
		expect(first).toContain("Fatto, ho preparato la bozza BZ-0002 del canone di ottobre 2026");
		const second = await s.run({ op: "run_now", id: "RI-0001" });
		expect(second).toContain("è già pronta: BZ-0002");
		s.at("2026-10-25T08:00:00Z");
		expect(await s.sweep()).toBe(0);
		expect(s.drafts()).toHaveLength(1);
		// Told in the answer: no notice besides.
		expect(s.notices).toHaveLength(0);
	});

	it("an unknown customer is not set; the same recurring invoice twice is said", async () => {
		const s = setup();
		const unknown = await s.run(CANONE);
		expect(unknown).toContain("Non trovo questo cliente");
		expect(s.recurring.read().schedules).toHaveLength(0);
		await known(s);
		await s.run(CANONE);
		const twice = await s.run(CANONE);
		expect(twice).toContain("C'è già una fattura ricorrente uguale");
		expect(s.recurring.read().schedules).toHaveLength(1);
	});

	it("the same call run again adds once", async () => {
		const s = setup();
		await known(s);
		const c = fresh("same");
		await s.run(CANONE, c);
		await s.run(CANONE, c);
		expect(s.recurring.read().schedules).toHaveLength(1);
	});

	it("change, list, show, remove: names only in the fence", async () => {
		const s = setup();
		await known(s);
		await s.run({ ...CANONE, note: "Canone di {periodo}" });
		const changed = await s.run({ op: "change", customer: "Delta", amount: 350, day: "fine mese" });
		expect(changed).toContain("Fatto, ho cambiato RI-0001: 350,00 €");
		expect(changed).toContain("l'ultimo giorno");
		const list = await s.run({ op: "list" });
		expect(list).toContain("RI-0001: 350,00 €");
		expect(list.split("<<<dati delle fatture ricorrenti")[0]).not.toContain("Delta");
		const shown = await s.run({ op: "show", customer: "Delta Servizi Srl" });
		expect(shown).toContain("Prossima bozza il 31 ottobre 2026 (ottobre 2026).");
		expect(shown).toContain("Note: Canone di {periodo}");
		expect(await s.run({ op: "day", id: "RI-0001" })).toContain("Errore");
		expect(await s.run({ ...CANONE, day: 30 })).toContain("il giorno va da 1 a 28");
		expect(await s.run({ op: "remove", id: "RI-0001" })).toContain("ho tolto la fattura ricorrente RI-0001");
		expect(await s.run({ op: "list" })).toContain("Non ci sono fatture ricorrenti");
		expect(s.recurring.read().runs).toHaveLength(0);
	});

	it("another agente: the totals only, never a customer, never a change", async () => {
		const s = setup();
		await known(s);
		await s.run(CANONE);
		await s.run({ ...CANONE, lines: [{ description: "Hosting", price: 120 }], cadence: "yearly" });
		const totals = await s.run({ op: "list" }, agent());
		expect(totals).toContain("Fatture ricorrenti: 2 attive.");
		expect(totals).toContain("In media al mese, senza IVA: 310,00 €");
		expect(totals).not.toContain("Delta");
		expect(totals).not.toContain("RI-0001");
		for (const args of [{ op: "list", customer: "Delta" }, { op: "show", id: "RI-0001" }, { ...CANONE }, { op: "run_now", id: "RI-0001" }, { op: "pause", id: "RI-0001" }, { op: "remove", id: "RI-0001" }]) {
			const answer = await s.run(args, agent());
			expect(answer).toMatch(/^Errore: a un altro agente/);
			expect(answer).not.toContain("Delta");
		}
		expect(s.recurring.read().schedules.every((x) => x.status === "active")).toBe(true);
		expect(s.drafts()).toHaveLength(0);
	});

	it("the audit has the op and a count, never a customer or an amount", async () => {
		const s = setup();
		await known(s);
		await s.run(CANONE);
		await s.run({ op: "change", id: "RI-0001", amount: 310 });
		await s.run({ op: "pause", id: "RI-0001" });
		await s.run({ op: "resume", id: "RI-0001" });
		await s.sweep();
		await s.run({ op: "remove", id: "RI-0001" });
		expect(s.events).toEqual([
			{ type: "recurring_invoices.changed", op: "add", count: 1 },
			{ type: "recurring_invoices.changed", op: "change", count: 1 },
			{ type: "recurring_invoices.changed", op: "pause", count: 1 },
			{ type: "recurring_invoices.changed", op: "resume", count: 1 },
			{ type: "recurring_invoices.changed", op: "prepared", count: 1 },
			{ type: "recurring_invoices.changed", op: "remove", count: 1 },
		]);
		for (const e of [...s.events, ...s.salesEvents]) expect(Object.keys(e).sort()).toEqual(["count", "op", "type"]);
		expect(JSON.stringify(s.events)).not.toMatch(/Delta|310|300/);
	});

	it("is in Annie's instructions", () => {
		expect(DEFAULT_INSTRUCTIONS).toContain("preparare ogni periodo le fatture ricorrenti (recurring_invoices:");
		expect(DEFAULT_INSTRUCTIONS).not.toMatch(/\u2014/);
	});
});
