import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BoardStore } from "../src/core/board.ts";
import { BoardWork } from "../src/core/board-work.ts";
import type { AnnieTool, ToolContext } from "../src/core/engine.ts";
import { cardSubjects, overlapText, partyKeys, SubjectLedger, type SubjectSeam, type SubjectStores, syncAgent, withSubjects } from "../src/core/subjects.ts";
import { createBoardTools } from "../src/core/tools/board-tools.ts";

const fresh = (o: Partial<ToolContext> = {}): ToolContext => ({ step: (_k, work) => work(), progress: () => {}, origin: "person", signal: new AbortController().signal, callId: `c${Math.random()}`, thread: { channel: "web", threadId: "w1" }, ...o }) as ToolContext;

/** One agente's registers in memory: what the fake tools below write. */
function registers() {
	const books = {
		clients: [] as { id: string; name: string; vat?: string; cf?: string }[],
		suppliers: [] as { id: string; name: string; vat?: string }[],
		quotes: [] as { number: string; customer: { name: string; vat?: string; fiscal?: string } }[],
		orders: [] as { id: string; supplier: { key: string; name: string; vat?: string } }[],
		appointments: [] as { id: string; client: { name: string } }[],
		sales: [] as { id: string; buyer: { name: string; vat?: string } }[],
		ddt: [] as { id: string; client: { name: string; vat?: string } }[],
	};
	const stores = {
		clients: { read: () => ({ cards: books.clients, broken: false }) },
		suppliers: { read: () => ({ cards: books.suppliers, broken: false }) },
		quotes: { read: () => ({ quotes: books.quotes, broken: false }) },
		orders: { read: () => ({ orders: books.orders, broken: false }) },
		appointments: { read: () => ({ appointments: books.appointments, broken: false }) },
		sales: { read: () => ({ invoices: books.sales, broken: false }) },
		ddt: { read: () => ({ ddts: books.ddt, broken: false }) },
	} as unknown as SubjectStores;
	return { books, stores };
}

/** A register tool: «list» reads, anything else runs `write`. */
const tool = (name: string, write: (args: Record<string, unknown>) => void): AnnieTool => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
	replaySafe: true,
	async execute(args) {
		if (args.op !== "list") write(args);
		return `fatto ${String(args.op)}`;
	},
});

const NAMES: Record<string, string> = { vendite: "Vendite", acquisti: "Acquisti" };

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "annie-subjects-"));
	const ledger = new SubjectLedger(dir);
	const board = new BoardStore(dir);
	const agent = (id: string, before: (books: ReturnType<typeof registers>["books"]) => void = () => {}) => {
		const { books, stores } = registers();
		before(books);
		const seam: SubjectSeam = { ledger, agent: id, stores, agentName: async (a) => NAMES[a] ?? a, cardShown: (c) => board.get(c) !== undefined };
		const tools = withSubjects(
			[
				tool("clients", (a) => {
					if (a.op === "remove") books.clients.splice(0, books.clients.length, ...books.clients.filter((c) => c.id !== a.id));
					else books.clients.push({ id: String(a.id), name: String(a.name), ...(typeof a.vat === "string" ? { vat: a.vat } : {}) });
				}),
				tool("orders", (a) => void books.orders.push({ id: String(a.id), supplier: { key: "k", name: String(a.name), ...(typeof a.vat === "string" ? { vat: a.vat } : {}) } })),
				tool("quotes", (a) => void books.quotes.push({ number: String(a.id), customer: { name: String(a.name) } })),
				tool("weather", () => {}),
			],
			seam,
		);
		const run = async (name: string, args: Record<string, unknown>, ctx = fresh()) => String(await (tools.find((t) => t.name === name) as AnnieTool).execute(args, ctx));
		return { books, stores, seam, tools, run };
	};
	return { dir, ledger, board, agent };
}

