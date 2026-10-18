/**
 * The renewal tool's arguments, read and checked: the name and provider, the category matched
 * from the person's words (or guessed from the name's whole words, «altro» when none fits), the
 * amount of one period (the quotes' decimal rules; never negative, never another currency), the
 * frequency, the next due date (renewal-dates.ts: ahead, never gone), the tacit renewal and its
 * notice, the reminder days, the payment method, the note and the contract's file in the
 * workspace (its path only).
 *
 * Reading (readFields) is apart from applying (applyFields): an edit applies only the fields
 * given, to the renewal as saved under the store's lock.
 */
import { foreignCurrency } from "../currency-words.ts";
import { matchMethod, type Method, METHODS } from "../expenses.ts";
import { normalPath } from "../invoices.ts";
import { type Due, parseFrequency, readDue } from "../renewal-dates.ts";
import { CATEGORIES, type Category, DOCUMENT_FILE, matchCategory, RENEWAL_LIMITS, type Renewal, validDocumentPath } from "../renewals.ts";
import type { Workspace } from "../workspace.ts";
import { cleanText, isProblem, type Problem, readAmount } from "./quote-input.ts";
import { fenced } from "./renewal-render.ts";

/** What a renewal holds besides its id, who recorded it and its state. */
export type RenewalDraft = Omit<Renewal, "id" | "by" | "at" | "callId" | "edited" | "status" | "cancelled" | "lastRoll">;

/** The fields an edit may change; any of them given makes it an edit. */
const EDIT_FIELDS = ["name", "provider", "category", "amount", "frequency", "due", "auto_renew", "notice_days", "remind_days", "method", "note", "document"] as const;

const NOT_EURO = "l'importo è in un'altra valuta: convertilo in euro con exchange_rate e scrivi l'importo originale in note";

/** The amount of one period: more than zero, in euros, to the cent; undefined when not given. */
export function readPeriodAmount(value: unknown): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (foreignCurrency(value)) return { problem: NOT_EURO };
	if ((typeof value === "number" && value < 0) || (typeof value === "string" && /^\s*(?:€|eur\w*)?\s*-/i.test(value))) return { problem: "l'importo è negativo: dammi quanto si paga a ogni scadenza" };
	const read = readAmount(value, 2, "amount", fenced);
	if (isProblem(read) || read === undefined) return read;
	if (Number(read) <= 0) return { problem: "l'importo è zero: se non lo sai, lascialo fuori" };
	if (Number(read) > RENEWAL_LIMITS.maxAmount) return { problem: `l'importo è oltre ${RENEWAL_LIMITS.maxAmount.toLocaleString("it-IT")} €: ricontrollalo con chi ti scrive` };
	return read;
}

/** Whole days, as a number or «30», «30 giorni»; months are not days and are asked for in days. */
function readDays(value: unknown, name: string, min: number, max: number): number | undefined | Problem {
	if (value === undefined) return undefined;
	let n: number | undefined;
	if (typeof value === "number") n = value;
	else if (typeof value === "string") {
		if (/\bmes[ei]\b/i.test(value)) return { problem: `${name} sono giorni: per «3 mesi» passa i giorni scritti nel contratto (circa 90)` };
		const m = /^\s*(\d{1,3})\s*(?:gg|giorni|giorno)?\.?\s*$/i.exec(value);
		if (m !== null) n = Number(m[1]);
	}
	if (n === undefined || !Number.isInteger(n) || n < min || n > max) return { problem: `${name} è un numero intero di giorni, da ${min} a ${max}` };
	return n;
}

/** The contract or policy: a workspace path of a file that is there. Only the path is kept. */
async function readDocument(value: unknown, workspace: Workspace): Promise<string | undefined | Problem> {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > RENEWAL_LIMITS.document) return { problem: "document è il percorso nel workspace del contratto o della polizza" };
	const path = normalPath(value);
	if (!DOCUMENT_FILE.test(path)) return { problem: "document è un PDF, una foto, un Word o un .p7m del workspace" };
	if (!validDocumentPath(path)) return { problem: "document non è un percorso valido del workspace" };
	// WorkspaceError (a link, a folder, a name outside) goes up to the tool, said as the workspace says it.
	const found = await workspace.stat(path);
	if (found === undefined) return { problem: "non trovo il documento nel workspace a quel percorso: usa il percorso del file che hai letto" };
	return found.path;
}

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

/** The fields given: a value, null for «""» in an edit (removes it), undefined when not given. */
export type Fields = {
	readonly name?: string;
	readonly provider?: string | null;
	readonly category?: { readonly category: Category; readonly unmatched?: true };
	readonly amount?: string | null;
	readonly months?: number;
	readonly due?: Due;
	readonly autoRenew?: boolean;
	readonly noticeDays?: number | null;
	readonly remindDays?: number | null;
	readonly method?: Method | null;
	readonly note?: string | null;
	readonly document?: string | null;
};

