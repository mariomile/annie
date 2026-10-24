import { deflateSync } from "node:zlib";
import type { Picture } from "./make-docx.ts";
import { numericColumn, pictureBox, safeUrl } from "./make-docx.ts";
import type { Align, Block, Span } from "./markdown-blocks.ts";
import { plainText } from "./markdown-blocks.ts";
import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS, WIN_ANSI_HIGH } from "./pdf-fonts.ts";
import { readPng } from "./png-read.ts";

/**
 * A PDF from Markdown blocks (ADR 0029), with the fonts every PDF reader has (Helvetica and
 * Courier), so nothing is embedded: A4 pages, headings, wrapped text, lists, tables that go on
 * over pages with their header, pictures, links and page numbers.
 */
export class PdfMakeError extends Error {
	override readonly name = "PdfMakeError";
}

export const PDF_MAKE_LIMITS = { maxPages: 300 } as const;

/** PNG pixels decoded for one PDF, all pictures together. */
const PICTURE_PIXELS = 40_000_000;

export type PdfInput = { readonly title?: string; readonly blocks: readonly Block[]; readonly pictures: ReadonlyMap<string, Picture>; readonly now: Date };
/**
 * `replaced`: characters the fonts do not have, written as "?"; `approximated`: letters written
 * without their accent; `emoji`: left out; `cut`: table rows too tall for a page, cut short.
 */
export type PdfResult = { readonly data: Buffer; readonly pages: number; readonly replaced: number; readonly approximated: number; readonly emoji: number; readonly cut: number; readonly skipped: readonly string[] };

type Face = "R" | "B" | "I" | "BI" | "M";
const FONT_NAMES: Record<Face, string> = { R: "Helvetica", B: "Helvetica-Bold", I: "Helvetica-Oblique", BI: "Helvetica-BoldOblique", M: "Courier" };
const FONT_IDS: Record<Face, string> = { R: "F1", B: "F2", I: "F3", BI: "F4", M: "F5" };

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56.7;
const LEFT = MARGIN;
const WIDTH = PAGE_W - 2 * MARGIN;
const TOP = PAGE_H - MARGIN;
const BOTTOM = MARGIN + 10;
const BODY = 10.5;
const BLACK: Rgb = [0.1, 0.1, 0.1];
const GREY: Rgb = [0.4, 0.4, 0.4];
const BLUE: Rgb = [0.02, 0.32, 0.75];
const HEADING_SIZE = { 1: 18, 2: 14.5, 3: 12 } as const;

type Rgb = readonly [number, number, number];
type Token = { readonly text: string; readonly face: Face; readonly size: number; readonly width: number; readonly link?: string; readonly space: boolean };
type Line = { readonly tokens: readonly Token[]; readonly width: number };
type Page = { ops: string[]; links: { rect: number[]; url: string }[]; pictures: Set<string> };

/** A few signs the standard fonts lack, written the way a person would type them. */
const SUBSTITUTES: Record<string, string> = { "→": "->", "←": "<-", "⇒": "=>", "≤": "<=", "≥": ">=", "≠": "!=", "✓": "v", "✔": "v", "✗": "x", "✘": "x", "−": "-", "‐": "-", "‑": "-", "″": '"', "′": "'", "☐": "[ ]", "☑": "[x]", "☒": "[x]" };

class Writer {
	readonly pages: Page[] = [];
	page: Page = { ops: [], links: [], pictures: new Set() };
	y = TOP;
	replaced = 0;
	emoji = 0;
	approximated = 0;
	cut = 0;

	constructor() {
		this.pages.push(this.page);
	}

	get empty(): boolean {
		return this.y === TOP;
	}

	newPage(): void {
		if (this.pages.length >= PDF_MAKE_LIMITS.maxPages) throw new PdfMakeError(`il documento supererebbe le ${PDF_MAKE_LIMITS.maxPages} pagine`);
		this.page = { ops: [], links: [], pictures: new Set() };
		this.pages.push(this.page);
		this.y = TOP;
	}

	/** Room for `height` on this page, or a new page. */
	ensure(height: number): void {
		if (this.y - height < BOTTOM && !this.empty) this.newPage();
	}

