import { inflateSync } from "node:zlib";
import { type PdfEncryption, pdfCipher, type PdfCipher } from "./pdf-crypt.ts";
import { ccittDecode, lzwDecode, PdfImageError, pngOf, runLengthDecode } from "./pdf-images.ts";

/**
 * The text of a PDF, without dependencies (ADR 0026). Reads the objects (also those packed in
 * object streams), walks the pages in order, decodes each page's content with its fonts
 * (ToUnicode maps, simple encodings with Differences, widths for spacing) and lays the text out
 * in lines. What it does not do: decrypt, OCR scans, read text drawn as curves. Every size is
 * bounded: a crafted file costs at most the limits below.
 */
export class PdfError extends Error {
	override readonly name = "PdfError";
}

export const PDF_LIMITS = { maxStreamBytes: 20 * 1024 * 1024, maxDecodedBytes: 120 * 1024 * 1024, maxPages: 1_000, maxTextChars: 2_000_000, maxObjects: 500_000, maxDepth: 64 } as const;

export type PdfText = { readonly text: string; readonly pages: number; readonly note?: string };

// No parameter properties in the files the document worker loads: Node strips the types there, nothing else.
class Name {
	readonly name: string;
	constructor(name: string) {
		this.name = name;
	}
}
class Ref {
	readonly num: number;
	readonly gen: number;
	constructor(num: number, gen: number) {
		this.num = num;
		this.gen = gen;
	}
}
class Op {
	readonly op: string;
	constructor(op: string) {
		this.op = op;
	}
}
type Dict = Map<string, Value>;
type Value = null | boolean | number | Buffer | Name | Ref | Value[] | Dict;
/** A stream and, for decryption, the number of the object that holds it. */
type Stream = { readonly dict: Dict; readonly raw: Buffer; readonly num?: number; readonly gen?: number };
type Obj = Value | Stream;

const isDict = (v: unknown): v is Dict => v instanceof Map;
const isStream = (v: unknown): v is Stream => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && !Buffer.isBuffer(v) && "raw" in v && "dict" in v;

/** What the lexer returns for a byte it skips. */
const SKIP = Symbol("skip");

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** PDF syntax: objects in a file, operands and operators in a content stream. */
class Lexer {
	pos: number;
	readonly data: Buffer;
	constructor(data: Buffer, start = 0) {
		this.data = data;
		this.pos = start;
	}

	skip(): void {
		const d = this.data;
		while (this.pos < d.length) {
			const c = d[this.pos] as number;
			if (WS.has(c)) this.pos++;
			else if (c === 0x25) {
				while (this.pos < d.length && d[this.pos] !== 0x0a && d[this.pos] !== 0x0d) this.pos++;
			} else break;
		}
	}

	/** The next value, an operator, or undefined at the end. Depth bounds nested arrays and dicts. */
	next(depth = 0): Value | Op | undefined {
		if (depth > PDF_LIMITS.maxDepth) throw new PdfError("struttura troppo annidata");
		// Stray delimiters and unknown bytes are skipped here, in a loop, never by recursion.
		for (;;) {
			const value = this.token(depth);
			if (value !== SKIP) return value;
		}
	}

	private token(depth: number): Value | Op | undefined | typeof SKIP {
		this.skip();
		const d = this.data;
		if (this.pos >= d.length) return undefined;
		const c = d[this.pos] as number;
		if (c === 0x2f) return new Name(this.word(1));
		if (c === 0x28) return this.literal();
		if (c === 0x3c) {
			if (d[this.pos + 1] === 0x3c) {
				this.pos += 2;
				const dict: Dict = new Map();
				for (;;) {
					this.skip();
					if (this.pos >= d.length) return dict;
					if (d[this.pos] === 0x3e && d[this.pos + 1] === 0x3e) {
						this.pos += 2;
						return dict;
					}
					const key = this.next(depth + 1);
					if (!(key instanceof Name)) {
						if (key === undefined) return dict;
						continue;
					}
					const value = this.value(depth + 1);
					if (value !== undefined) dict.set(key.name, value);
				}
			}
			return this.hex();
		}
		if (c === 0x5b) {
			this.pos++;
			const items: Value[] = [];
			for (;;) {
				this.skip();
				if (this.pos >= d.length) return items;
				if (d[this.pos] === 0x5d) {
					this.pos++;
					return items;
				}
				const item = this.value(depth + 1);
				if (item === undefined) {
					this.pos++;
					continue;
				}
				items.push(item);
			}
		}
		if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7b || c === 0x7d) {
			this.pos++;
			return SKIP;
		}
		const word = this.word(0);
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
			const n = Number(word);
			// "num gen R" is a reference.
			if (/^\d+$/.test(word)) {
				const save = this.pos;
				this.skip();
				const gen = this.word(0);
				this.skip();
				if (/^\d+$/.test(gen) && this.data[this.pos] === 0x52 && this.boundary(this.pos + 1)) {
					this.pos++;
					return new Ref(n, Number(gen));
				}
				this.pos = save;
			}
			return n;
		}
		if (word === "true") return true;
		if (word === "false") return false;
		if (word === "null") return null;
		if (word === "") {
			this.pos++;
			return SKIP;
		}
		return new Op(word);
	}

	/** A value, skipping stray operators (inside objects there are none). */
	value(depth = 0): Value | undefined {
		const v = this.next(depth);
		return v instanceof Op ? undefined : v;
	}

	private boundary(at: number): boolean {
		const c = this.data[at];
		return c === undefined || WS.has(c) || DELIM.has(c);
	}

	private word(from: number): string {
		const d = this.data;
		const start = this.pos + from;
		let end = start;
		while (end < d.length && !WS.has(d[end] as number) && !DELIM.has(d[end] as number)) end++;
		this.pos = end;
		const raw = d.subarray(start, end).toString("latin1");
		return from === 1 ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))) : raw;
	}

	private literal(): Buffer {
		const d = this.data;
		const out: number[] = [];
		let depth = 0;
		this.pos++;
		while (this.pos < d.length) {
			const c = d[this.pos++] as number;
			if (c === 0x5c) {
				const e = d[this.pos++];
				if (e === undefined) break;
				const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
				if (map[e] !== undefined) out.push(map[e] as number);
				else if (e >= 0x30 && e <= 0x37) {
					let n = e - 0x30;
					for (let i = 0; i < 2 && (d[this.pos] as number) >= 0x30 && (d[this.pos] as number) <= 0x37; i++) n = n * 8 + ((d[this.pos++] as number) - 0x30);
					out.push(n & 0xff);
				} else if (e === 0x0d) {
					if (d[this.pos] === 0x0a) this.pos++;
				} else if (e !== 0x0a) out.push(e);
			} else if (c === 0x28) {
				depth++;
				out.push(c);
			} else if (c === 0x29) {
				if (depth === 0) break;
				depth--;
				out.push(c);
			} else out.push(c);
		}
		return Buffer.from(out);
	}

	private hex(): Buffer {
		const d = this.data;
		this.pos++;
		let digits = "";
		while (this.pos < d.length && d[this.pos] !== 0x3e) {
			const ch = String.fromCharCode(d[this.pos++] as number);
			if (/[0-9a-fA-F]/.test(ch)) digits += ch;
		}
		this.pos++;
		if (digits.length % 2 === 1) digits += "0";
		return Buffer.from(digits, "hex");
	}
}

