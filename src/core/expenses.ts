/**
 * Spese: the costs the owner records, from a receipt photo or a sentence («ho speso 42 euro di
 * benzina»), numbered per year of the expense (S-2026-0001). The amount is the total paid, VAT
 * included; the VAT is only what the receipt or the person says (an amount, or a rate it is taken
 * out with). Categories are a fixed Italian list, matched tolerantly, «altro» when nothing fits.
 * Kept per instance in `expenses.json` (expense-store.ts); sums and periods in expense-sums.ts.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { hasControlChars } from "./plain-text.ts";
import { VAT_RATES, type VatRate } from "./quote-sums.ts";
import { fold } from "./text-match.ts";

export class ExpenseError extends Error {
	override readonly name = "ExpenseError";
}

export const EXPENSE_LIMITS = {
	/** Expenses dated in one year: past it, no new one of that year. */
	perYear: 5000,
	/** The store file: past it, nothing more is written (a full year is about 3 MB). */
	fileBytes: 16 * 1024 * 1024,
	supplier: 120,
	note: 500,
	receipt: 300,
	/** The largest total of one expense, in euros: no typo of a few zeros goes in unchecked. */
	maxAmount: 10_000_000,
} as const;

/** The expense tool's ops that only read: they run in a brief's thread and for another agente. */
export const EXPENSE_READ_OPS = ["list", "summary", "prima_nota"] as const;

export function expenseCallReads(args: Record<string, unknown>): boolean {
	return EXPENSE_READ_OPS.some((o) => o === args.op);
}

