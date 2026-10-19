/**
 * I DDT in uscita (documenti di trasporto): the goods the person ships to a client, line by line
 * (a voce of the listino, or free text) with quantity and unit, no prices. A DDT is a draft (DT-0001,
 * never given twice) until the person issues it: then it takes its number of the year («12/2026»,
 * or «12» as the person chose), never given again. An issued DDT is never deleted: it can only be
 * annulled, and keeps its number. Kept per instance in `ddt.json` (ddt-store.ts); the fattura
 * differita that bills them in sales-ddt.ts.
 *
 * Choices, tested:
 * - Quantities are canonical decimals (stock.ts isQuantity): never a float.
 * - The causale says what moves the magazzino at issue: vendita, omaggio and conto visione unload
 *   the lines with a voce that is an article (once per DDT and line, stock-store.ts sale); a reso
 *   names the DDT the goods come back from and puts them back as a storno of it; the others
 *   (riparazione, comodato, lavorazione) move nothing.
 * - A vendita DDT is billed by a fattura differita (TD24), and a conto visione one when the client
 *   keeps the goods (the person says so in the differita); marked billed when that invoice is
 *   issued, never by a draft. A reso of a DDT not billed yet is taken off its lines in the differita.
 * - A reso may come with the client's own DDT (`theirs`, its number and date): recorded as it is,
 *   it takes no number of ours.
 * - Another agente gets counts only: never a client, a line or a number.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { isQuantity } from "./stock.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export class DdtError extends Error {
	override readonly name = "DdtError";
}

export const DDT_OPS = ["create", "change", "issue", "cancel", "list", "status", "document", "export", "settings"] as const;
export type DdtOp = (typeof DDT_OPS)[number];

export const DDT_LIMITS = {
	ddts: 20_000,
	lines: 200,
	perYear: 99_999,
	calls: 500,
	alerts: 1000,
	name: 200,
	description: 300,
	unit: 20,
	destination: 300,
	carrier: 120,
	aspect: 80,
	notes: 500,
	packages: 99_999,
	/** Kilograms. */
	maxWeight: 1_000_000,
	maxQuantity: 1_000_000,
	file: 300,
	/** Rows shown in one answer, before «e altri N». */
	shown: 30,
	/** A draft older than these days is said in the brief. */
	staleDays: 7,
	/** The fattura differita is issued by this day of the month after the DDTs; the brief warns after `warnDay`. */
	dueDay: 15,
	warnDay: 10,
	fileBytes: 16 * 1024 * 1024,
} as const;

export const CAUSALI = ["vendita", "conto_visione", "reso", "riparazione", "omaggio", "comodato", "lavorazione"] as const;
export type Causale = (typeof CAUSALI)[number];

export const CAUSALE_WORDS: Readonly<Record<Causale, string>> = {
	vendita: "vendita",
	conto_visione: "conto visione",
	reso: "reso",
	riparazione: "riparazione",
	omaggio: "omaggio",
	comodato: "comodato d'uso",
	lavorazione: "conto lavorazione",
};

/** The causali whose goods leave the magazzino at issue. */
export const UNLOADING: readonly Causale[] = ["vendita", "omaggio", "conto_visione"];

export const TRANSPORTS = ["mittente", "destinatario", "vettore"] as const;
export type TransportBy = (typeof TRANSPORTS)[number];

export const TRANSPORT_WORDS: Readonly<Record<TransportBy, string>> = { mittente: "a cura del mittente", destinatario: "a cura del destinatario", vettore: "a cura del vettore" };

export type Transport = { readonly by: TransportBy; readonly carrier?: string };

/** The client, as found (its card, its tax ids) or as said; the address the card or the last invoice had. */
export type DdtClient = { readonly name: string; readonly vat?: string; readonly cf?: string; readonly card?: string; readonly address?: string };

/** One line: a voce of the listino (LS-0001) or free text, how many, in which unit. */
export type DdtLine = { readonly n: number; readonly description: string; readonly qty: string; readonly unit?: string; readonly item?: string };

/** The fattura differita that billed a DDT: its draft id, its number, its date. */
export type DdtBilled = { readonly invoice: string; readonly number: string; readonly day: string };

export const DDT_STATUSES = ["draft", "issued", "cancelled"] as const;
export type DdtStatus = (typeof DDT_STATUSES)[number];

export type Ddt = Marker & {
	/** «DT-0001», never used again. */
	readonly id: string;
	readonly status: DdtStatus;
	/** The day it was made; issued, the day of the DDT. */
	readonly day: string;
	readonly client: DdtClient;
	/** Where the goods go, when not the client's address. */
	readonly destination?: string;
	readonly causale: Causale;
	/** Who carries the goods: needed at issue. */
	readonly transport?: Transport;
	readonly aspect?: string;
	readonly packages?: number;
	/** Kilograms, a canonical decimal. */
	readonly weight?: string;
	readonly notes?: string;
	/** A reso: the DDT (its id) the goods come back from. */
	readonly of?: string;
	/** A reso that came with the client's own DDT: its number and date (recorded, never numbered by us). */
	readonly theirs?: TheirDdt;
	readonly lines: readonly DdtLine[];
	readonly callId: string;
	readonly edited?: Marker;
	// Set when issued.
	readonly number?: string;
	readonly year?: number;
	readonly seq?: number;
	readonly issued?: Marker;
	readonly issueCall?: string;
	/** The magazzino moved (or nothing to move): the issue is complete. */
	readonly stocked?: true;
	readonly cancelled?: Marker;
	/** Annulled after it moved the magazzino: whether the person said the goods left anyway, and the call that annulled it (a rerun puts the goods back all the same). */
	readonly left?: boolean;
	readonly cancelCall?: string;
	readonly billed?: DdtBilled;
	readonly file?: string;
};

