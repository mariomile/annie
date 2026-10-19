/**
 * Il magazzino: the stock of a small shop or an artisan. Each article (MG-0001, never given
 * twice) has a unit, an optional minimum level, code, place, category and pack (a scatola of 12),
 * and may be a voce of the listino (LS-0001): then a sales invoice issued with that voce unloads
 * it by itself. What there is comes only from the movements (MV-000001, append-only, never
 * edited): carichi, scarichi, rettifiche from a count, the storni of a credit note, the
 * corrections of a carico's cost, and the openings a closed year leaves. Kept per instance in
 * `stock.json` (stock-store.ts); the figures in stock-sums.ts.
 *
 * Choices, tested:
 * - Quantities are canonical decimal strings with at most 3 decimals (kg, m, l), read into bigint
 *   thousandths; money is euros to the fourth decimal for a unit cost, cents for a value. Never a float.
 * - The weighted average cost changes only on a carico (or the correction of one); a scarico, a
 *   rettifica and a storno go at the average and never change it.
 * - A count never edits a movement: the difference is a new rettifica.
 * - An article is found from the words said with their Italian endings off («cartuccia xl»,
 *   «cartucce», «rotoli di carta»), never by picking between two.
 * - Another agente gets only the articles' names and quantities (list, low): never a cost, a
 *   value, a supplier or a movement.
 */
import type { Marker } from "./marker.ts";
import { sameStems, spellingKey, stemsWithin } from "./name-keys.ts";
import { parseItemId, unitOf } from "./price-list.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";
import { realDate } from "./italian-calendar.ts";

export class StockError extends Error {
	override readonly name = "StockError";
}

export const STOCK_OPS = ["add_item", "receive", "receive_invoice", "unload", "count", "fix_cost", "status", "list", "low", "value", "movements", "remove_item", "close_year", "export"] as const;
export type StockOp = (typeof STOCK_OPS)[number];

export const STOCK_LIMITS = {
	items: 2000,
	moves: 20_000,
	/** The sales of movements folded by a closed year, kept as keys (an invoice line moved once, a credit note's cap). */
	archived: 200_000,
	/** The lines of invoices received loaded (each once), and the supplier codes learned for an article. */
	received: 200_000,
	codes: 5000,
	/** A supplier's units learned for an article («RS» is 1 risma). */
	units: 1000,
	/** A supplier's key (partita IVA first), a supplier's code and a line's description spelled out, as kept for a code learned. */
	supplierKey: 140,
	supplierCode: 60,
	supplierText: 300,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 500,
	/** The brief's alerts said, remembered so each crossing is said once: the oldest go first. */
	alerts: 2000,
	name: 120,
	unit: 10,
	code: 30,
	place: 60,
	category: 60,
	doc: 60,
	note: 200,
	/** The largest quantity of one article on hand, of a movement or of a minimum level; a rettifica spans twice it (from −max to max). */
	maxQuantity: 1_000_000_000,
	/** The largest unit cost, in euros. */
	maxCost: 1_000_000,
	/** Rows shown in one answer, before «e altri N». */
	shown: 40,
	fileBytes: 16 * 1024 * 1024,
} as const;

export const REASONS = ["vendita", "uso_interno", "reso", "scarto"] as const;
export type Reason = (typeof REASONS)[number];

export const REASON_WORDS: Readonly<Record<Reason, string>> = { vendita: "vendita", uso_interno: "uso interno", reso: "reso al fornitore", scarto: "scarto" };

/** A pack of the article: so many units in one («scatola» of 12 pezzi). */
export type Pack = { readonly unit: string; readonly size: string };

export type StockItem = Marker & {
	/** «MG-0001», never given again. */
	readonly id: string;
	readonly name: string;
	/** «pezzo», «kg», «m», «litro»…: folded to its singular when known. */
	readonly unit: string;
	/** Below this the article is sottoscorta: a canonical decimal, 3 decimals at most. */
	readonly min?: string;
	readonly code?: string;
	/** Where it is kept: one place only, a split across two is not kept. */
	readonly place?: string;
	readonly category?: string;
	readonly pack?: Pack;
	/** The voce of the listino it is (LS-0001): an invoice line with it unloads it. */
	readonly listino?: string;
	readonly callId?: string;
	readonly edited?: Marker;
	/** Taken off the list with nothing on hand: its movements stay. */
	readonly removed?: Marker;
};

