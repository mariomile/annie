/**
 * L'estratto conto: the movements of the person's bank account read from the file the bank gives
 * (CSV, Excel, CAMT.053; bank-parse.ts), kept in `bank.json` (bank-store.ts) without repeating a
 * movement loaded twice, and explained one by one (bank-match.ts): an invoice collected or paid,
 * an expense already recorded, a renewal's charge, an F24, a transfer between the person's own
 * accounts or a withdrawal. Nothing of the other registers is written without the person's yes:
 * confirming marks an invoice paid on the bank's day through the scadenzario, records an expense
 * through the expenses, sets the cashflow's balance through its store.
 *
 * The file is never trusted: rows and cells are capped, control characters go, IBAN and card
 * numbers in the descriptions are masked before anything is kept (only an IBAN's last 4
 * characters stay), and every text from it is fenced as data in the answers.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { MAX_EUROS } from "./money-input.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export class BankError extends Error {
	override readonly name = "BankError";
}

export const BANK_LIMITS = {
	/** bank.json: past it, nothing more is written. */
	fileBytes: 16 * 1024 * 1024,
	/** A statement file read: larger ones are refused before reading. */
	importBytes: 5 * 1024 * 1024,
	/** Data rows read from one file: the rest is left out, and said. */
	rows: 5000,
	/** Characters of a cell read; of a description kept. */
	cell: 300,
	description: 200,
	/** Movements kept: past it the oldest by date go, with their matches. */
	movements: 20_000,
	/** Import records kept, the oldest go. */
	imports: 300,
	/** Match records kept (refused ones included). */
	matches: 40_000,
	/** Candidates an «ask» keeps. */
	candidates: 5,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 300,
	/** Movements one to_expense or confirm may write. */
	batch: 50,
	/** Rows a list shows. */
	listed: 40,
	fileName: 120,
	label: 200,
	/** The largest amount of a movement, in euros. */
	maxAmount: MAX_EUROS,
} as const;

/** The days after which the brief asks for the next statement. */
export const BRIEF_STALE_DAYS = 35;
/** An expense already recorded explains a movement within these days of its date. */
export const EXPENSE_DAYS = 5;
/** A renewal's charge, an F24 estimate: within these days. */
export const NEAR_DAYS = 7;
/** Two equal charges within these days: maybe charged twice. */
export const TWIN_DAYS = 7;

/** The ops that only read: they run in a brief's thread (brief.ts). */
const BANK_READ_OPS = ["summary", "list", "totals", "anomalies"] as const;

export function bankCallReads(args: Record<string, unknown>): boolean {
	return BANK_READ_OPS.some((o) => o === args.op);
}

/** What another agente may ask: the totals in and out per month, never a description. */
export function bankAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "totals";
}

/** One movement as kept: the bank's day, the signed amount, the masked description. */
export type BankMovement = {
	/** «B-000001». */
	readonly id: string;
	/** Of date, cents, the normalized masked description and the running balance (bank-parse.ts). */
	readonly hash: string;
	/** The n-th movement with the same hash in one file (two equal coffees of one day are two). */
	readonly seq: number;
	/** ISO day: the data contabile, else the operation's or the value date. */
	readonly date: string;
	readonly valueDate?: string;
	/** A canonical signed decimal of euros: «-42.5» out, «1220» in. */
	readonly amount: string;
	/** As the bank wrote it, masked, without control characters, at most BANK_LIMITS.description. */
	readonly description: string;
	/** The running balance after it, when the file says it. */
	readonly balance?: string;
	/** The last 4 characters of an IBAN written in the description, never more. */
	readonly ibanTail?: string;
	/** The IBAN in the description is one of the company's own (set in the scadenzario). */
	readonly own?: true;
	/** «I-0001»: the import that brought it first. */
	readonly importId: string;
};

/** One file loaded: its name, the period it covers and what it brought; the closing balance it states. */
export type BankImport = Marker & {
	readonly id: string;
	readonly file: string;
	readonly from: string;
	readonly to: string;
	readonly rows: number;
	readonly added: number;
	readonly duplicates: number;
	readonly closing?: { readonly amount: string; readonly date: string };
	/** The closing balance saved as the cashflow's balance, by whom and when. */
	readonly balanceSet?: Marker;
	readonly format: "csv" | "xlsx" | "camt";
	/** The call that loaded it: a call run again finds it. */
	readonly callId?: string;
};

