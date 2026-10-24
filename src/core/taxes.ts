/**
 * Le tasse del forfettario: how much to put aside, the imposta sostitutiva and the INPS
 * contributions of a year, the next F24 and what another incasso would leave. Only the regime
 * forfettario is estimated; for the ordinario the deadlines are said without amounts. What is kept
 * is the person's profile (coefficient, rate, pension, start year) and the figures they say per
 * year (last year's imposta and contributi, the acconti paid, the contributions paid, what they
 * put aside), in `taxes.json` (tax-store.ts). The incassi are read from the scadenzario's paid
 * marks, by cash (the day marked paid), never written. The arithmetic in tax-sums.ts.
 *
 * Every default and threshold below is a constant with its source. Every number is an estimate to
 * check with the commercialista, and the answers say so.
 */
import type { Marker } from "./marker.ts";
import { words } from "./name-keys.ts";
import { isMarker, optText } from "./stored-fields.ts";

export class TaxError extends Error {
	override readonly name = "TaxError";
}

/**
 * Coefficienti di redditività by ATECO group: L. 190/2014, allegato 4, as replaced by L. 208/2015
 * (legge di stabilità 2016), in force since 2016.
 */
export const GROUPS = {
	alimentari: { label: "industrie alimentari e delle bevande", coefficient: "40" },
	commercio: { label: "commercio all'ingrosso e al dettaglio", coefficient: "40" },
	ambulante_alimentari: { label: "commercio ambulante di prodotti alimentari e bevande", coefficient: "40" },
	ambulante_altro: { label: "commercio ambulante di altri prodotti", coefficient: "54" },
	costruzioni: { label: "costruzioni e attività immobiliari", coefficient: "86" },
	intermediari: { label: "intermediari del commercio", coefficient: "62" },
	alloggio_ristorazione: { label: "attività dei servizi di alloggio e di ristorazione", coefficient: "40" },
	professionali: { label: "attività professionali, scientifiche, tecniche, sanitarie, di istruzione, servizi finanziari ed assicurativi", coefficient: "78" },
	altre: { label: "altre attività economiche", coefficient: "67" },
} as const;
export type Group = keyof typeof GROUPS;
export const GROUP_KEYS = Object.keys(GROUPS) as Group[];

/** Imposta sostitutiva: 15%; 5% for the first 5 tax years of a new activity with the requisites (L. 190/2014, art. 1, commi 64-65, as amended by L. 208/2015). */
export const RATE_FULL = "15";
export const RATE_START = "5";
export const START_RATE_YEARS = 5;

/** Gestione separata INPS, professionisti without other cover: 26,07% (25% IVS + 0,72% + 0,35%), unchanged for 2026 (INPS circolare 8/2026). Editable by the person. */
export const GS_RATE_DEFAULT = "26.07";
export const GS_RATE_YEAR = 2026;
/** Massimale contributivo of the gestione separata, the reddito over which no contribution is due: 2024 119.650 €, 2025 120.607 €, 2026 122.295 € (INPS circolari annuali; 2026 circolare 8/2026). A year not here takes the closest year before it (or the first), and the answer says so. */
export const GS_MASSIMALE: Readonly<Record<number, string>> = { 2024: "119650", 2025: "120607", 2026: "122295" };

/** Riduzione contributiva del 35% for artigiani and commercianti in the forfettario, on the fixed and the variable contributions: L. 190/2014, art. 1, commi 76-84. */
export const ARTIGIANI_REDUCTION_PERCENT = 35;
/** Riduzione del 50% for 36 months for those first registered with INPS as artigiani or commercianti in 2025, instead of the 35% (L. 207/2024, Legge di Bilancio 2025, art. 1, comma 186). Da verificare with the commercialista. */
export const NEW_2025_REDUCTION_PERCENT = 50;
/** The last year of the 50%: 36 months from a registration in 2025, counted as through 2027 (da verificare: from the month of registration it ends during 2028). Then the 35% with the reduction, else none. */
export const NEW_2025_LAST_YEAR = 2027;
/** The year of the first INPS registration that gives the 50%. */
export const NEW_2025_YEAR = 2025;
/**
 * INPS artigiani e commercianti of a year (INPS circolare 14/2026, as reported by partitaiva.it):
 * the reddito minimale; the fixed contributions on it, whole, before any reduction; the rate on the
 * reddito over the minimale up to `top`, and IVS_TOP_EXTRA points more above it. Looked up for the
 * year computed, never stored in the profile; a year not here takes the closest year before it (or
 * the first), and the answer says to check.
 */
