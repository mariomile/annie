/**
 * Budget e obiettivi: the limits on spending and the income targets the person sets, followed
 * from the registers that already exist and never written there. A spending budget is on one
 * expense category, on one supplier (the suppliers' identity: partita IVA, codice fiscale, card,
 * else the name) or on everything spent; an income target is on the incassato or the fatturato,
 * both read the business report's way (business-report-sums.ts). Each is so much per month,
 * quarter or year, from an optional first day. Kept per instance in `budgets.json`
 * (budget-store.ts), with the brief's alerts already said; the figures in budget-sums.ts.
 */
import { CATEGORIES, type Category } from "./expenses.ts";
import type { Marker } from "./marker.ts";
import { isMarker, isText } from "./stored-fields.ts";
import { realDate } from "./italian-calendar.ts";

export class BudgetError extends Error {
	override readonly name = "BudgetError";
}

export const BUDGET_OPS = ["set", "remove", "status", "list", "export"] as const;
export type BudgetOp = (typeof BUDGET_OPS)[number];

export const BUDGET_LIMITS = {
	budgets: 100,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 500,
	/** Alerts said, remembered so each is said once: the oldest go first. */
	alerts: 2000,
	name: 120,
	/** The largest amount of a budget, in euros. */
	maxEuros: 10_000_000,
	fileBytes: 2 * 1024 * 1024,
} as const;

/** A spending budget is said in the brief at these shares of its amount, each once per period. */
export const ALERT_PERCENTS = [80, 100] as const;
/** An income target is behind when, in the last third of its period, the estimate at the end is under this share of it. */
export const BEHIND_PERCENT = 80;
/** No estimate before this share of the period is gone (3 days of a month, 9 of a quarter, 37 of a year): too few days say nothing. */
export const ESTIMATE_MIN_TENTHS = 1;

export const EVERY = ["month", "quarter", "year"] as const;
export type Every = (typeof EVERY)[number];

export const MEASURES = ["incassato", "fatturato"] as const;
export type Measure = (typeof MEASURES)[number];

/** What a budget is on. */
export type BudgetSubject =
	| { readonly kind: "category"; readonly category: Category }
	/** A supplier: the name as found, with the partita IVA, codice fiscale or card it is found again by. */
	| { readonly kind: "supplier"; readonly name: string; readonly vat?: string; readonly cf?: string; readonly card?: string }
	| { readonly kind: "all" }
	| { readonly kind: "income"; readonly measure: Measure };

export type Budget = Marker & {
	/** «BU-0001», never given again. */
	readonly id: string;
	readonly subject: BudgetSubject;
	/** Euros, a canonical decimal string («300», «1250.5»). */
	readonly amount: string;
	readonly every: Every;
	/** The first day it counts from: before it the budget has not started. */
	readonly start?: string;
	/** The call that set it last: a call run again finds it. */
	readonly callId?: string;
	readonly edited?: Marker;
};

/** An alert said in the brief: the budget, the period («2026-10», «2026-T4», «2026») and which. */
export type AlertLevel = "80" | "100" | "behind";
export type AlertClaim = { readonly budget: string; readonly period: string; readonly level: AlertLevel; readonly call: string };

export const budgetId = (n: number) => `BU-${String(n).padStart(4, "0")}`;
export const BUDGET_ID = /^BU-(\d{4,6})$/;

export const isIncome = (s: BudgetSubject): boolean => s.kind === "income";

/** Two budgets are the same target when they are on the same thing for the same kind of period: setting it again replaces it. */
export function subjectKey(s: BudgetSubject): string {
	switch (s.kind) {
		case "category":
			return `category:${s.category}`;
		case "supplier":
			return s.vat !== undefined ? `supplier:vat:${s.vat}` : s.cf !== undefined ? `supplier:cf:${s.cf}` : s.card !== undefined ? `supplier:card:${s.card}` : `supplier:name:${s.name.toLowerCase()}`;
		case "all":
			return "all";
		case "income":
			return `income:${s.measure}`;
	}
}

export const sameTarget = (a: Pick<Budget, "subject" | "every">, b: Pick<Budget, "subject" | "every">): boolean => subjectKey(a.subject) === subjectKey(b.subject) && a.every === b.every;

/** The ops that only read, and the brief's status (compact), which only marks its alerts as said: they run in a brief's thread. */
const BUDGET_READ_OPS: readonly BudgetOp[] = ["status", "list"];

export function budgetCallReads(args: Record<string, unknown>): boolean {
	return BUDGET_READ_OPS.some((o) => o === args.op);
}

/** What another agente may ask: the status as totals and shares, never a supplier's name, never the brief's line, a change or a file. */
export function budgetAgentReads(args: Record<string, unknown>): boolean {
	return args.op === "status" && args.compact !== true;
}

const plain = (v: unknown, max: number) => isText(v, max) && !/[\r\n]/.test(v as string);

function validSubject(v: unknown): v is BudgetSubject {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	const keys = Object.keys(s);
	switch (s.kind) {
		case "category":
			return keys.every((k) => ["kind", "category"].includes(k)) && CATEGORIES.includes(s.category as Category);
		case "supplier":
			return keys.every((k) => ["kind", "name", "vat", "cf", "card"].includes(k)) && plain(s.name, BUDGET_LIMITS.name) && ["vat", "cf", "card"].every((k) => s[k] === undefined || plain(s[k], 40));
		case "all":
			return keys.every((k) => k === "kind");
		case "income":
			return keys.every((k) => ["kind", "measure"].includes(k)) && MEASURES.includes(s.measure as Measure);
		default:
			return false;
	}
}

/** A budget as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validBudget(v: unknown): v is Budget {
	if (!isMarker(v)) return false;
	const b = v as Budget;
	for (const key of Object.keys(b)) if (!["id", "subject", "amount", "every", "start", "callId", "edited", "by", "at"].includes(key)) return false;
	if (typeof b.id !== "string" || !BUDGET_ID.test(b.id) || !validSubject(b.subject)) return false;
	if (typeof b.amount !== "string" || !/^\d{1,8}(?:\.\d{1,2})?$/.test(b.amount) || Number(b.amount) <= 0) return false;
	if (!EVERY.includes(b.every)) return false;
	if (b.start !== undefined && (typeof b.start !== "string" || !realDate(b.start))) return false;
	if (b.callId !== undefined && !isText(b.callId, 200)) return false;
	return b.edited === undefined || isMarker(b.edited);
}

export function validClaim(v: unknown): v is AlertClaim {
	if (typeof v !== "object" || v === null) return false;
	const c = v as AlertClaim;
	return Object.keys(c).every((k) => ["budget", "period", "level", "call"].includes(k)) && typeof c.budget === "string" && BUDGET_ID.test(c.budget) && plain(c.period, 20) && ["80", "100", "behind"].includes(c.level) && isText(c.call, 200);
}

export const validBudgetCall = (v: unknown): boolean => isText(v, 200);
