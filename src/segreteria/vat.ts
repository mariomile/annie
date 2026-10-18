/**
 * The VAT number in a customer's mail, and in what the model read from it: found by its shape,
 * checked on paper only (tax-ids.ts, never the VIES). A wrong one is flagged to be asked again,
 * never kept; amounts, dates and phone numbers next to a label are left alone.
 */
import type { MissingField } from "../core/practice.ts";
import { checkVatNumber, EU_VAT_COUNTRIES, normalizeTaxId } from "../core/tax-ids.ts";

/**
 * What a mail says about its VAT number: the number to keep (normalized), or `invalid` when one
 * was given and fails the formal check. `asWritten` is the text as the customer wrote it, only to
 * keep it out of drafts: never stored, never logged.
 */
export type VatReading = { readonly vatNumber: string | null; readonly invalid: boolean; readonly asWritten?: string };

const NONE: VatReading = { vatNumber: null, invalid: false };

/**
 * What stands before a VAT number in free text: «P.IVA», «P. IVA n°», «P.IVA.:», «Partita
 * I.V.A.», «P.I.», «P.IVA/C.F.», «P.IVA e C.F.:», «VAT No.», «VAT ID:», «VAT Reg. No.»,
 * «USt-IdNr.», «MWST-Nr.», «UID-Nr.», «N° TVA», «TVA intracommunautaire», «BTW-nr», one word
 * before a colon («P.IVA corretta:»), one in brackets («P.IVA (nuova):»), and «P.IVA è …».
 * Group 1: «VAT», «MWST», «UID», «NIF», «BTW» or «TVA» alone, a label only before a colon
 * (group 2) or a country prefix, so «VAT 20000» is an amount, not a number.
 * Not tax-ids.ts's LABEL: that one strips a label in front of a value already set apart (and
 * takes «C.F.» alone, for codici fiscali); this one finds labels inside a mail.
 */
const LABEL =
	/\b(?:p\.?\s?i\.?\s?v\.?\s?a\b\.?|partita\s+i\.?\s?v\.?\s?a\b\.?|p\.\s?i\.|vat\s*(?:number|no\b\.?|nr\b\.?|n[°º]|id\b|reg(?:istration)?\b\.?(?:\s*no\b\.?)?)|ust-?id(?:nr)?\b\.?|(?:mwst|uid|btw)-?\s?nr\b\.?|n[°º]\s?tva\b|tva\s+intracom(?:munautaire)?\b\.?|(vat|mwst|uid|nif|btw|tva)\b)(?:\s*(?:\/|e|and|&)\s*(?:c\.\s?f\.|cf\b|cod(?:ice)?\.?\s?fisc(?:ale)?\b\.?))?(?:\s*(?:n[°º]|nr\b\.?|no\b\.?|n\b\.?|num(?:ero)?\b\.?))?(?:\s*\([a-zà-ù]{2,15}\))?(?:\s+[a-zà-ù]{2,15}(?=\s*:)|\s+(?:è|is)(?=\s))?\s*(?:(:)|-)?\s*/gi;

/** The prefixes a VAT number may start with: the VIES countries, GR for Greece, and GB, CH, NO, SM. */
const COUNTRIES = [...Object.keys(EU_VAT_COUNTRIES), "GR", "GB", "CH", "NO", "SM"];

/**
 * A VAT number's shape: letters in front (a country prefix, «ATU», «CHE»), then digits with
 * single spaces, dots or dashes between, the letters some countries add («B01»), and Switzerland's
 * or Norway's suffix («MWST», «MVA»). `prefix`: which letters may stand in front. Bounded
 * quantifiers: no runaway backtracking.
 */
const value = (prefix: string) => String.raw`(?:${prefix}[ .\-]?)?[a-z]{0,2}\d(?:[ .\-]?\d){4,15}(?:[a-z][a-z0-9]{0,2})?(?:\s?(?:mwst|tva|iva|mva)\b)?(?!\w)`;
/** Right where a label ends: any letters, vatShaped decides. */
const VALUE_AFTER_LABEL = new RegExp(value("[a-z]{2,3}"), "iy");
/**
 * Anywhere, not inside a word nor after «+» (a phone number's country code): for the model's
 * value and for drafts. Only a country in front, so «tel 02 …» and «IVA 0123…» leave the word out.
 */