export const IVS_YEARS: Readonly<Record<number, { readonly minimale: string; readonly top: string; readonly fixed: { readonly artigiani: string; readonly commercianti: string }; readonly rate: { readonly artigiani: string; readonly commercianti: string } }>> = {
	2026: { minimale: "18808", top: "56224", fixed: { artigiani: "4521.36", commercianti: "4611.64" }, rate: { artigiani: "24", commercianti: "24.48" } },
};
export const IVS_TOP_EXTRA = "1";
/** Artigiani and commercianti: the acconti on the part over the minimale are 100% of last year's, in two equal instalments on the imposte's deadlines (INPS, circolare annuale artigiani e commercianti). */
export const IVS_ACCONTO_FIRST_PERCENT = 50n;

/** Ricavi limits, by cash: past 85.000 € the forfettario ends the next year; past 100.000 € it ends at once, in the same year (L. 190/2014, art. 1, commi 54 e 71, as amended by L. 197/2022). */
export const LIMIT_CENTS = 8_500_000n;
export const HARD_LIMIT_CENTS = 10_000_000n;
/** Owni warns from this share of the 85.000 € limit, in percent; the brief again at each of the next bands. */
export const LIMIT_WARN_PERCENT = 80n;
export const LIMIT_BANDS = [80n, 90n, 100n] as const;
/** The brief says a limit band when the incassi of these last days crossed it (past 100.000 € it says it every day until the end of the year). */
export const LIMIT_BAND_DAYS = 3;

/** Acconto dell'imposta: none when last year's imposta is up to 51,65 € (istruzioni del modello Redditi PF, art. 1 L. 97/1977 in euro). */
export const ACCONTO_NONE_MAX_CENTS = 5_165n;
/** The acconto is 100% of last year's imposta (metodo storico), split 50% in June and 50% in November for subjects with ISA, the forfettari included (art. 58 DL 124/2019; Ris. AdE 93/E del 2019). Da verificare each year: the split has changed before. */
export const ACCONTO_FIRST_PERCENT = 50n;
/**
 * A first acconto under 103 € is not due in June: everything goes in November (istruzioni del
 * modello Redditi PF). So one payment when last year's imposta is under 103 × 100 / the first
 * percent: 206 € at 50%, strictly under. Da verificare: the sources disagree (207 € for ISA
 * subjects, 257,52 € or 258 € with the old 40% split).
 */
export const ACCONTO_FIRST_MIN_CENTS = 10_300n;
export const ACCONTO_SINGLE_BELOW_CENTS = (ACCONTO_FIRST_MIN_CENTS * 100n) / ACCONTO_FIRST_PERCENT;
/** Gestione separata: the acconti are 80% of last year's contributions, 40% in June and 40% in November (INPS, circolare annuale Gestione separata). */
export const GS_ACCONTO_PERCENT = 80n;
export const GS_ACCONTO_FIRST_PERCENT = 40n;

/**
 * The June F24 (saldi and first acconti, imposta and INPS contributions alike) of ISA subjects and
 * forfettari, by year: the deadline as prorogated, and the alternative with its extra percentage.
 */
export const JUNE_DEADLINES: Readonly<Record<number, { readonly due: string; readonly alternative: string; readonly extra: string }>> = {
	// Art. 37 D.Lgs. 13/2024: 31 July, or 30 August with 0,40% more.
	2024: { due: "2024-07-31", alternative: "2024-08-30", extra: "0.40" },
	// D.Lgs. 81/2025: 21 July, or 20 August with 0,40% more.
	2025: { due: "2025-07-21", alternative: "2025-08-20", extra: "0.40" },
	// Art. 6 DL 89/2026 (poi abrogato da L. 113/2026 che ne ha ripreso gli effetti; maggiorazione 0,80% secondo ecnews, informazionefiscale, ItaliaOggi; da verificare in Gazzetta): 20 July, or 20 August with 0,80% more.
	2026: { due: "2026-07-20", alternative: "2026-08-20", extra: "0.80" },
};
/**
 * A year without a known proroga: 30 June, or 30 days after the day it moves to with 0,40% more
 * (art. 17, comma 2, DPR 435/2001); an alternative from 1 to 20 August moves to 20 August (art.
 * 3-quater DL 16/2012, the proroga di ferragosto).
 */
export const JUNE_DUE = "06-30";
export const JUNE_ALTERNATIVE_DAYS = 30;
export const JUNE_EXTRA_DEFAULT = "0.40";

/** Days before an F24 the morning brief says it. */
export const BRIEF_DAYS = 10;
/** The calendar's window, in days today included. */
export const CALENDAR_DAYS = 366;

