/**
 * Control characters that never belong in text a person gives for a document or a record: the C0
 * controls but the newline, DEL, and the Unicode line and paragraph separators. Shared by the
 * quotes and the company's details.
 */
export const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g;

const CONTROL_CHAR = new RegExp(CONTROL_CHARS.source);

/** Whether `text` holds one of CONTROL_CHARS. */
export function hasControlChars(text: string): boolean {
	return CONTROL_CHAR.test(text);
}

/**
 * Invisible characters that can reorder or hide what a person reads: every format character
 * (zero-width, bidi controls, tags, the soft hyphen, the BOM), variation selectors and the
 * combining grapheme joiner.
 */
const FORMAT_CHARS = /[\p{Cf}\u034f\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/** `text` without FORMAT_CHARS. */
export function withoutFormatChars(text: string): string {
	return text.replace(FORMAT_CHARS, "");
}

/** Text on one line, as a person reads it: no line breaks, controls or format characters, single spaces; at most `max` characters (an ellipsis when cut, never inside a character). */
export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string {
	const flat = withoutFormatChars(text)
		.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.trim();
	if (flat.length <= max) return flat;
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

const TYPOGRAPHIC: readonly (readonly [RegExp, string])[] = [
	[/[\u2010-\u2015\u2212]/g, "-"],
	[/[\u2018\u2019\u201a\u201b\u2032]/g, "'"],
	[/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
	[/\u2026/g, "..."],
	[/\u20ac/g, "EUR"],
	[/[\u2022\u2023\u25e6]/g, "-"],
];

/**
 * Text as FatturaPA's schema takes it (String…LatinType): one line, single spaces, no control or
 * format characters, and Latin-1 only: typographic marks become their plain forms, accented
 * letters outside Latin-1 lose the accent, anything else is «?».
 */
export function latin1(text: string): string {
	let out = withoutFormatChars(text);
	for (const [from, to] of TYPOGRAPHIC) out = out.replace(from, to);
	return [...out.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim()].map(latinChar).join("");
}

function latinChar(c: string): string {
	if ((c.codePointAt(0) as number) <= 0xff) return c;
	const bare = c.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	return [...bare].every((b) => (b.codePointAt(0) as number) <= 0xff) ? bare : "?";
}