/** The objects of the file, by number: direct ones, then those inside object streams. */
class Document {
	readonly objects = new Map<number, Obj>();
	/** Set for an encrypted PDF that opens without a password. */
	cipher: PdfCipher | undefined;
	encryptMetadata = true;
	private decoded = 0;
	private spent = false;
	private readonly decodedStreams = new WeakMap<Stream, Buffer>();
	trailer: Dict = new Map();

	readonly data: Buffer;

	constructor(data: Buffer) {
		this.data = data;
		const text = data.toString("latin1");
		const header = /(\d+)\s+(\d+)\s+obj\b/g;
		let count = 0;
		for (let m = header.exec(text); m !== null; m = header.exec(text)) {
			if (++count > PDF_LIMITS.maxObjects) throw new PdfError("troppi oggetti");
			const lexer = new Lexer(data, m.index + m[0].length);
			let value: Value | undefined;
			try {
				value = lexer.value();
			} catch (error) {
				if (error instanceof PdfError) throw error;
				continue;
			}
			if (value === undefined) continue;
			lexer.skip();
			if (isDict(value) && text.startsWith("stream", lexer.pos)) {
				let start = lexer.pos + 6;
				if (data[start] === 0x0d) start++;
				if (data[start] === 0x0a) start++;
				const length = value.get("Length");
				let end = typeof length === "number" && length >= 0 && text.startsWith("endstream", skipWs(data, start + length)) ? start + length : text.indexOf("endstream", start);
				if (end < 0) end = data.length;
				this.objects.set(Number(m[1]), { dict: value, raw: data.subarray(start, end), num: Number(m[1]), gen: Number(m[2]) });
				header.lastIndex = end;
			} else this.objects.set(Number(m[1]), value);
			if (isDict(value) && value.get("Type") instanceof Name && (value.get("Type") as Name).name === "XRef") this.trailer = new Map([...this.trailer, ...value]);
		}
		for (let at = text.indexOf("trailer"); at >= 0; at = text.indexOf("trailer", at + 7)) {
			const dict = new Lexer(data, at + 7).value();
			if (isDict(dict)) this.trailer = new Map([...this.trailer, ...dict]);
		}
	}

	/** After the cipher is known: object streams are encrypted like any other stream. */
	unpackObjectStreams(): void {
		for (const obj of [...this.objects.values()]) {
			if (!isStream(obj) || nameOf(obj.dict.get("Type")) !== "ObjStm") continue;
			let body: Buffer;
			try {
				body = this.stream(obj);
			} catch {
				continue;
			}
			const n = Math.min(Number(this.get(obj.dict.get("N")) ?? 0), PDF_LIMITS.maxObjects);
			const first = Number(this.get(obj.dict.get("First")) ?? 0);
			const head = new Lexer(body);
			const pairs: [number, number][] = [];
			for (let i = 0; i < n; i++) {
				const num = head.value();
				const offset = head.value();
				if (typeof num !== "number" || typeof offset !== "number") break;
				pairs.push([num, offset]);
			}
			for (const [num, offset] of pairs) {
				if (this.objects.has(num)) continue;
				try {
					const value = new Lexer(body, first + offset).value();
					if (value !== undefined) this.objects.set(num, value);
				} catch {
					/* one bad object, the others still count */
				}
			}
		}
	}

	/** Follow a reference (a few hops at most). */
	get(value: Value | Obj | undefined): Obj | undefined {
		let v = value;
		for (let hops = 0; v instanceof Ref && hops < 16; hops++) v = this.objects.get(v.num);
		return v instanceof Ref ? undefined : v;
	}

	dict(value: Value | Obj | undefined): Dict | undefined {
		const v = this.get(value);
		if (isDict(v)) return v;
		if (isStream(v)) return v.dict;
		return undefined;
	}

	/** A stream's bytes after its filters. Images and unknown filters give an empty buffer. */
	stream(stream: Stream): Buffer {
		// Decoded once per stream: a font or form used a thousand times costs one decoding.
		const known = this.decodedStreams.get(stream);
		if (known !== undefined) return known;
		if (this.spent) throw new PdfError("il PDF è troppo grande da leggere");
		try {
			const data = this.decode(stream);
			this.decodedStreams.set(stream, data);
			return data;
		} catch (error) {
			// Once over a limit, every later stream fails at once: nothing can swallow the limit and go on.
			if (error instanceof PdfError) this.spent = true;
			throw error;
		}
	}

	private decode(stream: Stream): Buffer {
		return this.filtered(stream, false).data;
	}

	/**
	 * An image's bytes after the general filters, and the image filter left to apply (DCT, CCITT,
	 * JBIG2, JPX) with its parameters: a JPEG goes to the model as it is.
	 */
	imageData(stream: Stream): { data: Buffer; filter?: string; parm?: Dict } {
		return this.filtered(stream, true);
	}

	private filtered(stream: Stream, image: boolean): { data: Buffer; filter?: string; parm?: Dict } {
		const filters = this.get(stream.dict.get("Filter"));
		const list = (Array.isArray(filters) ? filters : filters === undefined ? [] : [filters]).map((f) => nameOf(this.get(f as Value)));
		const parms = this.get(stream.dict.get("DecodeParms"));
		let data: Buffer = stream.raw;
		const type = nameOf(stream.dict.get("Type"));
		// Cross-reference streams are never encrypted; metadata only when the file says so.
		if (this.cipher !== undefined && stream.num !== undefined && type !== "XRef" && (type !== "Metadata" || this.encryptMetadata)) data = this.cipher(stream.num, stream.gen ?? 0, data);
		let left: { filter: string; parm?: Dict } | undefined;
		list.forEach((filter, i) => {
			if (left !== undefined) return;
			const parm = this.dict(Array.isArray(parms) ? (parms[i] as Value) : (parms as Value | undefined));
			if (filter === "FlateDecode" || filter === "Fl") data = predictor(inflate(data), parm, this);
			else if (filter === "ASCIIHexDecode" || filter === "AHx") data = Buffer.from(data.toString("latin1").replace(/[^0-9a-fA-F]/g, "").replace(/^((?:..)*).$/, "$10"), "hex");
			else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85(data);
			else if (filter === "LZWDecode" || filter === "LZW") data = predictor(bounded(() => lzwDecode(data, Number(this.get(parm?.get("EarlyChange")) ?? 1) === 0 ? 0 : 1, PDF_LIMITS.maxStreamBytes)), parm, this);
			else if (filter === "RunLengthDecode" || filter === "RL") data = bounded(() => runLengthDecode(data, PDF_LIMITS.maxStreamBytes));
			else if (image && filter !== undefined) left = { filter: filter === "DCT" ? "DCTDecode" : filter === "CCF" ? "CCITTFaxDecode" : filter, ...(parm === undefined ? {} : { parm }) };
			else data = Buffer.alloc(0);
		});
		this.decoded += data.length;
		if (this.decoded > PDF_LIMITS.maxDecodedBytes) throw new PdfError("il PDF è troppo grande da leggere");
		return { data, ...left };
	}
}

