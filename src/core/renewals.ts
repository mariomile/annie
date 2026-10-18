/**
 * Rinnovi e abbonamenti: the costs and deadlines that come back (software, domains, insurance,
 * rent and leasing, utilities, memberships, licences, service contracts), numbered R-0001 (no
 * year: a renewal lives across years).
 *
 * A renewal has its payment schedule (`due`: the next payment not confirmed yet, every `months`
 * months, keeping day `day` of the month: a due on the 31st is 28/29 February, then 31 March) and,
 * when the contract's term differs from how often one pays, its term (`termMonths`, ending on
 * `termEnd`). Two independent flags:
 * - `autoRenew`: the contract renews unless it is cancelled (rinnovo tacito), with a notice
 *   period for the disdetta (`noticeDays` or `noticeMonths`).
 * - `autoPay`: the money leaves by itself (a card or PayPal charged, a direct debit: addebito,
 *   RID, SDD, domiciliazione).
 * The dates that move by themselves (renewal-dates.ts effectiveDue) are worked out when read and
 * written back only on the next change. Kept per instance in `renewals.json` (renewal-store.ts);
 * sums in renewal-sums.ts.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { saysPhrase, words } from "./name-keys.ts";
import { METHODS, type Method } from "./payment-methods.ts";
import { VAT_RATES, type VatRate } from "./quote-sums.ts";
import { isMarker, isText, optText } from "./stored-fields.ts";

export class RenewalError extends Error {
	override readonly name = "RenewalError";
}

export const RENEWAL_LIMITS = {
	/** Renewals kept, active and cancelled: past it, no new one. */
	items: 2000,
	/** The store file: past it, nothing more is written. */
	fileBytes: 4 * 1024 * 1024,
	name: 120,
	provider: 120,
	note: 500,
	document: 300,
	/** The longest period: ten years. */
	maxMonths: 120,
	maxNoticeDays: 365,
	maxNoticeMonths: 24,
	/** The amount in another currency as said («20 USD»), kept next to the euros. */
	originalAmount: 40,
	/** Rolls and charges remembered, for calls run again without their steps. */
	rolls: 5,
	charges: 12,
	maxRemindDays: 365,
	/** The largest amount of one period, in euros: no typo of a few zeros goes in unchecked. */
	maxAmount: 10_000_000,
} as const;

/** The renewal tool's ops that only read: they run in a brief's thread and for another agente. */
const RENEWAL_READ_OPS = ["list", "upcoming", "summary"] as const;

export function renewalCallReads(args: Record<string, unknown>): boolean {
	return RENEWAL_READ_OPS.some((o) => o === args.op);
}

