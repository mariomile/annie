/**
 * The renewal tool's arguments, read and checked: the name and provider, the category matched
 * from the person's words (or guessed from the name's whole words, «altro» when none fits), the
 * amount of one payment, the frequency (how often one pays), the next due date (renewal-dates.ts),
 * the contract's own term, the tacit renewal and its notice (days or months), whether the money
 * leaves by itself, a free trial, a new price from a date, the reminder days, the payment method,
 * the note and the contract's file in the workspace (its path only).
 *
 * The amount stored is what is paid, VAT included. Said VAT excluded («100 + IVA», «IVA esclusa»,
 * or vat_excluded) with its vat_rate, it is the net plus the VAT on it rounded half up to the cent
 * (bigint cents); the rate is kept for the expense of a payment. Said in another currency, the
 * person's approximate euros go in amount and the amount as said in original_amount.
 *
 * Reading (readFields) is apart from applying (applyFields): an edit applies only the fields
 * given, to the renewal as saved under the store's lock.
 */
import { foreignCurrency } from "../currency-words.ts";
import { daysBetween } from "../italian-calendar.ts";
import { capitalized, withDate } from "../italian-format.ts";
import { normalPath } from "../invoices.ts";
import { automaticPayment, type Method } from "../payment-methods.ts";
import { centsDecimal, halfUp, scaled, VAT_RATES, type VatRate } from "../quote-sums.ts";
import { type Due, effectiveDue, parseFrequency, placeDue, readDue } from "../renewal-dates.ts";
import { CATEGORIES, type Category, DOCUMENT_FILE, matchCategory, RENEWAL_LIMITS, type Renewal, validDocumentPath } from "../renewals.ts";
import type { Workspace } from "../workspace.ts";
import { readEuros } from "../money-input.ts";
import { readCategoryWith, readMethod } from "./field-input.ts";
import { readAmount } from "./quote-input.ts";
import { cleanText, isProblem, type Problem } from "../text-input.ts";
import { fenced } from "./renewal-render.ts";

/** What a renewal holds besides its id, who recorded it and its state. */
export type RenewalDraft = Omit<Renewal, "id" | "by" | "at" | "callId" | "edited" | "status" | "cancelled" | "rolls" | "charges" | "lastCall">;

/** The fields an edit may change; any of them given makes it an edit. */
const EDIT_FIELDS = ["name", "provider", "category", "amount", "vat_rate", "vat_excluded", "original_amount", "frequency", "due", "term_months", "term_end", "auto_renew", "auto_pay", "trial", "notice_days", "notice_months", "remind_days", "method", "note", "document", "new_amount", "new_amount_from"] as const;

const FOREIGN =
	"l'importo è in un'altra valuta: chiedi a chi ti scrive quanto sono circa in euro (o convertilo con exchange_rate, se c'è), poi passa gli euro in amount e l'importo com'è detto in original_amount (per esempio «20 USD»)";

const EURO_WORDS = { fence: fenced, max: RENEWAL_LIMITS.maxAmount, foreign: FOREIGN, negative: "l'importo è negativo: dammi quanto si paga a ogni scadenza", zero: "l'importo è zero: se non lo sai, lascialo fuori" } as const;