export const TAX_LIMITS = {
	fileBytes: 256 * 1024,
	/** Years with figures kept. */
	years: 30,
	/** Call ids remembered, so a call run again writes nothing twice. */
	calls: 200,
	/** The largest amount said, in euros. */
	maxAmount: 10_000_000,
	firstYear: 1990,
} as const;

/** The op the brief runs: calendar, with compact true (brief.ts). */
const TAX_BRIEF_OPS = ["calendar"] as const;

export function taxCallReads(args: Record<string, unknown>): boolean {
	return TAX_BRIEF_OPS.some((o) => o === args.op);
}

/** The entry of `table` for `year`: its own, else the closest year before it, else the first; and the year it is of. */
export function yearValues<T>(table: Readonly<Record<number, T>>, year: number): { readonly values: T; readonly year: number } {
	const years = Object.keys(table)
		.map(Number)
		.sort((a, b) => a - b);
	const at = (years.filter((y) => y <= year).at(-1) ?? years[0]) as number;
	return { values: table[at] as T, year: at };
}

/** The ops another agente may ask: they read (what_if saves nothing). Everything else is refused. */
const TAX_AGENT_OPS = ["estimate", "calendar", "what_if"] as const;

export function taxAgentReads(args: Record<string, unknown>): boolean {
	return TAX_AGENT_OPS.some((o) => o === args.op);
}

const PENSIONS = ["gestione_separata", "artigiani", "commercianti", "cassa", "nessuna"] as const;
export type PensionKind = (typeof PENSIONS)[number];

/**
 * The person's pension scheme, with only what the person said: what they did not say is the
 * year's own value, looked up when computed. Gestione separata: a percentage of the reddito, with
 * the year it was said (default GS_RATE_DEFAULT). Artigiani and commercianti: the whole fixed
 * contributions of a year (before any reduction), plus a percentage of the reddito over the
 * minimale (one point more over `top`), default the year's INPS figures (IVS_YEARS); the whole
 * reduced by 35% when they asked for it, or by 50% through NEW_2025_LAST_YEAR when first registered
 * in 2025 (`new2025`). Cassa professionale: a percentage, a minimum, and the contributo integrativo
 * charged in the invoices, which is not a ricavo (undefined: not known).
 */
export type Pension =
	| { readonly kind: "gestione_separata"; readonly rate?: string; readonly rateYear?: number }
	| { readonly kind: "artigiani" | "commercianti"; readonly fixed?: string; readonly rate?: string; readonly minimale?: string; readonly top?: string; readonly reduction: boolean; readonly new2025?: true }
	| { readonly kind: "cassa"; readonly rate: string; readonly minimum?: string; readonly integrativo?: string }
	| { readonly kind: "nessuna" };

export type TaxProfile = Marker & {
	/** The coefficiente di redditività, a percentage («78»). */
	readonly coefficient: string;
	/** The ATECO group when said by words or code, and which. */
	readonly group?: Group;
	readonly groupFrom?: "ateco" | "parole";
	/** «15» or «5» when said; undefined: 15, by default. */
	readonly rate?: string;
	readonly startYear?: number;
	readonly pension: Pension;
	readonly edited?: Marker;
};

/** What the person said of one year: canonical decimals in euros, «0» allowed. */
export type YearFigures = {
	readonly year: number;
	/** The imposta sostitutiva due for the year (the acconti's base, metodo storico). */
	readonly imposta?: string;
	/** The contributions due for the year on the reddito (gestione separata; for artigiani and commercianti the part over the minimale; for a cassa its percentage). */
	readonly contributi?: string;
	/** The acconti paid during the year for the year; this year, those paid so far. */
	readonly accontiImposta?: string;
	readonly accontiContributi?: string;
	/** The contributions actually paid during the year: deducted from the reddito. */
	readonly contributiVersati?: string;
	/** Put aside for the year's taxes so far. */
	readonly accantonato?: string;
};

export const FIGURE_KEYS = ["imposta", "contributi", "accontiImposta", "accontiContributi", "contributiVersati", "accantonato"] as const;
export type FigureKey = (typeof FIGURE_KEYS)[number];

const AMOUNT = /^\d{1,8}(?:\.\d{1,2})?$/;
const PERCENT = /^\d{1,2}(?:\.\d{1,2})?$/;

const isFigure = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && Number(v) <= TAX_LIMITS.maxAmount;
const isPercent = (v: unknown): v is string => typeof v === "string" && PERCENT.test(v) && Number(v) > 0 && Number(v) < 100;
const isYear = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= TAX_LIMITS.firstYear && v <= 2200;

