/**
 * Partite IVA and codici fiscali checked on paper: the Italian partita IVA's check digit and VAT
 * office, the codice fiscale's form, omocodia and check character, and the shape of a VAT number
 * in each country of the VIES. Pure functions, no I/O: a malformed number gets a precise answer
 * without asking anyone, and only well-formed numbers go to the VIES. A formal check says a
 * number is written right, never that it exists.
 */
import { daysInMonth } from "./italian-calendar.ts";

/** The VIES countries: the 27 member states, Greece as EL (its VAT prefix, not GR), and Northern Ireland as XI: 28 prefixes. `of` is the name with «di» and its article. */
export const EU_VAT_COUNTRIES = {
	AT: { name: "Austria", of: "dell'Austria", format: /^U\d{8}$/, example: "U + 8 cifre" },
	BE: { name: "Belgio", of: "del Belgio", format: /^[01]\d{9}$/, example: "10 cifre, la prima 0 o 1" },
	BG: { name: "Bulgaria", of: "della Bulgaria", format: /^\d{9,10}$/, example: "9 o 10 cifre" },
	CY: { name: "Cipro", of: "di Cipro", format: /^\d{8}[A-Z]$/, example: "8 cifre e una lettera" },
	CZ: { name: "Repubblica Ceca", of: "della Repubblica Ceca", format: /^\d{8,10}$/, example: "da 8 a 10 cifre" },
	DE: { name: "Germania", of: "della Germania", format: /^\d{9}$/, example: "9 cifre" },
	DK: { name: "Danimarca", of: "della Danimarca", format: /^\d{8}$/, example: "8 cifre" },
	EE: { name: "Estonia", of: "dell'Estonia", format: /^\d{9}$/, example: "9 cifre" },
	EL: { name: "Grecia", of: "della Grecia", format: /^\d{9}$/, example: "9 cifre" },
	ES: { name: "Spagna", of: "della Spagna", format: /^(?:[A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])$/, example: "9 caratteri, con una lettera all'inizio o alla fine" },
	FI: { name: "Finlandia", of: "della Finlandia", format: /^\d{8}$/, example: "8 cifre" },
	FR: { name: "Francia", of: "della Francia", format: /^[A-HJ-NP-Z0-9]{2}\d{9}$/, example: "2 caratteri di controllo e le 9 cifre del SIREN" },
	HR: { name: "Croazia", of: "della Croazia", format: /^\d{11}$/, example: "11 cifre" },
	HU: { name: "Ungheria", of: "dell'Ungheria", format: /^\d{8}$/, example: "8 cifre" },
	IE: { name: "Irlanda", of: "dell'Irlanda", format: /^(?:\d{7}[A-W][A-IW]?|\d[A-Z+*]\d{5}[A-W])$/, example: "7 cifre e una o due lettere" },
	IT: { name: "Italia", of: "dell'Italia", format: /^\d{11}$/, example: "11 cifre" },
	LT: { name: "Lituania", of: "della Lituania", format: /^(?:\d{9}|\d{12})$/, example: "9 o 12 cifre" },
	LU: { name: "Lussemburgo", of: "del Lussemburgo", format: /^\d{8}$/, example: "8 cifre" },
	LV: { name: "Lettonia", of: "della Lettonia", format: /^\d{11}$/, example: "11 cifre" },
	MT: { name: "Malta", of: "di Malta", format: /^\d{8}$/, example: "8 cifre" },
	NL: { name: "Paesi Bassi", of: "dei Paesi Bassi", format: /^\d{9}B\d{2}$/, example: "9 cifre, B e 2 cifre" },
	PL: { name: "Polonia", of: "della Polonia", format: /^\d{10}$/, example: "10 cifre" },
	PT: { name: "Portogallo", of: "del Portogallo", format: /^\d{9}$/, example: "9 cifre" },
	RO: { name: "Romania", of: "della Romania", format: /^[1-9]\d{1,9}$/, example: "da 2 a 10 cifre" },
	SE: { name: "Svezia", of: "della Svezia", format: /^\d{10}01$/, example: "12 cifre che finiscono con 01" },
	SI: { name: "Slovenia", of: "della Slovenia", format: /^\d{8}$/, example: "8 cifre" },
	SK: { name: "Slovacchia", of: "della Slovacchia", format: /^\d{10}$/, example: "10 cifre" },
	XI: { name: "Irlanda del Nord", of: "dell'Irlanda del Nord", format: /^(?:\d{9}|\d{12}|GD[0-4]\d{2}|HA[5-9]\d{2})$/, example: "9 o 12 cifre (GD o HA e 3 cifre per gli enti pubblici)" },
} as const satisfies Record<string, { readonly name: string; readonly of: string; readonly format: RegExp; readonly example: string }>;

