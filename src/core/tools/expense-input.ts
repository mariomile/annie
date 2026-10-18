/**
 * The expense tool's arguments, read and checked: the total (the decimal rules of the quotes:
 * «1.234,56», «42,5», «42.50»; «1.250» reads two ways and is asked), the VAT as an amount or a
 * rate, the day (today where the instance is, when not said; never a day to come), the supplier
 * and the note as plain text, the category and the payment method matched from the person's
 * words, and the receipt: a photo or PDF that is in the workspace, kept as its path only.
 */
import { DateError, readDate } from "../dates.ts";
import { CATEGORIES, type Category, EXPENSE_LIMITS, type Expense, matchCategory, matchMethod, type Method, METHODS, RECEIPT_FILE, validReceiptPath } from "../expenses.ts";
import { cents, centsValue, vatInGross } from "../expense-sums.ts";
import { normalPath } from "../invoices.ts";
import { italianDate } from "../italian-format.ts";
import type { VatRate } from "../quote-sums.ts";
import type { Workspace } from "../workspace.ts";
import { cleanText, isProblem, readAmount, readVat } from "./quote-input.ts";

/** What add and edit write, before the id and who did it. */
export type ExpenseDraft = Omit<Expense, "id" | "by" | "at" | "callId" | "edited">;

/** The fields an edit may change; any of them given makes it an edit. */
export const EDIT_FIELDS = ["date", "amount", "vat", "vat_rate", "supplier", "category", "method", "note", "receipt"] as const;

const FIRST_DAY = "2000-01-01";

/** The total: more than zero, at most EXPENSE_LIMITS.maxAmount, to the cent. */
export function readTotal(value: unknown): string | { problem: string } {
	const read = readAmount(value, 2, "amount");
	if (isProblem(read)) return read;
	if (read === undefined) return { problem: "manca l'importo (amount), il totale pagato IVA inclusa: se dalla foto non si legge, chiedilo a chi ti scrive" };
	if (Number(read) <= 0) return { problem: "l'importo è zero: dammi il totale pagato" };
	if (Number(read) > EXPENSE_LIMITS.maxAmount) return { problem: `l'importo è oltre ${EXPENSE_LIMITS.maxAmount.toLocaleString("it-IT")} €: ricontrollalo con chi ti scrive` };
	return read;
}

/** The day of the expense: today when not said; a day without a year is the latest one not to come. */
export function readDay(value: unknown, today: string): string | { problem: string } {
	if (value === undefined) return today;
	if (typeof value !== "string" || value.trim() === "" || value.length > 40) return { problem: "date è la data della spesa, come 18/10/2026 o 2026-10-18" };
	let date: string;
	try {
		date = readDate(value, today, { rule: "past" }).date;
	} catch (error) {
		if (error instanceof DateError) return { problem: error.message };
		throw error;
	}
	if (date > today) return { problem: `la data ${italianDate(date)} non è ancora arrivata: una spesa si registra quando è fatta` };
	if (date < FIRST_DAY) return { problem: "la data è prima del 2000: ricontrollala" };
	return date;
}

/** The category of the words given; with none given, of the supplier's and the note's words; «altro» when nothing fits. */
export function readCategory(value: unknown, hints: readonly (string | undefined)[]): { category: Category; unmatched?: string } | { problem: string } {
	if (value !== undefined && typeof value !== "string") return { problem: "category è un testo" };
	const said = typeof value === "string" ? value.trim().slice(0, 60) : "";
	if (said !== "") {
		const category = matchCategory(said);
		return category === undefined ? { category: "altro", unmatched: said } : { category };
	}
	for (const hint of hints) {
		const category = hint === undefined ? undefined : matchCategory(hint);
		if (category !== undefined) return { category };
	}
	return { category: "altro" };
}

export function readMethod(value: unknown): Method | undefined | { problem: string } {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > 60) return { problem: `method è uno di questi: ${METHODS.join(", ")}` };
	return matchMethod(value) ?? "altro";
}

