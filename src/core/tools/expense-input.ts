/**
 * The expense tool's arguments, read and checked: the total (the decimal rules of the quotes:
 * «1.234,56», «42,5», «42.50»; «1.250» reads two ways and is asked; never negative, never in
 * another currency), the VAT as an amount or a rate, the day (today where the instance is when not
 * said, «ieri», «sabato», a date; never a day to come), the supplier and its tax id, the document,
 * the note, the category and the payment method matched from the person's words, and the
 * receipt: a photo or PDF that is in the workspace, kept as its path only.
 *
 * Reading (readFields) is apart from applying (applyFields): an edit applies only the fields
 * given, to the expense as saved under the store's lock.
 */
import { foreignCurrency } from "../currency-words.ts";
import { CATEGORIES, type Category, DOC_TYPES, type DocType, EXPENSE_LIMITS, type Expense, idOrder, matchCategory, type Method, RECEIPT_FILE, SUPPLIER_VAT, validReceiptPath } from "../expenses.ts";
import { cents, centsValue, vatInGross } from "../expense-sums.ts";
import { normalPath } from "../invoices.ts";
import { VAT_RATES, type VatRate } from "../quote-sums.ts";
import { fold } from "../text-match.ts";
import type { Workspace } from "../workspace.ts";
import { type DayWords, readPastDay } from "./day-input.ts";
import { fenced } from "./expense-render.ts";
import { readEuros } from "../money-input.ts";
import { readCategoryWith, readMethod } from "./field-input.ts";
import { readAmount } from "./quote-input.ts";
import { cleanText, isProblem, type Problem } from "../text-input.ts";

/** What an expense holds besides its id and who recorded it. */
export type ExpenseDraft = Omit<Expense, "id" | "by" | "at" | "callId" | "edited">;

/** The fields an edit may change; any of them given makes it an edit. */
const EDIT_FIELDS = ["date", "amount", "vat", "vat_rate", "supplier", "supplier_vat", "doc_type", "doc_number", "category", "method", "note", "receipt"] as const;

const NOT_EURO = "l'importo è in un'altra valuta: convertilo in euro con exchange_rate alla data dello scontrino, passa gli euro in amount e scrivi l'importo originale in note";
const NEGATIVE = "l'importo è negativo: per un reso o un rimborso correggi la spesa con op edit o toglila con op remove";

/** The total: more than zero, in euros, at most EXPENSE_LIMITS.maxAmount, to the cent; undefined when not given. */
export function readTotal(value: unknown): string | undefined | Problem {
	return readEuros(value, { fence: fenced, max: EXPENSE_LIMITS.maxAmount, foreign: NOT_EURO, negative: NEGATIVE, zero: "l'importo è zero: dammi il totale pagato" });
}

/** What a day said wrong is called in the expenses' answers. */
const EXPENSE_DAY: DayWords = { field: "date è la data della spesa", future: "una spesa si registra quando è fatta" };

/** The day of the expense (day-input.ts' readPastDay): today when not said, never a day to come. */
export function readDayNoted(value: unknown, today: string): { date: string; note?: string } | Problem {
	return readPastDay(value, today, EXPENSE_DAY);
}

/** readDayNoted's day alone. */
export function readDay(value: unknown, today: string): string | Problem {
	const read = readDayNoted(value, today);
	return isProblem(read) ? read : read.date;
}

/** The category of the words given; «altro», said back, when they fit none. */
function readCategory(value: unknown): { category: Category; unmatched?: true } | undefined | Problem {
	return readCategoryWith(value, matchCategory, "altro");
}

function readDocType(value: unknown): DocType | undefined | Problem {
	if (value === undefined) return undefined;
	const t = typeof value === "string" ? fold(value).trim() : "";
	const found = DOC_TYPES.find((d) => t === d || (d === "fattura" && t.startsWith("fattur")) || (d === "scontrino" && t.startsWith("scontrin")) || (d === "ricevuta" && t.startsWith("ricevut")));
	return found ?? { problem: `doc_type è uno di questi: ${DOC_TYPES.join(", ")}` };
}

/** A supplier's partita IVA or codice fiscale as on the document: letters and digits, upper case. */
function readSupplierVat(value: unknown): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > EXPENSE_LIMITS.supplierVat) return { problem: "supplier_vat è la partita IVA o il codice fiscale del fornitore" };
	// A label only with its separator: «CF RMR…», «P.IVA: 0…»; «CFRMRA…» is a codice fiscale that starts with CF.
	const compact = value.replace(/^\s*(?:p\.?\s*iva|partita\s+iva|c\.?\s*f\.?)(?:\s*[:.]\s*|\s+)/i, "").replace(/[\s.-]+/g, "").toUpperCase();
	if (!SUPPLIER_VAT.test(compact)) return { problem: "supplier_vat non sembra una partita IVA o un codice fiscale: ricopiala dal documento, o toglila" };
	return compact;
}

