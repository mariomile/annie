/**
 * Spese: the costs the owner records, from a receipt photo or a sentence («ho speso 42 euro di
 * benzina»), numbered per year of the expense (S-2026-0001). The amount is the total paid, VAT
 * included; the VAT is only what the receipt or the person says (an amount, or a rate it is taken
 * out with). Categories are a fixed Italian list, matched tolerantly, «altro» when nothing fits.
 * Kept per instance in `expenses.json` (expense-store.ts); sums and periods in expense-sums.ts.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { businessKey, saysPhrase, words } from "./name-keys.ts";
import { METHODS, type Method } from "./payment-methods.ts";
import { VAT_RATES, type VatRate } from "./quote-sums.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export class ExpenseError extends Error {
	override readonly name = "ExpenseError";
}

export const EXPENSE_LIMITS = {
	/** Expenses dated in one year: past it, no new one of that year. */
	perYear: 5000,
	/** The store file: past it, nothing more is written (a full year is about 3 MB). */
	fileBytes: 16 * 1024 * 1024,
	supplier: 120,
	/** The supplier's tax id as written, label and spaces included. */
	supplierVat: 30,
	docNumber: 40,
	note: 500,
	receipt: 300,
	/** The largest total of one expense, in euros: no typo of a few zeros goes in unchecked. */
	maxAmount: 10_000_000,
} as const;

/** The expense tool's ops that only read: they run in a brief's thread and for another agente. */
const EXPENSE_READ_OPS = ["list", "summary", "prima_nota"] as const;

export function expenseCallReads(args: Record<string, unknown>): boolean {
	return EXPENSE_READ_OPS.some((o) => o === args.op);
}

export const CATEGORIES = [
	"carburante",
	"auto e veicoli",
	"pasti e trasferte",
	"ufficio e cancelleria",
	"software e abbonamenti",
	"telefono e internet",
	"formazione",
	"consulenze",
	"attrezzatura",
	"affitto e utenze",
	"spedizioni",
	"banca e commissioni",
	"altro",
] as const;
export type Category = (typeof CATEGORIES)[number];

export { matchMethod, METHODS, type Method } from "./payment-methods.ts";

/** What the document of an expense is; a scontrino when not said. */
export const DOC_TYPES = ["scontrino", "ricevuta", "fattura"] as const;
export type DocType = (typeof DOC_TYPES)[number];

/**
 * Whole words (folded: no case, no accents) and phrases that mean a category, tried in the list's
 * order (benzina per il furgone is carburante). Never words of an address (corso, via, sede) nor
 * words too vague alone (acqua, ip): a supplier's name or address must not pick a category.
 */
const CATEGORY_WORDS: readonly (readonly [Exclude<Category, "altro">, readonly string[]])[] = [
	["carburante", ["carburante", "carburanti", "benzina", "benzinaio", "stazione di servizio", "gasolio", "diesel", "gpl", "metano", "rifornimento", "distributore", "pieno", "eni", "agip", "q8", "esso", "tamoil"]],
	// Generic words only in phrases: «manutenzione software» or «revisione bilancio» is no car.
	["auto e veicoli", ["auto", "automobile", "veicolo", "veicoli", "furgone", "moto", "meccanico", "officina", "gommista", "gomme", "pneumatici", "tagliando", "carrozzeria", "autolavaggio", "pedaggio", "pedaggi", "autostrada", "autostrade", "telepass", "parcheggio", "parcheggi", "rca auto", "bollo auto"]],
	["pasti e trasferte", ["pasti", "pasto", "pranzo", "pranzi", "cena", "cene", "ristorante", "ristoranti", "trattoria", "osteria", "pizzeria", "pizza", "bar", "autogrill", "colazione", "caffe", "trasferta", "trasferte", "viaggio", "viaggi", "treno", "trenitalia", "italo", "aereo", "volo", "voli", "hotel", "albergo", "alloggio", "b&b", "taxi", "vitto"]],
	["ufficio e cancelleria", ["ufficio", "cancelleria", "cartoleria", "risma", "toner", "cartuccia", "cartucce", "penne", "penna", "quaderni", "raccoglitori", "buste"]],
	["software e abbonamenti", ["software", "abbonamento", "abbonamenti", "licenza", "licenze", "saas", "cloud", "hosting", "dominio", "domini", "app", "microsoft", "adobe", "google workspace", "canva", "dropbox"]],
	["telefono e internet", ["telefono", "telefonia", "cellulare", "smartphone", "internet", "fibra", "adsl", "sim", "tim", "vodafone", "windtre", "iliad", "fastweb", "ricarica telefonica"]],
	["formazione", ["formazione", "corsi", "libro", "libri", "seminario", "seminari", "webinar", "master", "convegno", "convegni", "aggiornamento", "workshop"]],
	["consulenze", ["consulenza", "consulenze", "consulente", "commercialista", "avvocato", "notaio", "professionista", "parcella"]],
	["attrezzatura", ["attrezzatura", "attrezzature", "attrezzi", "computer", "pc", "portatile", "notebook", "laptop", "tablet", "monitor", "stampante", "macchinario", "strumenti", "hardware", "utensili", "mobili", "arredo"]],
	// Before the rent: «canone conto» is the bank's, not a lease; only phrases here, so the bank never outranks the rent, the utilities or the shipping by a bare word.
	["banca e commissioni", ["canone conto", "tenuta conto", "spese tenuta conto", "canone bancomat", "bancomat canone", "canone carta"]],
	["affitto e utenze", ["affitto", "locazione", "canone", "utenze", "utenza", "luce", "gas", "energia", "elettricita", "bolletta", "bollette", "condominio", "riscaldamento", "enel"]],
	["spedizioni", ["spedizione", "spedizioni", "corriere", "poste", "raccomandata", "pacco", "dhl", "ups", "gls", "brt", "bartolini", "sda", "fedex"]],
	// The bank's bare words last: «commissioni» of a courier is its shipping.
	["banca e commissioni", ["banca", "commissioni", "commissione", "competenze", "spese bancarie", "costi bancari", "spese bonifico"]],
];

