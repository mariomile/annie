/**
 * The Markdown Owni writes, as blocks for the documents she makes (ADR 0029): headings, paragraphs,
 * lists, tables, quotes, code, rules, pictures and page breaks, with bold, italic, code and links
 * inside. Not all of CommonMark: what a letter, a quote or a report needs. A single line break in a
 * paragraph stays a line break, as in an address.
 */

export type Span = { readonly text: string; readonly bold?: boolean; readonly italic?: boolean; readonly code?: boolean; readonly link?: string };

export type Align = "left" | "center" | "right" | undefined;

/** An item of a list; a nested list can be of the other kind (bullets under numbered steps). */
export type ListItem = { readonly level: number; readonly ordered: boolean; readonly spans: readonly Span[] };

export type Block =
	| { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly spans: readonly Span[] }
	| { readonly type: "paragraph"; readonly spans: readonly Span[] }
	| { readonly type: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly ListItem[] }
	| { readonly type: "table"; readonly header: readonly (readonly Span[])[]; readonly rows: readonly (readonly (readonly Span[])[])[]; readonly align: readonly Align[] }
	| { readonly type: "quote"; readonly spans: readonly Span[] }
	| { readonly type: "code"; readonly text: string }
	| { readonly type: "rule" }
	| { readonly type: "pagebreak" }
	/** `widthCm`: from `![logo|4cm](...)`; without it a logo is small and on the left, any other picture as wide as fits. */
	| { readonly type: "image"; readonly alt: string; readonly path: string; readonly widthCm?: number };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE = /^ {0,3}(```|~~~)/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const PAGEBREAK = /^\s*\\(newpage|pagebreak)\s*$/;
const IMAGE = /^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*(.*)$/;
const SETEXT = /^ {0,3}(={2,}|-{3,})\s*$/;
const TASK = /^\[([ xX])\]\s+/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The blocks of a Markdown text. */
export function markdownBlocks(markdown: string): Block[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let at = 0;
	const isTableStart = (i: number): boolean => (lines[i] ?? "").includes("|") && SEPARATOR.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-");
	const startsBlock = (i: number): boolean => {
		const line = lines[i] ?? "";
		return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || PAGEBREAK.test(line) || IMAGE.test(line) || ITEM.test(line) || QUOTE.test(line) || isTableStart(i);
	};
	while (at < lines.length) {
		const line = lines[at] as string;
		if (line.trim() === "") {
			at++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const code: string[] = [];
			at++;
			while (at < lines.length && !(lines[at] as string).trimStart().startsWith(fence[1] as string)) code.push(lines[at++] as string);
			at++;
			blocks.push({ type: "code", text: code.join("\n") });
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			blocks.push({ type: "heading", level: Math.min(3, (heading[1] as string).length) as 1 | 2 | 3, spans: inlineSpans(headingText(heading[2] ?? "")) });
			at++;
			continue;
		}
		if (PAGEBREAK.test(line)) {
			blocks.push({ type: "pagebreak" });
			at++;
			continue;
		}
		if (RULE.test(line)) {
			blocks.push({ type: "rule" });
			at++;
			continue;
		}
		const image = IMAGE.exec(line);
		if (image !== null) {
			const [alt, size] = (image[1] as string).split("|");
			const cm = /^\s*(\d+(?:[.,]\d+)?)\s*(cm|mm)\s*$/i.exec(size ?? "");
			const widthCm = cm === null ? undefined : Number((cm[1] as string).replace(",", ".")) / ((cm[2] as string).toLowerCase() === "mm" ? 10 : 1);
			blocks.push({ type: "image", alt: (alt as string).trim(), path: image[2] as string, ...(widthCm === undefined || widthCm <= 0 ? {} : { widthCm }) });
			// Text after the picture on the same line (a logo and the company name) is a paragraph of its own.
			if ((image[3] as string).trim() !== "") lines[at] = image[3] as string;
			else at++;
			continue;
		}
		if (isTableStart(at)) {
			const header = cells(line);
			const align = cells(lines[at + 1] as string).map((c): Align => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined));
			at += 2;
			const rows: string[][] = [];
			while (at < lines.length && (lines[at] as string).trim() !== "" && (lines[at] as string).includes("|")) rows.push(cells(lines[at++] as string));
			const width = header.length;
			const fit = (row: string[]): string[] => Array.from({ length: width }, (_, i) => row[i] ?? "");
			// An amount never breaks between its currency sign and its number.
			const cell = (text: string) => inlineSpans(text.replace(/(€|\$|£)\s+(?=[-\d])/g, "$1\u00a0").replace(/(\d)\s+(€|EUR\b)/g, "$1\u00a0$2"));
			blocks.push({ type: "table", header: header.map(cell), rows: rows.map((r) => fit(r).map(cell)), align: Array.from({ length: width }, (_, i) => align[i]) });
			continue;
		}
		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			while (at < lines.length && QUOTE.test(lines[at] as string)) quoted.push((QUOTE.exec(lines[at++] as string) as RegExpExecArray)[1] as string);
			blocks.push({ type: "quote", spans: inlineSpans(quoted.join("\n")) });
			continue;
		}
		const item = ITEM.exec(line);
		if (item !== null) {
			const ordered = /\d/.test(item[2] as string);
			const start = ordered ? Number.parseInt(item[2] as string, 10) : 1;
			const items: { level: number; ordered: boolean; text: string }[] = [];
			while (at < lines.length) {
				const current = lines[at] as string;
				const next = ITEM.exec(current);
				if (next !== null) {
					if (/\d/.test(next[2] as string) !== ordered && (next[1] as string).length < 2) break;
					// A task list item: a box, ticked or not.
					const text = (next[3] as string).replace(TASK, (_m, mark: string) => (mark === " " ? "☐ " : "☑ "));
					items.push({ level: Math.min(2, Math.floor((next[1] as string).replace(/\t/g, "    ").length / 2)), ordered: /\d/.test(next[2] as string), text });
					at++;
				} else if (current.trim() !== "" && /^\s/.test(current) && items.length > 0) {
					// An indented line goes on with the item above.
					(items[items.length - 1] as { text: string }).text += `\n${current.trim()}`;
					at++;
				} else if (current.trim() === "" && at + 1 < lines.length && ITEM.test(lines[at + 1] as string) && /\d/.test((ITEM.exec(lines[at + 1] as string) as RegExpExecArray)[2] as string) === ordered) {
					at++; // a blank line between items: still the same list
				} else break;
			}
			// Levels never jump: an item is at most one level deeper than the one before.
			let previous = -1;
			const levelled = items.map((i) => {
				const level = Math.min(i.level, previous + 1);
				previous = level;
				return { level, ordered: level === 0 ? ordered : i.ordered, spans: inlineSpans(i.text) };
			});
			blocks.push({ type: "list", ordered, start, items: levelled });
			continue;
		}
		// A line underlined with === or --- is a heading (setext).
		const underline = SETEXT.exec(lines[at + 1] ?? "");
		if (underline !== null) {
			blocks.push({ type: "heading", level: (underline[1] as string).startsWith("=") ? 1 : 2, spans: inlineSpans(line.trim()) });
			at += 2;
			continue;
		}
		const paragraph: string[] = [];
		while (at < lines.length && (lines[at] as string).trim() !== "" && (paragraph.length === 0 || !startsBlock(at))) paragraph.push((lines[at++] as string).trim());
		blocks.push({ type: "paragraph", spans: inlineSpans(paragraph.join("\n")) });
	}
	return blocks;
}

/** A heading's text without its closing #s (`## Titolo ##`), trimmed by hand: a regex here backtracks on long runs of spaces. */
function headingText(text: string): string {
	let t = text.trim();
	let end = t.length;
	while (end > 0 && t[end - 1] === "#") end--;
	if (end < t.length && (end === 0 || t[end - 1] === " " || t[end - 1] === "\t")) t = t.slice(0, end).trim();
	return t;
}

/** A table row's cells, without the outer pipes; `\|` is a pipe inside a cell. */
function cells(line: string): string[] {
	let row = line.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
	const out: string[] = [];
	let cell = "";
	for (let i = 0; i < row.length; i++) {
		const c = row[i] as string;
		if (c === "\\" && row[i + 1] === "|") {
			cell += "|";
			i++;
		} else if (c === "|") {
			out.push(cell.trim());
			cell = "";
		} else cell += c;
	}
	out.push(cell.trim());
	return out;
}

type Style = { bold?: boolean; italic?: boolean; link?: string };

/** The longest bold, italic, code or link text, in characters: a bound on the work for each opening mark. */
const SPAN_MAX = 1000;

type Rule = {
	/** The characters a rule can start at. */
	readonly starts: string;
	/** A character before the start that rules it out (a letter before `_`). */
	readonly notAfter?: RegExp;
	/** The closing mark that must come within SPAN_MAX, looked for first (cheaply) before the expression. */
	readonly close?: string;
	readonly re: RegExp;
	readonly make: (m: RegExpExecArray, style: Style) => Span[];
};

const INLINE: readonly Rule[] = [
	{ starts: "\\", re: /^\\([\\`*_[\]()#+\-.!|>~{}])/, make: (m, s) => [{ ...s, text: m[1] as string }] },
	{ starts: "`", close: "`", re: /^`([^`]{1,1000})`/, make: (m, s) => [{ ...s, text: m[1] as string, code: true }] },
	{
		starts: "[",
		close: "](",
		re: /^\[([^\]]{1,1000})\]\(\s*<?((?:[^()\s>]|\([^()\s]*\)){1,2000})>?\s*\)/,
		make: (m, s) => spans(m[1] as string, { ...s, ...linkOf(m[2] as string) }),
	},
	{ starts: "<", re: /^<((?:https?:\/\/|mailto:)[^>\s]{1,2000})>/, make: (m, s) => [{ ...s, text: (m[1] as string).replace(/^mailto:/, ""), link: m[1] as string }] },
	{ starts: "hH", notAfter: /[\w/"'=]/, re: /^https?:\/\/[^\s<>()"]{0,2000}[^\s<>()".,;:!?']/i, make: (m, s) => [{ ...s, text: m[0], link: m[0] }] },
	{ starts: "*", close: "**", re: /^\*\*(?=\S)([\s\S]{0,1000}?\S)\*\*/, make: (m, s) => spans(m[1] as string, { ...s, bold: true }) },
	{ starts: "_", notAfter: /[\p{L}\p{N}]/u, close: "__", re: /^__(?=\S)([\s\S]{0,1000}?\S)__(?![\p{L}\p{N}])/u, make: (m, s) => spans(m[1] as string, { ...s, bold: true }) },
	{ starts: "*", close: "*", re: /^\*(?=[^\s*])([\s\S]{0,1000}?[^\s*])\*/, make: (m, s) => spans(m[1] as string, { ...s, italic: true }) },
	{ starts: "_", notAfter: /[\p{L}\p{N}]/u, close: "_", re: /^_(?=\S)([\s\S]{0,1000}?\S)_(?![\p{L}\p{N}])/u, make: (m, s) => spans(m[1] as string, { ...s, italic: true }) },
];

const STARTS = new Set(INLINE.flatMap((r) => [...r.starts]));

/** Only web and mail links become links; anything else (javascript:, file:) stays plain text. */
function linkOf(target: string): Style {
	return /^(https?:\/\/|mailto:)/i.test(target) ? { link: target } : {};
}

/** The spans of a line of Markdown: bold, italic, code and links, the rest as plain text. */
export function inlineSpans(text: string): Span[] {
	// Models write HTML line breaks in tables and addresses.
	return merge(spans(text.replace(/<br\s*\/?>/gi, "\n"), {}));
}

/**
 * One pass over the text: at a mark that can open a span, its closing mark is looked up (each
 * search goes on from the last one, so the whole text is read once per kind of mark) and only then
 * the rule's expression is tried, on at most SPAN_MAX characters. A text full of unclosed `[`, `*`
 * or `_` costs a linear scan, not a search to the end for each.
 */
function spans(text: string, style: Style): Span[] {
	const out: Span[] = [];
	const found = new Map<string, number>();
	const nextClose = (close: string, from: number): number => {
		const last = found.get(close);
		if (last !== undefined && (last >= from || last === -1)) return last;
		const at = text.indexOf(close, from);
		found.set(close, at);
		return at;
	};
	let plain = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;
		let rule: Rule | undefined;
		let match: RegExpExecArray | null = null;
		if (STARTS.has(c)) {
			for (const r of INLINE) {
				if (!r.starts.includes(c) || (r.notAfter !== undefined && i > 0 && r.notAfter.test(text[i - 1] as string))) continue;
				if (r.close !== undefined) {
					const at = nextClose(r.close, i + 1);
					if (at === -1 || at - i > SPAN_MAX + 4) continue;
				}
				match = r.re.exec(text.slice(i, i + 2 * SPAN_MAX + 64));
				if (match !== null) {
					rule = r;
					break;
				}
			}
		}
		if (rule === undefined || match === null) {
			plain += c;
			i++;
			continue;
		}
		if (plain !== "") out.push({ ...style, text: plain });
		plain = "";
		out.push(...rule.make(match, style));
		i += match[0].length;
	}
	if (plain !== "") out.push({ ...style, text: plain });
	return out;
}

/** Neighbouring spans with the same style become one. */
function merge(list: Span[]): Span[] {
	const out: Span[] = [];
	for (const span of list) {
		if (span.text === "") continue;
		const last = out[out.length - 1];
		if (last !== undefined && !!last.bold === !!span.bold && !!last.italic === !!span.italic && !!last.code === !!span.code && last.link === span.link) out[out.length - 1] = { ...last, text: last.text + span.text };
		else out.push(span);
	}
	return out;
}

/** The text of some spans, without styles. */
export function plainText(spans: readonly Span[]): string {
	return spans.map((s) => s.text).join("");
}

/** Characters XML 1.0 cannot hold (control characters, lone surrogates) are dropped. */
export function xmlSafe(text: string): string {
	return text
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