function validPension(v: unknown): v is Pension {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Pension;
	switch (p.kind) {
		case "gestione_separata":
			return (p.rate === undefined || isPercent(p.rate)) && (p.rateYear === undefined || isYear(p.rateYear));
		case "artigiani":
		case "commercianti":
			return (p.fixed === undefined || isFigure(p.fixed)) && (p.rate === undefined || isPercent(p.rate)) && (p.minimale === undefined || isFigure(p.minimale)) && (p.top === undefined || isFigure(p.top)) && typeof p.reduction === "boolean" && (p.new2025 === undefined || p.new2025 === true);
		case "cassa":
			return isPercent(p.rate) && (p.minimum === undefined || isFigure(p.minimum)) && (p.integrativo === undefined || isPercent(p.integrativo));
		case "nessuna":
			return true;
		default:
			return false;
	}
}

export function validProfile(v: unknown): v is TaxProfile {
	if (!isMarker(v)) return false;
	const p = v as TaxProfile;
	if (!isPercent(p.coefficient) || (p.rate !== undefined && p.rate !== RATE_FULL && p.rate !== RATE_START)) return false;
	if (p.groupFrom !== undefined && p.groupFrom !== "ateco" && p.groupFrom !== "parole") return false;
	if (p.group !== undefined && !GROUP_KEYS.includes(p.group)) return false;
	if (p.startYear !== undefined && !isYear(p.startYear)) return false;
	// The 5% needs its first year: it ends by itself after five.
	if (p.rate === RATE_START && p.startYear === undefined) return false;
	return validPension(p.pension) && (p.edited === undefined || isMarker(p.edited));
}

export function validFigures(v: unknown): v is YearFigures {
	if (typeof v !== "object" || v === null) return false;
	const f = v as YearFigures;
	if (!isYear(f.year)) return false;
	for (const key of Object.keys(f)) if (key !== "year" && !(FIGURE_KEYS as readonly string[]).includes(key)) return false;
	return FIGURE_KEYS.every((k) => f[k] === undefined || isFigure(f[k]));
}

export const validCall = (v: unknown): boolean => optText(v, 200) && v !== undefined;

/** The imposta's rate for `year`: the 5% for its first five tax years, then 15%. */
export function rateFor(profile: Pick<TaxProfile, "rate" | "startYear">, year: number): string {
	if (profile.rate === RATE_START && profile.startYear !== undefined && year >= profile.startYear && year < profile.startYear + START_RATE_YEARS) return RATE_START;
	return RATE_FULL;
}

/**
 * Words that say an ATECO group, tried in this order: the specific ones first («agente di
 * commercio» is an intermediary, «commercio ambulante» a street trader, not commerce at large).
 * Phrases and whole folded words only. Some words fit no group with certainty (a developer, a
 * graphic designer, an artisan): Owni asks for the ATECO code or the coefficient.
 */
const GROUP_WORDS: readonly (readonly [Group, readonly string[]])[] = [
	["intermediari", ["agente di commercio", "agenti di commercio", "procacciatore", "procacciatrice", "intermediario", "intermediaria", "intermediari", "rappresentante di commercio", "agente plurimandatario", "agente monomandatario"]],
	["ambulante_alimentari", ["ambulante alimentare", "ambulante alimentari", "ambulante di alimentari", "ambulante di frutta", "ambulante di frutta e verdura", "street food", "food truck"]],
	["ambulante_altro", ["ambulante", "ambulanti", "mercatino", "mercati rionali"]],
	["costruzioni", ["costruzioni", "edile", "edilizia", "edili", "muratore", "impresa edile", "immobiliare", "agente immobiliare", "agenzia immobiliare", "idraulico", "elettricista", "imbianchino", "carpentiere"]],
	["alloggio_ristorazione", ["ristorante", "ristorazione", "bar", "pizzeria", "trattoria", "albergo", "hotel", "alloggio", "b&b", "bed and breakfast", "affittacamere", "agriturismo", "catering", "gelateria"]],
	["alimentari", ["industria alimentare", "industrie alimentari", "produzione alimentare", "bevande", "panificio", "panetteria", "pastificio", "birrificio", "caseificio"]],
	["commercio", ["commercio", "commerciante", "negozio", "negoziante", "ingrosso", "grossista", "dettaglio", "dettagliante", "e commerce", "ecommerce", "vendita online", "vendita al dettaglio", "rivendita"]],
	[
		"professionali",
		[
			"professionista",
			"libero professionista",
			"libera professionista",
			"consulente",
			"consulenza",
			"avvocato",
			"avvocata",
			"architetto",
			"architetta",
			"ingegnere",
			"geometra",
			"commercialista",
			"notaio",
			"medico",
			"psicologo",
			"psicologa",
			"fisioterapista",
			"infermiere",
			"infermiera",
			"dentista",
			"veterinario",
			"nutrizionista",
			"insegnante",
			"docente",
			"formatore",
			"formatrice",
			"traduttore",
			"traduttrice",
			"interprete",
			"designer",
			"progettista",
			"biologo",
			"agronomo",
			"perito",
			"assicuratore",
			"broker",
			"promotore finanziario",
		],
	],
	["altre", ["altre attivita", "altra attivita", "servizi alla persona", "parrucchiere", "parrucchiera", "estetista", "trasporti", "autotrasportatore", "tassista", "noleggio", "pulizie", "manifattura", "artigianato artistico"]],
];

