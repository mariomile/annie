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

/** The legal form a name ends with, closed up («srl», «spa»), or undefined when it has none. */
export function legalForm(name: string): string | undefined {
	const forms = nameWords(name).filter((w) => LEGAL_FORMS.has(w));
	return forms.at(-1);
}

/** Whether two names may be one business: the same name without legal form, and the same legal form or one of them without («Rossi» and «Rossi Srl», never «Rossi Srl» and «Rossi SpA»). */
export function sameBusiness(a: string, b: string): boolean {
	const key = businessKey(a);
	if (key === "" || key !== businessKey(b)) return false;
	const fa = legalForm(a);
	const fb = legalForm(b);
	return fa === undefined || fb === undefined || fa === fb;
}

/** A name compared without case, accents and punctuation, its legal form kept: «Rossi S.r.l.» is «rossi srl», not «rossi» nor «rossi spa». */
export function spellingKey(name: string): string {
	return nameWords(name).join(" ");
}

/** Whether one key holds the other as whole words in a row («rossi» in «mario rossi»); never an empty one. */
export function keyWithin(a: string, b: string): boolean {
	return a !== "" && b !== "" && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
}

/**
 * Whether two keys differ only by a slip in one word: the same words but one, which is cut short
 * by a letter or two («ner» for «neri») or has one letter wrong, missing or extra («rosi» for
 * «rossi»). Short words never: «re» is not «rea».
 */
export function nearKey(a: string, b: string): boolean {
	const wa = a.split(" ");
	const wb = b.split(" ");
	if (a === "" || b === "" || a === b || wa.length !== wb.length) return false;
	const differ = wa.flatMap((w, i) => (w === wb[i] ? [] : [[w, wb[i] as string] as const]));
	if (differ.length !== 1) return false;
	const [x, y] = differ[0] as readonly [string, string];
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	if (short.length >= 3 && long.startsWith(short) && long.length - short.length <= 2) return true;
	return short.length >= 4 && oneEdit(short, long);
}

/** One letter changed, added or dropped (`a` no longer than `b`). */
function oneEdit(a: string, b: string): boolean {
	if (b.length - a.length > 1) return false;
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : a.slice(i) === b.slice(i + 1);
}

/** Whether folded words hold `key` (a word or a phrase, folded the same way) as whole words in a row. */
export function saysPhrase(tokens: readonly string[], key: string): boolean {
	const parts = words(key);
	if (parts.length === 0) return false;
	for (let i = 0; i + parts.length <= tokens.length; i++) {
		if (parts.every((p, j) => tokens[i + j] === p)) return true;
	}
	return false;
}

/** Words that only join a name's words: «rotoli di carta» is «rotoli carta». */
const JOINERS = new Set(["di", "da", "del", "dello", "della", "dei", "degli", "delle", "per", "il", "lo", "la", "i", "gli", "le", "l", "un", "uno", "una"]);

/** The words of a name that say what it is, the joining words out: «rotoli di carta» is «rotoli carta». */
export function sayingWords(text: string): string[] {
	return words(text).filter((w) => !JOINERS.has(w));
}

/**
 * The other number of an Italian word, the gender kept: a singular in -a is a plural in -e
 * (cartuccia, cartucce), in -o is one in -i (rotolo, rotoli; foglio, fogli), in -e is one in -i
 * (cartone, cartoni); and the plural back. Never -o with -a nor -a with -o or -i: «colla» is
 * not «collo», «panna» not «panno», «cera» not «ceri». The few spellings that move a letter
 * (-cia/-ce, -ca/-che, -co/-chi, -io/-i) are in. A word of less than three letters is only itself.
 */
export function otherNumbers(w: string): string[] {
	if (w.length < 3 || !/[a-z]$/.test(w)) return [w];
	const base = w.slice(0, -1);
	const out = new Set([w]);
	switch (w.at(-1)) {
		case "a":
			out.add(`${base}e`);
			if (/[cg]i$/.test(base)) out.add(`${base.slice(0, -1)}e`);
			if (/[cg]$/.test(base)) out.add(`${base}he`);
			break;
		case "o":
			out.add(`${base}i`);
			if (base.endsWith("i")) out.add(base);
			if (/[cg]$/.test(base)) out.add(`${base}hi`);
			break;
		case "e":
			out.add(`${base}a`);
			out.add(`${base}i`);
			if (/[cg]h$/.test(base)) out.add(`${base.slice(0, -1)}a`);
			if (/[cg]$/.test(base)) out.add(`${base}ia`);
			break;
		case "i":
			out.add(`${base}o`);
			out.add(`${base}e`);
			out.add(`${w}o`);
			if (/[cg]h$/.test(base)) out.add(`${base.slice(0, -1)}o`);
			break;
	}
	return [...out];
}

/** The same word, or the same word in the other number (otherNumbers, either way round). */
export function sameWord(a: string, b: string): boolean {
	return a === b || otherNumbers(a).includes(b) || otherNumbers(b).includes(a);
}

/** Whether every word of `said` is among those of `name`, in either number («cartucce» in «Cartuccia XL»); never an empty one. */
export function stemsWithin(said: string, name: string): boolean {
	const s = sayingWords(said);
	const n = sayingWords(name);
	return s.length > 0 && s.every((w) => n.some((x) => sameWord(w, x)));
}

/** Two names the same in either number, as sets of words: «rotoli di carta» and «carta rotolo». */
export function sameStems(a: string, b: string): boolean {
	return stemsWithin(a, b) && stemsWithin(b, a);
}

/** The abbreviations suppliers write in an invoice line, spelled out: «gr», «g» grammi, «ff», «fg» fogli, «rs» risma, «nr» numero. */
const ABBREVIATIONS: Readonly<Record<string, string>> = { gr: "grammi", g: "grammi", ff: "fogli", fg: "fogli", rs: "risma", nr: "numero" };

/**
 * A supplier's description the way it is matched: folded words, digits apart from the letters they
 * are glued to («80GR» is «80 gr», «RS500» «rs 500») and the abbreviations of ABBREVIATIONS spelled
 * out. Only for the lines of the invoices received and what is matched with them (prices paid,
 * articles of the magazzino a line is loaded on): never the names of articles, clients or
 * suppliers among themselves, where «g» or «rs» may be a name of their own.
 */
export function spelledOut(text: string): string {
	return words(
		fold(text)
			.replace(/(\d)([a-z])/g, "$1 $2")
			.replace(/([a-z])(\d)/g, "$1 $2"),
	)
		.map((w) => ABBREVIATIONS[w] ?? w)
		.join(" ");
}

/** Whether every word of `said` is in `description`, in either number, both spelled out (spelledOut): «carta a4 80 grammi» in «CARTA A4 80GR RS500». */
export function wordsWithin(said: string, description: string): boolean {
	return stemsWithin(spelledOut(said), spelledOut(description));
}
