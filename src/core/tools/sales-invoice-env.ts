/**
 * What the ops of sales_invoices share: the stores and seams they read and write, the audit event,
 * the one way to ask for what is missing, the due date of an invoice, and how a draft or an
 * invoice is named (a draft id, or the only draft; an invoice by its number).
 */
import type { ClientStore } from "../client-store.ts";
import { dueDates } from "../dates.ts";
import type { ToolContext } from "../engine.ts";
import type { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import type { QuoteStore } from "../quote-store.ts";
import { CREDIT_NOTE_TYPE } from "../sales-invoice-rules.ts";
import type { SalesBook, SalesInvoiceStore } from "../sales-invoice-store.ts";
import { type IssuedInvoice, isIssued, type SalesInvoice } from "../sales-invoices.ts";
import type { TaxStore } from "../tax-store.ts";
import type { TimesheetStore } from "../timesheet-store.ts";
import type { Workspace } from "../workspace.ts";

/** What changed, for the audit: the op and how many, never customers, amounts, numbers or lines. */
export type SalesEvent = { readonly type: "sales_invoices.changed"; readonly op: "draft" | "credit_note" | "issue" | "remove" | "settings"; readonly count: number };

export type SalesEnv = {
	readonly workspace: Workspace;
	readonly store: SalesInvoiceStore;
	/** The company's data (invoices set_company): the seller, read only. */
	readonly company: Pick<InvoiceStore, "read">;
	/** The forfettario's profile: tells the regime when the company does not say it. */
	readonly taxes: Pick<TaxStore, "read">;
	readonly clients?: Pick<ClientStore, "read">;
	readonly quotes?: Pick<QuoteStore, "read" | "markInvoiced">;
	readonly timesheet?: Pick<TimesheetStore, "read" | "setBilled">;
	/** The workspace's invoices (the scadenzario's scanner): the numbers already used this year. */
	readonly scanner: Pick<InvoiceScanner, "scan">;
	readonly timeZone: string;
	readonly now: () => Date;
	readonly make: (input: MakeInput) => Promise<MadeDocument>;
	readonly marker: (ctx: ToolContext) => Marker;
	readonly audit: (ctx: ToolContext, op: SalesEvent["op"], count: number) => Promise<void>;
	/** The store as saved; SalesInvoiceError when it does not read. */
	readonly book: () => SalesBook;
};

/** What FatturaPA still needs, to ask the person in one go: never invented. */
export function askFor(missing: readonly string[], what = "la fattura", tail?: string): string {
	return [`Per ${what} mi servono ancora questi dati. Chiedili a chi ti scrive tutti insieme, non inventarli, poi rifai la richiesta con le sue risposte:`, ...missing.map((m) => `• ${m}`), ...(tail === undefined ? [] : [tail])].join("\n");
}

/** The due date an invoice dated `day` has with its payment terms. */
export function dueOf(inv: Pick<SalesInvoice, "payment" | "type">, day: string): string | undefined {
	if (inv.payment === undefined || inv.type === CREDIT_NOTE_TYPE) return undefined;
	return dueDates(day, [inv.payment.days], { endOfMonth: inv.payment.endOfMonth })[0]?.date;
}

const SAID_NUMBER = /^(?:n\.?\s*)?(?:(\d{4})\s*[/-]\s*)?(\d{1,5})(?:\s*[/-]\s*(\d{4}))?$/i;

/** The issued invoices a number names: «12», «2026/12», «12/2026», «n. 12»; newest year first. */
export function findIssued(invoices: readonly SalesInvoice[], said: string, type?: SalesInvoice["type"]): IssuedInvoice[] {
	const m = SAID_NUMBER.exec(said.trim());
	if (m === null) return [];
	const year = m[1] ?? m[3];
	const seq = Number(m[2]);
	return invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.seq === seq && (year === undefined || i.year === Number(year)) && (type === undefined || i.type === type)).sort((a, b) => b.year - a.year);
}

/**
 * The draft (or invoice) a draft id names, or the only draft when none is named; else what to say.
 * `verb`: what is to be done with it, for the answer («emettere», «togliere», «vedere»).
 */
export function namedDraft(invoices: readonly SalesInvoice[], said: unknown, verb: string): { readonly found: SalesInvoice } | { readonly answer: string } {
	if (typeof said === "string" && said.trim() !== "") {
		const id = said.trim().toUpperCase();
		const found = invoices.find((i) => i.id === id);
		return found === undefined ? { answer: `Errore: non c'è la bozza ${id}.` } : { found };
	}
	const drafts = invoices.filter((i) => !isIssued(i));
	if (drafts.length === 1) return { found: drafts[0] as SalesInvoice };
	return { answer: drafts.length === 0 ? `Non c'è nessuna bozza da ${verb}.` : `Errore: ci sono più bozze, dimmi quale ${verb}.` };
}