const VALUE_ANYWHERE = new RegExp(String.raw`(?<![a-z0-9+])${value(`(?:${COUNTRIES.join("|")})`)}`, "gi");

/** Digits in thousands (1.250.000, 15 000) or a date (12.03.2024, 12-03-24): never a VAT number. */
const AMOUNT = /^\d{1,3}(?:[ .]\d{3})+$/;
const DATE = /^\d{1,2}[.\-/ ]\d{1,2}[.\-/ ]\d{2,4}$/;
/** A suffix only Switzerland and Norway put after the number. */
const SUFFIX = /\s?(?:MWST|TVA|IVA|MVA)$/i;

/** Letters that start a VAT number: a country prefix. */
function countryPrefix(letters: string): boolean {
	return letters.length >= 2 && COUNTRIES.includes(letters.slice(0, 2).toUpperCase());
}

function lettersOf(raw: string): string {
	return /^[a-z]*/i.exec(raw)?.[0] ?? "";
}

/**
 * The text as a VAT number worth checking, or undefined when it does not have the shape of one:
 * a country prefix and digits, or 10 to 12 digits alone (one more or one less than a partita
 * IVA: a typo). Never an amount, a date, a word that is no country in front («tel 02 …»), a
 * mobile number (3 and 9 more digits, 39 in front or not), nor, without a VAT label before it, a
 * landline (0 and 9 more digits).
 */
function vatShaped(raw: string, labelled: boolean): string | undefined {
	const letters = lettersOf(raw);
	if (countryPrefix(letters)) return normalizeTaxId(/^(?:CH|NO)/i.test(raw) ? raw : raw.replace(SUFFIX, ""));
	if (letters !== "") return undefined;
	const digits = raw.replace(SUFFIX, "");
	if (!/^[\d .\-]+$/.test(digits) || AMOUNT.test(digits) || DATE.test(digits)) return undefined;
	const number = digits.replace(/\D/g, "");
	if (/^(?:39)?3\d{9}$/.test(number) || (!labelled && /^0\d{9}$/.test(number))) return undefined;
	return number.length >= 10 && number.length <= 12 ? number : undefined;
}

function reading(raw: string, labelled: boolean): VatReading | undefined {
	const shaped = vatShaped(raw, labelled);
	const checked = shaped === undefined ? undefined : checkVatNumber(shaped);
	if (checked === undefined) return undefined;
	return "number" in checked ? { vatNumber: checked.number, invalid: false, asWritten: raw } : { vatNumber: null, invalid: true, asWritten: raw };
}

/**
 * A run read whole, or shorter at a space: «01234567890 333 1234567» is a VAT number with a
 * phone number after it. The first one written right, else the first with a VAT number's shape.
 */
function readRun(raw: string, labelled: boolean): VatReading | undefined {
	let wrong: VatReading | undefined;
	for (let end = raw.length; end > 0; end = raw.lastIndexOf(" ", end - 1)) {
		const read = reading(raw.slice(0, end), labelled);
		if (read?.invalid === false) return read;
		wrong ??= read;
	}
	return wrong;
}

/** Of several readings, the first written right, else the first wrong one, else none. */
export function bestVat(readings: Iterable<VatReading | undefined>): VatReading {
	let wrong: VatReading | undefined;
	for (const read of readings) {
		if (read?.vatNumber != null) return read;
		if (read?.invalid === true) wrong ??= read;
	}
	return wrong ?? NONE;
}

/** Each VAT number after a label, with where it starts. */
function* labelled(text: string): Generator<{ readonly at: number; readonly read: VatReading }> {
	for (const label of text.matchAll(LABEL)) {
		const at = label.index + label[0].length;
		VALUE_AFTER_LABEL.lastIndex = at;
		const raw = VALUE_AFTER_LABEL.exec(text)?.[0];
		if (raw === undefined) continue;
		// «VAT» and the like alone: only before a colon or a country prefix.
		if (label[1] !== undefined && label[2] === undefined && !countryPrefix(lettersOf(raw))) continue;
		const read = readRun(raw, true);
		if (read !== undefined) yield { at, read };
	}
}

