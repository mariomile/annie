/**
 * Names of businesses and people compared the way a person means them: no case, accents,
 * punctuation nor legal form («Bar Sport S.r.l.» is «bar sport»). Shared by the expenses (a
 * supplier recorded twice) and the timesheet (a client said again in other words).
 */
import { fold } from "./text-match.ts";

/** Folded words of a text: lower case, no accents, letters and digits (and & for B&B). */
export function words(text: string): string[] {
	return fold(text)
		.split(/[^a-z0-9&]+/)
		.filter((w) => w !== "");
}

const LEGAL_FORMS = new Set(["srl", "srls", "spa", "snc", "sas", "sapa", "ss"]);

/** The words of a name with dotted abbreviations closed up: «S.r.l.» is «srl». */
function nameWords(name: string): string[] {
	return words(fold(name).replace(/\b([a-z])\.(?=[a-z]\.?)/g, "$1").replace(/\.(?=\s|$)/g, ""));
}

/** A business's name compared: no case, accents, punctuation nor legal form («Bar Sport S.r.l.» is «bar sport»). */
export function businessKey(name: string): string {
	return nameWords(name)
		.filter((w) => !LEGAL_FORMS.has(w))
		.join(" ");
}

/** A name compared without case, accents and punctuation, its legal form kept: «Rossi S.r.l.» is «rossi srl», not «rossi» nor «rossi spa». */
export function spellingKey(name: string): string {
	return nameWords(name).join(" ");
}

/** Whether one key holds the other as whole words in a row («rossi» in «mario rossi»); never an empty one. */
export function keyWithin(a: string, b: string): boolean {
	return a !== "" && b !== "" && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
}