export const CATEGORIES = [
	"carburante",
	"pasti e trasferte",
	"ufficio e cancelleria",
	"software e abbonamenti",
	"telefono e internet",
	"formazione",
	"consulenze",
	"attrezzatura",
	"affitto e utenze",
	"altro",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const METHODS = ["contanti", "carta", "bonifico", "altro"] as const;
export type Method = (typeof METHODS)[number];

/** Words that mean a category, folded (no case, no accents): a word of the text that starts with one of them matches. */
const CATEGORY_WORDS: Readonly<Record<Exclude<Category, "altro">, readonly string[]>> = {
	carburante: ["carburant", "benzin", "gasolio", "diesel", "gpl", "metano", "rifornim", "distributor", "pieno", "fuel", "eni", "q8", "esso", "tamoil", "ip"],
	"pasti e trasferte": ["pasti", "pasto", "pranz", "cena", "cene", "ristorant", "trattoria", "pizzeria", "bar", "colazion", "caffe", "trasfert", "viaggi", "treno", "trenitalia", "italo", "aereo", "volo", "voli", "hotel", "albergo", "alloggio", "b&b", "taxi", "autostrad", "pedaggi", "telepass", "parchegg", "vitto"],
	"ufficio e cancelleria": ["ufficio", "cancelleria", "risma", "toner", "cartucc", "penne", "penna", "quaderni", "raccoglitor", "buste", "francobolli", "spedizion"],
	"software e abbonamenti": ["software", "abbonament", "licenz", "saas", "cloud", "hosting", "dominio", "domini", "app", "applicazion", "microsoft", "adobe", "google workspace", "netflix", "spotify"],
	"telefono e internet": ["telefon", "cellular", "smartphone", "internet", "fibra", "adsl", "sim", "tim", "vodafone", "windtre", "iliad", "fastweb"],
	formazione: ["formazion", "corso", "corsi", "libro", "libri", "seminari", "webinar", "=master", "convegn", "aggiornament"],
	consulenze: ["consulen", "commercialist", "avvocat", "notai", "notaio", "professionist", "parcella", "legale"],
	attrezzatura: ["attrezz", "computer", "pc", "portatil", "notebook", "laptop", "tablet", "monitor", "stampant", "macchinar", "strument", "hardware", "utensil", "mobili", "arredo"],
	"affitto e utenze": ["affitt", "locazion", "canone", "utenz", "luce", "gas", "acqua", "energia", "elettric", "bollett", "condomin", "riscaldament"],
};

const METHOD_WORDS: Readonly<Record<Exclude<Method, "altro">, readonly string[]>> = {
	contanti: ["contant", "cash", "in contanti"],
	carta: ["carta", "bancomat", "pos", "credito", "debito", "visa", "mastercard", "amex", "american express", "maestro", "apple pay", "google pay", "satispay", "paypal", "prepagata"],
	bonifico: ["bonific", "sepa", "rid", "sdd", "addebito", "domiciliazion"],
};

/** Folded words of a text: lower case, no accents, letters and digits (and & for B&B). */
function words(text: string): string[] {
	return fold(text)
		.split(/[^a-z0-9&]+/)
		.filter((w) => w !== "");
}

/** Whether `text` holds the words of `key` (one word or several in a row), each word starting as `key`'s. */
function says(tokens: readonly string[], key: string): boolean {
	const parts = key.split(" ");
	for (let i = 0; i + parts.length <= tokens.length; i++) {
		if (parts.every((p, j) => (j === parts.length - 1 ? (tokens[i + j] as string).startsWith(p) : tokens[i + j] === p))) return true;
	}
	return false;
}

/**
 * Short keys (pc, gas, bar, volo…) and those written «=master» only as whole words, so
 * «gastronomia» is no gas, «barca» no bar and «mastercard» no master; the others start a word.
 */
function saysWord(tokens: readonly string[], key: string): boolean {
	if (key.startsWith("=")) return tokens.includes(key.slice(1));
	return key.length <= 4 && !key.includes(" ") ? tokens.includes(key) : says(tokens, key);
}

/**
 * The category a person's words mean: a category's name («Software e abbonamenti», «software»),
 * or a word of it («benzina», «pranzo», «commercialista»). Undefined when nothing fits.
 */
export function matchCategory(text: string): Category | undefined {
	const tokens = words(text);
	if (tokens.length === 0) return undefined;
	const joined = tokens.join(" ");
	const exact = CATEGORIES.find((c) => words(c).join(" ") === joined);
	if (exact !== undefined) return exact;
	if (joined === "altro" || joined === "altre" || joined === "varie") return "altro";
	for (const [category, keys] of Object.entries(CATEGORY_WORDS) as [Category, readonly string[]][]) {
		if (keys.some((k) => saysWord(tokens, k))) return category;
	}
	return undefined;
}

/** The payment method a person's words mean; undefined when nothing fits. */
export function matchMethod(text: string): Method | undefined {
	const tokens = words(text);
	if (tokens.length === 0) return undefined;
	if (tokens.join(" ") === "altro") return "altro";
	for (const [method, keys] of Object.entries(METHOD_WORDS) as [Method, readonly string[]][]) {
		if (keys.some((k) => saysWord(tokens, k))) return method;
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
	readonly category: Category;
	readonly method?: Method;
	readonly note?: string;
	/** The receipt's photo or PDF in the workspace, a relative path: never its content. */
	readonly receipt?: string;
	/** The tool call that recorded it: a call run again finds it instead of recording another. */
	readonly callId?: string;
	/** Who changed it last, and when. */
	readonly edited?: Marker;
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

/**
 * The expenses a person's words name: «S-2026-0001», «2026-1», «1/2026», «spesa 12», «12».
 * More than one when the progressive without a year is in several years.
 */
export function findExpenses(expenses: readonly Expense[], text: string): Expense[] {
	const m = SAID_ID.exec(text.trim());
	if (m === null) return [];
	const year = m[1] ?? m[3];
	const n = Number(m[2]);
	return expenses.filter((e) => {
		const [y, seq] = idOrder(e.id);
		return seq === n && (year === undefined || y === Number(year));
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

/** A receipt's file: a photo or a PDF. */
export const RECEIPT_FILE = /\.(?:jpe?g|png|webp|gif|heic|heif|tiff?|bmp|pdf)$/i;

const AMOUNT = /^\d{1,8}(?:\.\d{1,2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !hasControlChars(v);
const optText = (v: unknown, max: number) => v === undefined || isText(v, max);
const isMarker = (v: unknown): v is Marker => typeof v === "object" && v !== null && isText((v as Marker).by, 200) && isText((v as Marker).at, 40);

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
	if (!optText(e.supplier, EXPENSE_LIMITS.supplier) || !optText(e.note, EXPENSE_LIMITS.note) || !optText(e.callId, 200)) return false;
	if (e.receipt !== undefined && !validReceiptPath(e.receipt)) return false;
	return e.edited === undefined || isMarker(e.edited);
}
