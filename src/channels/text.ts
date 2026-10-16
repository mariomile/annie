/** Text helpers every chat channel shares. */

/** First line of a reply resent after a crash, on channels that cannot deduplicate. */
export const DUPLICATE_NOTICE = "Possibile doppione: mi sono riavviata mentre ti inviavo questa risposta. Se l'hai già ricevuta, ignora questa.";

/** Text in pieces of at most `max` UTF-16 units, never cutting an emoji or another surrogate pair in half. */
export function splitText(text: string, max: number): string[] {
	if (text.length === 0) return ["(risposta vuota)"];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; ) {
		let end = Math.min(i + max, text.length);
		const code = text.charCodeAt(end - 1);
		if (end < text.length && code >= 0xd800 && code <= 0xdbff && end - 1 > i) end--;
		chunks.push(text.slice(i, end));
		i = end;
	}
	return chunks;
}

/** The last `max` units of a text, starting on a whole character. */
export function tailOf(text: string, max: number): string {
	let start = Math.max(0, text.length - max);
	const code = text.charCodeAt(start);
	if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start++;
	return text.slice(start);
}