/** Spaces at line ends removed, line by line: a regex here backtracks on long runs of spaces. */
export function trimLines(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function endsInSpace(text: string): boolean {
	const last = text.at(-1);
	return last === " " || last === "\n" || last === "\t" || last === "\r";
}

function skipWs(data: Buffer, at: number): number {
	let i = at;
	while (i < data.length && WS.has(data[i] as number)) i++;
	return i;
}

function nameOf(v: unknown): string | undefined {
	return v instanceof Name ? v.name : undefined;
}

function inflate(data: Buffer): Buffer {
	try {
		return inflateSync(data, { maxOutputLength: PDF_LIMITS.maxStreamBytes });
	} catch (error) {
		if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new PdfError("una parte del PDF è troppo grande da leggere");
		// A stream cut short: keep what inflates.
		try {
			return inflateSync(data, { maxOutputLength: PDF_LIMITS.maxStreamBytes, finishFlush: 2 });
		} catch {
			return Buffer.alloc(0);
		}
	}
}

/** PNG predictors, as cross-reference and object streams and many images use them. */
function predictor(data: Buffer, parm: Dict | undefined, doc: Document): Buffer {
	const p = Number(doc.get(parm?.get("Predictor")) ?? 1);
	if (p < 10) return data;
	const columns = Number(doc.get(parm?.get("Columns")) ?? 1);
	const colors = Number(doc.get(parm?.get("Colors")) ?? 1);
	const bits = Number(doc.get(parm?.get("BitsPerComponent")) ?? 8);
	if (!(columns > 0 && columns <= 100_000 && colors >= 1 && colors <= 4 && [1, 2, 4, 8, 16].includes(bits))) return data;
	// Bytes per row and per pixel: the left neighbour of a byte is the same byte of the pixel before.
	const rowBytes = Math.ceil((columns * colors * bits) / 8);
	const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
	const rows = Math.floor(data.length / (rowBytes + 1));
	const out = Buffer.alloc(rows * rowBytes);
	for (let r = 0; r < rows; r++) {
		const at = r * (rowBytes + 1);
		const type = data[at] as number;
		const row = r * rowBytes;
		for (let i = 0; i < rowBytes; i++) {
			const raw = data[at + 1 + i] as number;
			const left = i >= bpp ? (out[row + i - bpp] as number) : 0;
			const up = r > 0 ? (out[row - rowBytes + i] as number) : 0;
			const ul = r > 0 && i >= bpp ? (out[row - rowBytes + i - bpp] as number) : 0;
			let v = raw;
			if (type === 1) v = raw + left;
			else if (type === 2) v = raw + up;
			else if (type === 3) v = raw + ((left + up) >> 1);
			else if (type === 4) {
				const pa = Math.abs(up - ul);
				const pb = Math.abs(left - ul);
				const pc = Math.abs(left + up - 2 * ul);
				v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
			}
			out[row + i] = v & 0xff;
		}
	}
	return out;
}

/** A decoder's limit as the PDF's own error. */
function bounded(decode: () => Buffer): Buffer {
	try {
		return decode();
	} catch (error) {
		if (error instanceof PdfImageError) throw new PdfError(error.message);
		throw error;
	}
}

function ascii85(data: Buffer): Buffer {
	const text = data.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/, "");
	const out: number[] = [];
	let group: number[] = [];
	for (const ch of text) {
		if (ch === "z" && group.length === 0) {
			out.push(0, 0, 0, 0);
			continue;
		}
		const c = ch.charCodeAt(0) - 33;
		if (c < 0 || c > 84) continue;
		group.push(c);
		if (group.length === 5) {
			let n = 0;
			for (const g of group) n = n * 85 + g;
			out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
			group = [];
		}
	}
	if (group.length > 1) {
		const missing = 5 - group.length;
		while (group.length < 5) group.push(84);
		let n = 0;
		for (const g of group) n = n * 85 + g;
		out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, 4 - missing));
	}
	return Buffer.from(out);
}

// ---------- fonts ----------

const WIN_ANSI_HIGH = "€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ";

function winAnsi(code: number): string {
	if (code >= 0x80 && code <= 0x9f) return WIN_ANSI_HIGH[code - 0x80] as string;
	return String.fromCharCode(code);
}

const GLYPHS: Record<string, string> = {
	space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’", quoteleft: "‘", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "−", period: ".", slash: "/",
	zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@",
	bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
	quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„", endash: "–", emdash: "—", bullet: "•", ellipsis: "…", Euro: "€", euro: "€", degree: "°", copyright: "©", registered: "®", trademark: "™", section: "§", paragraph: "¶",
	fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", germandbls: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", oslash: "ø", Oslash: "Ø", guillemotleft: "«", guillemotright: "»", guilsinglleft: "‹", guilsinglright: "›", periodcentered: "·", nbspace: " ", sterling: "£", yen: "¥", cent: "¢", multiply: "×", divide: "÷", plusminus: "±", ordfeminine: "ª", ordmasculine: "º", exclamdown: "¡", questiondown: "¿", dotlessi: "ı",
};
const ACCENTS: Record<string, string> = { grave: "̀", acute: "́", circumflex: "̂", tilde: "̃", dieresis: "̈", ring: "̊", cedilla: "̧", caron: "̌" };

function glyphChar(name: string): string | undefined {
	if (GLYPHS[name] !== undefined) return GLYPHS[name];
	if (/^[A-Za-z]$/.test(name)) return name;
	const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
	if (uni !== null) {
		const n = Number.parseInt(uni[1] as string, 16);
		return n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
	}
	const accented = /^([A-Za-z])(grave|acute|circumflex|tilde|dieresis|ring|cedilla|caron)$/.exec(name);
	if (accented !== null) return `${accented[1]}${ACCENTS[accented[2] as string]}`.normalize("NFC");
	const base = name.split(".")[0] ?? "";
	return base !== name && base !== "" ? glyphChar(base) : undefined;
}

type Font = {
	/** Byte lengths of codes, longest first. */
	readonly widths: readonly number[];
	readonly toUnicode?: Map<string, string>;
	readonly simple?: Map<number, string>;
	readonly advance: (code: number) => number;
	readonly twoByte: boolean;
};

/** A font has at most 65,536 codes of each length: more entries than this are a crafted map. */
const CMAP_MAX_ENTRIES = 200_000;