export const CATEGORIES = [
	"software e abbonamenti",
	"dominio e hosting",
	"assicurazione",
	"affitto e leasing",
	"utenze",
	"telefono e internet",
	"associazioni e quote",
	"licenze e permessi",
	"contratti di servizio",
	"altro",
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Whole words (folded) and phrases that mean a category, tried in this order: the specific ones
 * first («contratto della fibra» is telefono e internet, «licenza Office» software), «abbonamento»
 * alone last (an «abbonamento palestra» is a membership).
 */
const CATEGORY_WORDS: readonly (readonly [Exclude<Category, "altro">, readonly string[]])[] = [
	["dominio e hosting", ["dominio", "domini", "hosting", "server", "vps", "sito", "sito web", "aruba", "register", "siteground", "godaddy", "ovh", "netsons", "serverplan"]],
	["assicurazione", ["assicurazione", "assicurazioni", "assicurativa", "polizza", "polizze", "rc", "rca", "rc auto", "rc professionale", "kasko", "furto e incendio", "unipol", "unipolsai", "generali", "allianz", "axa", "zurich", "reale mutua", "cattolica", "genertel", "vittoria assicurazioni", "groupama", "helvetia"]],
	["affitto e leasing", ["affitto", "affitti", "locazione", "pigione", "leasing", "noleggio", "noleggio a lungo termine", "coworking"]],
	["utenze", ["utenza", "utenze", "luce", "gas", "energia", "elettricita", "bolletta", "bollette", "bolletta acqua", "acquedotto", "tari", "rifiuti", "riscaldamento", "condominio", "enel", "hera", "a2a", "iren", "edison", "plenitude", "sorgenia"]],
	["telefono e internet", ["telefono", "telefonia", "telefonico", "cellulare", "sim", "internet", "fibra", "adsl", "wifi", "linea fissa", "tim", "vodafone", "windtre", "wind", "iliad", "fastweb", "tiscali", "ho mobile", "very mobile", "kena", "eolo"]],
	[
		"software e abbonamenti",
		["software", "saas", "app", "cloud", "pec", "canva", "adobe", "microsoft", "office", "microsoft 365", "google workspace", "dropbox", "notion", "slack", "zoom", "figma", "github", "chatgpt", "openai", "icloud", "netflix", "spotify", "sky", "dazn", "disney", "amazon prime", "linkedin premium", "fatture in cloud", "aruba pec", "antivirus", "gestionale"],
	],
	["associazioni e quote", ["associazione", "associazioni", "quota associativa", "quote associative", "tessera", "iscrizione", "albo", "ordine professionale", "ordine degli", "sindacato", "palestra", "club", "confcommercio", "confartigianato", "cna", "confesercenti"]],
	["licenze e permessi", ["licenza", "licenze", "permesso", "permessi", "autorizzazione", "concessione", "suolo pubblico", "siae", "diritto camerale", "camera di commercio", "patente", "passaporto", "porto d'armi", "certificazione"]],
	["contratti di servizio", ["contratto", "contratti", "manutenzione", "assistenza", "assistenza tecnica", "pulizie", "vigilanza", "allarme", "consulenza", "commercialista", "canone di assistenza", "servizio", "servizi"]],
];

/** Last of all: an «abbonamento» with no other word is a subscription. */
const GENERIC_SOFTWARE = ["abbonamento", "abbonamenti"];

/**
 * The category a person's words mean: a category's name («assicurazione», «Dominio e hosting»),
 * or a whole word of its list («polizza», «fibra», «Canva»). Undefined when nothing fits.
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
	if (GENERIC_SOFTWARE.some((k) => saysPhrase(tokens, k))) return "software e abbonamenti";
	return undefined;
}

export type Cancelled = Marker & {
	/** The day the disdetta was sent or said. */
	readonly on: string;
	/** The last day it is in force, when the person says it. */
	readonly ends?: string;
};

/** A due date moved on by a payment or renewal said: the call that did it (a rerun does not move it twice) and the expense recorded with it. */
export type Roll = Marker & {
	readonly callId: string;
	readonly from: string;
	readonly to: string;
	readonly expense?: string;
	/** The call that recorded that expense (renewed with record_expense on a roll of the same day). */
	readonly expenseCall?: string;
};

/** A charge of an autoPay renewal recorded as an expense: its date, the call and the expense. */
export type Charge = { readonly date: string; readonly callId: string; readonly expense: string };

export type Renewal = Marker & {
	/** «R-0001». */
	readonly id: string;
	readonly name: string;
	readonly provider?: string;
	readonly category: Category;
	/** The amount of one payment, VAT included: a canonical decimal string («480»), at most 2 decimals. */
	readonly amount?: string;
	/** The VAT rate the amount includes, when said: passed to the expense of a payment. */
	readonly vatRate?: VatRate;
	/** The amount as said in another currency («20 USD»): `amount` is then the euros the person said. */
	readonly originalAmount?: string;
	/** A new amount from a payment date on («dal 1° gennaio costa 15 €»). */
	readonly amountFrom?: { readonly amount: string; readonly from: string };
	/** How often one pays, in months: 1 mensile, 3 trimestrale, 12 annuale, 24 biennale… */
	readonly months: number;
	/** ISO day of the next payment not confirmed yet (for autoPay: the next charge, as of the last write). */
	readonly due: string;
	/** The day of the month the due date keeps when it rolls (31: always the month's last day). */
	readonly day: number;
	/** The first due date known (the first charge of an autoPay renewal): no charge before it. */
	readonly start?: string;
	/** The contract's term in months when it is not how often one pays (a yearly contract paid monthly). */
	readonly termMonths?: number;
	/** The end of the current term (with termMonths). */
	readonly termEnd?: string;
	/** Rinnovo tacito: the contract renews unless cancelled. */
	readonly autoRenew: boolean;
	/** The money leaves by itself (card, PayPal, direct debit). Missing on renewals of the first version: false. */
	readonly autoPay?: boolean;
	/** A free trial that ends on the first due date. */
	readonly trial?: boolean;
	/** The disdetta notice: days, or months (the deadline then the same day N months before). */
	readonly noticeDays?: number;
	readonly noticeMonths?: number;
	/** Days before a due date (or a disdetta deadline) it starts being said in the brief; a default by period when missing. */
	readonly remindDays?: number;
	readonly method?: Method;
	readonly note?: string;
	/** The contract or policy in the workspace, a relative path: never its content. */
	readonly document?: string;
	readonly status: "active" | "cancelled";
	readonly cancelled?: Cancelled;
	/** The last rolls, newest last. */
	readonly rolls?: readonly Roll[];
	/** The last charges recorded as expenses, newest last. */
	readonly charges?: readonly Charge[];
	/** The tool call that recorded it: a call run again finds it instead of recording another. */
	readonly callId?: string;
	/** The last call that changed it (edit, cancel, reactivate): a call run again answers as the first time. */
	readonly lastCall?: string;
	readonly edited?: Marker;
};