	/** Bytes of the text in the fonts' WinAnsi encoding. */
	encode(text: string): Buffer {
		const out: number[] = [];
		for (const char of text.normalize("NFC")) {
			const code = char.codePointAt(0) as number;
			if (code === 0xad || (code >= 0x200b && code <= 0x200d) || code === 0xfeff) continue;
			if (code === 9) out.push(32);
			else if ((code >= 32 && code < 127) || (code >= 0xa0 && code <= 0xff)) out.push(code);
			else if (WIN_ANSI_HIGH.has(code)) out.push(WIN_ANSI_HIGH.get(code) as number);
			else if (SUBSTITUTES[char] !== undefined) for (const c of SUBSTITUTES[char] as string) out.push(c.charCodeAt(0));
			else if ((code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x1f3fb && code <= 0x1f3ff)) continue; // emoji variation selectors and skin tones
			else if (/\p{Extended_Pictographic}/u.test(char)) this.emoji++;
			else if (plainLetter(char) !== undefined) {
				// Ș, ř, ł in a name: the letter without its sign, better than a "?".
				out.push((plainLetter(char) as string).charCodeAt(0));
				this.approximated++;
			} else {
				out.push(63);
				this.replaced++;
			}
		}
		return Buffer.from(out);
	}

	width(text: string, face: Face, size: number): number {
		if (face === "M") {
			const counts = [this.replaced, this.emoji, this.approximated] as const;
			const length = this.encode(text).length;
			[this.replaced, this.emoji, this.approximated] = counts;
			return length * 0.6 * size;
		}
		const table = face === "B" || face === "BI" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
		let total = 0;
		const counts = [this.replaced, this.emoji, this.approximated] as const;
		for (const byte of this.encode(text)) total += table[byte - 32] ?? 556;
		[this.replaced, this.emoji, this.approximated] = counts; // measuring is not writing
		return (total * size) / 1000;
	}

	text(x: number, baseline: number, token: Token, color: Rgb): void {
		const bytes = this.encode(token.text);
		this.page.ops.push(`BT /${FONT_IDS[token.face]} ${n(token.size)} Tf ${rgb(color)} rg ${n(x)} ${n(baseline)} Td <${bytes.toString("hex")}> Tj ET`);
	}
}

const STROKED: Record<string, string> = { Ł: "L", ł: "l", Đ: "D", đ: "d", Ħ: "H", ħ: "h", ı: "i", Ŧ: "T", ŧ: "t", Ŀ: "L", ŀ: "l", ĸ: "k" };

/** A Latin letter the fonts lack, as the letter without its accent or sign (ș as s, ř as r), if that is in them. */
function plainLetter(char: string): string | undefined {
	const base = STROKED[char] ?? char.normalize("NFD").replace(/\p{M}/gu, "");
	if (base.length !== 1 || base === char) return undefined;
	const code = base.charCodeAt(0);
	return (code >= 32 && code < 127) || (code >= 0xa0 && code <= 0xff) ? base : undefined;
}

/** Numbers in a content stream: at most two decimals. */
function n(value: number): string {
	return String(Math.round(value * 100) / 100);
}

function rgb(color: Rgb): string {
	return color.map(n).join(" ");
}

function faceOf(span: Span, base: { bold?: boolean; italic?: boolean }): Face {
	if (span.code) return "M";
	const bold = span.bold || base.bold;
	const italic = span.italic || base.italic;
	return bold && italic ? "BI" : bold ? "B" : italic ? "I" : "R";
}

