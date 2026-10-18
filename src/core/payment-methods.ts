/**
 * How something is paid, from the person's words: shared by the spese (how an expense was paid)
 * and the rinnovi (how a renewal is paid). Whole words only, folded (no case, no accents).
 */
import { saysPhrase, words } from "./name-keys.ts";

export const METHODS = ["contanti", "carta", "bonifico", "altro"] as const;
export type Method = (typeof METHODS)[number];

const METHOD_WORDS: Readonly<Record<Exclude<Method, "altro">, readonly string[]>> = {
	contanti: ["contanti", "contante", "cash"],
	carta: ["carta", "bancomat", "pos", "credito", "debito", "visa", "mastercard", "amex", "american express", "maestro", "apple pay", "google pay", "satispay", "paypal", "prepagata"],
	bonifico: ["bonifico", "bonifici", "sepa", "rid", "sdd", "addebito", "domiciliazione"],
};

/** The payment method a person's words mean; undefined when nothing fits. */
export function matchMethod(text: string): Method | undefined {
	const tokens = words(text);
	if (tokens.length === 0) return undefined;
	if (tokens.join(" ") === "altro") return "altro";
	for (const [method, keys] of Object.entries(METHOD_WORDS) as [Method, readonly string[]][]) {
		if (keys.some((k) => saysPhrase(tokens, k))) return method;
	}
	return undefined;
}

/**
 * Words of a payment that leaves by itself: a card or PayPal charged automatically, a direct
 * debit (addebito, RID, SDD, domiciliazione). Read from the raw words said, not the method matched.
 */
const AUTOMATIC_WORDS = ["carta", "carta di credito", "paypal", "addebito", "addebito in conto", "rid", "sdd", "domiciliazione", "domiciliata", "domiciliato"];

export function automaticPayment(text: string): boolean {
	const tokens = words(text);
	return AUTOMATIC_WORDS.some((k) => saysPhrase(tokens, k));
}