/** The arguments read and checked, nothing applied yet. In an edit «""» removes an optional field. */
export async function readFields(args: Record<string, unknown>, o: { today: string; workspace: Workspace; editing: boolean }): Promise<Fields | Problem> {
	const out: Record<string, unknown> = {};
	const removed = (name: string) => o.editing && args[name] === "";
	const name = cleanText(args.name, RENEWAL_LIMITS.name, "name");
	if (isProblem(name)) return name;
	if (name !== undefined) out.name = name;
	for (const [arg, key, max, lines] of [
		["provider", "provider", RENEWAL_LIMITS.provider, false],
		["note", "note", RENEWAL_LIMITS.note, true],
	] as const) {
		if (removed(arg)) out[key] = null;
		else {
			const text = cleanText(args[arg], max, arg, lines);
			if (isProblem(text)) return text;
			if (text !== undefined) out[key] = text;
		}
	}
	const category = readCategory(args.category);
	if (isProblem(category)) return category;
	if (category !== undefined) out.category = category;
	if (removed("amount")) out.amount = null;
	else {
		const amount = readPeriodAmount(args.amount);
		if (isProblem(amount)) return amount;
		if (amount !== undefined) out.amount = amount;
	}
	if (args.frequency !== undefined) {
		const months = parseFrequency(args.frequency);
		if (isProblem(months)) return months;
		out.months = months;
	}
	if (args.due !== undefined) {
		const due = readDue(args.due, o.today);
		if (isProblem(due)) return due;
		out.due = due;
	}
	if (args.auto_renew !== undefined) {
		if (typeof args.auto_renew !== "boolean") return { problem: "auto_renew è true (si rinnova da solo) o false" };
		out.autoRenew = args.auto_renew;
	}
	for (const [arg, key, min, max] of [
		["notice_days", "noticeDays", 1, RENEWAL_LIMITS.maxNoticeDays],
		["remind_days", "remindDays", 0, RENEWAL_LIMITS.maxRemindDays],
	] as const) {
		if (removed(arg)) out[key] = null;
		else {
			const days = readDays(args[arg], arg, min, max);
			if (isProblem(days)) return days;
			if (days !== undefined) out[key] = days;
		}
	}
	if (removed("method")) out.method = null;
	else {
		const method = readMethod(args.method);
		if (isProblem(method)) return method;
		if (method !== undefined) out.method = method;
	}
	if (removed("document")) out.document = null;
	else {
		const document = await readDocument(args.document, o.workspace);
		if (isProblem(document)) return document;
		if (document !== undefined) out.document = document;
	}
	return out as Fields;
}

/** A category guessed from the name's and the provider's whole words; «altro» when none fits. */
export function guessCategory(name: string, provider?: string, note?: string): Category {
	for (const hint of [name, provider, note]) {
		const category = hint === undefined ? undefined : matchCategory(hint);
		if (category !== undefined) return category;
	}
	return "altro";
}

/**
 * The fields applied: on nothing for a new renewal (name and due date needed; annuale when the
 * frequency is not said, said back), or on `old`, the renewal as saved now, changing only what is
 * given. A notice period given without saying auto_renew means a tacit renewal.
 */
export function applyFields(f: Fields, old?: Renewal): { draft: RenewalDraft; notes: string[] } | Problem {
	const notes: string[] = [];
	const name = f.name ?? old?.name;
	if (name === undefined) return { problem: "manca il nome (name): cos'è che si rinnova, per esempio «Assicurazione auto» o «Canva»" };
	const due = f.due ?? (old === undefined ? undefined : { date: old.due, day: old.day });
	if (due === undefined) return { problem: "manca la prossima scadenza (due): chiedi a chi ti scrive quando scade o si rinnova" };
	if (f.due?.note !== undefined) notes.push(f.due.note);
	let months = f.months ?? old?.months;
	if (months === undefined) {
		months = 12;
		notes.push("Frequenza non detta: ho messo annuale. Se è un'altra (mensile, trimestrale…), correggila con op edit (frequency).");
	}
	const pick = <T>(given: T | null | undefined, before: T | undefined): T | undefined => (given === null ? undefined : (given ?? before));
	const provider = pick(f.provider, old?.provider);
	const note = pick(f.note, old?.note);
	const noticeDays = pick(f.noticeDays, old?.noticeDays);
	let autoRenew = f.autoRenew ?? old?.autoRenew ?? false;
	if (f.autoRenew === undefined && f.noticeDays !== undefined && f.noticeDays !== null && !autoRenew) {
		autoRenew = true;
		notes.push("Con il preavviso di disdetta l'ho segnato come rinnovo tacito: se non si rinnova da solo, correggi con op edit (auto_renew false).");
	}
	if (!autoRenew && noticeDays !== undefined) notes.push("Il preavviso di disdetta conta solo per quello che si rinnova da solo: senza rinnovo tacito non lo uso.");
	const category = f.category?.category ?? old?.category ?? guessCategory(name, provider, note);
	if (f.category?.unmatched === true) notes.push(`La categoria detta non è tra quelle che uso: l'ho messa in «altro». Le categorie: ${CATEGORIES.join(", ")}.`);
	const optional = {
		provider,
		amount: pick(f.amount, old?.amount),
		noticeDays,
		remindDays: pick(f.remindDays, old?.remindDays),
		method: pick(f.method, old?.method),
		note,
		document: pick(f.document, old?.document),
	};
	const draft = { name, category, months, due: due.date, day: due.day, autoRenew, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) } as RenewalDraft;
	return { draft, notes };
}

/** Whether an edit's arguments change anything at all. */
export function editsSomething(args: Record<string, unknown>): boolean {
	return EDIT_FIELDS.some((k) => args[k] !== undefined);
}