function cmap(text: string): { map: Map<string, string>; lengths: number[] } {
	const map = new Map<string, string>();
	const lengths = new Set<number>();
	const utf16 = (hex: string) => {
		const b = Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, "hex");
		let s = "";
		for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
		return s;
	};
	for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>/g)) lengths.add(Math.ceil((m[1] as string).length / 2));
	for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
		for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
			map.set((m[1] as string).toLowerCase(), utf16(m[2] as string));
			lengths.add(Math.ceil((m[1] as string).length / 2));
		}
	}
	for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
		for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
			const lo = Number.parseInt(m[1] as string, 16);
			const hi = Number.parseInt(m[2] as string, 16);
			const size = (m[1] as string).length;
			lengths.add(Math.ceil(size / 2));
			if (!(hi >= lo) || hi - lo > 65_535 || map.size + (hi - lo) > CMAP_MAX_ENTRIES) continue;
			const list = m[5] === undefined ? undefined : [...(m[5] as string).matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1] as string);
			for (let code = lo; code <= hi; code++) {
				const key = code.toString(16).padStart(size, "0");
				if (list !== undefined) {
					const dst = list[code - lo];
					if (dst !== undefined) map.set(key, utf16(dst));
				} else {
					const start = Buffer.from((m[4] as string).length % 2 ? `${m[4]}0` : (m[4] as string), "hex");
					if (start.length < 2) continue;
					const last = start.readUInt16BE(start.length - 2) + (code - lo);
					const prefix = utf16(start.subarray(0, start.length - 2).toString("hex"));
					map.set(key, prefix + String.fromCharCode(last & 0xffff));
				}
			}
		}
	}
	return { map, lengths: [...lengths].filter((n) => n >= 1 && n <= 4).sort((a, b) => b - a) };
}

function loadFont(doc: Document, value: Value | undefined): Font {
	const font = doc.dict(value) ?? new Map();
	const subtype = nameOf(doc.get(font.get("Subtype")));
	const twoByte = subtype === "Type0";
	let toUnicode: Map<string, string> | undefined;
	let lengths: number[] = twoByte ? [2] : [1];
	const tu = doc.get(font.get("ToUnicode"));
	if (isStream(tu)) {
		try {
			const parsed = cmap(doc.stream(tu).toString("latin1"));
			if (parsed.map.size > 0) {
				toUnicode = parsed.map;
				if (parsed.lengths.length > 0) lengths = parsed.lengths;
			}
		} catch (error) {
			// A broken map falls back on the encoding; a limit reached stops the reading.
			if (error instanceof PdfError) throw error;
		}
	}
	let simple: Map<number, string> | undefined;
	if (!twoByte) {
		simple = new Map();
		const enc = doc.get(font.get("Encoding"));
		const differences = isDict(enc) ? doc.get(enc.get("Differences")) : undefined;
		if (Array.isArray(differences)) {
			let code = 0;
			for (const item of differences) {
				const v = doc.get(item);
				if (typeof v === "number") code = v;
				else if (v instanceof Name) {
					const ch = glyphChar(v.name);
					if (ch !== undefined) simple.set(code, ch);
					code++;
				}
			}
		}
	}
	// Advances in thousandths of the font size.
	let advance: (code: number) => number = () => 500;
	if (twoByte) {
		const descendant = doc.dict((doc.get(font.get("DescendantFonts")) as Value[] | undefined)?.[0]);
		const dw = Number(doc.get(descendant?.get("DW")) ?? 1000);
		const widths = new Map<number, number>();
		const w = doc.get(descendant?.get("W"));
		if (Array.isArray(w)) {
			for (let i = 0; i < w.length && widths.size < 70_000; ) {
				const first = doc.get(w[i]);
				const second = doc.get(w[i + 1]);
				if (typeof first !== "number") break;
				if (Array.isArray(second)) {
					second.forEach((x, k) => widths.set(first + k, Number(doc.get(x)) || dw));
					i += 2;
				} else {
					const width = Number(doc.get(w[i + 2]));
					if (typeof second === "number" && second >= first && second - first < 70_000) for (let c = first; c <= second; c++) widths.set(c, width);
					i += 3;
				}
			}
		}
		advance = (code) => widths.get(code) ?? dw;
	} else {
		const first = Number(doc.get(font.get("FirstChar")) ?? 0);
		const w = doc.get(font.get("Widths"));
		if (Array.isArray(w)) advance = (code) => Number(doc.get(w[code - first])) || 500;
	}
	return { widths: lengths, ...(toUnicode === undefined ? {} : { toUnicode }), ...(simple === undefined ? {} : { simple }), advance, twoByte };
}

/** Bytes of a shown string → characters, with each glyph's advance. */
function decode(font: Font, bytes: Buffer): { text: string; advance: number; spaces: number } {
	let text = "";
	let advance = 0;
	let spaces = 0;
	for (let i = 0; i < bytes.length; ) {
		let used = 0;
		let char: string | undefined;
		let code = 0;
		if (font.toUnicode !== undefined) {
			for (const n of font.widths) {
				if (i + n > bytes.length) continue;
				const key = bytes.subarray(i, i + n).toString("hex");
				const hit = font.toUnicode.get(key);
				if (hit !== undefined) {
					char = hit;
					used = n;
					code = Number.parseInt(key, 16);
					break;
				}
			}
		}
		if (used === 0) {
			used = font.twoByte ? Math.min(2, bytes.length - i) : 1;
			code = used === 2 ? bytes.readUInt16BE(i) : (bytes[i] as number);
			// Without a map a two-byte font's codes are glyph numbers: nothing to read.
			char = font.twoByte ? "" : (font.simple?.get(code) ?? winAnsi(code));
		}
		i += used;
		if (char === " ") spaces++;
		text += char ?? "";
		advance += font.advance(code);
	}
	return { text, advance, spaces };
}

// ---------- pages ----------

type Matrix = [number, number, number, number, number, number];

class PageText {
	private out = "";
	private lastY: number | undefined;
	private lastX = 0;
	private lastSize = 10;

	/** A run of text at (x, y) in text space, `size` tall, ending at x + width. */
	add(text: string, x: number, y: number, size: number, width: number): void {
		if (text === "") return;
		const s = Math.max(Math.abs(size), 0.1);
		if (this.lastY !== undefined) {
			const dy = Math.abs(y - this.lastY);
			if (dy > 0.5 * Math.min(s, this.lastSize)) this.out += dy > 1.9 * Math.max(s, this.lastSize) ? "\n\n" : "\n";
			else if (x - this.lastX > 0.15 * s && !endsInSpace(this.out) && !/^\s/.test(text)) this.out += " ";
			else if (x < this.lastX - 2 * s && !endsInSpace(this.out)) this.out += " ";
		}
		this.out += text;
		this.lastY = y;
		this.lastX = x + width;
		this.lastSize = s;
	}

	space(): void {
		if (this.out !== "" && !endsInSpace(this.out)) this.out += " ";
	}

	get length(): number {
		return this.out.length;
	}

	text(): string {
		return this.out;
	}
}

function multiply(a: Matrix, b: Matrix): Matrix {
	return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}

