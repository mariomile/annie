import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppointmentStore } from "./appointment-store.ts";
import { appointmentCallReads } from "./appointments.ts";
import type { ClientStore } from "./client-store.ts";
import { clientCallReads } from "./clients.ts";
import type { DdtStore } from "./ddt-store.ts";
import { ddtCallReads } from "./ddt.ts";
import type { AnnieTool, ToolResult } from "./engine.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { businessKey } from "./name-keys.ts";
import type { OrderStore } from "./order-store.ts";
import { orderCallReads } from "./orders.ts";
import type { QuoteStore } from "./quote-store.ts";
import { quoteCallReads } from "./quotes.ts";
import { recurringCallReads } from "./recurring-invoices.ts";
import type { SalesInvoiceStore } from "./sales-invoice-store.ts";
import { salesCallReads } from "./sales-invoices.ts";
import type { SupplierStore } from "./supplier-store.ts";
import { stockCallReads } from "./stock.ts";
import { supplierCallReads } from "./suppliers.ts";
import { timesheetCallReads } from "./timesheet.ts";
import { isAgentTurn } from "./turn-origin.ts";

/**
 * Il registro di chi segue cosa (ADR 0110): one per tenant, in `subjects.json`, next to the board.
 * The records stay in each agente's own registers; here only which agente has which record (its id
 * and kind), the scheda it is linked to, and when it was last touched. Two agenti handle the same
 * subject when their records are about the same client or supplier: the same partita IVA, codice
 * fiscale or name without legal form. Those keys are kept only as hashes, so the file holds no
 * name and no number of anybody (counts-only, ADR 0092).
 */
export const SUBJECT_REGISTERS = ["clients", "suppliers", "quotes", "orders", "appointments", "sales", "ddt"] as const;
export type SubjectRegister = (typeof SUBJECT_REGISTERS)[number];

/** How a record is said in a warning: «Vendite ha già preventivo 2026-004». */
export const SUBJECT_KIND: Readonly<Record<SubjectRegister, string>> = { clients: "cliente", suppliers: "fornitore", quotes: "preventivo", orders: "ordine", appointments: "appuntamento", sales: "fattura", ddt: "DDT" };

/** A record as a register has it now: its id, the hashed keys of its client or supplier, a fingerprint of its content. */
export type Subject = { readonly id: string; readonly keys: readonly string[]; readonly f: string };

export type SubjectEntry = {
	readonly agent: string;
	readonly register: SubjectRegister;
	/** The record's id in the agente's register: «CL-0012», «OR-0003», «2026-004». */
	readonly id: string;
	readonly kind: string;
	readonly keys: readonly string[];
	readonly f: string;
	/** Last created or changed. */
	readonly at: string;
	/** The scheda the agente linked it to. */
	readonly card?: { readonly id: string; readonly n: number };
};

type LedgerFile = {
	readonly entries: readonly SubjectEntry[];
	/** «agent/register» already read once: the first reading records without warning. */
	readonly synced: readonly string[];
};

const EMPTY: LedgerFile = { entries: [], synced: [] };

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The hashed keys of a client or supplier: partita IVA, codice fiscale, name without legal form. */
export function partyKeys(party: { readonly name?: string; readonly vat?: string; readonly cf?: string }): string[] {
	const keys: string[] = [];
	const vat = party.vat?.replace(/\s+/g, "").toUpperCase();
	if (vat !== undefined && vat !== "") keys.push(`iva:${/^\d{11}$/.test(vat) ? `IT${vat}` : vat}`);
	const cf = party.cf?.replace(/\s+/g, "").toUpperCase();
	// A company's codice fiscale is its partita IVA.
	if (cf !== undefined && cf !== "") keys.push(/^\d{11}$/.test(cf) ? `iva:IT${cf}` : `cf:${cf}`);
	const name = party.name === undefined ? "" : businessKey(party.name);
	if (name !== "") keys.push(`nome:${name}`);
	return [...new Set(keys)].map(hash);
}