/** The VAT number a mail gives after a label. Every label is read: one written right wins over a wrong one («P.IVA vecchia: …, ora P.IVA: …»). */
export function vatInMail(body: string): VatReading {
	return bestVat([...labelled(body)].map((hit) => hit.read));
}

/**
 * The model's value for the VAT number: placeholders («N/A», «n.d.», «Chiedere al cliente»)
 * have no digit and are none; otherwise only what has a VAT number's shape is checked
 * («IT00743110157 (da verificare)»), never a phone number («+39 02 1234 5678», «tel 02 12345678»).
 */
export function vatField(text: string | null): VatReading {
	if (text === null || !/\d/.test(text)) return NONE;
	return bestVat([...text.matchAll(VALUE_ANYWHERE)].map((m) => readRun(m[0], false)));
}

/**
 * What the draft asks about the VAT number: a wrong one again, whoever gave it; a missing one
 * only when the tenant requires it and the customer is a company (never private customers, A3).
 */
export function vatToAsk(vat: VatReading, requireVatNumber: boolean, company: boolean): MissingField | undefined {
	if (vat.invalid) return "vatNumberInvalid";
	return requireVatNumber && company && vat.vatNumber === null ? "vatNumber" : undefined;
}

/** A VAT number to compare: normalized, «IT» in front of digits dropped. */
function canonical(text: string): string {
	return normalizeTaxId(text).replace(/^IT(?=\d)/, "");
}

/** `text` without the parts in `cut` ([start, end) pairs), and the debris tidied: double spaces, a space before punctuation or at the end of a line, empty brackets. */
function cutOut(text: string, cut: readonly (readonly [number, number])[]): string {
	if (cut.length === 0) return text;
	let out = "";
	let from = 0;
	for (const [start, end] of [...cut].sort((a, b) => a[0] - b[0])) {
		if (start < from) continue;
		out += text.slice(from, start);
		from = end;
	}
	out += text.slice(from);
	return out
		.replace(/\(\s*\)/g, "")
		.replace(/[ \t]+([,.;:)])/g, "$1")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+$/gm, "");
}

/** Where `hit` (found at `at`) starts with a run whose canonical form is one of `targets`: its end. */
function matchingEnd(hit: string, at: number, targets: ReadonlySet<string>): number | undefined {
	for (let end = hit.length; end > 0; end = hit.lastIndexOf(" ", end - 1)) {
		if (targets.has(canonical(hit.slice(0, end)))) return at + end;
	}
	return undefined;
}

/** `text` without the VAT numbers the customer wrote (the model's reading and the mail's), however they are spaced or prefixed. */
export function withoutVatNumber(text: string, asWritten: readonly string[]): string {
	const targets = new Set(asWritten.map(canonical).filter((t) => t !== ""));
	if (targets.size === 0) return text;
	const cut: [number, number][] = [];
	for (const m of text.matchAll(VALUE_ANYWHERE)) {
		const end = matchingEnd(m[0], m.index, targets);
		if (end !== undefined) cut.push([m.index, end]);
	}
	return cutOut(text, cut);
}

/**
 * The draft's backstop (A7): any VAT number after a VAT label, right or wrong, and any number
 * with a country prefix that passes the formal check. Order numbers, dates, amounts and codes
 * («ordine n. 4500012345», «GA 2000-1500») stay.
 */
export function withoutVatNumbers(text: string): string {
	const cut: [number, number][] = [];
	for (const { at, read } of labelled(text)) cut.push([at, at + (read.asWritten?.length ?? 0)]);
	for (const m of text.matchAll(VALUE_ANYWHERE)) {
		if (!countryPrefix(lettersOf(m[0]))) continue;
		const read = readRun(m[0], false);
		if (read?.invalid === false) cut.push([m.index, m.index + (read.asWritten?.length ?? 0)]);
	}
	return cutOut(text, cut);
}
