/**
 * Preventivi: quotes the owner sends to customers, numbered per year (2026-012), with a revision
 * suffix when redone (2026-012-R1), a validity in days and a status the owner sets. Expired is not
 * stored: an open quote whose validity has passed. Kept per instance in `quotes.json`
 * (quote-store.ts); the arithmetic is in quote-sums.ts.
 */
import { addDays, realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { CASSA_KINDS, type Cassa, type CassaKind, type SumLine, type SumOptions, VAT_RATES, type VatRate } from "./quote-sums.ts";
import { fold } from "./text-match.ts";

export class QuoteError extends Error {
	override readonly name = "QuoteError";
}

export const QUOTE_LIMITS = {
	/** Quotes of one year, revisions included: past it, no new one that year. */
	perYear: 2000,
	/** The store file: past it, nothing more is written (a year is about 4 MB at the cap). */
	fileBytes: 16 * 1024 * 1024,
	lines: 50,
	revisions: 99,
	description: 300,
	unit: 20,
	name: 120,
	address: 200,
	email: 254,
	terms: 500,
	notes: 1000,
	vatNote: 200,
	delivery: 200,
	cassaLabel: 60,
	maxValidDays: 365,
	/** The largest unit price and quantity, so no total outgrows what a person can check. */
	maxPrice: 1_000_000_000,
	maxQuantity: 1_000_000,
} as const;

export const DEFAULT_VALID_DAYS = 30;

/** The note of a line at 0% for an owner in the regime forfettario. */
export const FORFETTARIO_NOTE = "operazione effettuata ai sensi dell'art. 1, commi 54-89, L. 190/2014 (regime forfettario), senza applicazione dell'IVA";

/** The quote tool's ops that only read: they run in a brief's thread and for another agente. */
export const QUOTE_READ_OPS = ["list", "show"] as const;

export function quoteCallReads(args: Record<string, unknown>): boolean {
	return QUOTE_READ_OPS.some((o) => o === args.op);
}

export type QuoteStatus = "open" | "accepted" | "declined" | "superseded";

export type QuoteCustomer = { readonly name: string; readonly vat?: string; readonly fiscal?: string; readonly address?: string; readonly email?: string };

export type QuoteLine = SumLine & { readonly description: string; readonly unit?: string; readonly vatNote?: string };

export type Quote = Marker & {
	/** «2026-012», or «2026-012-R1» for a revision. */
	readonly number: string;
	/** The first version's number: what every revision shares. */
	readonly base: string;
	readonly revision: number;
	/** ISO day it was made, and how many days it stays valid. */
	readonly date: string;
	readonly validDays: number;
	readonly customer: QuoteCustomer;
	readonly lines: readonly QuoteLine[];
	/** Unit prices as the person said them, with VAT included. */
	readonly pricesIncludeVat?: true;
	readonly cassa?: Cassa;
	readonly ritenuta?: true;
	readonly bollo?: true;
	/** Acconto at acceptance, in percent of what the customer pays. */
	readonly deposit?: string;
	readonly delivery?: string;
	readonly terms?: string;
	readonly notes?: string;
	readonly status: QuoteStatus;
	/** Who set the status, and when. */
	readonly statusMark?: Marker;
	/** For a superseded quote: the revision that replaced it, and the status it had (given back if that revision is dropped). */
	readonly replacedBy?: string;
	readonly before?: { readonly status: Exclude<QuoteStatus, "superseded">; readonly mark?: Marker };
	/** The document in the workspace. */
	readonly file?: string;
	/** The tool call that made it: a call run again after a crash finds it instead of making another. */
	readonly callId?: string;
};

/** «2026-012»: the year and its progressive number, three digits at least. */
export function quoteNumber(year: number, n: number): string {
	return `${year}-${String(n).padStart(3, "0")}`;
}

export function revisionNumber(base: string, revision: number): string {
	return revision === 0 ? base : `${base}-R${revision}`;
}

/** The year and progressive of a quote, for ordering. */
export function baseOrder(quote: Pick<Quote, "base">): [number, number] {
	const [year, seq] = quote.base.split("-");
	return [Number(year), Number(seq)];
}

/** The last day a quote is valid. */
export function validUntil(quote: Pick<Quote, "date" | "validDays">): string {
	return addDays(quote.date, quote.validDays);
}

/** What a person reads: open, accepted, declined, replaced, or expired when open past its validity. */
export type ShownStatus = QuoteStatus | "expired";

export function shownStatus(quote: Quote, today: string): ShownStatus {
	return quote.status === "open" && today > validUntil(quote) ? "expired" : quote.status;
}

export const STATUS_WORDS: Readonly<Record<ShownStatus, string>> = { open: "aperto", accepted: "accettato", declined: "rifiutato", superseded: "sostituito", expired: "scaduto" };

/** The latest revision of every quote. */
export function latest(quotes: readonly Quote[]): Quote[] {
	const byBase = new Map<string, Quote>();
	for (const q of quotes) {
		const seen = byBase.get(q.base);
		if (seen === undefined || q.revision > seen.revision) byBase.set(q.base, q);
	}
	return [...byBase.values()];
}

const SAID_PREFIX = /^(?:preventivo\s*)?(?:n(?:r|um(?:ero)?)?\.?\s*)?/i;
const REVISION_SUFFIX = /-R\d+$/;
const SAID_NUMBER = /^(?:(\d{4})[-/ ])?0*(\d{1,6})(?:[-/ ](\d{4}))?$/;

/**
 * The quotes a person's words name: a revision by its full number («2026-012-R1»), or the
 * progressive with or without the year («12», «2026-12», «12/2026», «n. 12»): its latest revision.
 * More than one when the progressive is in several years.
 */
export function findQuotes(quotes: readonly Quote[], text: string): Quote[] {
	const said = text.trim().replace(SAID_PREFIX, "").trim().toUpperCase();
	// A revision named with its suffix is that version; a number without it means the latest one.
	if (REVISION_SUFFIX.test(said)) return quotes.filter((q) => q.number === said);
	const m = SAID_NUMBER.exec(said);
	if (m === null) return [];
	const year = m[1] ?? m[3];
	const n = Number(m[2]);
	return latest(quotes).filter((q) => {
		const [y, seq] = baseOrder(q);
		return seq === n && (year === undefined || y === Number(year));
	});
}

/** A customer's name compared without case, accents, spaces and punctuation: «Rossi S.r.l.» is «Rossi Srl». */
export function customerKey(name: string): string {
	return fold(name).replace(/[^a-z0-9]+/g, "");
}

/** Words of a customer's name, matched at the start of its words, without case and accents. */
export function matchesCustomer(quote: Quote, words: string): boolean {
	const name = ` ${fold(quote.customer.name).replace(/[^a-z0-9]+/g, " ")}`;
	return fold(words)
		.split(/[^a-z0-9]+/)
		.filter((w) => w !== "")
		.every((w) => name.includes(` ${w}`));
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const QUANTITY = /^\d{1,12}(?:\.\d{1,3})?$/;
const PRICE = /^\d{1,12}(?:\.\d{1,4})?$/;
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
const BASE = /^\d{4}-\d{3,6}$/;
const REVISION = /^\d{4}-\d{3,6}-R\d{1,2}$/;
const FILE = /^preventivi\/[A-Za-z0-9-]{1,120}\.(?:pdf|docx)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v);
const optText = (v: unknown, max: number) => v === undefined || isText(v, max);
const isMarker = (v: unknown): v is Marker => typeof v === "object" && v !== null && isText((v as Marker).by, 200) && isText((v as Marker).at, 40);
const percent = (v: unknown, below100: boolean) => typeof v === "string" && PERCENT.test(v) && Number(v) > 0 && (below100 ? Number(v) < 100 : Number(v) <= 100);

function validLine(v: unknown): boolean {
	if (typeof v !== "object" || v === null) return false;
	const l = v as QuoteLine;
	if (!isText(l.description, QUOTE_LIMITS.description) || !optText(l.unit, QUOTE_LIMITS.unit) || !optText(l.vatNote, QUOTE_LIMITS.vatNote)) return false;
	if (typeof l.quantity !== "string" || !QUANTITY.test(l.quantity) || Number(l.quantity) <= 0 || typeof l.price !== "string" || !PRICE.test(l.price) || Number(l.price) <= 0) return false;
	if (l.discount !== undefined && !percent(l.discount, true)) return false;
	if (!VAT_RATES.includes(l.vat as VatRate)) return false;
	return (l.vat === 0) === (l.vatNote !== undefined);
}

function validCustomer(v: unknown): boolean {
	if (typeof v !== "object" || v === null) return false;
	const c = v as QuoteCustomer;
	return isText(c.name, QUOTE_LIMITS.name) && optText(c.vat, 30) && optText(c.fiscal, 30) && optText(c.address, QUOTE_LIMITS.address) && optText(c.email, QUOTE_LIMITS.email);
}

function validCassa(v: unknown): boolean {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Cassa;
	return CASSA_KINDS.includes(c.kind as CassaKind) && percent(c.rate, true) && Number(c.rate) <= 10 && isText(c.label, QUOTE_LIMITS.cassaLabel);
}

const STATUSES: readonly QuoteStatus[] = ["open", "accepted", "declined", "superseded"];

/** A quote as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validQuote(v: unknown): v is Quote {
	if (!isMarker(v)) return false;
	const q = v as Quote;
	if (typeof q.base !== "string" || !BASE.test(q.base) || !Number.isInteger(q.revision) || q.revision < 0 || q.revision > QUOTE_LIMITS.revisions) return false;
	if (q.number !== revisionNumber(q.base, q.revision)) return false;
	if (typeof q.date !== "string" || !DAY.test(q.date) || !realDate(q.date) || !Number.isInteger(q.validDays) || q.validDays < 1 || q.validDays > QUOTE_LIMITS.maxValidDays) return false;
	if (!validCustomer(q.customer)) return false;
	if (!Array.isArray(q.lines) || q.lines.length === 0 || q.lines.length > QUOTE_LIMITS.lines || !q.lines.every(validLine)) return false;
	for (const flag of [q.ritenuta, q.bollo, q.pricesIncludeVat]) if (flag !== undefined && flag !== true) return false;
	if (q.cassa !== undefined && (!validCassa(q.cassa) || q.pricesIncludeVat === true)) return false;
	if (q.deposit !== undefined && !percent(q.deposit, true)) return false;
	if (!optText(q.terms, QUOTE_LIMITS.terms) || !optText(q.notes, QUOTE_LIMITS.notes) || !optText(q.delivery, QUOTE_LIMITS.delivery) || !optText(q.callId, 200)) return false;
	if (q.file !== undefined && (typeof q.file !== "string" || !FILE.test(q.file))) return false;
	if (!STATUSES.includes(q.status)) return false;
	if (q.statusMark !== undefined && !isMarker(q.statusMark)) return false;
	if (q.status !== "superseded") return q.replacedBy === undefined && q.before === undefined;
	if (typeof q.replacedBy !== "string" || !REVISION.test(q.replacedBy) || !q.replacedBy.startsWith(`${q.base}-R`)) return false;
	const b = q.before;
	return b === undefined || (typeof b === "object" && b !== null && STATUSES.includes(b.status) && (b.status as QuoteStatus) !== "superseded" && (b.mark === undefined || isMarker(b.mark)));
}
