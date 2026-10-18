/**
 * Text out of HTML and XML for the tools that read pages and feeds (web_read, the sentinelle,
 * news_headlines): elements dropped whole, comments dropped, entities decoded. Every scan moves
 * forward with indexOf, so a hostile document is read in linear time.
 */

/** ASCII letters in lower case, nothing else: the text keeps its length, so an index in it is an index in the original («İ» would grow under toLowerCase). */
export function asciiLower(text: string): string {
	return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** The HTML without the given elements and their content, found with indexOf: one pass per tag. An unclosed one takes the rest. */
export function withoutBlocks(html: string, tags: readonly string[], lower: string = asciiLower(html)): string {
	const cut: [number, number][] = [];
	for (const tag of tags) {
		let from = 0;
		for (;;) {
			const start = lower.indexOf(`<${tag}`, from);
			if (start < 0) break;
			const close = lower.indexOf(`</${tag}`, start + 1);
			const end = close < 0 ? html.length : Math.max(close, lower.indexOf(">", close) + 1);
			cut.push([start, end]);
			from = end;
		}
	}
	cut.sort((a, b) => a[0] - b[0]);
	let out = "";
	let at = 0;
	for (const [start, end] of cut) {
		if (end <= at) continue;
		out += `${html.slice(at, Math.max(at, start))} `;
		at = Math.max(at, end);
	}
	return out + html.slice(at);
}

/** The HTML without `<!-- … -->`; an unclosed comment takes the rest. */
export function withoutComments(html: string): string {
	let out = "";
	let at = 0;
	for (;;) {
		const start = html.indexOf("<!--", at);
		if (start < 0) return out + html.slice(at);
		const end = html.indexOf("-->", start + 4);
		out += `${html.slice(at, start)} `;
		if (end < 0) return out;
		at = end + 3;
	}
}

/**
 * Characters that hide or reorder text: controls, soft hyphen, bidirectional marks and overrides,
 * zero-width and invisible operators, variation selectors, the byte order mark and the tag
 * characters (which can spell hidden instructions). Global: for replace, not test.
 */
export const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}]/gu;

/** The named entities pages and feeds use, beyond XML's five: Italian letters, quotes and dashes. A Map, so «&constructor;» is no entity. */
const ENTITIES = new Map<string, string>(
	Object.entries({
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		agrave: "à",
		aacute: "á",
		egrave: "è",
		eacute: "é",
		igrave: "ì",
		iacute: "í",
		ograve: "ò",
		oacute: "ó",
		ugrave: "ù",
		uacute: "ú",
		Agrave: "À",
		Egrave: "È",
		Eacute: "É",
		Igrave: "Ì",
		Ograve: "Ò",
		Ugrave: "Ù",
		ccedil: "ç",
		ntilde: "ñ",
		auml: "ä",
		ouml: "ö",
		uuml: "ü",
		szlig: "ß",
		lsquo: "‘",
		rsquo: "’",
		ldquo: "“",
		rdquo: "”",
		laquo: "«",
		raquo: "»",
		ndash: "–",
		mdash: "—",
		hellip: "…",
		middot: "·",
		bull: "•",
		euro: "€",
		pound: "£",
		deg: "°",
		copy: "©",
		reg: "®",
		trade: "™",
	}),
);

/** Named and numeric entities in one pass; an unknown name stays as written, a code point that is not a printable character becomes a space. */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (whole, decimal?: string, hex?: string, name?: string) => {
		if (name !== undefined) return ENTITIES.get(name) ?? whole;
		const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
		return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code < 0x20 ? " " : String.fromCodePoint(code);
	});
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML's five entities and numeric references, nothing else: no DTD, so no other entity is defined, and an unknown one stays as written. */
export function xmlUnescape(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, code: string) => {
		if (code.startsWith("#x")) return safeCodePoint(Number.parseInt(code.slice(2), 16)) ?? whole;
		if (code.startsWith("#")) return safeCodePoint(Number.parseInt(code.slice(1), 10)) ?? whole;
		return XML_ENTITIES[code] ?? whole;
	});
}

function safeCodePoint(n: number): string | undefined {
	return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}
