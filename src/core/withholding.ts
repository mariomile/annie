/**
 * Le ritenute d'acconto and the Certificazione Unica of a professional in regime ordinario: what
 * the clients (sostituti d'imposta) withheld on the invoices they paid, read from the registers that
 * already have it (the fatture in uscita and the FatturaPA XML of the workspace) and never writing
 * them; whether a client paid the net or the gross; the CU the person received, kept in
 * `withholding.json` (withholding-store.ts), compared with Annie's figures. A forfettario's
 * invoices bear no ritenuta: nothing here applies to them.
 *
 * The rules with their sources in withholding-rules.ts, the documents in withholding-docs.ts, the
 * sums and comparisons in withholding-sums.ts; the tool in tools/withholding-tools.ts.
 */
import type { Marker } from "./marker.ts";
import { MAX_EUROS } from "./money-input.ts";
import { isMarker, isText } from "./stored-fields.ts";

export class WithholdingError extends Error {
	override readonly name = "WithholdingError";
}

export const WITHHOLDING_OPS = ["summary", "check_payment", "record_cu", "cu_remove", "cu_list", "export"] as const;
export type WithholdingOp = (typeof WITHHOLDING_OPS)[number];

export const WITHHOLDING_LIMITS = {
	/** withholding.json: past it, nothing more is written. */
	fileBytes: 1024 * 1024,
	/** CU kept: past it, no new one. */
	cus: 2000,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 500,
	/** A client's name as kept. */
	name: 120,
	/** Clients in a summary, invoices in a check or an explanation, before «e altri N». */
	listed: 10,
	explained: 5,
	/** Invoices tried together to explain a CU's difference: past it, only the list. */
	tried: 16,
	/** The largest amount of a CU, in euros. */
	maxEuros: MAX_EUROS,
} as const;

/** The ops that only read: they run in a brief's thread (brief.ts). A CU recorded or removed and the export write. */
const READ_OPS: readonly WithholdingOp[] = ["summary", "check_payment", "cu_list"];

export function withholdingCallReads(args: Record<string, unknown>): boolean {
	return READ_OPS.some((o) => o === args.op);
}

/** What another agente may ask: the year's totals, never a client's name, a CU or a file. */
export function withholdingAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "summary";
}

/** The client of a CU as the person said it, and how its invoices are grouped (invoices.ts partyKey). */
export type CuClient = { readonly name: string; readonly vat?: string; readonly cf?: string; readonly key: string };

/**
 * A CU received, as the person said it: the client, the year of the payments, the compensi lordi
 * and the ritenute certificate (canonical decimals of euros, «1250.5»). Its figures are the
 * person's data, never checked against the client.
 */
export type CuRecord = Marker & {
	/** «CU-0001», never used again. */
	readonly id: string;
	readonly client: CuClient;
	readonly year: number;
	readonly gross: string;
	readonly withheld: string;
	/** The call that recorded it: a call run again finds it. */
	readonly callId: string;
	/** Recorded again for the same client and year (a CU sostitutiva): when. */
	readonly replaced?: string;
};

export const cuId = (n: number): string => `CU-${String(n).padStart(4, "0")}`;
export const CU_ID = /^CU-(\d{4,6})$/;

const AMOUNT = /^\d{1,8}(?:\.\d{1,2})?$/;
const isAmount = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && Number(v) <= WITHHOLDING_LIMITS.maxEuros;

/** The first year a CU may be of, and the last: the year after today's is not over yet. */
export const FIRST_YEAR = 2000;

export function validCu(v: unknown): v is CuRecord {
	if (!isMarker(v)) return false;
	const c = v as CuRecord;
	if (typeof c.id !== "string" || !CU_ID.test(c.id)) return false;
	if (typeof c.client !== "object" || c.client === null || !isText(c.client.name, WITHHOLDING_LIMITS.name) || !isText(c.client.key, 200)) return false;
	if (c.client.vat !== undefined && !isText(c.client.vat, 20)) return false;
	if (c.client.cf !== undefined && !isText(c.client.cf, 20)) return false;
	if (!Number.isInteger(c.year) || c.year < FIRST_YEAR || c.year > 2200) return false;
	if (!isAmount(c.gross) || !isAmount(c.withheld)) return false;
	if (c.replaced !== undefined && !isText(c.replaced, 40)) return false;
	return isText(c.callId, 200);
}

export const validCall = (v: unknown): boolean => typeof v === "string" && isText(v, 200);
