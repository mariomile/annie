/**
 * Field readers shared by the registers that take money and words from the person (spese,
 * rinnovi): an amount in euros (the quotes' decimal rules, never negative, never zero, under a
 * cap, another currency refused with the caller's words), a category from a fixed list matched
 * from words («altro», said back, when none fits), a payment method, and whether a draft is what
 * is already saved; and plain words (one line, a free text, a list of lines).
 */
import { foreignCurrency } from "../currency-words.ts";
import { matchMethod, type Method, METHODS } from "../payment-methods.ts";
import { hasControlChars } from "../plain-text.ts";
import { isProblem, type Problem, readAmount } from "./quote-input.ts";

export type EuroWords = {
	/** Echoes what is not digits inside the caller's fence. */
	readonly fence: (text: string) => string;
	readonly max: number;
	/** Why another currency is refused, and what to do. */
	readonly foreign: string;
	readonly negative: string;
	readonly zero: string;
};

/** An amount in euros to the cent: more than zero, at most `max`; undefined when not given. */
export function readEuros(value: unknown, w: EuroWords): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (foreignCurrency(value)) return { problem: w.foreign };
	if ((typeof value === "number" && value < 0) || (typeof value === "string" && /^\s*(?:€|eur\w*)?\s*-/i.test(value))) return { problem: w.negative };
	const read = readAmount(value, 2, "amount", w.fence);
	if (isProblem(read) || read === undefined) return read;
	if (Number(read) <= 0) return { problem: w.zero };
	if (Number(read) > w.max) return { problem: `l'importo è oltre ${w.max.toLocaleString("it-IT")} €: ricontrollalo con chi ti scrive` };
	return read;
}

/** A category of a fixed list from the words given; «altro», marked unmatched, when they fit none. */
export function readCategoryWith<C extends string>(value: unknown, match: (text: string) => C | undefined, fallback: C): { category: C; unmatched?: true } | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { problem: "category è un testo" };
	const said = value.trim().slice(0, 60);
	if (said === "") return undefined;
	const category = match(said);
	return category === undefined ? { category: fallback, unmatched: true } : { category };
}

/** A payment method from the words given; «altro» when they fit none. */
export function readMethod(value: unknown): Method | undefined | Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > 60) return { problem: `method è uno di questi: ${METHODS.join(", ")}` };
	return matchMethod(value) ?? "altro";
}

/** Whether a saved record already holds exactly `draft`, the keys in `skip` (id, who, state) aside. */
export function sameDraft(draft: object, saved: object, skip: readonly string[]): boolean {
	const canon = (o: object) => JSON.stringify(Object.entries(o).filter(([k, v]) => !skip.includes(k) && v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
	return canon(draft) === canon(saved);
}

/** One line of text as said: trimmed, spaces made single, no control characters, at most `max`. A problem otherwise. */
export function line(value: unknown, max: number, what: string): string | Problem {
	if (typeof value !== "string") return { problem: `${what} va scritto come testo` };
	const t = value.trim().replace(/\s+/g, " ");
	if (t === "" || t.length > max || hasControlChars(t)) return { problem: `${what} va da 1 a ${max} caratteri, senza caratteri speciali` };
	return t;
}

/** Free text (a note): newlines kept, at most `max`. */
export function textOf(value: unknown, max: number, what: string): string | Problem {
	if (typeof value !== "string") return { problem: `${what} va scritta come testo` };
	const t = value.trim();
	if (t === "" || t.length > max || hasControlChars(t)) return { problem: `${what} va da 1 a ${max} caratteri` };
	return t;
}

/** A list of lines as said: one string or an array of at most 20; undefined when not given. */
export function strings(value: unknown, max: number, what: string): string[] | Problem | undefined {
	if (value === undefined) return undefined;
	const list = Array.isArray(value) ? value : [value];
	if (list.length > 20) return { problem: `${what}: al più 20` };
	const out: string[] = [];
	for (const v of list) {
		const l = line(v, max, what);
		if (isProblem(l)) return l;
		out.push(l);
	}
	return out;
}