/** The receipt: a workspace path of a photo or PDF that is there. Only the path is kept. */
export async function readReceipt(value: unknown, workspace: Workspace): Promise<string | undefined | { problem: string }> {
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

export type VatGiven = { readonly vat?: string | null; readonly rate?: VatRate };

/**
 * The VAT of a total: as said, or taken out with the rate (half up to the cent). Both given: the
 * amount said is kept, with a note when it is more than a cent off the rate. In an edit, `old`
 * keeps the rate (the VAT taken out again from a new total) or the amount said for an unchanged
 * total; a VAT amount said for a total that changes is dropped, with a note.
 */
export function resolveVat(amount: string, given: VatGiven, old?: Pick<Expense, "amount" | "vat" | "vatRate">): { vat?: string; vatRate?: VatRate; notes: string[] } | { problem: string } {
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

/** The VAT arguments: vat an amount («9,02»; «» removes it in an edit), vat_rate 22, 10, 5, 4 or 0. */
function readVatGiven(args: Record<string, unknown>, editing: boolean): VatGiven | { problem: string } {
	let vat: string | null | undefined;
	if (editing && args.vat === "") vat = null;
	else {
		const read = readAmount(args.vat, 2, "vat");
		if (isProblem(read)) return read;
		vat = read;
	}
	const rate = readVat(args.vat_rate, "vat_rate");
	if (isProblem(rate)) return { problem: rate.problem.replace(" (per lo 0 serve il motivo in vat_note)", "") };
	return { ...(vat === undefined ? {} : { vat }), ...(rate === undefined ? {} : { rate }) };
}

/** A text argument; in an edit «""» removes it (null). */
function readText(args: Record<string, unknown>, name: "supplier" | "note", max: number, editing: boolean): string | null | undefined | { problem: string } {
	if (editing && args[name] === "") return null;
	return cleanText(args[name], max, name, name === "note");
}

/**
 * The expense the arguments describe: a new one (add), or `old` with what is given changed
 * (edit). A problem to say back otherwise; `notes` to add to the answer.
 */
export async function draftOf(args: Record<string, unknown>, o: { today: string; workspace: Workspace; old?: Expense }): Promise<{ draft: ExpenseDraft; notes: string[] } | { problem: string }> {
	const { old } = o;
	const editing = old !== undefined;
	const notes: string[] = [];
	const amount = args.amount === undefined && old !== undefined ? old.amount : readTotal(args.amount);
	if (isProblem(amount)) return amount;
	const date = args.date === undefined && old !== undefined ? old.date : readDay(args.date, o.today);
	if (isProblem(date)) return date;
	const supplier = readText(args, "supplier", EXPENSE_LIMITS.supplier, editing);
	if (isProblem(supplier)) return supplier;
	const note = readText(args, "note", EXPENSE_LIMITS.note, editing);
	if (isProblem(note)) return note;
	const vatGiven = readVatGiven(args, editing);
	if (isProblem(vatGiven)) return vatGiven;
	const vat = resolveVat(amount, vatGiven, old);
	if (isProblem(vat)) return vat;
	notes.push(...vat.notes);
	let category: Category = old?.category ?? "altro";
	if (!editing || args.category !== undefined) {
		const read = readCategory(args.category, [supplier ?? undefined, note ?? undefined]);
		if (isProblem(read)) return read;
		category = read.category;
		if (read.unmatched !== undefined) notes.push(`La categoria detta non è tra quelle che uso: l'ho messa in «altro». Le categorie: ${CATEGORIES.join(", ")}.`);
	}
	let method: Method | undefined | null = old?.method;
	if (editing && args.method === "") method = null;
	else if (args.method !== undefined) {
		const read = readMethod(args.method);
		if (isProblem(read)) return read;
		method = read;
	}
	let receipt: string | undefined | null = old?.receipt;
	if (editing && args.receipt === "") receipt = null;
	else if (args.receipt !== undefined) {
		const read = await readReceipt(args.receipt, o.workspace);
		if (isProblem(read)) return read;
		receipt = read;
	}
	const keep = <T>(given: T | null | undefined, before: T | undefined): T | undefined => (given === null ? undefined : (given ?? before));
	const finalSupplier = keep(supplier, old?.supplier);
	const finalNote = keep(note, old?.note);
	const draft: ExpenseDraft = {
		date,
		amount,
		...(vat.vat === undefined ? {} : { vat: vat.vat }),
		...(vat.vatRate === undefined ? {} : { vatRate: vat.vatRate }),
		...(finalSupplier === undefined ? {} : { supplier: finalSupplier }),
		category,
		...(method === undefined || method === null ? {} : { method }),
		...(finalNote === undefined ? {} : { note: finalNote }),
		...(receipt === undefined || receipt === null ? {} : { receipt }),
	};
	return { draft, notes };
}

/** Whether an edit's arguments change anything at all. */
export function editsSomething(args: Record<string, unknown>): boolean {
	return EDIT_FIELDS.some((k) => args[k] !== undefined);
}