/** «+ IVA», «IVA esclusa», «oltre IVA», «netto»: the amount said is before VAT. */
const VAT_EXCLUDED = /\+\s*iva\b|\biva\s+escl\w*|\besclus[ao]\s+iva\b|\boltre\s+(?:l')?iva\b|\bnett[oi]\b|\bimponibile\b/i;
/** «IVA inclusa», «IVA compresa», «ivato»: the amount said includes it, as by default. */
const VAT_INCLUDED = /\biva\s+(?:inclusa|compresa)\b|\b(?:inclusa|compresa)\s+iva\b|\bivat[oi]\b/i;

export type SaidAmount = { readonly amount: string; readonly vatRate?: VatRate; readonly excluded?: true };

function readRate(value: unknown): VatRate | undefined | Problem {
	const read = readAmount(value, 2, "vat_rate", fenced);
	if (read === undefined || isProblem(read)) return read;
	if (!VAT_RATES.includes(Number(read) as VatRate)) return { problem: `vat_rate è una di queste aliquote: ${VAT_RATES.join(", ")}` };
	return Number(read) as VatRate;
}

/**
 * The amount of one payment, VAT included: as said, or the net said («100 + IVA») with the VAT
 * at `vatRate` added, half up to the cent. Undefined when not given.
 */
export function readPeriodAmount(value: unknown, rate?: unknown, excludedArg?: unknown): SaidAmount | undefined | Problem {
	const vatRate = readRate(rate);
	if (isProblem(vatRate)) return vatRate;
	if (excludedArg !== undefined && typeof excludedArg !== "boolean") return { problem: "vat_excluded è true (l'importo detto è senza IVA) o false" };
	if (value === undefined) return excludedArg === true ? { problem: "con vat_excluded passa anche amount, l'importo senza IVA" } : undefined;
	let said = value;
	let excluded = excludedArg === true;
	if (typeof value === "string") {
		if (foreignCurrency(value)) return { problem: FOREIGN };
		if (VAT_EXCLUDED.test(value)) excluded = true;
		said = value.replace(VAT_EXCLUDED, " ").replace(VAT_INCLUDED, " ").replace(/\biva\b/gi, " ").replace(/\s+/g, " ").trim();
	}
	const euros = readEuros(said, EURO_WORDS);
	if (euros === undefined || isProblem(euros)) return euros;
	if (!excluded) return { amount: euros, ...(vatRate === undefined ? {} : { vatRate }) };
	if (vatRate === undefined) return { problem: "l'importo è senza IVA: serve l'aliquota (vat_rate 22, 10, 5 o 4) per sapere quanto si paga; chiedila a chi ti scrive" };
	const net = scaled(euros, 2);
	const gross = net + halfUp(net * BigInt(vatRate), 100n);
	if (gross > BigInt(RENEWAL_LIMITS.maxAmount) * 100n) return { problem: `l'importo è oltre ${RENEWAL_LIMITS.maxAmount.toLocaleString("it-IT")} €: ricontrollalo con chi ti scrive` };
	return { amount: centsDecimal(gross), vatRate, excluded: true };
}

export type Notice = { readonly days: number } | { readonly months: number };

/** The disdetta notice: whole days («30», «30 giorni») or months («3 mesi»). */
export function readNotice(days: unknown, months: unknown): Notice | undefined | Problem {
	if (months !== undefined) {
		if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > RENEWAL_LIMITS.maxNoticeMonths) return { problem: `notice_months è un numero intero di mesi, da 1 a ${RENEWAL_LIMITS.maxNoticeMonths}` };
		if (days !== undefined) return { problem: "il preavviso è in giorni (notice_days) o in mesi (notice_months), non tutti e due" };
		return { months };
	}
	if (days === undefined) return undefined;
	const bad = { problem: `notice_days è un numero intero di giorni, da 1 a ${RENEWAL_LIMITS.maxNoticeDays} (o «3 mesi»)` };
	if (typeof days === "number") return Number.isInteger(days) && days >= 1 && days <= RENEWAL_LIMITS.maxNoticeDays ? { days } : bad;
	if (typeof days !== "string") return bad;
	const m = /^\s*(\d{1,3}|un|uno|una|due|tre|quattro|sei)\s*(gg|giorni|giorno|mesi|mese)?\.?\s*(?:prima)?\s*$/i.exec(days);
	if (m === null) return bad;
	const n = /^\d+$/.test(m[1] as string) ? Number(m[1]) : ({ un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, sei: 6 } as Record<string, number>)[(m[1] as string).toLowerCase()];
	if (n === undefined) return bad;
	if (/^mes/i.test(m[2] ?? "")) return n >= 1 && n <= RENEWAL_LIMITS.maxNoticeMonths ? { months: n } : bad;
	return n >= 1 && n <= RENEWAL_LIMITS.maxNoticeDays ? { days: n } : bad;
}

