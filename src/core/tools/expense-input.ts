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
import { DateError, readDate } from "../dates.ts";
import { CATEGORIES, type Category, DOC_TYPES, type DocType, EXPENSE_LIMITS, type Expense, idOrder, matchCategory, matchMethod, type Method, METHODS, RECEIPT_FILE, SUPPLIER_VAT, validReceiptPath } from "../expenses.ts";
import { cents, centsValue, vatInGross } from "../expense-sums.ts";
import { normalPath } from "../invoices.ts";
import { addDays, daysBetween, realDate, weekdayOf } from "../italian-calendar.ts";
import { italianDate, italianWeekday } from "../italian-format.ts";
import { VAT_RATES, type VatRate } from "../quote-sums.ts";
import { fold } from "../text-match.ts";
import type { Workspace } from "../workspace.ts";
import { fenced } from "./expense-render.ts";
import { cleanText, isProblem, type Problem, readAmount } from "./quote-input.ts";

/** What an expense holds besides its id and who recorded it. */
export type ExpenseDraft = Omit<Expense, "id" | "by" | "at" | "callId" | "edited">;

/** The fields an edit may change; any of them given makes it an edit. */
const EDIT_FIELDS = ["date", "amount", "vat", "vat_rate", "supplier", "supplier_vat", "doc_type", "doc_number", "category", "method", "note", "receipt"] as const;

const FIRST_DAY = "2000-01-01";

const FOREIGN = /\$|£|¥|\b(?:usd|gbp|chf|jpy|cad|aud|dollar\w*|sterlin\w*|franch\w*|yen)\b/i;

const NOT_EURO = "l'importo è in un'altra valuta: convertilo in euro con exchange_rate alla data dello scontrino, passa gli euro in amount e scrivi l'importo originale in note";
const NEGATIVE = "l'importo è negativo: per un reso o un rimborso correggi la spesa con op edit o toglila con op remove";

/** The total: more than zero, in euros, at most EXPENSE_LIMITS.maxAmount, to the cent; undefined when not given. */
export function readTotal(value: unknown): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value === "string" && FOREIGN.test(value)) return { problem: NOT_EURO };
	if ((typeof value === "number" && value < 0) || (typeof value === "string" && /^\s*(?:€|eur\w*)?\s*-/i.test(value))) return { problem: NEGATIVE };
	const read = readAmount(value, 2, "amount", fenced);
	if (isProblem(read) || read === undefined) return read;
	if (Number(read) <= 0) return { problem: "l'importo è zero: dammi il totale pagato" };
	if (Number(read) > EXPENSE_LIMITS.maxAmount) return { problem: `l'importo è oltre ${EXPENSE_LIMITS.maxAmount.toLocaleString("it-IT")} €: ricontrollalo con chi ti scrive` };
	return read;
}

const WEEKDAYS = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"];
const WEEKDAY = new RegExp(`^(?:(?:il|lo|la) )?(${WEEKDAYS.join("|")})(?: (scors[oa])| (\\d{1,2}))?$`);
const BAD_DAY = "scrivi la data come 12/10 o 12/10/2026, oppure ieri, oggi o sabato";
/** A date without a year placed further back than this: said, it may be last year by mistake. */
const FAR_BACK_DAYS = 300;

/**
 * The day of the expense: today when not said; «ieri», «l'altro ieri», a weekday («sabato», «la
 * domenica»: the last one up to today; «sabato scorso»: the last one before today; «venerdì 16»:
 * the last 16th up to today, which must be a Friday), a date (without a year the latest one
 * gone, with a note when that is almost a year back). Never a day to come, nor before 2000.
 */
export function readDayNoted(value: unknown, today: string): { date: string; note?: string } | Problem {
	if (value === undefined) return { date: today };
	if (typeof value !== "string" || value.trim() === "" || value.length > 40) return { problem: `date è la data della spesa: ${BAD_DAY}` };
	const t = fold(value).replace(/\s+/g, " ").trim();
	let date: string;
	let yearless = false;
	const weekday = WEEKDAY.exec(t);
	if (weekday !== null) {
		const wanted = WEEKDAYS.indexOf(weekday[1] as string);
		if (weekday[3] !== undefined) {
			const day = Number(weekday[3]);
			let candidate: string | undefined;
			// The last such day of the month up to today, in the last twelve months.
			for (let back = 0; back < 12 && candidate === undefined; back++) {
				const month = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - back, 1)).toISOString().slice(0, 7);
				const c = `${month}-${String(day).padStart(2, "0")}`;
				if (realDate(c) && c <= today) candidate = c;
			}
			if (candidate === undefined) return { problem: `non capisco la data: ${BAD_DAY}` };
			if (weekdayOf(candidate) !== wanted) return { problem: `il ${italianDate(candidate)} è ${italianWeekday(candidate)}, non ${weekday[1]}: ${BAD_DAY}` };
			date = candidate;
		} else {
			const back = (weekdayOf(today) - wanted + 7) % 7;
			date = addDays(today, -(back === 0 && weekday[2] !== undefined ? 7 : back));
		}
	} else {
		try {
			const read = readDate(/^l'? ?altro ?ieri$/.test(t) ? "altro ieri" : value, today, { rule: "past" });
			date = read.date;
			yearless = read.yearless;
		} catch (error) {
			if (error instanceof DateError) return { problem: `non capisco la data: ${BAD_DAY}` };
			throw error;
		}
	}
	if (date > today) return { problem: `la data ${italianDate(date)} non è ancora arrivata: una spesa si registra quando è fatta` };
	if (date < FIRST_DAY) return { problem: "la data è prima del 2000: ricontrollala" };
	if (yearless && daysBetween(date, today) > FAR_BACK_DAYS) return { date, note: `Ho messo il ${italianDate(date)}: se era un'altra data correggila con op edit.` };
	return { date };
}

/** readDayNoted's day alone. */
export function readDay(value: unknown, today: string): string | Problem {
	const read = readDayNoted(value, today);
	return isProblem(read) ? read : read.date;
}

/** The category of the words given; «altro», said back, when they fit none. */
function readCategory(value: unknown): { category: Category; unmatched?: true } | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { problem: "category è un testo" };
	const said = value.trim().slice(0, 60);
	if (said === "") return undefined;
	const category = matchCategory(said);
	return category === undefined ? { category: "altro", unmatched: true } : { category };
}

function readMethod(value: unknown): Method | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > 60) return { problem: `method è uno di questi: ${METHODS.join(", ")}` };
	return matchMethod(value) ?? "altro";
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
		if (typeof args.vat === "string" && FOREIGN.test(args.vat)) return { problem: NOT_EURO };
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