/** The receipt: a workspace path of a photo or PDF that is there. Only the path is kept. */
async function readReceipt(value: unknown, workspace: Workspace): Promise<string | undefined | Problem> {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > EXPENSE_LIMITS.receipt) return { problem: "receipt è il percorso nel workspace della foto o del PDF dello scontrino" };
	const path = normalPath(value);
	if (!RECEIPT_FILE.test(path)) return { problem: "receipt è una foto (jpg, png, webp, heic) o un PDF del workspace" };
	if (!validReceiptPath(path)) return { problem: "receipt non è un percorso valido del workspace" };
	// WorkspaceError (a link, a folder, a name outside) goes up to the tool, said as the workspace says it.
	const found = await workspace.stat(path);
	if (found === undefined) return { problem: "non trovo lo scontrino nel workspace a quel percorso: usa il percorso della foto che ti hanno mandato" };
	return found.path;
}

function readRate(value: unknown): VatRate | undefined | Problem {
	const read = readAmount(value, 2, "vat_rate", fenced);
	if (read === undefined || isProblem(read)) return read;
	if (!VAT_RATES.includes(Number(read) as VatRate)) return { problem: `vat_rate è una di queste aliquote: ${VAT_RATES.join(", ")}` };
	return Number(read) as VatRate;
}

/** The fields given: a value, null for «""» in an edit (removes it), undefined when not given. */
export type Fields = {
	readonly amount?: string;
	readonly date?: string;
	/** Said with the answer: a date without a year placed almost a year back. */
	readonly dateNote?: string;
	readonly vat?: string | null;
	readonly rate?: VatRate;
	readonly supplier?: string | null;
	readonly supplierVat?: string | null;
	readonly docType?: DocType | null;
	readonly docNumber?: string | null;
	readonly note?: string | null;
	readonly category?: { readonly category: Category; readonly unmatched?: true };
	readonly method?: Method | null;
	readonly receipt?: string | null;
};

/** The arguments read and checked, nothing applied yet. In an edit «""» removes the field. */
export async function readFields(args: Record<string, unknown>, o: { today: string; workspace: Workspace; editing: boolean }): Promise<Fields | Problem> {
	const out: Record<string, unknown> = {};
	const removed = (name: string) => o.editing && args[name] === "";
	const amount = readTotal(args.amount);
	if (isProblem(amount)) return amount;
	if (amount !== undefined) out.amount = amount;
	if (args.date !== undefined || !o.editing) {
		const date = readDayNoted(args.date, o.today);
		if (isProblem(date)) return date;
		out.date = date.date;
		if (date.note !== undefined) out.dateNote = date.note;
	}
	if (removed("vat")) out.vat = null;
	else {
		if (foreignCurrency(args.vat)) return { problem: NOT_EURO };
		const vat = readAmount(args.vat, 2, "vat", fenced);
		if (isProblem(vat)) return vat;
		if (vat !== undefined) out.vat = vat;
	}
	const rate = readRate(args.vat_rate);
	if (isProblem(rate)) return rate;
	if (rate !== undefined) out.rate = rate;
	const texts = [
		["supplier", "supplier", EXPENSE_LIMITS.supplier],
		["doc_number", "docNumber", EXPENSE_LIMITS.docNumber],
		["note", "note", EXPENSE_LIMITS.note],
	] as const;
	for (const [arg, key, max] of texts) {
		if (removed(arg)) out[key] = null;
		else {
			const text = cleanText(args[arg], max, arg, arg === "note");
			if (isProblem(text)) return text;
			if (text !== undefined) out[key] = text;
		}
	}
	const readers: [string, string, (v: unknown) => unknown][] = [
		["supplier_vat", "supplierVat", readSupplierVat],
		["doc_type", "docType", readDocType],
		["method", "method", readMethod],
		["category", "category", readCategory],
	];
	for (const [arg, key, read] of readers) {
		if (removed(arg) && arg !== "category") out[key] = null;
		else {
			const value = read(args[arg]);
			if (isProblem(value)) return value;
			if (value !== undefined) out[key] = value;
		}
	}
	if (removed("receipt")) out.receipt = null;
	else {
		const receipt = await readReceipt(args.receipt, o.workspace);
		if (isProblem(receipt)) return receipt;
		if (receipt !== undefined) out.receipt = receipt;
	}
	return out as Fields;
}