function runContent(doc: Document, content: Buffer, resources: Dict | undefined, page: PageText, depth: number, fonts: Map<unknown, Font>): void {
	const lexer = new Lexer(content);
	const stack: Value[] = [];
	let ctm: Matrix = [1, 0, 0, 1, 0, 0];
	const saved: Matrix[] = [];
	let tm: Matrix = [1, 0, 0, 1, 0, 0];
	let tlm: Matrix = [1, 0, 0, 1, 0, 0];
	let font: Font | undefined;
	let size = 0;
	let leading = 0;
	let hscale = 1;
	let charSpacing = 0;
	let wordSpacing = 0;
	const fontDict = doc.dict(resources?.get("Font"));
	const xobjects = doc.dict(resources?.get("XObject"));
	const show = (bytes: Buffer) => {
		if (font === undefined) return;
		const run = decode(font, bytes);
		const m = multiply(tm, ctm);
		const scale = Math.hypot(m[2], m[3]) || 1;
		const width = ((run.advance / 1000) * size + charSpacing * bytes.length + wordSpacing * run.spaces) * hscale;
		page.add(run.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ""), m[4], m[5], size * scale, width * (Math.hypot(m[0], m[1]) || 1));
		tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + width * tm[0], tm[5] + width * tm[1]];
	};
	const moveLine = (tx: number, ty: number) => {
		tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]];
		tm = tlm;
	};
	for (;;) {
		const token = lexer.next();
		if (token === undefined) break;
		if (!(token instanceof Op)) {
			if (stack.length < 64) stack.push(token);
			continue;
		}
		const num = (i: number) => Number(stack[stack.length - i]) || 0;
		switch (token.op) {
			case "BT":
				tm = [1, 0, 0, 1, 0, 0];
				tlm = tm;
				break;
			case "q":
				if (saved.length < 64) saved.push(ctm);
				break;
			case "Q":
				ctm = saved.pop() ?? ctm;
				break;
			case "cm":
				ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
				break;
			case "Tf": {
				const ref = fontDict?.get(nameOf(stack[stack.length - 2]) ?? "");
				size = num(1);
				if (ref === undefined) font = undefined;
				else {
					// By object number: a thousand names pointing at one font load it once.
					const key = ref instanceof Ref ? `${ref.num} ${ref.gen}` : ref;
					let cached = fonts.get(key);
					if (cached === undefined) {
						cached = loadFont(doc, ref);
						fonts.set(key, cached);
					}
					font = cached;
				}
				break;
			}
			case "Tz":
				hscale = num(1) / 100;
				break;
			case "Tc":
				charSpacing = num(1);
				break;
			case "Tw":
				wordSpacing = num(1);
				break;
			case "TL":
				leading = num(1);
				break;
			case "Td":
				moveLine(num(2), num(1));
				break;
			case "TD":
				leading = -num(1);
				moveLine(num(2), num(1));
				break;
			case "Tm":
				tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
				tm = tlm;
				break;
			case "T*":
				moveLine(0, -leading);
				break;
			case "Tj": {
				const s = stack.at(-1);
				if (Buffer.isBuffer(s)) show(s);
				break;
			}
			case "'":
			case '"': {
				moveLine(0, -leading);
				const s = stack.at(-1);
				if (Buffer.isBuffer(s)) show(s);
				break;
			}
			case "TJ": {
				const arr = stack.at(-1);
				if (Array.isArray(arr)) {
					for (const item of arr) {
						if (Buffer.isBuffer(item)) show(item);
						else if (typeof item === "number") {
							const shift = (-item / 1000) * size * hscale;
							tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + shift * tm[0], tm[5] + shift * tm[1]];
							if (item < -180) page.space();
						}
					}
				}
				break;
			}
			case "Do": {
				const xo = doc.get(xobjects?.get(nameOf(stack.at(-1)) ?? ""));
				if (depth < 6 && isStream(xo) && nameOf(xo.dict.get("Subtype")) === "Form") {
					try {
						runContent(doc, doc.stream(xo), doc.dict(xo.dict.get("Resources")) ?? resources, page, depth + 1, fonts);
					} catch (error) {
						if (error instanceof PdfError) throw error;
					}
				}
				break;
			}
			case "ID": {
				// Inline image data: binary until EI.
				const at = content.indexOf("EI", lexer.pos);
				lexer.pos = at < 0 ? content.length : at + 2;
				break;
			}
		}
		stack.length = 0;
		if (page.length > PDF_LIMITS.maxTextChars) break;
	}
}

function pageList(doc: Document): Dict[] {
	const pages: Dict[] = [];
	const seen = new Set<Dict>();
	// What a page inherits from the tree above it.
	const INHERITED = ["Resources", "MediaBox", "Rotate"] as const;
	const walk = (node: Dict | undefined, inherited: Dict, depth: number) => {
		if (node === undefined || seen.has(node) || depth > 64 || pages.length >= PDF_LIMITS.maxPages) return;
		seen.add(node);
		const here: Dict = new Map(inherited);
		for (const key of INHERITED) if (node.has(key)) here.set(key, node.get(key) as Value);
		const kids = doc.get(node.get("Kids"));
		if (Array.isArray(kids)) for (const kid of kids) walk(doc.dict(kid), here, depth + 1);
		else if (nameOf(node.get("Type")) === "Page" || node.has("Contents")) pages.push(INHERITED.every((key) => node.has(key) || !here.has(key)) ? node : new Map([...here, ...node]));
	};
	const root = doc.dict(doc.trailer.get("Root")) ?? [...doc.objects.values()].map((o) => (isDict(o) ? o : undefined)).find((d) => nameOf(d?.get("Type")) === "Catalog");
	walk(doc.dict(root?.get("Pages")), new Map(), 0);
	if (pages.length === 0) {
		for (const o of doc.objects.values()) if (isDict(o) && nameOf(o.get("Type")) === "Page" && pages.length < PDF_LIMITS.maxPages) pages.push(o);
	}
	return pages;
}

/** The Encrypt dictionary of the standard handler; undefined for other handlers or one that is broken. */
function encryptionOf(doc: Document, e: Dict): PdfEncryption | undefined {
	if (nameOf(doc.get(e.get("Filter"))) !== "Standard") return undefined;
	const num = (key: string) => {
		const v = doc.get(e.get(key));
		return typeof v === "number" ? v : undefined;
	};
	const bytes = (key: string) => {
		const v = doc.get(e.get(key));
		return Buffer.isBuffer(v) ? v : undefined;
	};
	const v = num("V") ?? 0;
	const r = num("R") ?? 0;
	const o = bytes("O");
	const u = bytes("U");
	if (o === undefined || u === undefined) return undefined;
	const ids = doc.get(doc.trailer.get("ID"));
	const first = Array.isArray(ids) ? doc.get(ids[0]) : undefined;
	let method: PdfEncryption["method"] | undefined;
	if (v === 1 || v === 2) method = "rc4";
	else if (v === 4 || v === 5) {
		const filter = nameOf(doc.get(e.get("StmF"))) ?? "Identity";
		const cf = doc.dict(e.get("CF"));
		const cfm = filter === "Identity" ? "None" : nameOf(doc.get(doc.dict(cf?.get(filter))?.get("CFM")));
		method = cfm === "None" ? "none" : cfm === "V2" ? "rc4" : cfm === "AESV2" ? "aes128" : cfm === "AESV3" ? "aes256" : undefined;
	}
	if (method === undefined) return undefined;
	const ue = bytes("UE");
	return {
		v,
		r,
		length: num("Length") ?? (v === 1 ? 40 : 128),
		o,
		u,
		...(ue === undefined ? {} : { ue }),
		p: num("P") ?? 0,
		id: Buffer.isBuffer(first) ? first : Buffer.alloc(0),
		encryptMetadata: doc.get(e.get("EncryptMetadata")) !== false,
		method,
	};
}