export type EuVatCountry = keyof typeof EU_VAT_COUNTRIES;

/**
 * Prefixes people write that the VIES does not take, with what to say instead, and the shape of
 * the rest (after the two letters): Switzerland's UID is CHE and 9 digits, with MWST, TVA or IVA
 * after it; Norway's 9 digits may end with MVA.
 */
const OTHER_PREFIXES = {
	GB: { problem: "il Regno Unito non è più nel VIES dal 2021: lì c'è solo l'Irlanda del Nord, con il prefisso XI", format: /^(?:\d{9}|\d{12})$/ },
	CH: { problem: "la Svizzera non è nell'Unione europea: il VIES non ha i suoi numeri IVA", format: /^E\d{9}(?:MWST|TVA|IVA)?$/ },
	NO: { problem: "la Norvegia non è nell'Unione europea: il VIES non ha i suoi numeri IVA", format: /^\d{9}(?:MVA)?$/ },
	SM: { problem: "San Marino non è nell'Unione europea: il VIES non ha i suoi numeri IVA", format: /^\d{5}$/ },
} as const satisfies Record<string, { readonly problem: string; readonly format: RegExp }>;

type OtherCountry = keyof typeof OTHER_PREFIXES;

function isOtherCountry(code: string): code is OtherCountry {
	return Object.hasOwn(OTHER_PREFIXES, code);
}

/**
 * «P.IVA:», «partita IVA n.», «P.I.», «VAT number», «C.F.», «Cod. Fisc.», «codice fiscale» in
 * front: a label, not part of the number. A separator must follow, so a code starting with CF
 * (a surname like Cafiero) stays whole.
 */
const LABEL = /^\s*(?:p\.?\s*iva|partita\s+iva|vat(?:\s+number)?|p\.\s*i\.|c\.\s*f\.|cf|cod\.?\s*fisc\.?|codice\s+fiscale)(?:\s+n\.?|\s*n\.)?(?:\s*:\s*|\s+|(?=\d))/i;

/** A leading label out, then spaces, dots, dashes and slashes, letters in capitals: «P.IVA: it 007.431-10157» → «IT00743110157». */
export function normalizeTaxId(text: string): string {
	return text.replace(LABEL, "").replace(/[\s.\-/]/g, "").toUpperCase();
}

/** The VAT office codes (digits 8 to 10 of a partita IVA): 001 to 100, 120, 121, and the special 888 and 999. */
function validOffice(code: number): boolean {
	return (code >= 1 && code <= 100) || code === 120 || code === 121 || code === 888 || code === 999;
}

/** The check digit of 10 digits (Luhn): the odd positions as they are, the even ones doubled, less 9 past 9. */
function luhnDigit(digits: string): number {
	let sum = 0;
	for (let i = 0; i < 10; i++) {
		const d = Number(digits[i]);
		sum += i % 2 === 0 ? d : d * 2 > 9 ? d * 2 - 9 : d * 2;
	}
	return (10 - (sum % 10)) % 10;
}

/**
 * What is wrong with an Italian partita IVA (11 digits, «IT» not included), or undefined when it
 * is written right: the check digit, a serial number (the first 7 digits) that is not all zeros,
 * and the VAT office. The numeric codici fiscali of bodies (starting with 8 or 9) pass the same
 * checks: parseTaxId tells them apart.
 */
