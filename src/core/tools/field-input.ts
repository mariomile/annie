/**
 * Field readers shared by the registers that take money and words from the person (spese,
 * rinnovi; the amount in euros is money-input.ts): a category from a fixed list matched
 * from words («altro», said back, when none fits), a payment method, and whether a draft is what
 * is already saved; and plain words (one line, a free text, a list of lines).
 */
import { matchMethod, type Method, METHODS } from "../payment-methods.ts";
import { hasControlChars } from "../plain-text.ts";
import { isProblem, type Problem } from "../text-input.ts";

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