/** The PDF's objects, decrypted when it opens without a password, and its pages. */
function openPdf(data: Buffer): { doc: Document; pages: Dict[] } {
	if (!data.subarray(0, 1024).toString("latin1").includes("%PDF-")) throw new PdfError("non è un PDF");
	const doc = new Document(data);
	const encrypt = doc.dict(doc.trailer.get("Encrypt"));
	if (encrypt !== undefined) {
		const encryption = encryptionOf(doc, encrypt);
		doc.cipher = encryption === undefined ? undefined : pdfCipher(encryption);
		if (doc.cipher === undefined) throw new PdfError("il PDF è protetto da una password. Chiedi alla persona di mandarlo senza password, o di copiarne il testo");
		doc.encryptMetadata = encryption?.encryptMetadata ?? true;
	}
	doc.unpackObjectStreams();
	const pages = pageList(doc);
	if (pages.length === 0) throw new PdfError("non trovo pagine in questo PDF: forse è rovinato");
	return { doc, pages };
}

export function pdfText(data: Buffer): PdfText {
	const { doc, pages } = openPdf(data);
	const fonts = new Map<unknown, Font>();
	const out: string[] = [];
	let total = 0;
	let empty = 0;
	let read = 0;
	const blank: number[] = [];
	for (const [index, page] of pages.entries()) {
		const text = new PageText();
		const contents = doc.get(page.get("Contents"));
		const parts = Array.isArray(contents) ? contents.map((c) => doc.get(c)) : [contents];
		const body = Buffer.concat(parts.filter(isStream).map((s) => Buffer.concat([doc.stream(s), Buffer.from("\n")])));
		runContent(doc, body, doc.dict(page.get("Resources")), text, 0, fonts);
		const pageText = trimLines(text.text()).trim();
		read++;
		if (pageText === "") {
			empty++;
			blank.push(index + 1);
		}
		out.push(`--- Pagina ${index + 1} ---\n${pageText}`);
		total += pageText.length;
		if (total > PDF_LIMITS.maxTextChars) break;
	}
	const notes: string[] = [];
	if (empty === read)
		notes.push(
			"Il PDF non contiene testo: è probabilmente una scansione. Guarda le pagine con image_view (il percorso del PDF e page) e leggi tu cosa dicono.",
		);
	else if (blank.length > 0) {
		const listed = blank.length > 20 ? `${blank.slice(0, 20).join(", ")} e altre ${blank.length - 20}` : blank.join(", ");
		notes.push(
			blank.length === 1
				? `La pagina ${listed} non ha testo (forse una scansione o un'immagine): guardala con image_view (page ${listed}).`
				: `Le pagine ${listed} non hanno testo (forse scansioni o immagini): guardale con image_view (page e il numero).`,
		);
	}
	if (pages.length >= PDF_LIMITS.maxPages) notes.push(`Il PDF ha almeno ${PDF_LIMITS.maxPages} pagine: oltre queste non leggo.`);
	if (read < pages.length) notes.push(`Il testo è molto lungo: lette le prime ${read} pagine su ${pages.length}.`);
	const note = notes.length === 0 ? undefined : notes.join(" ");
	if (empty === read) return { text: "", pages: pages.length, ...(note === undefined ? {} : { note }) };
	return { text: out.join("\n\n"), pages: pages.length, ...(note === undefined ? {} : { note }) };
}

/** The largest picture a scanned page shows, at most: what the model can be given to look at. */
export const PDF_IMAGE_LIMITS = { maxPixels: 25_000_000, maxSide: 8_000, maxSamples: 64 * 1024 * 1024, perPage: 4, maxBytes: 20 * 1024 * 1024 } as const;

export type PdfImage = { readonly mime: "image/jpeg" | "image/png"; readonly data: Buffer; readonly width: number; readonly height: number };

export type PdfPageImage = {
	/** The page's pictures from top to bottom (a scan in strips comes in several). */
	readonly images: readonly PdfImage[];
	readonly pages: number;
	/** Pictures on the page left out: too small to matter, or past the limit. */
	readonly leftOut: number;
	/** Clockwise degrees to turn the picture to see it as the page shows it. */
	readonly turn: 0 | 90 | 180 | 270;
	/** A JPEG stored upside down and mirrored back by the page: seen as stored. */
	readonly mirrored: boolean;
	/** The pictures cover little of the page: a logo or a photo beside the text. */
	readonly small: boolean;
};

/**
 * The pictures on a page of a PDF (ADR 0028), for a scan: what the page draws, largest first in
 * weight, given from top to bottom; a JPEG as it is in the file, the rest (fax-coded, raw) as a
 * PNG. PdfError says why not.
 */
export function pdfPageImage(data: Buffer, pageNumber: number): PdfPageImage {
	const { doc, pages } = openPdf(data);
	const page = pages[pageNumber - 1];
	if (page === undefined) throw new PdfError(`il PDF ha ${pages.length} ${pages.length === 1 ? "pagina" : "pagine"}: la pagina ${pageNumber} non c'è`);
	const placed = pageImages(doc, page);
	if (placed.length === 0) throw new PdfError(`la pagina ${pageNumber} non contiene immagini`);
	const area = (m: Matrix) => Math.abs(m[0] * m[3] - m[1] * m[2]);
	const largest = Math.max(...placed.map((p) => area(p.at)));
	// Decorations (a stamp, a line drawn as an image) next to a scan are left out.
	const kept = placed.filter((p) => area(p.at) >= largest * 0.02).sort((a, b) => area(b.at) - area(a.at)).slice(0, PDF_IMAGE_LIMITS.perPage);
	const top = (m: Matrix) => m[5] + Math.max(0, m[1]) + Math.max(0, m[3]);
	kept.sort((a, b) => top(b.at) - top(a.at) || a.at[4] - b.at[4]);
	const main = kept.reduce((best, p) => (area(p.at) > area(best.at) ? p : best));
	const box = doc.get(page.get("MediaBox"));
	const pageArea = Array.isArray(box) && box.length === 4 ? Math.abs((Number(doc.get(box[2])) - Number(doc.get(box[0]))) * (Number(doc.get(box[3])) - Number(doc.get(box[1])))) : 0;
	const covered = kept.reduce((sum, p) => sum + area(p.at), 0);
	const { turn, flipped } = orientation(main.at, Number(doc.get(page.get("Rotate"))) || 0);
	const images: PdfImage[] = [];
	let bytes = 0;
	try {
		for (const p of kept) {
			const image = imageOf(doc, p.stream, p.resources, flipped);
			bytes += image.data.length;
			if (bytes > PDF_IMAGE_LIMITS.maxBytes && images.length > 0) break;
			images.push(image);
		}
	} catch (error) {
		if (error instanceof PdfImageError) throw new PdfError(error.message);
		throw error;
	}
	return { images, pages: pages.length, leftOut: placed.length - images.length, turn, mirrored: flipped && images.some((i) => i.mime === "image/jpeg"), small: pageArea > 0 && covered < pageArea * 0.15 };
}

