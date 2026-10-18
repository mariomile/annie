/**
 * Le tasse del forfettario's own state, in `taxes.json` of an instance (outside the workspace):
 * the profile, the figures said per year and the ids of the calls that wrote (a call run again
 * writes nothing twice). Changed under the shared file lock through json-book.ts, with the copy
 * `taxes.json.bak`. Read never throws: a file that does not read is `broken`, and nothing is
 * written over it.
 */
import { join } from "node:path";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { FIGURE_KEYS, type FigureKey, IVS_YEARS, type Pension, TAX_LIMITS, TaxError, type TaxProfile, validCall, validFigures, validProfile, type YearFigures } from "./taxes.ts";

type Book = { readonly profile?: TaxProfile; readonly years: readonly YearFigures[]; readonly calls: readonly string[] };

export type TaxBook = { readonly profile?: TaxProfile; readonly years: readonly YearFigures[]; readonly calls: readonly string[]; readonly broken: boolean };

export const TAXES_BROKEN = "il profilo delle tasse (taxes.json) non si legge: non lo cambio, perché andrebbe perso. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { years: [], calls: [] };

/** A year's figures to set: a value sets it, null clears it, undefined keeps it. */
export type FiguresPatch = Partial<Record<FigureKey, string | null>>;

export class TaxStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "taxes.json"),
			empty: EMPTY,
			maxBytes: TAX_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new TaxError(TAXES_BROKEN),
			full: () => new TaxError("il profilo delle tasse è pieno: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): TaxBook {
		const book = readBook(this.book);
		if (book === undefined) return { years: [], calls: [], broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `profile` gets the profile as saved now and gives the new
	 * one (undefined keeps it); `figures` sets fields of years. Returns false when the call wrote
	 * already (run again), and then nothing changes.
	 */
	update(callId: string, profile: ((old: TaxProfile | undefined) => TaxProfile | undefined) | undefined, figures: readonly { readonly year: number; readonly patch: FiguresPatch }[]): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) return book;
			fresh = true;
			let next: Book = { ...book, calls: [...book.calls, callId].slice(-TAX_LIMITS.calls) };
			const made = profile?.(book.profile);
			if (made !== undefined) {
				if (!validProfile(made)) throw new TaxError("il profilo non è valido: non l'ho salvato");
				next = { ...next, profile: made };
			}
			for (const { year, patch } of figures) next = { ...next, years: patched(next.years, year, patch) };
			return next;
		});
		return fresh;
	}
}

/** The years with `patch` applied to `year`; a year left with no figure goes; the oldest go past the cap. */
function patched(years: readonly YearFigures[], year: number, patch: FiguresPatch): YearFigures[] {
	const old = years.find((y) => y.year === year) ?? { year };
	const fields: Record<string, unknown> = { ...old };
	for (const key of FIGURE_KEYS) {
		const value = patch[key];
		if (value === null) delete fields[key];
		else if (value !== undefined) fields[key] = value;
	}
	const made = fields as YearFigures;
	if (!validFigures(made)) throw new TaxError("le cifre dell'anno non sono valide: non le ho salvate");
	const rest = years.filter((y) => y.year !== year);
	const kept = Object.keys(made).length > 1 ? [...rest, made] : rest;
	return kept.sort((a, b) => a.year - b.year).slice(-TAX_LIMITS.years);
}

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { profile, years, calls } = raw as Book;
	if (profile !== undefined && !validProfile(profile)) return undefined;
	if (!Array.isArray(years) || years.length > TAX_LIMITS.years || !years.every(validFigures)) return undefined;
	if (new Set(years.map((y) => y.year)).size !== years.length) return undefined;
	if (!Array.isArray(calls) || calls.length > TAX_LIMITS.calls || !calls.every(validCall)) return undefined;
	return profile === undefined ? (raw as Book) : { ...(raw as Book), profile: { ...profile, pension: unfrozen(profile.pension) } };
}

/**
 * Compatibility with the profiles saved before week 56's second review, which stored the 2026 INPS
 * figures as if the person had said them. A fixed amount, minimale or top exactly equal to the 2026
 * default is taken as not said, so the year's values are read when computing. The percentage stays:
 * a person can well say the 24%. Applied on reading; the next write keeps the cleaned profile.
 */
function unfrozen(p: Pension): Pension {
	if (p.kind !== "artigiani" && p.kind !== "commercianti") return p;
	const d = IVS_YEARS[2026];
	if (d === undefined) return p;
	const { fixed, minimale, top, ...rest } = p;
	return {
		...rest,
		...(fixed === undefined || fixed === d.fixed[p.kind] ? {} : { fixed }),
		...(minimale === undefined || minimale === d.minimale ? {} : { minimale }),
		...(top === undefined || top === d.top ? {} : { top }),
	};
}
