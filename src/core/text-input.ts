/**
 * What a person types for a record, read and checked: text with control characters and spare
 * spaces out, an amount as a canonical decimal string («1.250» is asked, never guessed), a
 * percent. What does not read comes back as a Problem in Italian, for the caller to say.
 */
import { AMBIGUOUS, readDecimal } from "./quote-sums.ts";
import { CONTROL_CHARS } from "./plain-text.ts";

export type Problem = { readonly problem: string };

export const isProblem = (v: unknown): v is Problem => typeof v === "object" && v !== null && "problem" in v;

/** Text the person gave, with control characters and spare spaces out; newlines kept only where `lines` allows. */
export function cleanText(value: unknown, max: number, name: string, lines = false): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { problem: `${name} è un testo` };
	const text = value
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL_CHARS, " ")
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l !== "")
		.join(lines ? "\n" : " ");
	if (text === "") return undefined;
	if (text.length > max) return { problem: `${name} è troppo lungo (al massimo ${max} caratteri)` };
	return text;
}

/**
 * A decimal as given, or why not: «1.250» reads two ways and is asked, not guessed. What is not
 * digits and separators is echoed inside `fence`, the caller's.
 */
export function readAmount(value: unknown, decimals: number, what: string, fence: (text: string) => string): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "number" && typeof value !== "string") return { problem: `${what}: dammi un numero` };
	const read = readDecimal(value, decimals);
	// Echoed as written only when it is digits and separators; anything else inside the fence.
	const text = String(value);
	const said = /^[\d .,€%-]{1,20}$/.test(text) ? `«${text}»` : fence(text.slice(0, 20));
	if (read === AMBIGUOUS) return { problem: `${what}: ${said} può voler dire migliaia o decimali. Chiedi a chi ti scrive, o passa il valore come numero JSON (1250 o 1.25)` };
	if (read === undefined) return { problem: `${what}: ${said} non è un numero che so leggere (al più ${decimals} decimali, senza segno meno)` };
	return read;
}

/** A percent from more than 0 to less than 100; 0 means none, given back as null. What does not read is echoed inside `fence`. */
export function readPercent(value: unknown, where: string, fence: (text: string) => string): string | null | undefined | Problem {
	const read = readAmount(value, 2, where, fence);
	if (read === undefined || isProblem(read)) return read;
	if (Number(read) === 0) return null;
	if (Number(read) >= 100) return { problem: `${where}: la percentuale va da 0 a meno di 100` };
	return read;
}