/** Spans broken into lines at most `max` wide; a line break in the text starts a new line, a word too long is split. */
function wrap(w: Writer, spans: readonly Span[], size: number, max: number, base: { bold?: boolean; italic?: boolean } = {}): Line[] {
	const lines: Line[] = [];
	let tokens: Token[] = [];
	let width = 0;
	const flush = () => {
		while (tokens.length > 0 && (tokens[tokens.length - 1] as Token).space) width -= (tokens.pop() as Token).width;
		lines.push({ tokens, width });
		tokens = [];
		width = 0;
	};
	for (const span of spans) {
		const face = faceOf(span, base);
		const pieces = span.text.split(/(\n| +)/);
		for (const piece of pieces) {
			if (piece === "") continue;
			if (piece === "\n") {
				flush();
				continue;
			}
			const space = piece.trim() === "";
			if (space && tokens.length === 0) continue;
			const pieceWidth = w.width(space ? " " : piece, face, size);
			if (!space && width + pieceWidth > max && tokens.length > 0) flush();
			if (!space && pieceWidth > max) {
				// A word longer than the line (a link, a code): split it by characters.
				let part = "";
				for (const char of piece) {
					if (w.width(part + char, face, size) > max && part !== "") {
						tokens.push({ text: part, face, size, width: w.width(part, face, size), space: false, ...(span.link === undefined ? {} : { link: span.link }) });
						width += w.width(part, face, size);
						flush();
						part = "";
					}
					part += char;
				}
				if (part !== "") {
					const partWidth = w.width(part, face, size);
					tokens.push({ text: part, face, size, width: partWidth, space: false, ...(span.link === undefined ? {} : { link: span.link }) });
					width += partWidth;
				}
				continue;
			}
			tokens.push({ text: space ? " " : piece, face, size, width: pieceWidth, space, ...(span.link === undefined ? {} : { link: span.link }) });
			width += pieceWidth;
		}
	}
	if (tokens.length > 0 || lines.length === 0) flush();
	return lines;
}

function drawLine(w: Writer, line: Line, x: number, baseline: number, color: Rgb): void {
	// Neighbouring words in the same style go out as one string, spaces included, so the text copies and reads back whole.
	let at = x;
	let i = 0;
	const tokens = line.tokens;
	while (i < tokens.length) {
		const first = tokens[i] as Token;
		let text = "";
		let width = 0;
		let j = i;
		while (j < tokens.length && (tokens[j] as Token).face === first.face && (tokens[j] as Token).size === first.size && (tokens[j] as Token).link === first.link) {
			text += (tokens[j] as Token).text;
			width += (tokens[j] as Token).width;
			j++;
		}
		const run = { ...first, text, width };
		if (text.trim() !== "") w.text(at, baseline, run, first.link === undefined ? color : BLUE);
		if (first.link !== undefined) {
			w.page.ops.push(`${rgb(BLUE)} RG 0.5 w ${n(at)} ${n(baseline - 1.5)} m ${n(at + width)} ${n(baseline - 1.5)} l S`);
			w.page.links.push({ rect: [at, baseline - first.size * 0.25, at + width, baseline + first.size * 0.85], url: first.link });
		}
		at += width;
		i = j;
	}
}

/** Lines of text, one under the other, going on to the next page when this one is full. */
function flow(w: Writer, lines: readonly Line[], size: number, x: number, color: Rgb, decorate?: (top: number, height: number) => void): void {
	const leading = size * 1.38;
	for (const line of lines) {
		w.ensure(leading);
		decorate?.(w.y, leading);
		drawLine(w, line, x, w.y - leading + size * 0.32, color);
		w.y -= leading;
	}
}

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];

function marker(ordered: boolean, level: number, count: number): string {
	if (!ordered) return ["•", "–", "·"][level] as string;
	if (level === 0) return `${count}.`;
	if (level === 1) return `${count <= 26 ? String.fromCharCode(96 + count) : count}.`;
	return `${ROMAN[count - 1] ?? count}.`;
}

function list(w: Writer, block: Extract<Block, { type: "list" }>): void {
	const counts = [block.start - 1, 0, 0];
	let previous = 0;
	for (const item of block.items) {
		if (item.level < previous) for (let l = item.level + 1; l < 3; l++) counts[l] = 0;
		previous = item.level;
		counts[item.level] = (counts[item.level] as number) + 1;
		const label = marker(item.ordered, item.level, counts[item.level] as number);
		const indent = item.level * 18;
		const gap = Math.max(16, w.width(label, "R", BODY) + 6);
		const lines = wrap(w, item.spans, BODY, WIDTH - indent - gap);
		const leading = BODY * 1.38;
		w.ensure(leading);
		w.text(LEFT + indent, w.y - leading + BODY * 0.32, { text: label, face: "R", size: BODY, width: 0, space: false }, BLACK);
		flow(w, lines, BODY, LEFT + indent + gap, BLACK);
		w.y -= 2;
	}
	w.y -= 5;
}

