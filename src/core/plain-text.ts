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