/** Whole days, as a number or «30», «30 giorni». */
function readDays(value: unknown, name: string, min: number, max: number): number | undefined | Problem {
	if (value === undefined) return undefined;
	let n: number | undefined;
	if (typeof value === "number") n = value;
	else if (typeof value === "string") {
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
	if (!DOCUMENT_FILE.test(path)) return { problem: "document è un PDF, una foto, un Word, un OpenDocument, un .p7m o un .txt del workspace" };
	if (!validDocumentPath(path)) return { problem: "document non è un percorso valido del workspace" };
	// WorkspaceError (a link, a folder, a name outside) goes up to the tool, said as the workspace says it.
	const found = await workspace.stat(path);
	if (found === undefined) return { problem: "non trovo il documento nel workspace a quel percorso: usa il percorso del file che hai letto" };
	return found.path;
}

function readBool(value: unknown, name: string, what: string): boolean | undefined | Problem {
	if (value === undefined) return undefined;
	return typeof value === "boolean" ? value : { problem: `${name} è true (${what}) o false` };
}

/** The fields given: a value, null for «""» in an edit (removes it), undefined when not given. */
export type Fields = {
	readonly name?: string;
	readonly provider?: string | null;
	readonly category?: { readonly category: Category; readonly unmatched?: true };
	readonly amount?: SaidAmount | null;
	readonly vatRate?: VatRate;
	readonly originalAmount?: string | null;
	readonly months?: number;
	readonly due?: Due;
	readonly termMonths?: number | null;
	readonly termEnd?: Due;
	readonly autoRenew?: boolean;
	readonly autoPay?: boolean;
	readonly trial?: boolean;
	readonly notice?: Notice | null;
	readonly remindDays?: number | null;
	readonly method?: Method | null;
	/** The method as said, for the autoPay guess («carta», «addebito in conto»). */
	readonly methodText?: string;
	readonly note?: string | null;
	readonly document?: string | null;
	readonly amountFrom?: { readonly amount: string; readonly from: string } | null;
	/** What reading said back: the renewal's VAT rate kept for an amount without one, a new price already in force… */
	readonly said?: readonly string[];
};

/** The arguments read and checked, nothing applied yet. In an edit «""» removes an optional field. */
export async function readFields(args: Record<string, unknown>, o: { today: string; workspace: Workspace; editing: boolean; vatRate?: VatRate }): Promise<Fields | Problem> {
	const out: Record<string, unknown> = {};
	const said: string[] = [];
	// An amount said without a rate keeps the renewal's (an edit): the VAT worked out on it, said back.
	const rate = args.vat_rate ?? o.vatRate;
	const removed = (name: string) => o.editing && args[name] === "";
	const name = cleanText(args.name, RENEWAL_LIMITS.name, "name");
	if (isProblem(name)) return name;
	if (name !== undefined) out.name = name;
	for (const [arg, key, max, lines] of [
		["provider", "provider", RENEWAL_LIMITS.provider, false],
		["note", "note", RENEWAL_LIMITS.note, true],
		["original_amount", "originalAmount", RENEWAL_LIMITS.originalAmount, false],
	] as const) {
		if (removed(arg)) out[key] = null;
		else {
			const text = cleanText(args[arg], max, arg, lines);
			if (isProblem(text)) return text;
			if (text !== undefined) out[key] = text;
		}
	}
	const category = readCategoryWith(args.category, matchCategory, "altro");
	if (isProblem(category)) return category;
	if (category !== undefined) out.category = category;
	if (removed("amount")) out.amount = null;
	else {
		const amount = readPeriodAmount(args.amount, rate, args.vat_excluded);
		if (isProblem(amount)) return amount;
		if (amount !== undefined) {
			out.amount = amount;
			if (args.vat_rate === undefined && o.vatRate !== undefined) said.push(`Ho tenuto l'aliquota IVA del rinnovo (${o.vatRate}%)${amount.excluded === true ? ", aggiunta all'importo detto senza IVA" : ", inclusa nell'importo detto"}: se è cambiata, correggi con op edit (vat_rate).`);
		}
		else if (args.vat_rate !== undefined) {
			const rate = readRate(args.vat_rate);
			if (isProblem(rate)) return rate;
			out.vatRate = rate;
		}
	}
	if (out.originalAmount !== undefined && out.originalAmount !== null && out.amount === undefined && !o.editing) return { problem: "con original_amount passa in amount gli euro che dice chi ti scrive" };
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
	if (removed("term_months")) out.termMonths = null;
	else if (args.term_months !== undefined) {
		const term = parseFrequency(args.term_months);
		if (isProblem(term)) return { problem: "term_months è la durata del contratto in mesi (12, «annuale», «2 anni»)" };
		out.termMonths = term;
	}
	if (args.term_end !== undefined) {
		const end = readDue(args.term_end, o.today);
		if (isProblem(end)) return { problem: `term_end: ${end.problem}` };
		out.termEnd = end;
	}
	for (const [arg, key, what] of [
		["auto_renew", "autoRenew", "il contratto si rinnova da solo se non lo disdici"],
		["auto_pay", "autoPay", "i soldi partono da soli: carta, PayPal, addebito in conto"],
		["trial", "trial", "è una prova gratuita che finisce alla scadenza"],
	] as const) {
		const v = readBool(args[arg], arg, what);
		if (isProblem(v)) return v;
		if (v !== undefined) out[key] = v;
	}
	if (removed("notice_days") || removed("notice_months")) out.notice = null;
	else {
		const notice = readNotice(args.notice_days, args.notice_months);
		if (isProblem(notice)) return notice;
		if (notice !== undefined) out.notice = notice;
	}
	if (removed("remind_days")) out.remindDays = null;
	else {
		const days = readDays(args.remind_days, "remind_days", 0, RENEWAL_LIMITS.maxRemindDays);
		if (isProblem(days)) return days;
		if (days !== undefined) out.remindDays = days;
	}
	if (removed("method")) out.method = null;
	else {
		const method = readMethod(args.method);
		if (isProblem(method)) return method;
		if (method !== undefined) {
			out.method = method;
			out.methodText = String(args.method);
		}
	}
	if (removed("document")) out.document = null;
	else {
		const document = await readDocument(args.document, o.workspace);
		if (isProblem(document)) return document;
		if (document !== undefined) out.document = document;
	}
	if (removed("new_amount")) out.amountFrom = null;
	else if (args.new_amount !== undefined || args.new_amount_from !== undefined) {
		const amount = readPeriodAmount(args.new_amount, rate);
		if (isProblem(amount)) return { problem: `new_amount: ${amount.problem}` };
		if (amount === undefined || args.new_amount_from === undefined) return { problem: "per un cambio di prezzo passa new_amount (il nuovo importo) e new_amount_from (da quale scadenza)" };
		if (amount.excluded === true) said.push(`Il nuovo importo era senza IVA: ho salvato quanto si paga, IVA ${amount.vatRate}% inclusa.`);
		const from = readDue(args.new_amount_from, o.today);
		if (isProblem(from)) return { problem: `new_amount_from: ${from.problem}` };
		// A day without a year gone this year, in the last three months: the new price is in force
		// already («dal 1° ottobre costa 15» said on the 18th). Further back it is the next one
		// («dal 1° gennaio» said in October is next January).
		let since = from.date;
		if (from.yearless === true && from.previous !== undefined && from.previous.slice(0, 4) === o.today.slice(0, 4) && daysBetween(from.previous, o.today) <= 92) {
			since = from.previous;
			said.push(`${capitalized(withDate("il", since))} è già passato: il nuovo importo vale già da allora. Se intendeva ${withDate("il", from.date)}, correggi con op edit (new_amount_from ${from.date.split("-").reverse().join("/")}).`);
		}
		out.amountFrom = { amount: amount.amount, from: since };
	}
	if (said.length > 0) out.said = said;
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
 * The fields applied: on nothing for a new renewal (name and due date needed; monthly when the
 * due date is a day of every month, annuale otherwise, said back), or on `old`, the renewal as
 * saved now, changing only what is given. A notice given without auto_renew means a tacit
 * renewal. auto_pay not given is guessed true only for a tacit renewal paid with words that leave
 * by themselves (carta, PayPal, addebito, RID, SDD, domiciliazione), and said back.
 */
export function applyFields(f: Fields, old: Renewal | undefined, today: string): { draft: RenewalDraft; notes: string[] } | Problem {
	const notes: string[] = [...(f.said ?? [])];
	const name = f.name ?? old?.name;
	if (name === undefined) return { problem: "manca il nome (name): cos'è che si rinnova, per esempio «Assicurazione auto» o «Canva»" };
	let months = f.months ?? old?.months;
	if (months === undefined) {
		months = f.due?.monthly === true ? 1 : 12;
		notes.push(months === 1 ? "Frequenza non detta: dalla scadenza «ogni mese» ho messo mensile." : "Frequenza non detta: ho messo annuale. Se è un'altra (mensile, trimestrale…), correggila con op edit (frequency).");
	}
	let due: Due | undefined = f.due === undefined ? undefined : placeDue(f.due, months, today);
	if (due === undefined && old !== undefined) due = { date: old.due, day: old.day };
	if (due === undefined) return { problem: "manca la prossima scadenza (due): chiedi a chi ti scrive quando scade o si rinnova" };
	if (due.note !== undefined) notes.push(due.note);
	const pick = <T>(given: T | null | undefined, before: T | undefined): T | undefined => (given === null ? undefined : (given ?? before));
	const provider = pick(f.provider, old?.provider);
	const note = pick(f.note, old?.note);
	const notice: Notice | undefined = f.notice === null ? undefined : (f.notice ?? (old?.noticeMonths !== undefined ? { months: old.noticeMonths } : old?.noticeDays !== undefined ? { days: old.noticeDays } : undefined));
	let autoRenew = f.autoRenew ?? old?.autoRenew ?? false;
	if (f.autoRenew === undefined && f.notice !== undefined && f.notice !== null && !autoRenew) {
		autoRenew = true;
		notes.push("Con il preavviso di disdetta l'ho segnato come contratto che si rinnova da solo: se non è così, correggi con op edit (auto_renew false).");
	}
	let autoPay = f.autoPay ?? old?.autoPay;
	if (f.autoPay === undefined && old?.autoPay === undefined && autoRenew && f.methodText !== undefined && automaticPayment(f.methodText)) {
		autoPay = true;
		notes.push("Dal pagamento detto l'ho segnato come addebito automatico (i soldi partono da soli). Di' a chi ti scrive: «Ho segnato che si paga da solo: se non è così, dimmelo.» Se non è così, correggi con op edit (auto_pay false).");
	}
	const termMonths = pick(f.termMonths, old?.termMonths);
	let termEnd = f.termEnd !== undefined ? f.termEnd.date : termMonths === undefined ? undefined : old?.termEnd;
	if (termMonths !== undefined && termEnd === undefined) return { problem: "con term_months serve term_end: quando finisce il contratto in corso" };
	if (termMonths === undefined) termEnd = undefined;
	const termDay = termEnd === undefined ? undefined : f.termEnd !== undefined ? f.termEnd.day : old?.termDay;
	if (termMonths !== undefined && termMonths === months && f.termMonths !== undefined) notes.push("La durata del contratto è uguale alla frequenza dei pagamenti: term_months non serve, lo tengo comunque.");
	const amount = f.amount === null ? undefined : f.amount;
	const amountValue = amount?.amount ?? (f.amount === null ? undefined : old?.amount);
	const vatRate = amount !== undefined ? amount.vatRate : f.amount === null ? undefined : (f.vatRate ?? old?.vatRate);
	if (amount?.excluded === true) notes.push("L'importo era senza IVA: ho salvato quanto si paga, IVA inclusa. Ripetilo come è scritto.");
	const originalAmount = pick(f.originalAmount, f.amount !== undefined && f.originalAmount === undefined ? undefined : old?.originalAmount);
	const trial = f.trial ?? old?.trial;
	const category = f.category?.category ?? old?.category ?? guessCategory(name, provider, note);
	if (f.category?.unmatched === true) notes.push(`La categoria detta non è tra quelle che uso: l'ho messa in «altro». Le categorie: ${CATEGORIES.join(", ")}.`);
	if (!autoRenew && notice !== undefined) notes.push("Il preavviso di disdetta conta solo per un contratto che si rinnova da solo: così non lo uso.");
	if (due.past === true && f.due !== undefined) notes.push(autoPay === true || autoRenew ? "La scadenza detta è già passata: la porto avanti da sola alla prossima." : "La scadenza detta è già passata: lo segno come scaduto, da confermare. Se è già stato pagato, segnalo con op renewed.");
	let start = f.due !== undefined ? due.date : (old?.start ?? old?.due ?? due.date);
	// Turned to paid by itself with the due date gone: the periods gone are not taken as charged.
	if (old !== undefined && autoPay === true && old.autoPay !== true && f.due === undefined && old.due < today) {
		const next = effectiveDue({ ...old, autoPay: true, status: "active" }, today);
		due = { date: next, day: old.day };
		start = next;
		notes.push(`Le scadenze passate (${withDate("dal", old.due)}) non le conto come addebitate: il primo addebito che conto è ${withDate("il", next)}. Se quelle sono state pagate o sono da pagare, chiedilo a chi ti scrive e registrale con expenses op add.`);
	}
	const optional = {
		provider,
		amount: amountValue,
		vatRate: amountValue === undefined ? undefined : vatRate,
		originalAmount: amountValue === undefined ? undefined : originalAmount,
		amountFrom: pick(f.amountFrom, old?.amountFrom),
		termMonths,
		termEnd,
		termDay,
		autoPay,
		trial: trial === true ? true : undefined,
		noticeDays: notice !== undefined && "days" in notice ? notice.days : undefined,
		noticeMonths: notice !== undefined && "months" in notice ? notice.months : undefined,
		remindDays: pick(f.remindDays, old?.remindDays),
		method: pick(f.method, old?.method),
		note,
		document: pick(f.document, old?.document),
	};
	const draft = { name, category, months, due: due.date, day: due.day, start, autoRenew, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) } as RenewalDraft;
	return { draft, notes };
}

/** Whether an edit's arguments change anything at all. */
export function editsSomething(args: Record<string, unknown>): boolean {
	return EDIT_FIELDS.some((k) => args[k] !== undefined);
}