/** «R-0001». */
export function renewalId(n: number): string {
	return `R-${String(n).padStart(4, "0")}`;
}

const ID = /^R-(\d{4,6})$/;

/** The progressive of an id; 0 when it is none. */
export function idNumber(id: string): number {
	const m = ID.exec(id);
	return m === null ? 0 : Number(m[1]);
}

const SAID_ID = /^(?:r(?:innovo)?\s*[-.]?\s*)?(?:n(?:r|um(?:ero)?)?\.?\s*)?0*(\d{1,6})$/i;

/** The progressive of an id as a person writes it: «R-0001», «R1», «rinnovo 12», «12». */
export function parseRenewalId(text: string): number | undefined {
	const m = SAID_ID.exec(text.trim());
	if (m === null || Number(m[1]) === 0) return undefined;
	return Number(m[1]);
}

/** Articles, prepositions and possessives: no word of a name. */
const STOP_WORDS = new Set(
	"il lo la i gli le l un uno una un di a da in con su per tra fra del dello della dei degli delle dell al allo alla ai agli alle all dal dallo dalla dai dagli dalle dall nel nello nella nei negli nelle nell sul sullo sulla sui sugli sulle sull d mio mia miei mie tuo tua tuoi tue suo sua suoi sue nostro nostra nostri nostre vostro vostra vostri vostre loro".split(" "),
);

/** Words people put before a name that the name may or may not hold: dropped when it does not. */
const GENERIC_WORDS = new Set(["abbonamento", "abbonamenti", "rinnovo", "rinnovi", "contratto", "contratti", "polizza", "polizze", "assicurazione", "assicurazioni"]);

/**
 * Whether a renewal is named by the words given: all of them, as whole words of its name or
 * provider, after dropping articles, prepositions and possessives, and the generic words
 * (abbonamento, rinnovo, contratto, polizza, assicurazione) the name does not hold. «l'assicurazione
 * dell'auto» names «Assicurazione auto», «abbonamento Canva» names «Canva Pro», «net» names nothing.
 */
export function matchesName(r: Renewal, text: string): boolean {
	const have = new Set([...words(r.name), ...(r.provider === undefined ? [] : words(r.provider))]);
	const wanted = words(text).filter((w) => !STOP_WORDS.has(w) && (!GENERIC_WORDS.has(w) || have.has(w)));
	return wanted.length > 0 && wanted.every((w) => have.has(w));
}

/** The renewals a person's words name: an id, or the words of a name. */
export function findRenewals(all: readonly Renewal[], text: string): Renewal[] {
	const n = parseRenewalId(text);
	if (n !== undefined) return all.filter((r) => idNumber(r.id) === n);
	return all.filter((r) => matchesName(r, text));
}

/**
 * An active renewal already recorded that `r` looks like: the same name, one inside the other as
 * whole words, and the same provider when both have one. Said to the person, never refused.
 */
export function lookalike(all: readonly Renewal[], r: Renewal): string | undefined {
	const key = (text: string) => words(text).join(" ");
	const within = (a: string, b: string) => a !== "" && b !== "" && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
	for (const other of all) {
		if (other.id === r.id || other.status !== "active") continue;
		if (!within(key(other.name), key(r.name))) continue;
		if (other.provider !== undefined && r.provider !== undefined && key(other.provider) !== key(r.provider)) continue;
		return other.id;
	}
	return undefined;
}


/** A contract's or policy's file: a PDF, a photo, a Word or OpenDocument file, a signed .p7m. */
export const DOCUMENT_FILE = /\.(?:pdf|jpe?g|png|webp|heic|heif|tiff?|docx?|odt|p7m|txt)$/i;

