/**
 * Small XML files read whole into a tree, for formats whose structure matters (FatturaPA): one
 * forward pass with indexOf, so a hostile file is read in linear time. Elements by local name
 * (any namespace prefix dropped), their own text with the five XML entities and numeric
 * references decoded, CDATA kept as written. No DTD: any declaration (<!DOCTYPE, <!ENTITY) is
 * refused, so no entity is ever defined or expanded. Bounded in elements and depth. Loaded by the
 * document worker from source: erasable TypeScript only.
 */
import { xmlUnescape } from "./html-text.ts";

export class XmlError extends Error {
	override readonly name = "XmlError";
}

/** An element: its local name, children, text and, when it has any, its attributes as written (read with attribute()). */
export type XmlElement = { readonly name: string; readonly children: XmlElement[]; text: string; readonly attrs?: string };

/** The root element as the start of a file shows it: local name, attribute text, whether a DOCTYPE came before. */
export type XmlRoot = { readonly name: string; readonly attrs: string; readonly doctype: boolean };

const BROKEN = "il file XML è rovinato o incompleto";

/**
 * The root element of the text, past the XML declaration, processing instructions, comments and
 * a DOCTYPE; undefined when the text does not start like XML or the root's tag does not end in it.
 */
export function xmlRoot(text: string): XmlRoot | undefined {
	let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	let doctype = false;
	for (;;) {
		while (at < text.length && /\s/.test(text.charAt(at))) at++;
		if (text.startsWith("<?", at)) at = after(text, "?>", at);
		else if (text.startsWith("<!--", at)) at = after(text, "-->", at);
		else if (text.startsWith("<!DOCTYPE", at)) {
			doctype = true;
			at = doctypeEnd(text, at);
		} else break;
		if (at < 0) return undefined;
	}
	if (text.charAt(at) !== "<") return undefined;
	const end = tagEnd(text, at);
	if (end < 0) return undefined;
	const tag = text.slice(at + 1, end);
	const name = /^[^\s/>]+/.exec(tag)?.[0] ?? "";
	return { name: localName(name), attrs: tag.slice(name.length), doctype };
}

/** The XML as a tree; an XmlError in Italian when it is broken, declares anything, or passes the limits. */
export function parseXml(xml: string, limits: { readonly maxElements: number; readonly maxDepth: number }): XmlElement {
	const stack: XmlElement[] = [];
	let root: XmlElement | undefined;
	let count = 0;
	let at = 0;
	while (at < xml.length) {
		const lt = xml.indexOf("<", at);
		const textEnd = lt < 0 ? xml.length : lt;
		const top = stack.at(-1);
		if (textEnd > at && top !== undefined) top.text += xmlUnescape(xml.slice(at, textEnd));
		if (lt < 0) break;
		if (xml.startsWith("<!--", lt)) at = after(xml, "-->", lt + 4);
		else if (xml.startsWith("<![CDATA[", lt)) {
			const end = xml.indexOf("]]>", lt + 9);
			if (end < 0) throw new XmlError(BROKEN);
			if (top !== undefined) top.text += xml.slice(lt + 9, end);
			at = end + 3;
		} else if (xml.startsWith("<?", lt)) at = after(xml, "?>", lt + 2);
		else if (xml.startsWith("<!", lt)) throw new XmlError("il file XML contiene dichiarazioni (DOCTYPE o ENTITY): per sicurezza non lo leggo");
		else if (xml.charAt(lt + 1) === "/") {
			const end = xml.indexOf(">", lt);
			if (end < 0) throw new XmlError(BROKEN);
			const open = stack.pop();
			if (open === undefined || open.name !== localName(xml.slice(lt + 2, end).trim())) throw new XmlError(BROKEN);
			at = end + 1;
		} else {
			const end = tagEnd(xml, lt);
			if (end < 0) throw new XmlError(BROKEN);
			const tag = xml.slice(lt + 1, end);
			const name = /^[^\s/>]+/.exec(tag)?.[0];
			if (name === undefined) throw new XmlError(BROKEN);
			if (++count > limits.maxElements) throw new XmlError("il file XML ha troppi elementi da leggere");
			const attrs = tag.slice(name.length).replace(/\/$/, "").trim();
			const element: XmlElement = { name: localName(name), children: [], text: "", ...(attrs === "" ? {} : { attrs }) };
			if (top !== undefined) top.children.push(element);
			else if (root === undefined) root = element;
			else throw new XmlError(BROKEN);
			if (!tag.endsWith("/")) {
				if (stack.length >= limits.maxDepth) throw new XmlError("il file XML è annidato troppo in profondità");
				stack.push(element);
			}
			at = end + 1;
		}
		if (at < 0) throw new XmlError(BROKEN);
	}
	if (root === undefined || stack.length > 0) throw new XmlError(BROKEN);
	return root;
}

/**
 * Bytes as text in the encoding they declare: UTF-8 unless a byte order mark says UTF-16 or the
 * XML declaration names another (ISO-8859-1 and Windows-1252 turn up in files from old programs).
 */
export function decodeXml(data: Uint8Array): string {
	if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
	if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
	const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 200)).toString("latin1");
	const declared = /^(?:\xEF\xBB\xBF)?\s*<\?xml[^>]{0,150}?encoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(head)?.[1];
	let label = "utf-8";
	if (declared !== undefined) {
		try {
			label = new TextDecoder(declared).encoding;
		} catch {
			// An encoding nobody knows: UTF-8, as XML says when nothing else is known.
		}
	}
	return new TextDecoder(label).decode(data);
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
	return el?.children.find((c) => c.name === name);
}

export function children(el: XmlElement | undefined, name: string): XmlElement[] {
	return el === undefined ? [] : el.children.filter((c) => c.name === name);
}

/** The value of an attribute by its local name («Ccy» of `<Amt Ccy="EUR">`), unescaped; undefined when not there. */
export function attribute(el: XmlElement | undefined, name: string): string | undefined {
	if (el?.attrs === undefined) return undefined;
	for (const m of el.attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (localName(m[1] as string) === name) return xmlUnescape(m[2] ?? m[3] ?? "");
	return undefined;
}

/** The element at a path of local names, «A/B/C», taking the first of each. */
export function descendant(el: XmlElement | undefined, path: string): XmlElement | undefined {
	let current = el;
	for (const name of path.split("/")) current = child(current, name);
	return current;
}

/** The index after `close`, searched from `at`; -1 when it is not there. */
function after(text: string, close: string, at: number): number {
	const end = text.indexOf(close, at);
	return end < 0 ? -1 : end + close.length;
}

/** The end of a DOCTYPE, past an internal subset in brackets and quoted strings; -1 when it does not end. */
function doctypeEnd(text: string, at: number): number {
	let brackets = 0;
	let quote = "";
	for (let i = at; i < text.length; i++) {
		const c = text.charAt(i);
		if (quote !== "") {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "[") brackets++;
		else if (c === "]") brackets--;
		else if (c === ">" && brackets <= 0) return i + 1;
	}
	return -1;
}

/** The index of the `>` that closes the tag opening at `at`, past `>` inside quoted attribute values; -1 if none. */
function tagEnd(text: string, at: number): number {
	let quote = "";
	for (let i = at + 1; i < text.length; i++) {
		const c = text.charAt(i);
		if (quote !== "") {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === ">") return i;
	}
	return -1;
}

function localName(name: string): string {
	return name.slice(name.lastIndexOf(":") + 1);
}
