/**
 * The budgets tool's arguments, read and checked: what a budget is on (a category of the
 * expenses matched from the person's words, «tutto», «fatturato» or «incassato»; a supplier is
 * found by the tool), the amount in euros («300», «60.000», «60k»), the kind of period (each
 * month, quarter or year) and the first day it counts from («novembre», «2027», «1/11/2026»).
 */
import { CATEGORIES, matchCategory } from "../expenses.ts";
import { BUDGET_LIMITS, type BudgetSubject, type Every, type Measure } from "../budgets.ts";
import { DateError, parseDate } from "../dates.ts";
import { plainEuros, readEuros } from "../money-input.ts";
import { PeriodError, readPeriod } from "../periods.ts";
import { isProblem, type Problem } from "../text-input.ts";
import { fold } from "../text-match.ts";
import { fencedBudgets } from "./budget-render.ts";

/** What a budget is on, as said: the subject, or a supplier to find. */
export type SaidTarget = { readonly subject: Exclude<BudgetSubject, { kind: "supplier" }> } | { readonly supplier: string };

const ALL = /^(?:tutto|tutte(?: le spese)?|totale|in tutto|spese|tutte le uscite|uscite|spesa totale|spese totali)$/;
const INCASSATO = /^(?:incassato|incassi|incasso|entrate|soldi entrati|incassare)$/;
const FATTURATO = /^(?:fatturato|fatture|fatturare|fatturazione|ricavi)$/;

const CATEGORY_LIST = CATEGORIES.join(", ");

/** The target of a budget: `target` (category, «tutto», «fatturato», «incassato») or `supplier`; undefined when neither is given. */
export function readTarget(args: Record<string, unknown>): SaidTarget | undefined | Problem {
	if (args.supplier !== undefined && args.target !== undefined) return { problem: "dimmi o la categoria (o tutto, fatturato, incassato) o il fornitore, non tutti e due" };
	if (args.supplier !== undefined) {
		if (typeof args.supplier !== "string" || args.supplier.trim() === "") return { problem: "il fornitore va scritto come testo: il nome, la partita IVA o la scheda FO-0001" };
		return { supplier: args.supplier.trim().slice(0, BUDGET_LIMITS.name) };
	}
	if (args.target === undefined) return undefined;
	if (typeof args.target !== "string" || args.target.trim() === "") return { problem: "dimmi su cosa è il budget: una categoria delle spese, tutto, fatturato o incassato" };
	const t = fold(args.target).replace(/^(?:il |lo |la |l'|per (?:il |lo |la |l')?|di |del |della |dello )/, "").replace(/\s+/g, " ").trim();
	if (ALL.test(t)) return { subject: { kind: "all" } };
	if (INCASSATO.test(t)) return { subject: { kind: "income", measure: "incassato" as Measure } };
	if (FATTURATO.test(t)) return { subject: { kind: "income", measure: "fatturato" as Measure } };
	const category = matchCategory(args.target);
	if (category !== undefined) return { subject: { kind: "category", category } };
	return { problem: `questa non è una delle categorie delle spese (${CATEGORY_LIST}). Chiedi a chi ti scrive in quale categoria registra queste spese; per un fornitore solo, dimmi il fornitore` };
}

const EVERY_WORDS: Readonly<Record<string, Every>> = {
	month: "month",
	mese: "month",
	mensile: "month",
	"al mese": "month",
	quarter: "quarter",
	trimestre: "quarter",
	trimestrale: "quarter",
	"al trimestre": "quarter",
	year: "year",
	anno: "year",
	annuale: "year",
	"all'anno": "year",
};

/** The kind of period: month, quarter or year. */
export function readEvery(value: unknown): Every | undefined | Problem {
	if (value === undefined) return undefined;
	const e = typeof value === "string" ? EVERY_WORDS[fold(value).trim()] : undefined;
	return e ?? { problem: "il periodo del budget è al mese, al trimestre o all'anno" };
}

const EURO_WORDS = {
	fence: fencedBudgets,
	max: BUDGET_LIMITS.maxEuros,
	foreign: "l'importo è in un'altra valuta: convertilo in euro con exchange_rate e passa gli euro",
	negative: "l'importo di un budget non è negativo",
	zero: "l'importo è zero: dimmi quanto",
};

/** The amount in euros, a canonical decimal string. */
export function readBudgetAmount(value: unknown): string | undefined | Problem {
	return readEuros(plainEuros(value), EURO_WORDS);
}

const NO_START = /^(?:|subito|da subito|nessun[oa]?|nessuna data|senza data|senza inizio|togli la data|dall'inizio del periodo)$/;

/**
 * The first day a budget counts from: a month, a quarter or a year («novembre», «T1 2027», «2027»:
 * their first day), or a date; null when the person clears it («subito», «senza data», or empty):
 * then it counts from the start of each period.
 */
export function readStart(value: unknown, today: string): string | null | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { problem: "il giorno da cui conta il budget va scritto come «novembre» o «01/11/2026»" };
	if (NO_START.test(fold(value).trim())) return null;
	const text = value.trim().slice(0, 40);
	try {
		return parseDate(text, today);
	} catch (error) {
		if (!(error instanceof DateError)) throw error;
	}
	try {
		return readPeriod(text, today, { ahead: true }).from;
	} catch (error) {
		if (!(error instanceof PeriodError)) throw error;
		return { problem: "non riconosco da quando conta il budget: scrivilo come «novembre», «2027» o «01/11/2026»" };
	}
}

export { isProblem };