describe("il registro di chi segue cosa (ADR 0110)", () => {
	it("records the writes of two registers, warns the second agente with ids, kinds and the scheda only", async () => {
		const { dir, ledger, board, agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		// Reads leave the ledger alone.
		expect(await vendite.run("clients", { op: "list" })).toBe("fatto list");
		expect(await acquisti.run("orders", { op: "list" })).toBe("fatto list");

		expect(await vendite.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa S.r.l.", vat: "01234567890" })).toBe("fatto upsert");
		expect(await vendite.run("quotes", { op: "create", id: "2026-004", name: "Alfa srl" })).toBe("fatto create");
		const card = board.create({ title: "Offerta Alfa" }, { kind: "agent", id: "vendite" });
		const linkV = cardSubjects(vendite.seam);
		expect(await linkV.link(card, ["2026-004"])).toBe("");

		// Acquisti orders from the same company, spelled otherwise: same partita IVA.
		const said = await acquisti.run("orders", { op: "create", id: "OR-0003", name: "ALFA SPA", vat: "IT01234567890" });
		expect(said).toBe(`fatto create\n\nAttenzione, lo stesso cliente o fornitore lo segue anche un altro agente: Vendite ha già preventivo 2026-004 (scheda #${card.n}); Vendite ha già cliente CL-0001. Dillo alla persona prima di andare avanti.`);
		// Counts-only: no name, no partita IVA, in the warning or in the file.
		for (const text of [said, readFileSync(join(dir, "subjects.json"), "utf8")]) {
			expect(text).not.toMatch(/alfa/i);
			expect(text).not.toContain("01234567890");
		}

		// Vendite writing again about Alfa hears of Acquisti's order.
		expect(await vendite.run("clients", { op: "upsert", id: "CL-0002", name: "Alfa" })).toContain("Acquisti ha già ordine OR-0003.");
		// A client nobody else has: no warning.
		expect(await vendite.run("clients", { op: "upsert", id: "CL-0003", name: "Beta" })).toBe("fatto upsert");

		// Persisted: a new ledger on the same folder has the entries, with the agente, kind, scheda and when.
		const again = new SubjectLedger(dir).list();
		expect(again.map((e) => `${e.agent} ${e.kind} ${e.id}${e.card ? ` #${e.card.n}` : ""}`).sort()).toEqual(["acquisti ordine OR-0003", "vendite cliente CL-0001", "vendite cliente CL-0002", "vendite cliente CL-0003", `vendite preventivo 2026-004 #${card.n}`]);
		expect(again.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
		expect(ledger.list()).toHaveLength(5);
	});

	it("reads do not write, another agente's request is skipped, other tools are untouched", async () => {
		const { ledger, agent } = setup();
		const vendite = agent("vendite");
		await vendite.run("clients", { op: "list" });
		vendite.books.clients.push({ id: "CL-0001", name: "Alfa" });
		await vendite.run("clients", { op: "list" });
		expect(ledger.list()).toHaveLength(0);
		await vendite.run("clients", { op: "upsert", id: "CL-0002", name: "Beta" }, fresh({ origin: "agent", thread: { channel: AGENT_CHANNEL, threadId: "a1" } }));
		expect(ledger.list()).toHaveLength(0);
		expect(vendite.tools.find((t) => t.name === "weather")?.execute).toBe(vendite.tools.find((t) => t.name === "weather")?.execute);
		await vendite.run("clients", { op: "upsert", id: "CL-0003", name: "Gamma" });
		expect(ledger.list().map((e) => e.id)).toEqual(["CL-0001", "CL-0002", "CL-0003"]);
	});

	it("a record deleted, a scheda deleted, an agente deleted leave the ledger", async () => {
		const { ledger, board, agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		await vendite.run("clients", { op: "list" });
		await vendite.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa" });
		await vendite.run("clients", { op: "upsert", id: "CL-0002", name: "Beta" });
		await acquisti.run("orders", { op: "list" });
		await acquisti.run("orders", { op: "create", id: "OR-0001", name: "Alfa" });
		const card = board.create({ title: "Alfa" }, { kind: "agent", id: "vendite" });
		await cardSubjects(vendite.seam).link(card, ["CL-0001", "CL-0002"]);

		await vendite.run("clients", { op: "remove", id: "CL-0002" });
		expect(ledger.list().map((e) => e.id).sort()).toEqual(["CL-0001", "OR-0001"]);

		ledger.unlinkCard(card.id);
		expect(ledger.list().some((e) => e.card !== undefined)).toBe(false);

		ledger.forgetAgent("acquisti");
		expect(ledger.list().map((e) => `${e.agent} ${e.id}`)).toEqual(["vendite CL-0001"]);
		// Its next first reading is again without warning.
		acquisti.books.orders.push({ id: "OR-0002", supplier: { key: "k", name: "Alfa" } });
		expect(await acquisti.run("orders", { op: "create", id: "OR-0003", name: "Alfa" })).toBe("fatto create");
	});

	it("the board tools link a scheda to the agente's records and warn of the others", async () => {
		const { dir, ledger, board, agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		await acquisti.run("orders", { op: "list" });
		await acquisti.run("orders", { op: "create", id: "OR-0001", name: "Alfa" });
		vendite.books.quotes.push({ number: "2026-001", customer: { name: "Alfa srl" } });
		vendite.books.clients.push({ id: "CL-0009", name: "Delta" });
		const work = new BoardWork({ store: board, agentName: async (id) => NAMES[id], canChat: async () => true, isOwner: async () => false, owners: async () => [], personName: async () => undefined, openThread: async () => "t1", post: async () => {} });
		const tools = createBoardTools({ self: "vendite", store: board, work, agents: async () => [{ id: "vendite", name: "Vendite" }], personOf: () => "p_anna", subjects: cardSubjects(vendite.seam) });
		const run = async (name: string, args: Record<string, unknown>) => String(await (tools.find((t) => t.name === name) as AnnieTool).execute(args, fresh()));

		expect(await run("board_create", { title: "Offerta", subjects: ["2026-999"] })).toBe("Errore: nei tuoi registri non c'è 2026-999. Usa gli ID dei tuoi record (CL-0012, OR-0003...).");
		expect(board.list()).toHaveLength(0);
		const made = await run("board_create", { title: "Offerta", subjects: ["2026-001"] });
		expect(made).toBe("Scheda #1 creata in «Da fare». Collegata a 2026-001. Attenzione, lo stesso cliente o fornitore lo segue anche un altro agente: Acquisti ha già ordine OR-0001. Dillo alla persona prima di andare avanti.");
		const card = board.get("1");
		expect(ledger.list().find((e) => e.id === "2026-001")?.card).toEqual({ id: card?.id, n: 1 });

		expect(await run("board_update", { card: "1", subjects: ["CL-0009"] })).toBe("Scheda #1 collegata a CL-0009.");
		expect(ledger.list().filter((e) => e.card !== undefined).map((e) => e.id)).toEqual(["CL-0009"]);
		expect(await run("board_update", { card: "1", subjects: [] })).toBe("Scheda #1: non più collegata ai tuoi record.");
		expect(ledger.list().some((e) => e.card !== undefined)).toBe(false);

		// Not its scheda: no linking.
		const other = board.create({ title: "Altro" }, { kind: "person", id: "p_anna" });
		expect(await run("board_update", { card: String(other.n), subjects: ["CL-0009"] })).toMatch(/^Errore: la scheda #2 non è tua/);
		expect(readFileSync(join(dir, "subjects.json"), "utf8")).not.toMatch(/alfa|delta/i);
	});

	it("keys are hashes of partita IVA, codice fiscale and name without legal form; the text says at most five", () => {
		expect(partyKeys({ name: "Alfa S.r.l.", vat: "01234567890" })).toEqual(partyKeys({ name: "alfa srl", vat: "IT 01234567890" }));
		expect(partyKeys({ name: "Alfa", cf: "01234567890" })[0]).toBe(partyKeys({ vat: "IT01234567890" })[0]);
		expect(partyKeys({ name: "Alfa" }).every((k) => /^[0-9a-f]{16}$/.test(k))).toBe(true);
		const entries = Array.from({ length: 7 }, (_, i) => ({ agent: "acquisti", register: "orders" as const, id: `OR-000${i}`, kind: "ordine", keys: [], f: "", at: "" }));
		expect(overlapText(entries, (id) => NAMES[id] ?? id)).toMatch(/Acquisti ha già ordine OR-0004, e altri 2\. Dillo/);
		expect(overlapText([], () => "")).toBe("");
	});

	it("what the registers had before goes in at start, without warning; the next write warns", async () => {
		const { ledger, agent } = setup();
		agent("vendite", (b) => void b.clients.push({ id: "CL-0001", name: "Alfa" }));
		const acquisti = agent("acquisti", (b) => void b.orders.push({ id: "OR-0001", supplier: { key: "k", name: "Alfa srl" } }));
		expect(ledger.list().map((e) => `${e.agent} ${e.id}`).sort()).toEqual(["acquisti OR-0001", "vendite CL-0001"]);
		expect(await acquisti.run("orders", { op: "create", id: "OR-0002", name: "Alfa S.p.A." })).toContain("Vendite ha già cliente CL-0001.");
	});

	it("a register that does not read keeps its entries", () => {
		const { ledger, agent } = setup();
		const vendite = agent("vendite");
		vendite.books.clients.push({ id: "CL-0001", name: "Alfa" });
		syncAgent(vendite.seam);
		const broken = { ...vendite.stores, clients: { read: () => ({ cards: [], broken: true }) } } as unknown as SubjectStores;
		syncAgent({ ...vendite.seam, stores: broken });
		expect(ledger.list().map((e) => e.id)).toEqual(["CL-0001"]);
	});
});