/** Where a movement of a sale comes from: the invoice (or credit note) and its line; a storno says the invoice it corrects. */
export type SaleRef = { readonly invoice: string; readonly line: number; readonly number: string; readonly of?: string };

export type MoveKind = "carico" | "scarico" | "rettifica" | "storno" | "costo" | "apertura";

export type Movement = Marker & {
	/** «MV-000001», never given again; the order of the movements is the order of their numbers. */
	readonly id: string;
	readonly item: string;
	readonly kind: MoveKind;
	/**
	 * How much: positive; a rettifica's is signed (the counted less what there was, 0 when the count
	 * matched); an apertura's is what there was at the close, signed; a costo's is 0.
	 */
	readonly qty: string;
	readonly day: string;
	/**
	 * carico: the unit cost, euros to the fourth decimal; costo: the right one; apertura: the average
	 * at the close; scarico vendita: the average at the moment it went out (recorded from week 71 on;
	 * older ones have none). A vendita's cost is written only by stock-store.ts planSale, from this
	 * magazzino's own movements (never from a tool's arguments, an invoice or a file), and validMove
	 * takes it on no other scarico: the margins trust it as our own figure. It is a snapshot: a
	 * later costo correction does not change it.
	 */
	readonly cost?: string;
	/** costo: the carico it corrects (the last of the article), and the cost it had. */
	readonly fixes?: string;
	readonly was?: string;
	/** carico: the supplier, as found (with its partita IVA when known) or as said. */
	readonly supplier?: { readonly name: string; readonly vat?: string };
	/** carico: the document's reference (a DDT, an invoice number). */
	readonly doc?: string;
	/** scarico: why. */
	readonly reason?: Reason;
	/** rettifica: the quantity counted. */
	readonly counted?: string;
	/** scarico vendita or storno from an invoice issued. */
	readonly sale?: SaleRef;
	/** apertura: the movement it went in negativo with, and the one it went under its minimum with, when it still was at the close. */
	readonly negative?: string;
	readonly low?: string;
	readonly note?: string;
	readonly callId?: string;
};

/** A sale's movement folded by a closed year: its key (invoice#line), the article, how much, and (a storno) the invoice it corrected. */
export type SaleKey = {
	readonly k: string;
	readonly i: string;
	readonly q: string;
	readonly of?: string;
	/** The year of the invoice (or credit note): a key ten years older than a year closed is dropped. */
	readonly y?: number;
	/** A vendita's cost as its scarico recorded it (the margins' cost of goods sold), kept when the year closes. */
	readonly c?: string;
};

/** A line of an invoice received loaded into the magazzino (purchase-prices.ts lineKey: a digest of the invoice and the line), with the invoice's year: never loaded twice. */
export type ReceivedKey = { readonly k: string; readonly y: number };

/**
 * What a supplier writes for an article, learned when the person confirmed a line of theirs on
 * it: the supplier's key (partita IVA first), and the code (`c`) or the line's description spelled
 * out (`d`, name-keys.ts spelledOut), one of the two; the article.
 */
export type CodeMap = { readonly s: string; readonly c?: string; readonly d?: string; readonly i: string };

/** One code map's key: the supplier, and its code (case aside) or its description. */
export const codeMapKey = (c: Pick<CodeMap, "s" | "c" | "d">) => `${c.s}\u0000${c.c !== undefined ? `c:${c.c.toLowerCase()}` : `d:${c.d ?? ""}`}`;

/** A supplier's unit for an article, learned when the person said it: one `u` (the unit as kept, «rs») is `q` of the article's units; `c` the cost per unit of the last load under it. */
export type UnitMap = { readonly s: string; readonly u: string; readonly i: string; readonly q: string; readonly c?: string };

export const unitMapKey = (u: Pick<UnitMap, "s" | "u" | "i">) => `${u.s}\u0000${u.u}\u0000${u.i}`;

export function validReceivedKey(v: unknown): v is ReceivedKey {
	if (typeof v !== "object" || v === null) return false;
	const r = v as ReceivedKey;
	return Object.keys(r).every((k) => ["k", "y"].includes(k)) && typeof r.k === "string" && /^[0-9a-f]{24}#\d{1,4}$/.test(r.k) && Number.isInteger(r.y) && r.y >= 2000 && r.y <= 9999;
}