const subject = (id: string, party: Parameters<typeof partyKeys>[0], record: unknown): Subject => ({ id, keys: partyKeys(party), f: hash(JSON.stringify(record)) });

/** The registers of one agente the ledger reads. */
export type SubjectStores = {
	readonly clients: Pick<ClientStore, "read">;
	readonly suppliers: Pick<SupplierStore, "read">;
	readonly quotes: Pick<QuoteStore, "read">;
	readonly orders: Pick<OrderStore, "read">;
	readonly appointments: Pick<AppointmentStore, "read">;
	readonly sales: Pick<SalesInvoiceStore, "read">;
	readonly ddt: Pick<DdtStore, "read">;
};

/** The records of each register as they are now; a register that does not read is left out, its entries kept. */
export function readSubjects(stores: SubjectStores): Partial<Record<SubjectRegister, Subject[]>> {
	const out: Partial<Record<SubjectRegister, Subject[]>> = {};
	const clients = stores.clients.read();
	if (!clients.broken) out.clients = clients.cards.map((c) => subject(c.id, c, c));
	const suppliers = stores.suppliers.read();
	if (!suppliers.broken) out.suppliers = suppliers.cards.map((c) => subject(c.id, c, c));
	const quotes = stores.quotes.read();
	if (!quotes.broken) out.quotes = quotes.quotes.map((q) => subject(q.number, { name: q.customer.name, ...(q.customer.vat === undefined ? {} : { vat: q.customer.vat }), ...(q.customer.fiscal === undefined ? {} : { cf: q.customer.fiscal }) }, q));
	const orders = stores.orders.read();
	if (!orders.broken) out.orders = orders.orders.map((o) => subject(o.id, o.supplier, o));
	const appointments = stores.appointments.read();
	if (!appointments.broken) out.appointments = appointments.appointments.map((a) => subject(a.id, a.client, a));
	const sales = stores.sales.read();
	if (!sales.broken) out.sales = sales.invoices.map((i) => subject(i.id, i.buyer, i));
	const ddt = stores.ddt.read();
	if (!ddt.broken) out.ddt = ddt.ddts.map((d) => subject(d.id, d.client, d));
	return out;
}

export class SubjectLedger {
	private readonly file: string;

	constructor(tenantDir: string) {
		this.file = join(tenantDir, "subjects.json");
	}

	list(): SubjectEntry[] {
		return [...readJsonFile<LedgerFile>(this.file, EMPTY).entries];
	}