/** The client's own DDT a reso came with. */
export type TheirDdt = { readonly number: string; readonly date: string };

export type IssuedDdt = Ddt & { readonly number: string; readonly year: number; readonly seq: number; readonly issued: Marker };

/** Issued with a number of ours. */
export const isIssuedDdt = (d: Ddt): d is IssuedDdt => d.number !== undefined;

/** A reso recorded with the client's own DDT (no number of ours). */
export const isRecordedReso = (d: Ddt): d is Ddt & { readonly theirs: TheirDdt; readonly issued: Marker } => d.theirs !== undefined && d.issued !== undefined;

/** «12/2026» (the default) or «12», as the person chose once. */
export type DdtNumbering = "plain" | "year";

export function ddtNumber(year: number, seq: number, numbering: DdtNumbering | undefined): string {
	return numbering === "plain" ? String(seq) : `${seq}/${year}`;
}

export type DdtSettings = Marker & { readonly numbering?: DdtNumbering; readonly lastBefore?: Readonly<Record<string, number>> };

/** What the brief said: a key (the month of unbilled DDTs «unbilled:2026-09», or «stale»), the day, the call. */
export type DdtClaim = { readonly k: string; readonly day: string; readonly call: string };

export const DDT_ID = /^DT-(\d{4,6})$/;
export const ddtId = (n: number) => `DT-${String(n).padStart(4, "0")}`;
export const LISTINO_ID = /^LS-\d{4,7}$/;

/** The month after a day's: «2026-11» for any day of October 2026. */
export function nextMonth(day: string): string {
	const y = Number(day.slice(0, 4));
	const m = Number(day.slice(5, 7));
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The last day a fattura differita of DDTs of `day`'s month may be issued: the 15th of the month after. */
export const dueDayOf = (day: string): string => `${nextMonth(day)}-${String(DDT_LIMITS.dueDay).padStart(2, "0")}`;

/** The ops that only read, and the brief's list (compact), which only marks what it said: they run in a brief's thread. */
const READ_OPS: readonly DdtOp[] = ["list", "status"];

export function ddtCallReads(args: Record<string, unknown>): boolean {
	return READ_OPS.some((o) => o === args.op);
}

const plain = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);
const optPlain = (v: unknown, max: number) => v === undefined || plain(v, max);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v);

function validClient(v: unknown): v is DdtClient {
	if (typeof v !== "object" || v === null) return false;
	const c = v as DdtClient;
	return Object.keys(c).every((k) => ["name", "vat", "cf", "card", "address"].includes(k)) && plain(c.name, DDT_LIMITS.name) && optPlain(c.vat, 40) && optPlain(c.cf, 20) && (c.card === undefined || (typeof c.card === "string" && /^CL-\d{4,6}$/.test(c.card))) && optPlain(c.address, DDT_LIMITS.destination);
}

function validLine(v: unknown): v is DdtLine {
	if (typeof v !== "object" || v === null) return false;
	const l = v as DdtLine;
	if (!Object.keys(l).every((k) => ["n", "description", "qty", "unit", "item"].includes(k))) return false;
	return Number.isInteger(l.n) && l.n >= 1 && l.n <= 9999 && plain(l.description, DDT_LIMITS.description) && isQuantity(l.qty, false, DDT_LIMITS.maxQuantity) && Number(l.qty) > 0 && optPlain(l.unit, DDT_LIMITS.unit) && (l.item === undefined || (typeof l.item === "string" && LISTINO_ID.test(l.item)));
}

function validTransport(v: unknown): v is Transport {
	if (typeof v !== "object" || v === null) return false;
	const t = v as Transport;
	return Object.keys(t).every((k) => ["by", "carrier"].includes(k)) && (TRANSPORTS as readonly string[]).includes(t.by) && optPlain(t.carrier, DDT_LIMITS.carrier);
}

function validBilled(v: unknown): v is DdtBilled {
	if (typeof v !== "object" || v === null) return false;
	const b = v as DdtBilled;
	return Object.keys(b).every((k) => ["invoice", "number", "day"].includes(k)) && typeof b.invoice === "string" && /^BZ-\d{4,6}$/.test(b.invoice) && plain(b.number, 20) && isDay(b.day);
}

const FIELDS = ["id", "status", "day", "client", "destination", "causale", "transport", "aspect", "packages", "weight", "notes", "of", "theirs", "lines", "callId", "edited", "number", "year", "seq", "issued", "issueCall", "stocked", "cancelled", "left", "cancelCall", "billed", "file", "by", "at"];

