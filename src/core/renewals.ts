/**
 * Rinnovi e abbonamenti: the costs and deadlines that come back (software, domains, insurance,
 * rent and leasing, utilities, memberships, licences, service contracts), numbered R-0001 (no
 * year: a renewal lives across years). Each has its next due date, how many months a period is
 * (1 mensile … 12 annuale, 24 biennale, or any N), the day of the month it keeps (`day`: a due on
 * the 31st rolls to 28/29 February and back to 31 March), the amount per period VAT included
 * when known, and whether it renews by itself (rinnovo tacito) with a notice period (disdetta).
 * A due date that passed is never moved silently: it stays «scaduto» until the person says it was
 * paid or renewed (op renewed, one period per call) or cancelled. Kept per instance in
 * `renewals.json` (renewal-store.ts); dates in renewal-dates.ts, sums in renewal-sums.ts.
 */
import { realDate } from "./italian-calendar.ts";
import type { Marker } from "./marker.ts";
import { METHODS, type Method } from "./expenses.ts";
import { words } from "./name-keys.ts";
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

export { METHODS, type Method };

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

/** Whether the words hold `key`, a whole word or a phrase of whole words in a row. */
function says(tokens: readonly string[], key: string): boolean {
	const parts = words(key);
	for (let i = 0; i + parts.length <= tokens.length; i++) {
		if (parts.every((p, j) => tokens[i + j] === p)) return true;
	}
	return false;
}

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
		if (keys.some((k) => says(tokens, k))) return category;
	}
	if (GENERIC_SOFTWARE.some((k) => says(tokens, k))) return "software e abbonamenti";
	return undefined;
}

export type Cancelled = Marker & {
	/** The day the disdetta was sent or said. */
	readonly on: string;
	/** The last day it is in force, when the person says it. */
	readonly ends?: string;
};

/** The last time the due date was moved on by a payment or renewal: the call that did it, so a rerun does not move it twice. */
export type Roll = Marker & {
	readonly callId: string;
	readonly from: string;
	readonly to: string;
};

export type Renewal = Marker & {
	/** «R-0001». */
	readonly id: string;
	readonly name: string;
	readonly provider?: string;
	readonly category: Category;
	/** The amount of one period, VAT included: a canonical decimal string («480»), at most 2 decimals. */
	readonly amount?: string;
	/** Months in a period: 1 mensile, 3 trimestrale, 12 annuale, 24 biennale… */
	readonly months: number;
	/** ISO day of the next due date (or the one passed, still to be confirmed). */
	readonly due: string;
	/** The day of the month the due date keeps when it rolls (31: always the month's last day). */
	readonly day: number;
	/** Rinnovo tacito: it renews by itself unless cancelled in time. */
	readonly autoRenew: boolean;
	/** Days before the due date the disdetta must be sent by (with autoRenew). */
	readonly noticeDays?: number;
	/** Days before a due date (or a disdetta deadline) it starts being said in the brief; a default by period when missing. */
	readonly remindDays?: number;
	readonly method?: Method;
	readonly note?: string;
	/** The contract or policy in the workspace, a relative path: never its content. */
	readonly document?: string;
	readonly status: "active" | "cancelled";
	readonly cancelled?: Cancelled;
	readonly lastRoll?: Roll;
	/** The tool call that recorded it: a call run again finds it instead of recording another. */
	readonly callId?: string;
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

/**
 * The renewals whose name (or provider) holds all the words given, as whole words: «Netflix»
 * names «Netflix Premium», «auto» names «Assicurazione auto», «net» names nothing.
 */
export function matchesName(r: Renewal, text: string): boolean {
	const wanted = words(text);
	if (wanted.length === 0) return false;
	const have = new Set([...words(r.name), ...(r.provider === undefined ? [] : words(r.provider))]);
	return wanted.every((w) => have.has(w));
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

/** Soonest due first, then by id. */
export function soonestFirst(a: Renewal, b: Renewal): number {
	return a.due.localeCompare(b.due) || idNumber(a.id) - idNumber(b.id);
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

/** A renewal as stored, checked field by field: what does not have this shape makes the store unreadable. */
export function validRenewal(v: unknown): v is Renewal {
	if (!isMarker(v)) return false;
	const r = v as Renewal;
	if (typeof r.id !== "string" || !ID.test(r.id)) return false;
	if (!isText(r.name, RENEWAL_LIMITS.name) || !optText(r.provider, RENEWAL_LIMITS.provider) || !optText(r.note, RENEWAL_LIMITS.note) || !optText(r.callId, 200)) return false;
	if (!CATEGORIES.includes(r.category)) return false;
	if (r.amount !== undefined && (typeof r.amount !== "string" || !AMOUNT.test(r.amount) || Number(r.amount) <= 0 || Number(r.amount) > RENEWAL_LIMITS.maxAmount)) return false;
	if (!isInt(r.months, 1, RENEWAL_LIMITS.maxMonths) || !isInt(r.day, 1, 31) || !isDay(r.due)) return false;
	if (typeof r.autoRenew !== "boolean") return false;
	if (r.noticeDays !== undefined && !isInt(r.noticeDays, 1, RENEWAL_LIMITS.maxNoticeDays)) return false;
	if (r.remindDays !== undefined && !isInt(r.remindDays, 0, RENEWAL_LIMITS.maxRemindDays)) return false;
	if (r.method !== undefined && !METHODS.includes(r.method)) return false;
	if (r.document !== undefined && !validDocumentPath(r.document)) return false;
	if (r.status !== "active" && r.status !== "cancelled") return false;
	if ((r.status === "cancelled") !== (r.cancelled !== undefined)) return false;
	if (r.cancelled !== undefined && (!isMarker(r.cancelled) || !isDay(r.cancelled.on) || (r.cancelled.ends !== undefined && !isDay(r.cancelled.ends)))) return false;
	if (r.lastRoll !== undefined && (!isMarker(r.lastRoll) || !isText(r.lastRoll.callId, 200) || !isDay(r.lastRoll.from) || !isDay(r.lastRoll.to))) return false;
	return r.edited === undefined || isMarker(r.edited);
}