export type VatGiven = { readonly vat?: string | null; readonly rate?: VatRate };

/**
 * The VAT of a total: as said, or taken out with the rate. Both given: the amount said is kept,
 * with a note when it is more than a cent off the rate. In an edit, `old` keeps the rate (the VAT
 * taken out again from a new total) or the amount said for an unchanged total; a VAT amount said
 * for a total that changes is dropped, with a note.
 */
export function resolveVat(amount: string, given: VatGiven, old?: Pick<Expense, "amount" | "vat" | "vatRate">): { vat?: string; vatRate?: VatRate; notes: string[] } | Problem {
	const notes: string[] = [];
	if (given.vat === null) return { notes };
	const rate = given.rate ?? (given.vat === undefined ? old?.vatRate : undefined);
	let vat = given.vat;
	if (vat === undefined && rate !== undefined) vat = centsValue(vatInGross(cents(amount), rate));
	if (vat === undefined && old?.vat !== undefined) {
		if (old.amount === amount) vat = old.vat;
		else notes.push("L'importo è cambiato e l'IVA era detta come importo: l'ho tolta. Se c'è, ridimmela (vat o vat_rate).");
	}
	if (vat !== undefined && cents(vat) > cents(amount)) return { problem: "l'IVA è più del totale: ricontrollala" };
	if (given.vat !== undefined && given.rate !== undefined) {
		const diff = cents(given.vat) - vatInGross(cents(amount), given.rate);
		if (diff > 1n || diff < -1n) notes.push(`L'IVA detta non torna con l'aliquota del ${given.rate}% sul totale: ho tenuto l'importo detto. Ricontrollalo sullo scontrino (con più aliquote, passa solo vat).`);
	}
	return { ...(vat === undefined ? {} : { vat }), ...(rate === undefined ? {} : { vatRate: rate }), notes };
}

/** A category guessed from the supplier's and the note's whole words; «altro» when none fits. */
function guessed(supplier: string | undefined, note: string | undefined): Category {
	for (const hint of [supplier, note]) {
		const category = hint === undefined ? undefined : matchCategory(hint);
		if (category !== undefined) return category;
	}
	return "altro";
}

/**
 * The fields applied: on nothing for a new expense (the total is needed), or on `old`, the
 * expense as saved now, changing only what is given. An edit never moves an expense to another
 * year: its id is of its year.
 */
export function applyFields(f: Fields, old?: Expense): { draft: ExpenseDraft; notes: string[] } | Problem {
	const notes: string[] = f.dateNote === undefined ? [] : [f.dateNote];
	const amount = f.amount ?? old?.amount;
	if (amount === undefined) return { problem: "manca l'importo (amount), il totale pagato IVA inclusa: se dalla foto non si legge, chiedilo a chi ti scrive" };
	const date = f.date ?? old?.date;
	if (date === undefined) return { problem: "manca la data" };
	if (old !== undefined && f.date !== undefined && Number(f.date.slice(0, 4)) !== idOrder(old.id)[0]) {
		return { problem: `la spesa ${old.id} è del ${idOrder(old.id)[0]}: per cambiare anno toglila e registrala di nuovo` };
	}
	const vat = resolveVat(amount, { ...(f.vat === undefined ? {} : { vat: f.vat }), ...(f.rate === undefined ? {} : { rate: f.rate }) }, old);
	if (isProblem(vat)) return vat;
	notes.push(...vat.notes);
	const pick = <T>(given: T | null | undefined, before: T | undefined): T | undefined => (given === null ? undefined : (given ?? before));
	const supplier = pick(f.supplier, old?.supplier);
	const note = pick(f.note, old?.note);
	const category = f.category?.category ?? old?.category ?? guessed(supplier, note);
	if (f.category?.unmatched === true) notes.push(`La categoria detta non è tra quelle che uso: l'ho messa in «altro». Le categorie: ${CATEGORIES.join(", ")}.`);
	const optional = {
		vat: vat.vat,
		vatRate: vat.vatRate,
		supplier,
		supplierVat: pick(f.supplierVat, old?.supplierVat),
		docType: pick(f.docType, old?.docType),
		docNumber: pick(f.docNumber, old?.docNumber),
		method: pick(f.method, old?.method),
		note,
		receipt: pick(f.receipt, old?.receipt),
	};
	const draft = { date, amount, category, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) } as ExpenseDraft;
	return { draft, notes };
}

/** Whether an edit's arguments change anything at all. */
export function editsSomething(args: Record<string, unknown>): boolean {
	return EDIT_FIELDS.some((k) => args[k] !== undefined);
}