export function validCodeMap(v: unknown): v is CodeMap {
	if (typeof v !== "object" || v === null) return false;
	const c = v as CodeMap;
	if (!Object.keys(c).every((k) => ["s", "c", "d", "i"].includes(k)) || (c.c === undefined) === (c.d === undefined)) return false;
	return plain(c.s, STOCK_LIMITS.supplierKey) && (c.c === undefined || plain(c.c, STOCK_LIMITS.supplierCode)) && (c.d === undefined || plain(c.d, STOCK_LIMITS.supplierText)) && typeof c.i === "string" && STOCK_ID.test(c.i);
}

export function validUnitMap(v: unknown): v is UnitMap {
	if (typeof v !== "object" || v === null) return false;
	const u = v as UnitMap;
	return Object.keys(u).every((k) => ["s", "u", "i", "q", "c"].includes(k)) && plain(u.s, STOCK_LIMITS.supplierKey) && plain(u.u, STOCK_LIMITS.unit) && typeof u.i === "string" && STOCK_ID.test(u.i) && isQuantity(u.q) && Number(u.q) > 0 && (u.c === undefined || isCost(u.c));
}

/** A sottoscorta (or in negativo) said in the brief: the article, the crossing and the call that said it. */
export type LowClaim = { readonly item: string; readonly crossing: string; readonly call: string };

export const stockItemId = (n: number) => `MG-${String(n).padStart(4, "0")}`;
export const STOCK_ID = /^MG-(\d{4,6})$/;
export const moveId = (n: number) => `MV-${String(n).padStart(6, "0")}`;
export const MOVE_ID = /^MV-(\d{6,7})$/;
const LISTINO_ID = /^LS-\d{4,7}$/;
/** An invoice's draft id (BZ-0001), or a DDT's (DT-0001): what moves the magazzino as a sale. */
const DRAFT_ID = /^(?:BZ|DT)-\d{4,6}$/;

const QTY = /^\d{1,10}(?:\.\d{1,3})?$/;
const SIGNED_QTY = /^-?\d{1,10}(?:\.\d{1,3})?$/;
const COST = /^\d{1,7}(?:\.\d{1,4})?$/;

/** A canonical quantity: digits, at most 3 decimals, no trailing zeros, at most `max` (the size, signed or not). */
export function isQuantity(v: unknown, signed = false, max: number = STOCK_LIMITS.maxQuantity): v is string {
	if (typeof v !== "string" || !(signed ? SIGNED_QTY : QTY).test(v)) return false;
	if (/\.\d*0$/.test(v) || /^-?0\d/.test(v) || v === "-0") return false;
	return Math.abs(Number(v)) <= max;
}

export const isCost = (v: unknown): v is string => typeof v === "string" && COST.test(v) && !/\.\d*0$/.test(v) && !/^0\d/.test(v) && Number(v) <= STOCK_LIMITS.maxCost;

/** Units a person says that the listino does not fold: litri, metri, grammi…; and the abbreviations invoices write («NR», «RS», «CF»). Different units stay different. */
const MORE_UNITS: Readonly<Record<string, string>> = { litro: "litro", litri: "litro", l: "litro", lt: "litro", metro: "m", metri: "m", m: "m", mt: "m", ml: "ml", grammo: "g", grammi: "g", g: "g", gr: "g", chilo: "kg", chili: "kg", chilogrammi: "kg", kg: "kg", confezione: "confezione", confezioni: "confezione", conf: "confezione", scatola: "scatola", scatole: "scatola", rotolo: "rotolo", rotoli: "rotolo", paio: "paio", paia: "paio", mq: "mq", cartone: "cartone", cartoni: "cartone", pacco: "pacco", pacchi: "pacco", bancale: "bancale", bancali: "bancale", busta: "busta", buste: "busta", risma: "risma", risme: "risma", flacone: "flacone", flaconi: "flacone", bottiglia: "bottiglia", bottiglie: "bottiglia", nr: "pezzo", n: "pezzo", num: "pezzo", pzz: "pezzo", rs: "risma", cf: "confezione", cnf: "confezione", ct: "cartone", crt: "cartone", pk: "pacco", pac: "pacco", bt: "bottiglia", fl: "flacone", sc: "scatola" };

/** A unit as said, to the one kept: «pezzi» is «pezzo», «litri» is «litro», «metri» is «m». */
export function stockUnit(said: string): string {
	const folded = unitOf(said.trim().toLowerCase());
	return MORE_UNITS[folded] ?? folded;
}