function columnWidths(w: Writer, block: Extract<Block, { type: "table" }>, size: number, pad: number): number[] {
	const columns = block.header.length;
	const all = [block.header, ...block.rows];
	const natural: number[] = [];
	const least: number[] = [];
	for (let c = 0; c < columns; c++) {
		let wide = 0;
		let word = 0;
		for (const [r, row] of all.entries()) {
			const spans = row[c] ?? [];
			const face: Face = r === 0 ? "B" : "R";
			for (const line of plainText(spans).split("\n")) wide = Math.max(wide, w.width(line, face, size));
			for (const piece of plainText(spans).split(/[ \t\n]+/)) word = Math.min(WIDTH / 3, Math.max(word, w.width(piece, face, size)));
		}
		natural.push(wide + 2 * pad + 1);
		least.push(word + 2 * pad + 1);
	}
	const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
	if (sum(natural) <= WIDTH) return natural;
	const room = WIDTH - sum(least);
	if (room <= 0) return least.map((l) => (l * WIDTH) / sum(least));
	const extra = natural.map((v, i) => v - (least[i] as number));
	const share = sum(extra);
	return least.map((l, i) => l + (room * (extra[i] as number)) / share);
}

function table(w: Writer, block: Extract<Block, { type: "table" }>): void {
	const size = 9.5;
	const pad = 4;
	const leading = size * 1.32;
	const widths = columnWidths(w, block, size, pad);
	const numeric = block.header.map((_, i) => numericColumn(block.rows.map((r) => plainText(r[i] ?? []))));
	const layout = (row: readonly (readonly Span[])[], header: boolean) => {
		const cells = row.map((spans, i) => wrap(w, spans, size, (widths[i] as number) - 2 * pad, header ? { bold: true } : {}));
		return { cells, height: Math.max(1, ...cells.map((c) => c.length)) * leading + 2 * pad };
	};
	const head = layout(block.header, true);
	const draw = (row: { cells: Line[][]; height: number }, header: boolean) => {
		let x = LEFT;
		const top = w.y;
		if (header) w.page.ops.push(`0.93 0.93 0.93 rg ${n(LEFT)} ${n(top - row.height)} ${n(widths.reduce((a, b) => a + b, 0))} ${n(row.height)} re f`);
		row.cells.forEach((lines, i) => {
			const width = widths[i] as number;
			const align: Align = block.align[i] ?? (numeric[i] && !header ? "right" : undefined);
			lines.forEach((line, l) => {
				const baseline = top - pad - (l + 1) * leading + size * 0.3;
				const at = align === "right" ? x + width - pad - line.width : align === "center" ? x + (width - line.width) / 2 : x + pad;
				drawLine(w, line, at, baseline, BLACK);
			});
			w.page.ops.push(`0.7 0.7 0.7 RG 0.5 w ${n(x)} ${n(top - row.height)} ${n(width)} ${n(row.height)} re S`);
			x += width;
		});
		w.y -= row.height;
	};
	const room = TOP - BOTTOM;
	w.ensure(head.height + leading + 2 * pad);
	draw(head, true);
	for (const cells of block.rows) {
		let row = layout(cells, false);
		if (row.height > room - head.height) {
			// Taller than a page: cut short, and say so.
			const fit = Math.max(1, Math.floor((room - head.height - 2 * pad) / leading));
			row = { cells: row.cells.map((c) => c.slice(0, fit)), height: fit * leading + 2 * pad };
			w.cut++;
		}
		if (w.y - row.height < BOTTOM) {
			w.newPage();
			draw(head, true);
		}
		draw(row, false);
	}
	w.y -= 8;
}

