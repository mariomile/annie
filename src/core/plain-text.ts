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

/** Invisible format characters that can reorder or hide what a person reads: zero-width, bidi embeddings, overrides and isolates, the BOM. */
export const FORMAT_CHARS = /[​-‏‪-‮⁦-⁩﻿]/g;

/** `text` without FORMAT_CHARS. */
export function withoutFormatChars(text: string): string {
	return text.replace(FORMAT_CHARS, "");
}

/** Text on one line, as a person reads it: no line breaks, controls or format characters, single spaces; at most `max` characters (an ellipsis when cut). */
export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string {
	const flat = withoutFormatChars(text)
		.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
