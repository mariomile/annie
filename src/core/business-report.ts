/**
 * L'andamento dell'attività: how the business is going, from the registers that already exist and
 * never writing them: fatturato (the invoices issued, by their date), incassato (the money in, by
 * the day it was paid), spese (the expenses recorded and the supplier invoices paid, each payment
 * once), margine, the taxes to put aside (an estimate), what is left in the pocket (for the
 * ordinario only what is left after the IVA: IRPEF and contributions are not estimated), the hours, the
 * quotes, what is still to collect. No store of its own: the CSV goes to the workspace's `report/`.
 *
 * The figures in business-report-sums.ts, the taxes in business-report-taxes.ts, the comparisons
 * and the months in business-report-compare.ts, the ranking in business-report-top.ts; the tool in
 * tools/business-report-tools.ts.
 */
import type { MaybeTwin } from "./cashflow-sources.ts";
import { weekend } from "./italian-calendar.ts";
import type { Span } from "./periods.ts";

export const REPORT_OPS = ["summary", "compare", "trend", "top", "export"] as const;
export type ReportOp = (typeof REPORT_OPS)[number];

export const REPORT_LIMITS = {
	/** Months of a trend in the chat: by default, and at most. */
	trendMonths: 6,
	maxTrendMonths: 24,
	/** Clients and expense categories in a ranking. */
	topClients: 5,
	topCategories: 3,
	/** The biggest changes said in words before a comparison's table. */
	biggestChanges: 3,
	/** A custom span: at most this many days (a little over two years). */
	maxSpanDays: 800,
	/** Euros per hour only with at least this many minutes recorded in the span (10 hours): fewer say nothing. */
	perHourMinutes: 600,
} as const;

/**
 * The brief's line on the month just closed, said once: on the first weekday of the month (the
 * 1st, or the Monday after when it is a Saturday or a Sunday, so the 3rd at the latest). The
 * report never writes, so it cannot know whether a brief already said it; one day keeps it once.
 */
export const BRIEF_LAST_DAY = 3;

/** Whether `day` is the day the brief says the month just closed (see BRIEF_LAST_DAY). */
export function briefSpeaks(day: string): boolean {
	const n = Number(day.slice(8, 10));
	if (n > BRIEF_LAST_DAY || weekend(day)) return false;
	for (let d = 1; d < n; d++) if (!weekend(`${day.slice(0, 8)}${String(d).padStart(2, "0")}`)) return false;
	return true;
}

/** The ops that only read: everything but the export, which writes a file. They run in a brief's thread. */
const READ_OPS: readonly ReportOp[] = ["summary", "compare", "trend", "top"];

export function businessCallReads(args: Record<string, unknown>): boolean {
	return READ_OPS.some((o) => o === args.op);
}

/** What another agente may ask: numbers only (summary, trend), never a client's name nor a file. */
const AGENT_OPS: readonly ReportOp[] = ["summary", "trend"];

export function businessAgentReads(args: Record<string, unknown>): boolean {
	return AGENT_OPS.some((o) => o === args.op);
}

/** A span of whole days, both ends included: the periods' own. */
export type { Span };

/** What a span's figures say about the taxes: an estimate of the forfettario, the IVA of the ordinario, or why there is none. */
export type TaxPart =
	| { readonly kind: "forfettario"; readonly cents: bigint; readonly percent?: number }
	| { readonly kind: "iva"; readonly cents: bigint; readonly credit: boolean }
	| { readonly kind: "none"; readonly why: "no_regime" | "no_profile" | "unreadable_taxes" | "unreadable_vat" | "unreadable_invoices" };

/** The figures of one span; a part is undefined when the register it comes from does not read. */
export type Figures = {
	readonly span: Span;
	/** Imponibile of the invoices issued dated in the span, credit notes less. */
	readonly fatturato?: { readonly cents: bigint; readonly count: number; readonly credits: number };
	/** The money in: instalments paid in the span, IVA included, less the credit notes used. */
	readonly incassato?: bigint;
	/** The expenses dated in the span, and the supplier invoices paid in it that no expense stands for. */
	readonly spese?: { readonly cents: bigint; readonly expenses: number; readonly suppliers: number; readonly supplierCents: bigint; readonly twins: number; readonly maybe?: readonly MaybeTwin[] };
	/** Incassato less spese. */
	readonly margine?: bigint;
	readonly tasse?: TaxPart;
	/** Margine less the taxes, when they are estimated: in the pocket for the forfettario; for the ordinario only after the IVA (IRPEF and contributions not estimated). */
	readonly inTasca?: bigint;
	/** The hours recorded in the span; per hour: the fatturato over them, in cents. */
	readonly ore?: { readonly minutes: number; readonly perHour?: bigint };
	/** Quotes made in the span (their first version's date), and of those accepted and declined. */
	readonly preventivi?: { readonly made: number; readonly accepted: number; readonly declined: number };
};

/** What is still to collect today, credit notes taken off: all of it, and what is past due. */
export type Receivables = { readonly open: bigint; readonly overdue: bigint; readonly overdueCount: number };

/** The money figures a comparison and a trend look at, in the order they are said. */
export const MONEY_KEYS = ["fatturato", "incassato", "spese", "margine", "tasse", "inTasca"] as const;
export type MoneyKey = (typeof MONEY_KEYS)[number];

/** A money figure of `f`, undefined when it is not known. */
export function moneyOf(f: Figures, key: MoneyKey): bigint | undefined {
	switch (key) {
		case "fatturato":
			return f.fatturato?.cents;
		case "incassato":
			return f.incassato;
		case "spese":
			return f.spese?.cents;
		case "margine":
			return f.margine;
		case "tasse":
			return f.tasse === undefined || f.tasse.kind === "none" ? undefined : f.tasse.cents;
		case "inTasca":
			return f.inTasca;
	}
}