function picture(w: Writer, picture: Picture, block: Extract<Block, { type: "image" }>, name: string): void {
	const { width, height, left } = pictureBox(picture, block.alt, block.widthCm, WIDTH, (TOP - BOTTOM) * 0.9);
	if (w.y - height < BOTTOM) w.newPage();
	const x = left ? LEFT : LEFT + (WIDTH - width) / 2;
	w.page.ops.push(`q ${n(width)} 0 0 ${n(height)} ${n(x)} ${n(w.y - height)} cm /${name} Do Q`);
	w.page.pictures.add(name);
	w.y -= height + 10;
}

export function makePdf(input: PdfInput): PdfResult {
	const w = new Writer();
	const names = new Map<string, string>();
	const skipped: string[] = [];
	const decoded = new Map<string, { picture: Picture; object?: ReturnType<typeof pictureObject> }>();
	let pixels = 0;
	for (const block of input.blocks) {
		switch (block.type) {
			case "heading": {
				const size = HEADING_SIZE[block.level];
				const lines = wrap(w, block.spans, size, WIDTH, { bold: true });
				// A heading never stays alone at the bottom of a page.
				if (!w.empty) w.y -= size * 0.7;
				w.ensure(lines.length * size * 1.38 + BODY * 1.38 * 2);
				flow(w, lines, size, LEFT, block.level === 3 ? BLACK : [0.12, 0.22, 0.39]);
				w.y -= 3;
				break;
			}
			case "paragraph":
				flow(w, wrap(w, block.spans, BODY, WIDTH), BODY, LEFT, BLACK);
				w.y -= 6;
				break;
			case "quote":
				flow(w, wrap(w, block.spans, BODY, WIDTH - 16, { italic: true }), BODY, LEFT + 14, GREY, (top, height) => w.page.ops.push(`0.75 0.75 0.75 rg ${n(LEFT + 2)} ${n(top - height)} 2.5 ${n(height)} re f`));
				w.y -= 6;
				break;
			case "code": {
				const size = 9;
				const lines = block.text.split("\n").flatMap((line) => wrap(w, [{ text: line === "" ? " " : line, code: true }], size, WIDTH - 12));
				flow(w, lines, size, LEFT + 6, BLACK, (top, height) => w.page.ops.push(`0.95 0.95 0.95 rg ${n(LEFT)} ${n(top - height)} ${n(WIDTH)} ${n(height)} re f`));
				w.y -= 8;
				break;
			}
			case "rule":
				w.ensure(14);
				w.page.ops.push(`0.7 0.7 0.7 RG 0.75 w ${n(LEFT)} ${n(w.y - 7)} m ${n(LEFT + WIDTH)} ${n(w.y - 7)} l S`);
				w.y -= 14;
				break;
			case "pagebreak":
				if (!w.empty) w.newPage();
				break;
			case "list":
				list(w, block);
				break;
			case "table":
				table(w, block);
				break;
			case "image": {
				const found = input.pictures.get(block.path);
				if (found === undefined) break;
				let entry = decoded.get(block.path);
				if (entry === undefined) {
					try {
						// All the pictures of a PDF together at most PICTURE_PIXELS: decoded pixels live outside the worker's heap limit.
						if (found.mime === "image/png") pixels += found.width * found.height;
						if (pixels > PICTURE_PIXELS) throw new Error("le immagini del documento insieme sono troppo grandi");
						entry = { picture: found, object: pictureObject(found) };
					} catch (error) {
						skipped.push(`${block.path} (${error instanceof Error ? error.message : "illeggibile"})`);
						entry = { picture: found };
					}
					decoded.set(block.path, entry);
				}
				if (entry.object === undefined) break;
				let name = names.get(block.path);
				if (name === undefined) {
					name = `Im${names.size + 1}`;
					names.set(block.path, name);
				}
				picture(w, found, block, name);
				break;
			}
		}
	}
	const pictures = [...names.entries()].map(([path, name]) => ({ name, object: (decoded.get(path) as { object: ReturnType<typeof pictureObject> }).object }));
	return { data: serialize(w, pictures, input), pages: w.pages.length, replaced: w.replaced, approximated: w.approximated, emoji: w.emoji, cut: w.cut, skipped };
}