/** The ops that only read, and the brief's low (compact), which only marks its alerts as said: they run in a brief's thread. */
const READ_OPS: readonly StockOp[] = ["status", "list", "low", "value", "movements"];

export function stockCallReads(args: Record<string, unknown>): boolean {
	return READ_OPS.some((o) => o === args.op);
}

/** What another agente may ask: the list and what is running low, as names and quantities; never the brief's line, a cost, a value, a supplier or a change. */
export function stockAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "list" || (args.op === "low" && args.compact !== true);
}

export type StockFound = { readonly item: StockItem; readonly respelled: boolean } | { readonly close: readonly StockItem[] } | "none";

/**
 * The article said, among `items`: by its id (MG-0001), its voce of the listino (LS-0001), its
 * code, or its own name (case, accents and punctuation aside); then, `respelled`, its name in
 * the other number of the same gender («cartuccia xl» for «Cartucce XL», never «colla» for
 * «Collo»), or the only article whose name holds every word said («cartucce»). A change asks
 * about a `respelled` one before writing. More than one is asked, never picked. `strict`: only the same name (an article said again, never another one).
 */
export function findStockItem(items: readonly StockItem[], said: string, strict = false): StockFound {
	const t = said.trim();
	const mg = /^\s*mg\s*-?\s*0*(\d{1,6})\s*$/i.exec(t);
	if (mg !== null) {
		const i = items.find((x) => x.id === stockItemId(Number(mg[1])));
		return i === undefined ? "none" : { item: i, respelled: false };
	}
	const ls = parseItemId(t);
	if (ls !== undefined) {
		const i = items.find((x) => x.listino === ls);
		return i === undefined ? "none" : { item: i, respelled: false };
	}
	const byCode = items.find((x) => x.code !== undefined && x.code.toLowerCase() === t.toLowerCase());
	if (byCode !== undefined) return { item: byCode, respelled: false };
	if (spellingKey(t) === "") return "none";
	const spelled = items.filter((x) => spellingKey(x.name) === spellingKey(t));
	if (spelled.length === 1) return { item: spelled[0] as StockItem, respelled: false };
	const same = items.filter((x) => sameStems(x.name, t));
	if (same.length === 1) return { item: same[0] as StockItem, respelled: true };
	if (same.length > 1) return { close: same };
	if (strict) return "none";
	const holding = items.filter((x) => stemsWithin(t, x.name));
	if (holding.length === 1) return { item: holding[0] as StockItem, respelled: true };
	return holding.length === 0 ? "none" : { close: holding };
}

const plain = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);
const optPlain = (v: unknown, max: number) => v === undefined || plain(v, max);

function validPack(v: unknown): v is Pack {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Pack;
	return Object.keys(p).every((k) => ["unit", "size"].includes(k)) && plain(p.unit, STOCK_LIMITS.unit) && isQuantity(p.size) && Number(p.size) > 0;
}