export function partitaIvaProblem(digits: string): string | undefined {
	if (!/^\d+$/.test(digits)) return "una partita IVA italiana ha solo cifre, 11";
	if (digits.length !== 11) return `una partita IVA italiana ha 11 cifre, qui ne ha ${digits.length}`;
	// The check digit first: a typo is the likeliest mistake, and the office code would hide it.
	if (luhnDigit(digits) !== Number(digits[10])) return "la cifra di controllo (l'ultima) non torna: probabilmente c'è un errore di battitura";
	if (/^0{7}/.test(digits)) return "le prime 7 cifre (il numero di matricola) non possono essere tutte zero";
	if (!validOffice(Number(digits.slice(7, 10)))) return `le cifre dall'8ª alla 10ª (${digits.slice(7, 10)}) dovrebbero essere il codice di un ufficio IVA, e non lo sono`;
	return undefined;
}

/** The letters that replace digits in a codice fiscale given twice (omocodia): L is 0, M is 1, … V is 9. */
const OMOCODIA = "LMNPQRSTUV";
/** Positions (from 0) that hold digits, or their omocodia letters: year, day, and the comune's number. */
const DIGIT_POSITIONS = [6, 7, 9, 10, 12, 13, 14];
/** The month letters, January to December. */
const MONTHS = "ABCDEHLMPRST";
/** The value of A to Z in an odd position (1st, 3rd, …), for the check character; the digits 0 to 9 count as A to J. */
const ODD_VALUES = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
const CODICE_FISCALE = /^[A-Z]{6}[0-9LMNP-V]{2}[ABCDEHLMPRST][0-9LMNP-V]{2}[A-Z][0-9LMNP-V]{3}[A-Z]$/;

/** The check character of the first 15 characters of a codice fiscale. */
function checkCharacter(first15: string): string {
	let sum = 0;
	for (let i = 0; i < 15; i++) {
		const c = first15.charAt(i);
		// A digit is worth what A to J are: 0 is A, 9 is J.
		const index = /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 65;
		sum += i % 2 === 0 ? (ODD_VALUES[index] as number) : index;
	}
	return String.fromCharCode(65 + (sum % 26));
}

export type CodiceFiscale = {
	/** As written, normalized. */
	readonly code: string;
	readonly sex: "M" | "F";
	/** Day, month and the year's last two digits: the century is not in the code. */
	readonly birth: { readonly day: number; readonly month: number; readonly year: number };
	/** Some digits are written as letters: the code was given to someone with the same one. */
	readonly omocodia: boolean;
};

/**
 * A person's codice fiscale (16 characters) checked on paper: the form, omocodia letters, the
 * month letter, the day (plus 40 for women) in its month, and the check character. Its sex and
 * birthday as the code says them; the comune is not decoded (that needs the cadastral table).
 * Says nothing on whether the Agenzia delle Entrate gave it to anyone.
 */
export function checkCodiceFiscale(text: string): CodiceFiscale | { readonly problem: string } {
	const code = normalizeTaxId(text);
	if (code.length !== 16) return { problem: `un codice fiscale ha 16 caratteri, qui ne ha ${code.length}` };
	if (!CODICE_FISCALE.test(code)) {
		if (!MONTHS.includes(code.charAt(8))) return { problem: `la 9ª lettera (${code.charAt(8)}) dovrebbe essere il mese di nascita (A, B, C, D, E, H, L, M, P, R, S, T), e non lo è` };
		return { problem: "non ha la forma di un codice fiscale: 6 lettere, 2 cifre, una lettera, 2 cifre, una lettera, 3 cifre e una lettera" };
	}
	// Omocodia replaces digits from the right, one at a time: the letters are the last positions, never a gap.
	const replaced = DIGIT_POSITIONS.filter((i) => OMOCODIA.includes(code.charAt(i)));
	if (replaced.some((position, k) => position !== DIGIT_POSITIONS[DIGIT_POSITIONS.length - replaced.length + k])) {
		return { problem: "ha lettere al posto di cifre in posizioni dove l'omocodia non le mette (si sostituiscono da destra, una alla volta)" };
	}
	const omocodia = replaced.length > 0;
	const digits = [...code].map((c, i) => (DIGIT_POSITIONS.includes(i) && OMOCODIA.includes(c) ? String(OMOCODIA.indexOf(c)) : c)).join("");
	const year = Number(digits.slice(6, 8));
	const month = MONTHS.indexOf(code.charAt(8)) + 1;
	const dayField = Number(digits.slice(9, 11));
	const sex = dayField > 40 ? "F" : "M";
	const day = sex === "F" ? dayField - 40 : dayField;
	// The code has no century: 2000 + yy allows 29 February whenever a birth year could have one (2000 was a leap year; 1900 is out of reach).
	const last = daysInMonth(2000 + year, month);
	if (day < 1 || day > last) return { problem: `il giorno di nascita (${digits.slice(9, 11)}) non esiste: va da 01 a ${last} per gli uomini, da 41 a ${40 + last} per le donne` };
	if (checkCharacter(code.slice(0, 15)) !== code.charAt(15)) return { problem: "il carattere di controllo (l'ultimo) non torna: probabilmente c'è un errore di battitura" };
	return { code, sex, birth: { day, month, year }, omocodia };
}