	/**
	 * The agente's records of a register as they are now: new and changed ones are recorded with
	 * `now`, records gone (deleted) leave the ledger. Returns the ones created or changed, none the
	 * first time a register is read (what was already there is not news).
	 */
	sync(agent: string, register: SubjectRegister, subjects: readonly Subject[], now = new Date()): SubjectEntry[] {
		const at = now.toISOString();
		const tag = `${agent}/${register}`;
		const touched: SubjectEntry[] = [];
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			const first = !book.synced.includes(tag);
			const mine = (e: SubjectEntry) => e.agent === agent && e.register === register;
			const old = new Map(book.entries.filter(mine).map((e) => [e.id, e]));
			let changed = first || old.size !== subjects.length;
			const next = subjects.map((s): SubjectEntry => {
				const was = old.get(s.id);
				if (was !== undefined && was.f === s.f && was.keys.join() === s.keys.join()) return was;
				changed = true;
				const entry: SubjectEntry = { agent, register, id: s.id, kind: SUBJECT_KIND[register], keys: s.keys, f: s.f, at, ...(was?.card === undefined ? {} : { card: was.card }) };
				if (!first) touched.push(entry);
				return entry;
			});
			if (!changed) return book;
			return { entries: [...book.entries.filter((e) => !mine(e)), ...next], synced: first ? [...book.synced, tag] : book.synced };
		});
		return touched;
	}

	/**
	 * The scheda linked to these records of the agente (by id), and no longer to its others.
	 * Returns the entries linked and the ids the agente has no record for.
	 */
	link(agent: string, card: { readonly id: string; readonly n: number }, ids: readonly string[]): { linked: SubjectEntry[]; missing: string[] } {
		const wanted = new Set(ids.map((id) => id.trim()).filter((id) => id !== ""));
		const linked: SubjectEntry[] = [];
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			let changed = false;
			const entries = book.entries.map((e) => {
				if (e.agent !== agent) return e;
				if (wanted.has(e.id)) {
					const next = { ...e, card: { id: card.id, n: card.n } };
					linked.push(next);
					if (e.card?.id === card.id && e.card.n === card.n) return e;
					changed = true;
					return next;
				}
				if (e.card?.id !== card.id) return e;
				changed = true;
				const { card: _c, ...rest } = e;
				return rest;
			});
			return changed ? { ...book, entries } : book;
		});
		return { linked, missing: [...wanted].filter((id) => !linked.some((e) => e.id === id)) };
	}

	/** A scheda deleted: no record is linked to it any more. */
	unlinkCard(cardId: string): void {
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			if (!book.entries.some((e) => e.card?.id === cardId)) return book;
			return {
				...book,
				entries: book.entries.map((e) => {
					if (e.card?.id !== cardId) return e;
					const { card: _c, ...rest } = e;
					return rest;
				}),
			};
		});
	}

	/** An agente deleted: its records leave the ledger. */
	forgetAgent(agent: string): void {
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			if (!book.entries.some((e) => e.agent === agent) && !book.synced.some((t) => t.startsWith(`${agent}/`))) return book;
			return { entries: book.entries.filter((e) => e.agent !== agent), synced: book.synced.filter((t) => !t.startsWith(`${agent}/`)) };
		});
	}

	/** The records of other agenti about the same client or supplier as these, the most recent first. */
	overlaps(of: readonly SubjectEntry[]): SubjectEntry[] {
		if (of.length === 0) return [];
		const agents = new Set(of.map((e) => e.agent));
		const keys = new Set(of.flatMap((e) => e.keys));
		return this.list()
			.filter((e) => !agents.has(e.agent) && e.keys.some((k) => keys.has(k)))
			.sort((a, b) => b.at.localeCompare(a.at));
	}
}

/** The most other agenti's records a warning names. */
const SHOWN = 5;

/**
 * «Attenzione, lo segue anche un altro agente: Vendite ha già preventivo 2026-004 (scheda #12).»
 * Only agenti, kinds, record ids and scheda numbers: never a name or what a record holds.
 * `cardShown` says whether a linked scheda is still on the board. Empty when there is nothing.
 */