/** A DDT as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validDdt(v: unknown): v is Ddt {
	if (!isMarker(v)) return false;
	const d = v as Ddt;
	if (!Object.keys(d).every((k) => FIELDS.includes(k))) return false;
	if (typeof d.id !== "string" || !DDT_ID.test(d.id) || !(DDT_STATUSES as readonly string[]).includes(d.status) || !isDay(d.day) || !validClient(d.client)) return false;
	if (!(CAUSALI as readonly string[]).includes(d.causale) || (d.transport !== undefined && !validTransport(d.transport))) return false;
	if (!optPlain(d.destination, DDT_LIMITS.destination) || !optPlain(d.aspect, DDT_LIMITS.aspect) || !optText(d.notes, DDT_LIMITS.notes)) return false;
	if (d.packages !== undefined && (!Number.isInteger(d.packages) || d.packages < 1 || d.packages > DDT_LIMITS.packages)) return false;
	if (d.weight !== undefined && (!isQuantity(d.weight, false, DDT_LIMITS.maxWeight) || Number(d.weight) <= 0)) return false;
	if (d.of !== undefined && (d.causale !== "reso" || typeof d.of !== "string" || !DDT_ID.test(d.of) || d.of === d.id)) return false;
	if (d.theirs !== undefined && (d.causale !== "reso" || typeof d.theirs !== "object" || d.theirs === null || !Object.keys(d.theirs).every((k) => k === "number" || k === "date") || !plain(d.theirs.number, 20) || !isDay(d.theirs.date))) return false;
	if (!Array.isArray(d.lines) || d.lines.length === 0 || d.lines.length > DDT_LIMITS.lines || !d.lines.every(validLine) || new Set(d.lines.map((l) => l.n)).size !== d.lines.length) return false;
	if (!isText(d.callId, 200) || !optText(d.issueCall, 200) || !optText(d.file, DDT_LIMITS.file)) return false;
	if (![d.edited, d.issued, d.cancelled].every((m) => m === undefined || isMarker(m))) return false;
	if (d.stocked !== undefined && d.stocked !== true) return false;
	const issued = d.number !== undefined;
	// A reso with the client's own DDT is recorded, never numbered by us.
	if (d.theirs !== undefined && issued) return false;
	const out = issued || (d.theirs !== undefined && d.issued !== undefined);
	if (out !== (d.issued !== undefined) || issued !== (d.year !== undefined) || issued !== (d.seq !== undefined)) return false;
	if (issued && (!plain(d.number, 20) || !Number.isInteger(d.year) || Number(d.day.slice(0, 4)) !== d.year || !Number.isInteger(d.seq) || (d.seq as number) < 1 || (d.seq as number) > DDT_LIMITS.perYear)) return false;
	if (d.status === "issued" && !out) return false;
	if ((d.status === "cancelled") !== (d.cancelled !== undefined)) return false;
	if (d.left !== undefined && (d.status !== "cancelled" || typeof d.left !== "boolean")) return false;
	if (d.cancelCall !== undefined && (d.status !== "cancelled" || !isText(d.cancelCall, 200))) return false;
	if (!out && (d.stocked !== undefined || d.issueCall !== undefined)) return false;
	if (d.billed !== undefined && (d.status !== "issued" || !BILLED.includes(d.causale) || !validBilled(d.billed))) return false;
	return true;
}

export function validDdtSettings(v: unknown): v is DdtSettings {
	if (!isMarker(v)) return false;
	const s = v as DdtSettings;
	if (!Object.keys(s).every((k) => ["numbering", "lastBefore", "by", "at"].includes(k))) return false;
	if (s.numbering !== undefined && s.numbering !== "plain" && s.numbering !== "year") return false;
	return s.lastBefore === undefined || (typeof s.lastBefore === "object" && s.lastBefore !== null && !Array.isArray(s.lastBefore) && Object.entries(s.lastBefore).every(([y, n]) => /^\d{4}$/.test(y) && Number.isInteger(n) && n >= 0 && n < DDT_LIMITS.perYear));
}

export function validDdtClaim(v: unknown): v is DdtClaim {
	if (typeof v !== "object" || v === null) return false;
	const c = v as DdtClaim;
	return Object.keys(c).every((k) => ["k", "day", "call"].includes(k)) && typeof c.k === "string" && /^(?:unbilled:\d{4}-\d{2}|stale)$/.test(c.k) && isDay(c.day) && isText(c.call, 200);
}

export const validDdtCall = (v: unknown): boolean => isText(v, 200);

/** The causali a fattura differita bills: a vendita, and a conto visione the client keeps. */
export const BILLED: readonly Causale[] = ["vendita", "conto_visione"];

/** A vendita or conto visione DDT issued and not annulled, not marked billed: the fattura differita may bill it. */
export const billable = (d: Ddt): d is IssuedDdt => d.status === "issued" && isIssuedDdt(d) && BILLED.includes(d.causale) && d.billed === undefined;