/** A document path as stored: relative, no «..», no hidden names, a document's extension. */
export function validDocumentPath(path: unknown): path is string {
	if (!isText(path, RENEWAL_LIMITS.document) || path.startsWith("/") || path.includes("\\")) return false;
	const parts = path.split("/");
	return parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.startsWith(".")) && DOCUMENT_FILE.test(path);
}

const AMOUNT = /^\d{1,8}(?:\.\d{1,2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && realDate(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isAmount = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && Number(v) > 0 && Number(v) <= RENEWAL_LIMITS.maxAmount;
const EXPENSE_ID = /^S-\d{4}-\d{4,6}$/;

function validRoll(v: unknown): boolean {
	const r = v as Roll;
	return isMarker(v) && isText(r.callId, 200) && isDay(r.from) && isDay(r.to) && (r.expense === undefined || (typeof r.expense === "string" && EXPENSE_ID.test(r.expense))) && optText(r.expenseCall, 200);
}

function validCharge(v: unknown): boolean {
	const c = v as Charge;
	return typeof v === "object" && v !== null && isDay(c.date) && isText(c.callId, 200) && typeof c.expense === "string" && EXPENSE_ID.test(c.expense);
}

/** A renewal as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validRenewal(v: unknown): v is Renewal {
	if (!isMarker(v)) return false;
	const r = v as Renewal;
	if (typeof r.id !== "string" || !ID.test(r.id)) return false;
	if (!isText(r.name, RENEWAL_LIMITS.name) || !optText(r.provider, RENEWAL_LIMITS.provider) || !optText(r.note, RENEWAL_LIMITS.note) || !optText(r.callId, 200)) return false;
	if (!CATEGORIES.includes(r.category)) return false;
	if (r.amount !== undefined && !isAmount(r.amount)) return false;
	if (!isInt(r.months, 1, RENEWAL_LIMITS.maxMonths) || !isInt(r.day, 1, 31) || !isDay(r.due)) return false;
	if (typeof r.autoRenew !== "boolean") return false;
	if (r.noticeDays !== undefined && !isInt(r.noticeDays, 1, RENEWAL_LIMITS.maxNoticeDays)) return false;
	if (r.noticeMonths !== undefined && (!isInt(r.noticeMonths, 1, RENEWAL_LIMITS.maxNoticeMonths) || r.noticeDays !== undefined)) return false;
	if (r.vatRate !== undefined && !VAT_RATES.includes(r.vatRate)) return false;
	if (!optText(r.originalAmount, RENEWAL_LIMITS.originalAmount) || !optText(r.lastCall, 200)) return false;
	if (r.amountFrom !== undefined && (typeof r.amountFrom !== "object" || r.amountFrom === null || !isAmount(r.amountFrom.amount) || !isDay(r.amountFrom.from))) return false;
	if (r.start !== undefined && !isDay(r.start)) return false;
	if ((r.termMonths === undefined) !== (r.termEnd === undefined)) return false;
	if (r.termMonths !== undefined && (!isInt(r.termMonths, 1, RENEWAL_LIMITS.maxMonths) || !isDay(r.termEnd))) return false;
	if ((r.autoPay !== undefined && typeof r.autoPay !== "boolean") || (r.trial !== undefined && typeof r.trial !== "boolean")) return false;
	if (r.remindDays !== undefined && !isInt(r.remindDays, 0, RENEWAL_LIMITS.maxRemindDays)) return false;
	if (r.method !== undefined && !METHODS.includes(r.method)) return false;
	if (r.document !== undefined && !validDocumentPath(r.document)) return false;
	if (r.status !== "active" && r.status !== "cancelled") return false;
	if ((r.status === "cancelled") !== (r.cancelled !== undefined)) return false;
	if (r.cancelled !== undefined && (!isMarker(r.cancelled) || !isDay(r.cancelled.on) || (r.cancelled.ends !== undefined && !isDay(r.cancelled.ends)))) return false;
	if (r.rolls !== undefined && (!Array.isArray(r.rolls) || r.rolls.length > RENEWAL_LIMITS.rolls || !r.rolls.every(validRoll))) return false;
	if (r.charges !== undefined && (!Array.isArray(r.charges) || r.charges.length > RENEWAL_LIMITS.charges || !r.charges.every(validCharge))) return false;
	return r.edited === undefined || isMarker(r.edited);
}