/** An article as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validItem(v: unknown): v is StockItem {
	if (!isMarker(v)) return false;
	const i = v as StockItem;
	for (const key of Object.keys(i)) if (!["id", "name", "unit", "min", "code", "place", "category", "pack", "listino", "callId", "edited", "removed", "by", "at"].includes(key)) return false;
	if (typeof i.id !== "string" || !STOCK_ID.test(i.id) || !plain(i.name, STOCK_LIMITS.name) || !plain(i.unit, STOCK_LIMITS.unit)) return false;
	if (i.min !== undefined && !isQuantity(i.min)) return false;
	if (i.pack !== undefined && (!validPack(i.pack) || i.pack.unit === i.unit)) return false;
	if (!optPlain(i.code, STOCK_LIMITS.code) || !optPlain(i.place, STOCK_LIMITS.place) || !optPlain(i.category, STOCK_LIMITS.category)) return false;
	if (i.listino !== undefined && (typeof i.listino !== "string" || !LISTINO_ID.test(i.listino))) return false;
	if (!optText(i.callId, 200)) return false;
	return (i.edited === undefined || isMarker(i.edited)) && (i.removed === undefined || isMarker(i.removed));
}

function validSale(v: unknown): v is SaleRef {
	if (typeof v !== "object" || v === null) return false;
	const s = v as SaleRef;
	if (!Object.keys(s).every((k) => ["invoice", "line", "number", "of"].includes(k))) return false;
	return typeof s.invoice === "string" && DRAFT_ID.test(s.invoice) && Number.isInteger(s.line) && s.line >= 1 && s.line <= 1000 && plain(s.number, 40) && (s.of === undefined || (typeof s.of === "string" && DRAFT_ID.test(s.of)));
}

const isMoveId = (v: unknown): v is string => typeof v === "string" && MOVE_ID.test(v);

/** A movement as stored: each kind with its own fields only. */
export function validMove(v: unknown): v is Movement {
	if (!isMarker(v)) return false;
	const m = v as Movement;
	const FIELDS = ["cost", "fixes", "was", "supplier", "doc", "reason", "counted", "sale", "negative", "low"];
	for (const key of Object.keys(m)) if (![...FIELDS, "id", "item", "kind", "qty", "day", "note", "callId", "by", "at"].includes(key)) return false;
	if (typeof m.id !== "string" || !MOVE_ID.test(m.id) || typeof m.item !== "string" || !STOCK_ID.test(m.item)) return false;
	if (typeof m.day !== "string" || !realDate(m.day) || !optPlain(m.note, STOCK_LIMITS.note) || !optText(m.callId, 200)) return false;
	const only = (allowed: readonly string[]) => FIELDS.every((k) => allowed.includes(k) || (m as Record<string, unknown>)[k] === undefined);
	switch (m.kind) {
		case "carico": {
			if (!isQuantity(m.qty) || Number(m.qty) <= 0 || !isCost(m.cost) || !only(["cost", "supplier", "doc"]) || !optPlain(m.doc, STOCK_LIMITS.doc)) return false;
			const s = m.supplier;
			return s === undefined || (typeof s === "object" && s !== null && Object.keys(s).every((k) => ["name", "vat"].includes(k)) && plain(s.name, STOCK_LIMITS.name) && optPlain(s.vat, 40));
		}
		case "scarico":
			return isQuantity(m.qty) && Number(m.qty) > 0 && REASONS.includes(m.reason as Reason) && only(["reason", "sale", "cost"]) && (m.sale === undefined || (validSale(m.sale) && m.reason === "vendita" && m.sale.of === undefined)) && (m.cost === undefined || (m.reason === "vendita" && isCost(m.cost)));
		case "rettifica":
			return isQuantity(m.qty, true, 2 * STOCK_LIMITS.maxQuantity) && isQuantity(m.counted) && only(["counted"]);
		case "storno":
			return isQuantity(m.qty) && Number(m.qty) > 0 && only(["sale"]) && validSale(m.sale) && m.sale.of !== undefined;
		case "costo":
			return m.qty === "0" && isCost(m.cost) && isCost(m.was) && isMoveId(m.fixes) && only(["cost", "fixes", "was"]);
		case "apertura":
			return isQuantity(m.qty, true) && (m.cost === undefined || isCost(m.cost)) && (m.negative === undefined || isMoveId(m.negative)) && (m.low === undefined || isMoveId(m.low) || (typeof m.low === "string" && STOCK_ID.test(m.low))) && only(["cost", "negative", "low"]);
		default:
			return false;
	}
}

export function validSaleKey(v: unknown): v is SaleKey {
	if (typeof v !== "object" || v === null) return false;
	const s = v as SaleKey;
	if (s.c !== undefined && (!isCost(s.c) || s.of !== undefined)) return false;
	return Object.keys(s).every((k) => ["k", "i", "q", "of", "y", "c"].includes(k)) && typeof s.k === "string" && /^(?:BZ|DT)-\d{4,6}#\d{1,4}$/.test(s.k) && typeof s.i === "string" && STOCK_ID.test(s.i) && isQuantity(s.q) && (s.of === undefined || (typeof s.of === "string" && DRAFT_ID.test(s.of))) && (s.y === undefined || (Number.isInteger(s.y) && s.y >= 2000 && s.y <= 9999));
}

export function validLowClaim(v: unknown): v is LowClaim {
	if (typeof v !== "object" || v === null) return false;
	const c = v as LowClaim;
	return Object.keys(c).every((k) => ["item", "crossing", "call"].includes(k)) && typeof c.item === "string" && STOCK_ID.test(c.item) && plain(c.crossing, 40) && isText(c.call, 200);
}

export const validStockCall = (v: unknown): boolean => isText(v, 200);