/** What is wrong with a VAT number of `country` (without its prefix), or undefined when it has the right shape (for Italy: the check digit too). */
export function euVatProblem(country: EuVatCountry, number: string): string | undefined {
	if (country === "IT") return partitaIvaProblem(number);
	const { of, format, example } = EU_VAT_COUNTRIES[country];
	return format.test(number) ? undefined : `un numero IVA ${of} è ${country} seguito da ${example}`;
}

function isEuVatCountry(code: string): code is EuVatCountry {
	return Object.hasOwn(EU_VAT_COUNTRIES, code);
}

/**
 * What a number is, read the way people write it:
 * - vat: a VAT number for the VIES, with its country (from its prefix, `country`, or 11 digits alone: Italy);
 * - ente: an Italian numeric codice fiscale of a body (8 or 9 first), written right: not a partita IVA, never in the VIES;
 * - codice_fiscale: 16 characters, a person's codice fiscale, «IT» in front dropped;
 * - outside_vies: GB, CH and the like, with the rest of the number and what to say about the VIES;
 * - each with the problem found on paper, if any.
 * GR is read as EL.
 */
type TaxId =
	| { readonly kind: "vat"; readonly country: EuVatCountry; readonly number: string; readonly problem?: string }
	| { readonly kind: "ente"; readonly number: string }
	| { readonly kind: "codice_fiscale"; readonly code: string; readonly checked: CodiceFiscale | { readonly problem: string } }
	| { readonly kind: "outside_vies"; readonly country: OtherCountry; readonly number: string; readonly problem: string }
	| { readonly kind: "unknown"; readonly problem: string };

/** The start of a person's codice fiscale: 6 letters, the year (digits or omocodia letters), the month letter. */
const CODICE_FISCALE_START = /^[A-Z]{6}[0-9LMNP-V]{2}[A-Z]/;

