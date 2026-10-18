/**
 * The VAT number in a customer's mail, and in what the model read from it: found by its shape,
 * checked on paper only (tax-ids.ts, never the VIES). A wrong one is flagged to be asked again,
 * never kept; amounts, dates and phone numbers next to a label are left alone.
 */
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
 * «USt-IdNr.», and one word before a colon («P.IVA corretta:»). Group 1: «VAT» alone, a label
 * only before a colon (group 2) or a country prefix, so «VAT 20000» is an amount, not a number.
 * Not tax-ids.ts's LABEL: that one strips a label in front of a value already set apart (and
 * takes «C.F.» alone, for codici fiscali); this one finds labels inside a mail.
 */
const LABEL =
	/\b(?:p\.?\s?i\.?\s?v\.?\s?a\b\.?|partita\s+i\.?\s?v\.?\s?a\b\.?|p\.\s?i\.|vat\s*(?:number|no\b\.?|nr\b\.?|n[°º]|id\b|reg(?:istration)?\b\.?(?:\s*no\b\.?)?)|(vat)|ust-?id(?:nr)?\b\.?)(?:\s*(?:\/|e|and|&)\s*(?:c\.\s?f\.|cf\b|cod(?:ice)?\.?\s?fisc(?:ale)?\b\.?))?(?:\s*(?:n[°º]|nr\b\.?|no\b\.?|n\b\.?|num(?:ero)?\b\.?))?(?:\s+[a-zà-ù]{2,15}(?=\s*:))?\s*(?:(:)|-)?\s*/gi;

/**
 * A VAT number's shape: letters in front (a country prefix, «ATU», «CHE»), then digits with
 * single spaces, dots or dashes between, the letters some countries add («B01»), and Switzerland's
 * or Norway's suffix («MWST», «MVA»). Bounded quantifiers: no runaway backtracking.
 */
const VALUE = String.raw`(?:[a-z]{2,3}[ .\-]?)?[a-z]{0,2}\d(?:[ .\-]?\d){4,15}(?:[a-z][a-z0-9]{0,2})?(?:\s?(?:mwst|tva|iva|mva)\b)?(?!\w)`;
/** VALUE right where a label ends. */
const VALUE_AFTER_LABEL = new RegExp(VALUE, "iy");
/** VALUE anywhere, not inside a word: for the model's value and for drafts. */
const VALUE_ANYWHERE = new RegExp(String.raw`(?<![a-z0-9])${VALUE}`, "gi");

/** Digits in thousands (1.250.000, 15 000) or a date (12.03.2024, 12-03-24): never a VAT number. */
const AMOUNT = /^\d{1,3}(?:[ .]\d{3})+$/;
const DATE = /^\d{1,2}[.\-/ ]\d{1,2}[.\-/ ]\d{2,4}$/;
/** A suffix only Switzerland and Norway put after the number. */
const SUFFIX = /\s?(?:MWST|TVA|IVA|MVA)$/i;

/** Two letters that start a VAT number: a VIES country (GR for Greece too) or GB, CH, NO, SM. */
function countryPrefix(letters: string): boolean {
	const code = letters.slice(0, 2).toUpperCase();
	return code === "GR" || Object.hasOwn(EU_VAT_COUNTRIES, code) || ["GB", "CH", "NO", "SM"].includes(code);
}

/**
 * The text as a VAT number worth checking, or undefined when it does not have the shape of one:
 * a country prefix and digits, or 10 to 12 digits alone (one more or one less than a partita
 * IVA: a typo), not an amount, a date or a mobile number (3 and 9 more digits).
 */
function vatShaped(raw: string): string | undefined {
	const letters = /^[a-z]*/i.exec(raw)?.[0] ?? "";
	if (letters.length >= 2 && countryPrefix(letters)) return normalizeTaxId(/^(?:CH|NO)/i.test(raw) ? raw : raw.replace(SUFFIX, ""));
	// Letters that are no country («VAT number is 0123…»): the digits alone.
	const digits = raw.slice(letters.length).replace(SUFFIX, "").replace(/^[ .\-]/, "");
	if (!/^[\d .\-]+$/.test(digits) || AMOUNT.test(digits) || DATE.test(digits)) return undefined;
	const number = digits.replace(/\D/g, "");
	return number.length >= 10 && number.length <= 12 && !/^3\d{9}$/.test(number) ? number : undefined;
}

function reading(raw: string): VatReading | undefined {
	const shaped = vatShaped(raw);
	const checked = shaped === undefined ? undefined : checkVatNumber(shaped);
	if (checked === undefined) return undefined;
	return "number" in checked ? { vatNumber: checked.number, invalid: false, asWritten: raw } : { vatNumber: null, invalid: true, asWritten: raw };
}

/**
 * A run read whole, or shorter at a space: «01234567890 333 1234567» is a VAT number with a
 * phone number after it. The first one written right, else the first with a VAT number's shape.
 */
function readRun(raw: string): VatReading | undefined {
	let wrong: VatReading | undefined;
	for (let end = raw.length; end > 0; end = raw.lastIndexOf(" ", end - 1)) {
		const read = reading(raw.slice(0, end));
		if (read?.invalid === false) return read;
		wrong ??= read;
	}
	return wrong;
}

/** Of several readings, the first written right, else the first wrong one, else none. */
function best(readings: Iterable<VatReading | undefined>): VatReading {
	let wrong: VatReading | undefined;
	for (const read of readings) {
		if (read?.invalid === false) return read;
		wrong ??= read;
	}
	return wrong ?? NONE;
}

/** The VAT number a mail gives after a label. Every label is read: one written right wins over a wrong one («P.IVA vecchia: …, ora P.IVA: …»). */
export function vatInMail(body: string): VatReading {
	return best(
		(function* () {
			for (const label of body.matchAll(LABEL)) {
				VALUE_AFTER_LABEL.lastIndex = label.index + label[0].length;
				const raw = VALUE_AFTER_LABEL.exec(body)?.[0];
				if (raw === undefined) continue;
				// «VAT» alone: only before a colon or a country prefix.
				if (label[1] !== undefined && label[2] === undefined && !countryPrefix(/^[a-z]*/i.exec(raw)?.[0] ?? "")) continue;
				yield readRun(raw);
			}
		})(),
	);
}

/**
 * The model's value for the VAT number: placeholders («N/A», «n.d.», «Chiedere al cliente»)
 * have no digit and are none; otherwise only what has a VAT number's shape is checked
 * («IT00743110157 (da verificare)»).
 */
export function vatField(text: string | null): VatReading {
	if (text === null || !/\d/.test(text)) return NONE;
	return best([...text.matchAll(VALUE_ANYWHERE)].map((m) => readRun(m[0])));
}

/** A VAT number to compare: normalized, «IT» in front of digits dropped. */
function canonical(text: string): string {
	return normalizeTaxId(text).replace(/^IT(?=\d)/, "");
}

/** `body` without the VAT number the customer wrote, however it is spaced or prefixed. */
export function withoutVatNumber(body: string, asWritten: string): string {
	const target = canonical(asWritten);
	if (target === "") return body;
	return body.replace(VALUE_ANYWHERE, (hit) => {
		if (canonical(hit) === target) return "";
		// A word in front caught with the number («IVA 01234567890»): the word stays.
		const word = /^[a-z]{2,3}[ .\-]?/i.exec(hit)?.[0];
		return word !== undefined && canonical(hit.slice(word.length)) === target ? word : hit;
	});
}