/**
 * The category a person's words mean: a category's name («Software e abbonamenti», «software»),
 * or a whole word of its list («benzina», «pranzo», «commercialista»). Undefined when nothing
 * fits (a supermercato, Amazon: the caller puts it in «altro» unless the note says more).
 */
export function matchCategory(text: string): Category | undefined {
	const tokens = words(text);
	if (tokens.length === 0) return undefined;
	const joined = tokens.join(" ");
	const exact = CATEGORIES.find((c) => words(c).join(" ") === joined);
	if (exact !== undefined) return exact;
	if (joined === "altre" || joined === "varie") return "altro";
	for (const [category, keys] of CATEGORY_WORDS) {
		if (keys.some((k) => saysPhrase(tokens, k))) return category;
	}
	return undefined;
}

export type Expense = Marker & {
	/** «S-2026-0001»: the year of the expense's date and its progressive. */
	readonly id: string;
	/** ISO day of the expense. */
	readonly date: string;
	/** The total paid, VAT included: a canonical decimal string («42.5»), at most 2 decimals. */
	readonly amount: string;
	/** The VAT in the total, as the receipt or the person says it (or taken out with `vatRate`). */
	readonly vat?: string;
	readonly vatRate?: VatRate;
	readonly supplier?: string;
	/** The supplier's partita IVA or codice fiscale, as on the document. */
	readonly supplierVat?: string;
	/** Scontrino when missing. */
	readonly docType?: DocType;
	/** The document's number, as written. */
	readonly docNumber?: string;
	readonly category: Category;
	readonly method?: Method;
	readonly note?: string;
	/** The receipt's photo or PDF in the workspace, a relative path: never its content. */
	readonly receipt?: string;
	/** The tool call that recorded it: a call run again finds it instead of recording another. */
	readonly callId?: string;
	/** Who changed it last, and when. */
	readonly edited?: Marker;
	/** «bank»: recorded from a movement of the bank statement (bank.ts), on the bank's day. */
	readonly source?: "bank";
};

/** «S-2026-0001». */
export function expenseId(year: number, n: number): string {
	return `S-${year}-${String(n).padStart(4, "0")}`;
}

const ID = /^S-(\d{4})-(\d{4,6})$/;

/** The year and progressive of an id, for ordering. */
export function idOrder(id: string): [number, number] {
	const m = ID.exec(id);
	return m === null ? [0, 0] : [Number(m[1]), Number(m[2])];
}

const SAID_ID = /^(?:s(?:pesa)?\s*[-.]?\s*)?(?:n(?:r|um(?:ero)?)?\.?\s*)?(?:(\d{4})[-/ ])?0*(\d{1,6})(?:[-/ ](\d{4}))?$/i;

/** The year (when said) and progressive of an id as a person writes it: «S-2026-0001», «2026-1», «1/2026», «spesa 12», «12». */
export function parseExpenseId(text: string): { readonly year?: number; readonly n: number } | undefined {
	const m = SAID_ID.exec(text.trim());
	if (m === null || Number(m[2]) === 0) return undefined;
	const year = m[1] ?? m[3];
	return { ...(year === undefined ? {} : { year: Number(year) }), n: Number(m[2]) };
}