export const MATCH_KINDS = ["invoice_in", "invoice_out", "expense", "renewal", "f24", "transfer", "withdrawal"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/**
 * auto: explained without asking (nothing written, or an invoice when the person enabled it);
 * proposed: waits for a yes; ask: several candidates, the person says which; confirmed; refused
 * (kept so the same target is not proposed again); hint: unexplained, with a guess to say.
 */
export const MATCH_STATES = ["auto", "proposed", "ask", "confirmed", "refused", "hint"] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/** What a movement may be: an invoice (its key and instalment), an expense, a renewal, or no target. */
export type MatchTarget = { readonly kind: MatchKind; readonly target?: string; readonly instalment?: number; readonly label: string };

export type BankMatch = Marker &
	Partial<MatchTarget> & {
		readonly movement: string;
		readonly state: MatchState;
		/** The amount and a name, a partita IVA or the number agree: an invoice's strong match. */
		readonly strong?: true;
		/** oldest: two invoices alike, the oldest proposed; partial: maybe part of the invoice in label. */
		readonly note?: "oldest" | "partial";
		readonly candidates?: readonly MatchTarget[];
		/** The expense recorded from it (to_expense). */
		readonly expense?: string;
	};

export type BankSettings = Marker & { readonly autoConfirm: boolean };

/** Whether a match explains its movement (a refused one or a hint does not). */
export const isLive = (m: Pick<BankMatch, "state">): boolean => m.state !== "refused" && m.state !== "hint";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED = /^-?\d{1,9}(?:\.\d{1,2})?$/;

export const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && realDate(v);
export const isSigned = (v: unknown): v is string => typeof v === "string" && SIGNED.test(v) && v !== "-0" && Math.abs(Number(v)) <= BANK_LIMITS.maxAmount;

export function validMovement(v: unknown): v is BankMovement {
	if (typeof v !== "object" || v === null) return false;
	const m = v as BankMovement;
	if (typeof m.id !== "string" || !/^B-\d{6,7}$/.test(m.id)) return false;
	if (typeof m.hash !== "string" || !/^[0-9a-f]{32}$/.test(m.hash) || !Number.isInteger(m.seq) || m.seq < 1 || m.seq > BANK_LIMITS.rows) return false;
	if (!isDay(m.date) || (m.valueDate !== undefined && !isDay(m.valueDate))) return false;
	if (!isSigned(m.amount) || Number(m.amount) === 0 || (m.balance !== undefined && !isSigned(m.balance))) return false;
	if (!isText(m.description, BANK_LIMITS.description) || m.description.includes("\n")) return false;
	if (m.ibanTail !== undefined && (typeof m.ibanTail !== "string" || !/^[A-Z0-9]{4}$/.test(m.ibanTail))) return false;
	if (m.own !== undefined && m.own !== true) return false;
	return typeof m.importId === "string" && /^I-\d{4,6}$/.test(m.importId);
}

export function validImport(v: unknown): v is BankImport {
	if (!isMarker(v)) return false;
	const i = v as BankImport;
	if (typeof i.id !== "string" || !/^I-\d{4,6}$/.test(i.id) || !isText(i.file, BANK_LIMITS.fileName) || !isDay(i.from) || !isDay(i.to) || i.from > i.to) return false;
	for (const n of [i.rows, i.added, i.duplicates]) if (!Number.isInteger(n) || n < 0 || n > BANK_LIMITS.rows) return false;
	if (i.closing !== undefined && (typeof i.closing !== "object" || i.closing === null || !isSigned(i.closing.amount) || !isDay(i.closing.date))) return false;
	if (i.balanceSet !== undefined && !isMarker(i.balanceSet)) return false;
	return (i.format === "csv" || i.format === "xlsx" || i.format === "camt") && optText(i.callId, 200);
}

function validTarget(v: unknown): v is MatchTarget {
	if (typeof v !== "object" || v === null) return false;
	const t = v as MatchTarget;
	return MATCH_KINDS.includes(t.kind) && optText(t.target, 300) && (t.instalment === undefined || (Number.isInteger(t.instalment) && t.instalment >= 1 && t.instalment <= 1000)) && isText(t.label, BANK_LIMITS.label);
}

export function validMatch(v: unknown): v is BankMatch {
	if (!isMarker(v)) return false;
	const m = v as BankMatch;
	if (typeof m.movement !== "string" || !/^B-\d{6,7}$/.test(m.movement) || !MATCH_STATES.includes(m.state)) return false;
	if (m.kind !== undefined && !validTarget(m)) return false;
	if (m.state !== "ask" && m.kind === undefined) return false;
	if (m.state === "ask" && !(Array.isArray(m.candidates) && m.candidates.length >= 2 && m.candidates.length <= BANK_LIMITS.candidates && m.candidates.every(validTarget))) return false;
	if (m.state !== "ask" && m.candidates !== undefined) return false;
	if (m.strong !== undefined && m.strong !== true) return false;
	if (m.note !== undefined && m.note !== "oldest" && m.note !== "partial") return false;
	return m.expense === undefined || (typeof m.expense === "string" && /^S-\d{4}-\d{4,6}$/.test(m.expense));
}

export function validSettings(v: unknown): v is BankSettings {
	return isMarker(v) && typeof (v as BankSettings).autoConfirm === "boolean";
}

export const validCall = (v: unknown): boolean => typeof v === "string" && isText(v, 200);

/** Cents of a canonical signed decimal. */
export function movementCents(amount: string): bigint {
	const negative = amount.startsWith("-");
	const [integer, fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
	const cents = BigInt(`${integer}${fraction.padEnd(2, "0")}`);
	return negative ? -cents : cents;
}

/** The canonical signed decimal of cents: -4250n → «-42.5». */
export function centsAmount(cents: bigint): string {
	const abs = cents < 0n ? -cents : cents;
	const digits = abs.toString().padStart(3, "0");
	const fraction = digits.slice(-2).replace(/0+$/, "");
	return `${cents < 0n ? "-" : ""}${digits.slice(0, -2)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** «B-000012». */
export const movementId = (n: number): string => `B-${String(n).padStart(6, "0")}`;
/** «I-0003». */
export const importId = (n: number): string => `I-${String(n).padStart(4, "0")}`;