/** The image objects of a picture: JPEG as it is, PNG as pixels with its transparency apart. */
function pictureObject(picture: Picture): { dict: string; data: Buffer; mask?: { dict: string; data: Buffer } } {
	if (picture.mime === "image/jpeg") {
		const components = jpegComponents(picture.data);
		const space = components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
		// Photoshop writes CMYK JPEGs inverted.
		const decode = components === 4 && picture.data.includes(Buffer.from("Adobe")) ? " /Decode [1 0 1 0 1 0 1 0]" : "";
		return { dict: `/Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${decode}`, data: picture.data };
	}
	const png = readPng(picture.data);
	const base = `/Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /BitsPerComponent 8 /Filter /FlateDecode`;
	return {
		dict: `${base} /ColorSpace ${png.channels === 1 ? "/DeviceGray" : "/DeviceRGB"}`,
		data: deflateSync(png.pixels),
		...(png.alpha === undefined ? {} : { mask: { dict: `${base} /ColorSpace /DeviceGray`, data: deflateSync(png.alpha) } }),
	};
}

function jpegComponents(data: Buffer): number {
	for (let at = 2; at + 9 < data.length; ) {
		if (data[at] !== 0xff) return 3;
		const marker = data[at + 1] as number;
		if (marker === 0xff) {
			at++;
			continue;
		}
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return data[at + 9] as number;
		at += 2 + data.readUInt16BE(at + 2);
	}
	return 3;
}

/** A PDF string for text outside WinAnsi (the title): UTF-16 with its byte order mark, in hex. */
function unicodeString(text: string): string {
	const units = Buffer.from(`﻿${text}`, "utf16le");
	units.swap16();
	return `<${units.toString("hex")}>`;
}

function serialize(w: Writer, pictures: { name: string; object: ReturnType<typeof pictureObject> }[], input: PdfInput): Buffer {
	const objects: Buffer[] = [];
	const add = (body: string | Buffer): number => {
		objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
		return objects.length;
	};
	const stream = (dict: string, data: Buffer): Buffer => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
	add("<< /Type /Catalog /Pages 2 0 R >>");
	add(""); // the page tree, written last when the pages are known
	const fonts = (Object.keys(FONT_NAMES) as Face[]).map((face) => `/${FONT_IDS[face]} ${add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[face]} /Encoding /WinAnsiEncoding >>`)} 0 R`);
	const pictureIds = new Map<string, number>();
	for (const { name, object } of pictures) {
		const mask = object.mask === undefined ? "" : ` /SMask ${add(stream(object.mask.dict, object.mask.data))} 0 R`;
		pictureIds.set(name, add(stream(object.dict + mask, object.data)));
	}
	const total = w.pages.length;
	const kids: number[] = [];
	w.pages.forEach((page, i) => {
		const label = `${i + 1} / ${total}`;
		const footer = `BT /F1 8.5 Tf ${rgb(GREY)} rg ${n(PAGE_W / 2 - w.width(label, "R", 8.5) / 2)} ${n(MARGIN / 2)} Td <${Buffer.from(label, "latin1").toString("hex")}> Tj ET`;
		const content = add(stream("/Filter /FlateDecode", deflateSync(Buffer.from([...page.ops, footer].join("\n"), "latin1"))));
		const xobjects = [...page.pictures].map((name) => `/${name} ${pictureIds.get(name)} 0 R`).join(" ");
		const annots = page.links.map(
			(link) => `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(n).join(" ")}] /Border [0 0 0] /A << /S /URI /URI <${Buffer.from(safeUrl(link.url), "latin1").toString("hex")}> >> >>`,
		);
		kids.push(
			add(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fonts.join(" ")} >>${xobjects === "" ? "" : ` /XObject << ${xobjects} >>`} >> /Contents ${content} 0 R${annots.length === 0 ? "" : ` /Annots [${annots.join(" ")}]`} >>`,
			),
		);
	});
	objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
	const date = input.now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const info = add(`<< /Producer (Owni) /CreationDate (D:${date}Z)${input.title === undefined || input.title === "" ? "" : ` /Title ${unicodeString(input.title)}`} >>`);
	const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
	let offset = chunks[0]?.length as number;
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(offset);
		const piece = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
		chunks.push(piece);
		offset += piece.length;
	});
	const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
	chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
	return Buffer.concat(chunks);
}