export function overlapText(overlaps: readonly SubjectEntry[], agentName: (id: string) => string, cardShown: (id: string) => boolean = () => true): string {
	if (overlaps.length === 0) return "";
	const lines = overlaps.slice(0, SHOWN).map((e) => `${agentName(e.agent)} ha già ${e.kind} ${e.id}${e.card !== undefined && cardShown(e.card.id) ? ` (scheda #${e.card.n})` : ""}`);
	const more = overlaps.length > SHOWN ? `, e altri ${overlaps.length - SHOWN}` : "";
	return `Attenzione, lo stesso cliente o fornitore lo segue anche un altro agente: ${lines.join("; ")}${more}. Dillo alla persona prima di andare avanti.`;
}

/**
 * The tools that write these registers, and whether a call of theirs only reads: the seven
 * registers' own, the timesheet (it makes quotes), the fatture ricorrenti (they make drafts) and
 * the magazzino (an invoice loaded marks an order).
 */
const READS: Readonly<Record<string, (args: Record<string, unknown>) => boolean>> = {
	clients: clientCallReads,
	suppliers: supplierCallReads,
	quotes: quoteCallReads,
	orders: orderCallReads,
	appointments: appointmentCallReads,
	sales_invoices: salesCallReads,
	ddt: ddtCallReads,
	timesheet: timesheetCallReads,
	recurring_invoices: recurringCallReads,
	stock: stockCallReads,
};

/** The agente's records read again after a write, its new and changed ones with what other agenti have on the same subjects. */
export type SubjectSeam = {
	readonly ledger: SubjectLedger;
	readonly agent: string;
	readonly stores: SubjectStores;
	readonly agentName: (id: string) => Promise<string>;
	readonly cardShown?: (id: string) => boolean;
};

/** Read the agente's registers into the ledger; the entries created or changed. */
export function syncAgent(seam: Pick<SubjectSeam, "ledger" | "agent" | "stores">, now = new Date()): SubjectEntry[] {
	const all = readSubjects(seam.stores);
	return SUBJECT_REGISTERS.flatMap((r) => {
		const subjects = all[r];
		return subjects === undefined ? [] : seam.ledger.sync(seam.agent, r, subjects, now);
	});
}

/** The warning for these entries of the agente, or "" when no other agente has the same subjects. */
export async function warningFor(seam: SubjectSeam, entries: readonly SubjectEntry[]): Promise<string> {
	const overlaps = seam.ledger.overlaps(entries);
	if (overlaps.length === 0) return "";
	const names = new Map(await Promise.all([...new Set(overlaps.map((e) => e.agent))].map(async (id) => [id, await seam.agentName(id)] as const)));
	return overlapText(overlaps, (id) => names.get(id) ?? id, seam.cardShown);
}

const append = (result: ToolResult, text: string): ToolResult => (text === "" ? result : typeof result === "string" ? `${result}\n\n${text}` : { ...result, text: `${result.text}\n\n${text}` });

/**
 * The register tools of an agente with the ledger's write hook: after a call that may have written
 * (not a read, not another agente's request, which may not write), the agente's records are read
 * into the ledger, and the result says which other agenti already have the same client or supplier.
 * A ledger that fails never fails the call: the register wrote already.
 */
export function withSubjects(tools: readonly AnnieTool[], seam: SubjectSeam, log: (message: string) => void = () => {}): AnnieTool[] {
	// What the registers have already goes in now, without warning: from here on every write is news.
	try {
		syncAgent(seam);
	} catch (error) {
		log(`annie: subjects of ${seam.agent} not read: ${error instanceof Error ? error.message : String(error)}`);
	}
	return tools.map((tool): AnnieTool => {
		const reads = READS[tool.name];
		if (reads === undefined) return tool;
		return {
			...tool,
			async execute(args, ctx) {
				const result = await tool.execute(args, ctx);
				if (isAgentTurn(ctx) || reads(args)) return result;
				try {
					return append(result, await warningFor(seam, syncAgent(seam)));
				} catch (error) {
					log(`annie: subjects of ${seam.agent} not recorded: ${error instanceof Error ? error.message : String(error)}`);
					return result;
				}
			},
		};
	});
}

/** The records of an agente a scheda is about, as the board tools take them: by their ids. */
export type CardSubjects = {
	/** The ids the agente has no record for. */
	readonly missing: (ids: readonly string[]) => string[];
	/** The scheda linked to these records, and no longer to the agente's others; the warning when other agenti have the same subjects, or "". */
	readonly link: (card: { readonly id: string; readonly n: number }, ids: readonly string[]) => Promise<string>;
};

export function cardSubjects(seam: SubjectSeam): CardSubjects {
	return {
		missing(ids) {
			syncAgent(seam);
			const have = new Set(seam.ledger.list().filter((e) => e.agent === seam.agent).map((e) => e.id));
			return ids.map((id) => id.trim()).filter((id) => id !== "" && !have.has(id));
		},
		async link(card, ids) {
			syncAgent(seam);
			return warningFor(seam, seam.ledger.link(seam.agent, card, ids).linked);
		},
	};
}