/** The expenses a person's words name; more than one when the progressive without a year is in several years. */
export function findExpenses(expenses: readonly Expense[], text: string): Expense[] {
	const said = parseExpenseId(text);
	if (said === undefined) return [];
	return expenses.filter((e) => {
		const [y, seq] = idOrder(e.id);
		return seq === said.n && (said.year === undefined || y === said.year);
	});
}

/** Newest first: by date, then by id. */
export function newestFirst(a: Expense, b: Expense): number {
	const [ay, an] = idOrder(a.id);
	const [by, bn] = idOrder(b.id);
	return b.date.localeCompare(a.date) || by - ay || bn - an;
}

/** Words of a supplier, matched anywhere in its name without case and accents. */
export function matchesSupplier(expense: Expense, text: string): boolean {
	if (expense.supplier === undefined) return false;
	const name = words(expense.supplier).join(" ");
	const wanted = words(text);
	return wanted.length > 0 && wanted.every((w) => name.includes(w));
}

/**
 * An expense already recorded that `e` looks like: the same receipt, or the same day and total
 * (and the same supplier, when both have one: one name inside the other, without legal forms). Said to the person, never refused: two coffees of
 * the same price on the same day are two expenses.
 */
export function lookalike(expenses: readonly Expense[], e: Expense): { readonly id: string; readonly why: string } | undefined {
	const supplier = (x: Expense) => (x.supplier === undefined ? undefined : businessKey(x.supplier));
	for (const other of expenses) {
		if (other.id === e.id) continue;
		if (e.receipt !== undefined && other.receipt === e.receipt) return { id: other.id, why: "stesso scontrino" };
		const a = supplier(e);
		const b = supplier(other);
		const same = a === undefined || b === undefined || a === "" || b === "" || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
		if (other.date === e.date && other.amount === e.amount && same) return { id: other.id, why: "stesso giorno e importo" };
	}
	return undefined;
}

/** A receipt's file: a photo or a PDF. */
export const RECEIPT_FILE = /\.(?:jpe?g|png|webp|gif|heic|heif|tiff?|bmp|pdf)$/i;

/**
 * A supplier's tax id as stored: an Italian partita IVA (11 digits, «IT» in front or not), a
 * person's codice fiscale (its 16 letters and digits in their places), or another EU VAT number
 * (its country and 8 to 12 letters and digits, at least one a digit).
 */
export const SUPPLIER_VAT = /^(?:(?:IT)?\d{11}|[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]|(?!IT)[A-Z]{2}(?=[A-Z0-9]*\d)[A-Z0-9]{8,12})$/;

const AMOUNT = /^\d{1,8}(?:\.\d{1,2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;


/** A receipt path as stored: relative, no «..», no hidden names, a photo or PDF. */
export function validReceiptPath(path: unknown): path is string {
	if (!isText(path, EXPENSE_LIMITS.receipt) || path.startsWith("/") || path.includes("\\")) return false;
	const parts = path.split("/");
	return parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.startsWith(".")) && RECEIPT_FILE.test(path);
}

/** An expense as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validExpense(v: unknown): v is Expense {
	if (!isMarker(v)) return false;
	const e = v as Expense;
	if (typeof e.id !== "string" || !ID.test(e.id)) return false;
	if (typeof e.date !== "string" || !DAY.test(e.date) || !realDate(e.date)) return false;
	if (typeof e.amount !== "string" || !AMOUNT.test(e.amount) || Number(e.amount) <= 0 || Number(e.amount) > EXPENSE_LIMITS.maxAmount) return false;
	if (e.vat !== undefined && (typeof e.vat !== "string" || !AMOUNT.test(e.vat) || Number(e.vat) > Number(e.amount))) return false;
	if (e.vatRate !== undefined && !VAT_RATES.includes(e.vatRate)) return false;
	if (!CATEGORIES.includes(e.category)) return false;
	if (e.method !== undefined && !METHODS.includes(e.method)) return false;
	if (e.docType !== undefined && !DOC_TYPES.includes(e.docType)) return false;
	if (e.supplierVat !== undefined && (typeof e.supplierVat !== "string" || !SUPPLIER_VAT.test(e.supplierVat))) return false;
	if (!optText(e.docNumber, EXPENSE_LIMITS.docNumber)) return false;
	if (!optText(e.supplier, EXPENSE_LIMITS.supplier) || !optText(e.note, EXPENSE_LIMITS.note) || !optText(e.callId, 200)) return false;
	if (e.receipt !== undefined && !validReceiptPath(e.receipt)) return false;
	if (e.source !== undefined && e.source !== "bank") return false;
	return e.edited === undefined || isMarker(e.edited);
}