/** Words that do not say a group for sure, whatever else is said: the coefficient depends on the ATECO code. */
const UNSURE = [
	"sviluppatore",
	"sviluppatrice",
	"programmatore",
	"programmatrice",
	"informatico",
	"informatica",
	"it",
	"software",
	"web",
	"digital",
	"marketing digitale",
	"fotografo",
	"fotografa",
	"videomaker",
	"grafico",
	"grafica",
	"artigiano",
	"artigiana",
	"freelance",
	"partita iva",
	"creator",
	"influencer",
	"social media manager",
	"copywriter",
];

/** The two groups an unsure activity most often falls in, with an ATECO code of each as an example. */
export const UNSURE_GROUPS: readonly { readonly group: Group; readonly ateco: string; readonly example: string }[] = [
	{ group: "altre", ateco: "62.xx", example: "produzione di software, consulenza informatica" },
	{ group: "professionali", ateco: "70.22", example: "consulenza imprenditoriale" },
];

function says(tokens: readonly string[], phrase: string): boolean {
	const parts = words(phrase);
	for (let i = 0; i + parts.length <= tokens.length; i++) if (parts.every((p, j) => tokens[i + j] === p)) return true;
	return false;
}

/** The group words say: a word that never says one for sure («unsure», whatever else matched); one group; several or none («ambiguous», «unknown»). */
export function groupOfWords(text: string): Group | "ambiguous" | "unknown" | "unsure" {
	const tokens = words(text);
	if (UNSURE.some((p) => says(tokens, p))) return "unsure";
	const hits = new Set<Group>();
	for (const [group, phrases] of GROUP_WORDS) {
		if (!phrases.some((p) => says(tokens, p))) continue;
		// The specific groups hold the general words in them: «ambulante alimentare» is not also «ambulante», «agente di commercio» not also «commercio».
		if (group === "ambulante_altro" && hits.has("ambulante_alimentari")) continue;
		if (group === "commercio" && (hits.has("intermediari") || hits.has("ambulante_alimentari") || hits.has("ambulante_altro"))) continue;
		hits.add(group);
	}
	// «consulente immobiliare»: an agent, a professional or a builder? Asked.
	if (hits.size === 1) return [...hits][0] as Group;
	return hits.size > 1 ? "ambiguous" : "unknown";
}

/**
 * The group of an ATECO code («62.01.00», «6201», «47.81»): by its division (two digits) and,
 * where allegato 4 splits a division, its group (the third digit). The codes are ATECO 2007, as in
 * allegato 4; some changed with ATECO 2025, so the answer asks to check it. Undefined when it is
 * no code, or a division allegato 4 splits given without the digits that tell.
 */
export function groupOfAteco(text: string): Group | undefined {
	const t = text.trim().replace(/^ateco\s*/i, "");
	const m = /^(\d{2})(?:\.?(\d))?(?:\d)?(?:\.?\d{1,2})?$/.exec(t);
	if (m === null) return undefined;
	const division = Number(m[1]);
	const third = m[2] === undefined ? undefined : Number(m[2]);
	const sub = /^\d{2}\.?(\d{2})/.exec(t)?.[1];
	if (division === 10 || division === 11) return "alimentari";
	if (division === 46) return third === 1 ? "intermediari" : third === undefined ? undefined : "commercio";
	if (division === 47) {
		if (third !== 8) return third === undefined ? undefined : "commercio";
		if (sub === undefined) return undefined;
		return sub === "81" ? "ambulante_alimentari" : "ambulante_altro";
	}
	if (division === 45) return "commercio";
	if ((division >= 41 && division <= 43) || division === 68) return "costruzioni";
	if (division === 55 || division === 56) return "alloggio_ristorazione";
	if ((division >= 64 && division <= 66) || (division >= 69 && division <= 75) || (division >= 85 && division <= 88)) return "professionali";
	if (division >= 1 && division <= 99) return "altre";
	return undefined;
}
