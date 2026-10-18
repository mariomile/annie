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

/** Gestione separata INPS, professionisti without other cover: 26,07% (25% IVS + 0,72% + 0,35%), INPS circolare annuale 2025. Editable by the person. */
export const GS_RATE_DEFAULT = "26.07";
export const GS_RATE_YEAR = 2025;

/** Riduzione contributiva del 35% for artigiani and commercianti in the forfettario: L. 190/2014, art. 1, commi 76-84. */
export const ARTIGIANI_REDUCTION_PERCENT = 35;

/** Ricavi limits, by cash: past 85.000 € the forfettario ends the next year; past 100.000 € it ends at once, in the same year (L. 190/2014, art. 1, commi 54 e 71, as amended by L. 197/2022). */
export const LIMIT_CENTS = 8_500_000n;
export const HARD_LIMIT_CENTS = 10_000_000n;
/** Annie warns from this share of the 85.000 € limit, in percent. */
export const LIMIT_WARN_PERCENT = 80n;

/** Acconto dell'imposta: none when last year's imposta is up to 51,65 € (istruzioni del modello Redditi PF, art. 1 L. 97/1977 in euro). */
export const ACCONTO_NONE_MAX_CENTS = 5_165n;
/** One payment in November when last year's imposta is up to 257,52 € (istruzioni del modello Redditi PF: a first instalment under 103 € is not due in June). */
export const ACCONTO_SINGLE_MAX_CENTS = 25_752n;
/** The acconto is 100% of last year's imposta (metodo storico), split 50% in June and 50% in November for subjects with ISA, the forfettari included (art. 58 DL 124/2019; Ris. AdE 93/E del 2019). Da verificare each year: the split has changed before. */
export const ACCONTO_FIRST_PERCENT = 50n;
/** Gestione separata: the acconti are 80% of last year's contributions, 40% in June and 40% in November (INPS, circolare annuale Gestione separata). */
export const GS_ACCONTO_PERCENT = 80n;
export const GS_ACCONTO_FIRST_PERCENT = 40n;
/** Paying the June F24 by 31 July costs 0,40% more (art. 17, comma 2, DPR 435/2001); in basis points. */
export const JULY_EXTRA_BP = 40n;

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

/** The ops the brief runs: calendar, compact (brief.ts). */
const TAX_BRIEF_OPS = ["calendar"] as const;

export function taxCallReads(args: Record<string, unknown>): boolean {
	return TAX_BRIEF_OPS.some((o) => o === args.op);
}

/** The ops another agente may ask: they read (what_if saves nothing). Everything else is refused. */
const TAX_AGENT_OPS = ["estimate", "calendar", "what_if"] as const;

export function taxAgentReads(args: Record<string, unknown>): boolean {
	return TAX_AGENT_OPS.some((o) => o === args.op);
}

export const PENSIONS = ["gestione_separata", "artigiani", "commercianti", "cassa", "nessuna"] as const;
export type PensionKind = (typeof PENSIONS)[number];

/**
 * The person's pension scheme. Gestione separata: a percentage of the reddito, with the year its
 * rate is of. Artigiani and commercianti: the fixed contributions of a year as the person pays
 * them (the four instalments, already reduced when they have the reduction), plus a percentage of
 * the reddito over the minimale, reduced by 35% when they asked for it. Cassa professionale: a
 * percentage and a minimum they say.
 */
export type Pension =
	| { readonly kind: "gestione_separata"; readonly rate: string; readonly rateYear: number }
	| { readonly kind: "artigiani" | "commercianti"; readonly fixed: string; readonly rate: string; readonly minimale: string; readonly reduction: boolean }
	| { readonly kind: "cassa"; readonly rate: string; readonly minimum?: string }
	| { readonly kind: "nessuna" };

export type TaxProfile = Marker & {
	/** The coefficiente di redditività, a percentage («78»). */
	readonly coefficient: string;
	/** The ATECO group when said by words or code. */
	readonly group?: Group;
	/** «15» or «5». */
	readonly rate: string;
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
	/** The acconti paid during the year for the year. */
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

export const isFigure = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && Number(v) <= TAX_LIMITS.maxAmount;
export const isPercent = (v: unknown): v is string => typeof v === "string" && PERCENT.test(v) && Number(v) > 0 && Number(v) < 100;
const isYear = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= TAX_LIMITS.firstYear && v <= 2200;

export function validPension(v: unknown): v is Pension {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Pension;
	switch (p.kind) {
		case "gestione_separata":
			return isPercent(p.rate) && isYear(p.rateYear);
		case "artigiani":
		case "commercianti":
			return isFigure(p.fixed) && isPercent(p.rate) && isFigure(p.minimale) && typeof p.reduction === "boolean";
		case "cassa":
			return isPercent(p.rate) && (p.minimum === undefined || isFigure(p.minimum));
		case "nessuna":
			return true;
		default:
			return false;
	}
}

export function validProfile(v: unknown): v is TaxProfile {
	if (!isMarker(v)) return false;
	const p = v as TaxProfile;
	if (!isPercent(p.coefficient) || (p.rate !== RATE_FULL && p.rate !== RATE_START)) return false;
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
 * graphic designer, an artisan): Annie asks for the ATECO code or the coefficient.
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
			"giornalista",
			"fotografo",
			"fotografa",
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

/** Words that do not say a group for sure: the coefficient depends on the ATECO code. */
const UNSURE = ["sviluppatore", "sviluppatrice", "programmatore", "programmatrice", "informatico", "informatica", "web designer", "grafico", "grafica", "artigiano", "artigiana", "freelance", "partita iva", "creator", "influencer", "social media manager", "copywriter", "videomaker"];

function says(tokens: readonly string[], phrase: string): boolean {
	const parts = words(phrase);
	for (let i = 0; i + parts.length <= tokens.length; i++) if (parts.every((p, j) => tokens[i + j] === p)) return true;
	return false;
}

/** The group words say: one group; several or none («ambiguous», «unknown»); a word that never says one for sure («unsure»). */
export function groupOfWords(text: string): Group | "ambiguous" | "unknown" | "unsure" {
	const tokens = words(text);
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
	if (hits.size > 1) return "ambiguous";
	return UNSURE.some((p) => says(tokens, p)) ? "unsure" : "unknown";
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