export function parseTaxId(text: string, country?: string): TaxId {
	const value = normalizeTaxId(text);
	const given = country === undefined ? undefined : normalizeTaxId(country);
	const asked = given === "GR" ? "EL" : given;
	if (value === "") return { kind: "unknown", problem: "manca il numero" };
	if (value.length > 30) return { kind: "unknown", problem: "il numero è troppo lungo per una partita IVA o un codice fiscale" };
	if (!/^[A-Z0-9+*]+$/.test(value)) return { kind: "unknown", problem: "il numero ha caratteri che non stanno in una partita IVA né in un codice fiscale" };
	if (asked !== undefined && isOtherCountry(asked)) return outsideVies(asked, value.startsWith(asked) ? value.slice(2) : value);
	if (asked !== undefined && !isEuVatCountry(asked)) return { kind: "unknown", problem: `${asked} non è un paese del VIES (i paesi dell'Unione europea, EL per la Grecia, XI per l'Irlanda del Nord)` };
	if (asked === undefined || asked === "IT") {
		// «IT» and a letter: a codice fiscale with the partite IVA's habit in front (an Italian VAT
		// number has only digits, and no codice fiscale starts with IT). Dropped; the rest is checked as one, short or not.
		if (/^IT[A-Z]/.test(value)) return { kind: "codice_fiscale", code: value.slice(2), checked: checkCodiceFiscale(value.slice(2)) };
		if (CODICE_FISCALE_START.test(value)) return { kind: "codice_fiscale", code: value, checked: checkCodiceFiscale(value) };
	}
	const prefix = value.slice(0, 2) === "GR" ? "EL" : value.slice(0, 2);
	if (/^[A-Z]{2}/.test(value) && (isEuVatCountry(prefix) || isOtherCountry(prefix))) {
		if (isOtherCountry(prefix)) return outsideVies(prefix, value.slice(2));
		// A French number's two check characters may be letters that look like a prefix (FR + «DE123456789»).
		if (asked !== undefined && asked !== prefix) return euVatProblem(asked, value) === undefined ? vat(asked, value) : { kind: "unknown", problem: `il numero comincia con ${prefix}, ma il paese indicato è ${asked}` };
		return vat(prefix, value.slice(2));
	}
	if (asked !== undefined) return vat(asked, value);
	if (/^\d{11}$/.test(value)) return vat("IT", value);
	if (/^\d+$/.test(value)) return { kind: "unknown", problem: `il numero ha ${value.length} cifre: una partita IVA italiana ne ha 11; per un numero estero serve il prefisso del paese (DE, FR…)` };
	return { kind: "unknown", problem: "il numero non sembra una partita IVA né un codice fiscale: per un numero estero serve il prefisso del paese (DE, FR…)" };
}

/** A VAT number with its problem; an Italian one starting with 8 or 9 and written right is a body's codice fiscale. */
function vat(country: EuVatCountry, number: string): TaxId {
	const problem = euVatProblem(country, number);
	if (country === "IT" && problem === undefined && /^[89]/.test(number)) return { kind: "ente", number };
	return { kind: "vat", country, number, ...(problem === undefined ? {} : { problem }) };
}

function outsideVies(country: OtherCountry, number: string): TaxId {
	return { kind: "outside_vies", country, number, problem: OTHER_PREFIXES[country].problem };
}

/**
 * The United Kingdom's check on the first 9 digits: weights 8 to 2 on the first 7, plus the last
 * two, make a multiple of 97, or (numbers issued since 2010) 55 short of one.
 */
function gbCheckDigits(digits: string): boolean {
	const sum = [...digits.slice(0, 7)].reduce((s, c, i) => s + Number(c) * (8 - i), Number(digits.slice(7, 9)));
	return sum % 97 === 0 || (sum + 55) % 97 === 0;
}

/**
 * A VAT number as a customer writes it («P.IVA: IT 012 345 678 90», «DE123456789»), checked on
 * paper only: the number to keep, what is wrong with it, or undefined when it is no VAT number.
 * - Italian: kept as its 11 digits, without «IT»; another VIES country: its shape, kept with the prefix.
 * - A body's numeric codice fiscale (8 or 9 first, written right) is kept: not a partita IVA, but
 *   the tax id a body without one invoices with, and nothing the customer should correct.
 * - GB (with its check digits), CHE, NO and SM: kept in their shape, prefix and digits only; any
 *   other text with those letters in front («Smith», «None») is no VAT number.
 * - A person's codice fiscale, right or wrong, is no VAT number either: never «partita IVA non
 *   corretta» for it.
 */
export function checkVatNumber(text: string): { readonly number: string } | { readonly problem: string } | undefined {
	const id = parseTaxId(text);
	switch (id.kind) {
		case "vat":
			if (id.problem !== undefined) return { problem: id.problem };
			return { number: id.country === "IT" ? id.number : `${id.country}${id.number}` };
		case "ente":
			return { number: id.number };
		case "codice_fiscale":
			return undefined;
		case "outside_vies": {
			if (!OTHER_PREFIXES[id.country].format.test(id.number)) return undefined;
			if (id.country === "GB" && !gbCheckDigits(id.number)) return { problem: "le cifre di controllo di un numero IVA del Regno Unito (l'8ª e la 9ª) non tornano" };
			return { number: `${id.country}${id.number.replace(/[A-Z]+$/, "")}` };
		}
		case "unknown":
			return { problem: id.problem };
	}
}