/**
 * How the picture is drawn: its "up" in page space, after the page's own rotation, against the
 * screen's up. A picture drawn upside down and mirrored (bottom-up rows) is flipped back first.
 */
function orientation(m: Matrix, rotate: number): { turn: 0 | 90 | 180 | 270; flipped: boolean } {
	const flipped = m[0] * m[3] - m[1] * m[2] < 0;
	const up = flipped ? [-m[2], -m[3]] : [m[2], m[3]];
	const shown = (Math.atan2(up[1] as number, up[0] as number) * 180) / Math.PI - rotate;
	const turn = (((Math.round((90 - shown) / 90) * 90) % 360) + 360) % 360;
	return { turn: turn as 0 | 90 | 180 | 270, flipped };
}

type Placed = { readonly stream: Stream; readonly at: Matrix; readonly resources: Dict | undefined };

/** Inline image keys and names, in full. */
const INLINE_KEYS: Record<string, string> = { W: "Width", H: "Height", BPC: "BitsPerComponent", CS: "ColorSpace", F: "Filter", DP: "DecodeParms", IM: "ImageMask", D: "Decode", I: "Interpolate", L: "Length" };

/** The images a page draws (XObjects, inside forms too, and inline ones) with where they are drawn; each once. */
function pageImages(doc: Document, page: Dict): Placed[] {
	const found: Placed[] = [];
	const seen = new Set<Stream>();
	const walk = (content: Buffer, resources: Dict | undefined, start: Matrix, depth: number) => {
		const xobjects = doc.dict(resources?.get("XObject"));
		const lexer = new Lexer(content);
		const stack: Value[] = [];
		const saved: Matrix[] = [];
		let ctm = start;
		for (let steps = 0; steps < 2_000_000 && found.length < 200; steps++) {
			const token = lexer.next();
			if (token === undefined) break;
			if (!(token instanceof Op)) {
				if (stack.length < 64) stack.push(token);
				continue;
			}
			const num = (i: number) => Number(stack[stack.length - i]) || 0;
			if (token.op === "q" && saved.length < 64) saved.push(ctm);
			else if (token.op === "Q") ctm = saved.pop() ?? ctm;
			else if (token.op === "cm") ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
			else if (token.op === "Do") {
				const xo = doc.get(xobjects?.get(nameOf(stack.at(-1)) ?? ""));
				if (isStream(xo) && !seen.has(xo)) {
					seen.add(xo);
					const subtype = nameOf(xo.dict.get("Subtype"));
					if (subtype === "Image") found.push({ stream: xo, at: ctm, resources });
					else if (subtype === "Form" && depth < 6) {
						const matrix = doc.get(xo.dict.get("Matrix"));
						const m: Matrix = Array.isArray(matrix) && matrix.length === 6 ? (matrix.map((v) => Number(doc.get(v)) || 0) as unknown as Matrix) : [1, 0, 0, 1, 0, 0];
						walk(doc.stream(xo), doc.dict(xo.dict.get("Resources")) ?? resources, multiply(m, ctm), depth + 1);
					}
				}
			} else if (token.op === "BI") {
				// An inline image: key value pairs up to ID, the bytes up to EI.
				const dict: Dict = new Map();
				let key: string | undefined;
				for (let pairs = 0; pairs < 64; pairs++) {
					const item = lexer.next();
					if (item === undefined || item instanceof Op) break;
					if (key === undefined && item instanceof Name) key = INLINE_KEYS[item.name] ?? item.name;
					else if (key !== undefined) {
						dict.set(key, item);
						key = undefined;
					}
				}
				const begin = lexer.pos + 1;
				const end = inlineEnd(content, begin);
				lexer.pos = end + 2;
				found.push({ stream: { dict, raw: content.subarray(begin, end) }, at: ctm, resources });
			}
			stack.length = 0;
		}
	};
	const contents = doc.get(page.get("Contents"));
	const parts = Array.isArray(contents) ? contents.map((c) => doc.get(c)) : [contents];
	walk(Buffer.concat(parts.filter(isStream).map((s) => Buffer.concat([doc.stream(s), Buffer.from("\n")]))), doc.dict(page.get("Resources")), [1, 0, 0, 1, 0, 0], 0);
	return found;
}

/** Where an inline image's bytes end: an EI between white space (binary data may hold the letters). */
function inlineEnd(content: Buffer, from: number): number {
	for (let at = content.indexOf("EI", from); at >= 0; at = content.indexOf("EI", at + 1)) {
		const after = content[at + 2];
		if (WS.has(content[at - 1] ?? 0x20) && (after === undefined || WS.has(after) || DELIM.has(after))) return at - 1;
	}
	return content.length;
}

/** A colour space as what a PNG can say: grey (maybe inverted, as ink), RGB, CMYK (made RGB) or a palette. */
type Colors = { kind: "gray"; ink?: boolean } | { kind: "rgb" } | { kind: "cmyk" } | { kind: "indexed"; palette: Buffer; entries: number };

function colorsOf(doc: Document, value: Value | Obj | undefined, resources: Dict | undefined, depth = 0): Colors | undefined {
	const v = doc.get(value as Value);
	const name = nameOf(v);
	if (name === "DeviceGray" || name === "G" || name === "CalGray") return { kind: "gray" };
	if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return { kind: "rgb" };
	if (name === "DeviceCMYK" || name === "CMYK") return { kind: "cmyk" };
	// A name of the page's resources (inline images use these).
	if (name !== undefined && depth < 2) {
		const named = doc.dict(resources?.get("ColorSpace"))?.get(name);
		return named === undefined ? undefined : colorsOf(doc, named, resources, depth + 1);
	}
	if (!Array.isArray(v) || depth > 2) return undefined;
	const family = nameOf(doc.get(v[0]));
	if (family === "CalGray") return { kind: "gray" };
	if (family === "CalRGB") return { kind: "rgb" };
	if (family === "ICCBased") {
		const n = Number(doc.dict(v[1])?.get("N"));
		return n === 1 ? { kind: "gray" } : n === 3 ? { kind: "rgb" } : n === 4 ? { kind: "cmyk" } : undefined;
	}
	// One ink (a black-only scan as a separation): more ink is darker.
	if (family === "Separation" || (family === "DeviceN" && Array.isArray(doc.get(v[1])) && (doc.get(v[1]) as Value[]).length === 1)) return { kind: "gray", ink: true };
	if (family === "Indexed" || family === "I") {
		const base = colorsOf(doc, v[1], resources, depth + 1);
		const hival = Math.min(255, Math.max(0, Math.floor(Number(doc.get(v[2])) || 0)));
		const lookupValue = doc.get(v[3]);
		const lookup = Buffer.isBuffer(lookupValue) ? lookupValue : isStream(lookupValue) ? doc.stream(lookupValue) : undefined;
		if (base === undefined || base.kind === "indexed" || lookup === undefined) return undefined;
		const entries = hival + 1;
		const palette = Buffer.alloc(entries * 3);
		const size = base.kind === "gray" ? 1 : base.kind === "rgb" ? 3 : 4;
		for (let i = 0; i < entries; i++) {
			const at = i * size;
			const c = [0, 1, 2, 3].map((k) => lookup[at + k] ?? 0) as [number, number, number, number];
			const g = base.kind === "gray" && base.ink === true ? 255 - c[0] : c[0];
			const rgb = base.kind === "gray" ? [g, g, g] : base.kind === "rgb" ? [c[0], c[1], c[2]] : cmyk(c[0], c[1], c[2], c[3]);
			palette.set(rgb, i * 3);
		}
		return { kind: "indexed", palette, entries };
	}
	return undefined;
}

function cmyk(c: number, m: number, y: number, k: number): [number, number, number] {
	return [255 - Math.min(255, c + k), 255 - Math.min(255, m + k), 255 - Math.min(255, y + k)];
}

const CANNOT = "la scansione è in un formato che non so aprire";

function imageOf(doc: Document, stream: Stream, resources: Dict | undefined, flipped: boolean): PdfImage {
	const d = stream.dict;
	const width = Math.floor(Number(doc.get(d.get("Width"))) || 0);
	const height = Math.floor(Number(doc.get(d.get("Height"))) || 0);
	if (width <= 0 || height <= 0) throw new PdfError("l'immagine della pagina è rovinata");
	if (width > PDF_IMAGE_LIMITS.maxSide || height > PDF_IMAGE_LIMITS.maxSide || width * height > PDF_IMAGE_LIMITS.maxPixels) throw new PdfError("l'immagine della pagina è troppo grande da aprire");
	const { data, filter, parm } = doc.imageData(stream);
	if (filter === "DCTDecode") {
		// The size the JPEG itself says, not the one the PDF claims.
		const size = jpegSize(data);
		if (size === undefined) throw new PdfError("l'immagine della pagina è rovinata");
		if (size.width > PDF_IMAGE_LIMITS.maxSide || size.height > PDF_IMAGE_LIMITS.maxSide) throw new PdfError("l'immagine della pagina è troppo grande da aprire");
		return { mime: "image/jpeg", data, ...size };
	}
	if (filter === "JBIG2Decode") throw new PdfError(`${CANNOT} (JBIG2)`);
	if (filter === "JPXDecode") throw new PdfError(`${CANNOT} (JPEG 2000)`);
	if (filter !== undefined && filter !== "CCITTFaxDecode") throw new PdfError(CANNOT);
	const mask = doc.get(d.get("ImageMask")) === true;
	const fax = filter === "CCITTFaxDecode";
	const bits = mask || fax ? 1 : Math.floor(Number(doc.get(d.get("BitsPerComponent"))) || 8);
	const colors: Colors | undefined = mask || fax ? { kind: "gray" } : colorsOf(doc, d.get("ColorSpace"), resources);
	if (colors === undefined) throw new PdfError("i colori della scansione sono in un formato che non so aprire");
	// What a PNG can hold: grey at any depth, a palette up to 8 bits, RGB at 8 or 16, CMYK at 8 (made RGB).
	const fits = colors.kind === "gray" ? [1, 2, 4, 8, 16].includes(bits) : colors.kind === "indexed" ? [1, 2, 4, 8].includes(bits) : colors.kind === "rgb" ? bits === 8 || bits === 16 : bits === 8;
	if (!fits) throw new PdfError(CANNOT);
	const channels = colors.kind === "rgb" ? 3 : colors.kind === "cmyk" ? 4 : 1;
	const rowBytes = Math.ceil((width * channels * bits) / 8);
	// Every buffer below is sized from these numbers: checked before any is made.
	if (rowBytes * height > PDF_IMAGE_LIMITS.maxSamples || (colors.kind === "cmyk" && width * height * 3 > PDF_IMAGE_LIMITS.maxSamples)) throw new PdfError("l'immagine della pagina è troppo grande da aprire");
	const decodeArray = doc.get(d.get("Decode"));
	const inverted = Array.isArray(decodeArray) && Number(doc.get(decodeArray[0])) === 1 && Number(doc.get(decodeArray[1])) === 0;
	let samples = data;
	if (fax) {
		const k = doc.get(parm?.get("K"));
		samples = ccittDecode(data, { k: typeof k === "number" ? k : 0, columns: width, rows: height, blackIs1: doc.get(parm?.get("BlackIs1")) === true, byteAlign: doc.get(parm?.get("EncodedByteAlign")) === true });
	}
	// A short tail is padded white; an image with most of its bytes missing is not a scan.
	if (samples.length < (rowBytes * height) / 2) throw new PdfError("l'immagine della pagina è rovinata");
	if (samples.length < rowBytes * height) samples = Buffer.concat([samples, Buffer.alloc(rowBytes * height - samples.length, 0xff)]);
	samples = Buffer.from(samples.subarray(0, rowBytes * height));
	// Rows stored bottom up come out the right way round.
	if (flipped) {
		const rows = Buffer.alloc(samples.length);
		for (let y = 0; y < height; y++) samples.copy(rows, (height - 1 - y) * rowBytes, y * rowBytes, (y + 1) * rowBytes);
		samples = rows;
	}
	if (colors.kind === "gray") {
		// 0 is black in a grey image and in a mask; Decode [1 0], and an ink, turn it round.
		if (inverted !== (colors.ink === true)) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] as number) ^ 0xff;
		return { mime: "image/png", data: pngOf({ width, height, colorType: 0, bitDepth: bits, samples }), width, height };
	}
	if (colors.kind === "indexed") return { mime: "image/png", data: pngOf({ width, height, colorType: 3, bitDepth: bits, samples, palette: colors.palette }), width, height };
	if (colors.kind === "rgb") return { mime: "image/png", data: pngOf({ width, height, colorType: 2, bitDepth: bits, samples }), width, height };
	const rgb = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++) rgb.set(cmyk(samples[i * 4] ?? 0, samples[i * 4 + 1] ?? 0, samples[i * 4 + 2] ?? 0, samples[i * 4 + 3] ?? 0), i * 3);
	return { mime: "image/png", data: pngOf({ width, height, colorType: 2, bitDepth: 8, samples: rgb }), width, height };
}

/** A JPEG's size from its frame header, or undefined when there is none. */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
	if (data[0] !== 0xff || data[1] !== 0xd8) return undefined;
	for (let at = 2; at + 9 < data.length; ) {
		if (data[at] !== 0xff) return undefined;
		const marker = data[at + 1] as number;
		if (marker === 0xff) {
			at++;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			at += 2;
			continue;
		}
		// Start of frame: any of C0 to CF except C4 (tables), C8 (reserved) and CC (arithmetic tables).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
		at += 2 + data.readUInt16BE(at + 2);
	}
	return undefined;
}
