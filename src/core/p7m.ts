/**
 * The document inside a signed file (.p7m, CAdES): a CMS SignedData envelope (RFC 5652) in DER,
 * or in BER as some signing programs write it (indefinite lengths, the content split into
 * chunks), sometimes as base64 text with or without PEM lines. Only opened, never verified: the
 * signature, the certificates and the signer are not looked at. Every read is bounded (nesting
 * depth, lengths inside the input, the content's size) and anything unexpected is a P7mError in
 * Italian, never a crash or a loop. The document worker loads this file from source: erasable
 * TypeScript only.
 */

export class P7mError extends Error {
	override readonly name = "P7mError";
}

/** The deepest nesting read; a SignedData needs about 6 levels, chunked content a few more. */
const MAX_DEPTH = 32;

/**
 * Chunks of content, and elements read in one envelope (each chunk is one): real files have a few
 * thousand chunks and a few dozen other elements, and MAX_P7M_BYTES in chunks of 160 bytes still read.
 */
const MAX_CHUNKS = 200_000;
const MAX_ELEMENTS = MAX_CHUNKS + 1000;

/** How much of a binary envelope is looked at to tell what it holds: the content starts in the first few hundred bytes. */
const SNIFF_BYTES = 256 * 1024;

/** The largest envelope and content read, in bytes, as for a file inside an archive (ADR 0026). */
export const MAX_P7M_BYTES = 30 * 1024 * 1024;

/** Envelopes inside envelopes (a file signed twice, one signature over the other): at most this many. */
const MAX_LAYERS = 3;

/** 1.2.840.113549.1.7.2, id-signedData, as written in DER after its tag and length. */
const SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];

const BROKEN = "la busta della firma digitale (.p7m) è rovinata o incompleta";

/**
 * One element's header: class, number, where its content starts and, for a definite length,
 * where it ends. An indefinite one (`end` undefined) runs to an end-of-contents marker (00 00)
 * before `limit`, found only by walking it, once.
 */
type Header = { readonly cls: number; readonly constructed: boolean; readonly tag: number; readonly start: number; readonly end: number | undefined; readonly limit: number };

/**
 * A reader over the envelope's bytes. `partial`: the bytes are only the beginning of the file, so
 * lengths past the end are cut to what there is. `elements` counts the headers read; `ranges` are
 * the pieces of content found so far, [start, end) in `data`.
 */
type Reader = { readonly data: Uint8Array; readonly partial: boolean; elements: number; readonly ranges: [number, number][] };

function reader(data: Uint8Array, partial: boolean): Reader {
	return { data, partial, elements: 0, ranges: [] };
}

/** Whether these bytes look like a signed envelope, binary or base64, from their first bytes only. */
export function isSignedEnvelope(data: Uint8Array): boolean {
	return isBinaryEnvelope(data) || base64Start(data) !== undefined;
}

/** A SEQUENCE whose first element is the signedData identifier: 30, a length of up to 5 bytes, 06 09 and the OID. */
function isBinaryEnvelope(data: Uint8Array): boolean {
	if (data[0] !== 0x30) return false;
	const first = data[1] ?? 0;
	const at = first <= 0x80 ? 2 : 2 + (first & 0x7f);
	if (first > 0x84 || data[at] !== 0x06 || data[at + 1] !== SIGNED_DATA.length) return false;
	return SIGNED_DATA.every((byte, i) => data[at + 2 + i] === byte);
}

/**
 * The content that was signed, unwrapped from as many envelopes as there are (up to MAX_LAYERS);
 * a P7mError when the envelope is broken, too deep, too large or holds no content.
 */
export function signedContent(data: Uint8Array): Uint8Array {
	let bytes = binary(data);
	for (let layer = 0; layer < MAX_LAYERS; layer++) {
		bytes = encapsulated(reader(bytes, false), MAX_P7M_BYTES, false);
		if (!isBinaryEnvelope(bytes)) return bytes;
	}
	throw new P7mError("il file è firmato troppe volte, una busta dentro l'altra");
}

/**
 * The first `bytes` bytes of the signed content (or fewer, if there are not that many), read
 * from the start of the file only (SNIFF_BYTES of a binary envelope, as much base64 text as that
 * takes): enough to tell what the document is without opening all of it. Undefined when that
 * start is not a readable envelope.
 */
export function signedContentStart(data: Uint8Array, bytes: number): Uint8Array | undefined {
	let read: Reader;
	if (isBinaryEnvelope(data)) read = reader(data.subarray(0, Math.max(SNIFF_BYTES, bytes + 4096)), true);
	else {
		// Four characters are three bytes: enough of the text for the envelope's start and `bytes` of content.
		const chars = Math.ceil((bytes + 4096) / 3) * 4;
		const text = base64Start(data, chars * 2);
		if (text === undefined) return undefined;
		const clean = text.replace(/[^A-Za-z0-9+/]+/g, "").slice(0, chars);
		read = reader(Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64"), true);
	}
	for (let layer = 0; layer < MAX_LAYERS; layer++) {
		let content: Uint8Array;
		try {
			content = encapsulated(read, bytes, true);
		} catch {
			// The start was cut, or is broken: what was found before the cut is still the content's start.
			content = joined(read);
		}
		if (content.length === 0) return undefined;
		if (!isBinaryEnvelope(content)) return content;
		read = reader(content, true);
	}
	return undefined;
}

const TOO_BIG = "il file firmato è troppo grande da leggere";

/**
 * The envelope as bytes: binary as it is, base64 decoded (checked whole, so no garbage is
 * decoded). Either way at most MAX_P7M_BYTES of envelope.
 */
function binary(data: Uint8Array): Uint8Array {
	if (isBinaryEnvelope(data)) {
		if (data.length > MAX_P7M_BYTES) throw new P7mError(TOO_BIG);
		return data;
	}
	if (base64Start(data) === undefined) throw new P7mError("non è un file firmato digitalmente (.p7m) che so aprire");
	// Base64 is a third longer than the bytes it holds, a little more with its line breaks.
	if (data.length > MAX_P7M_BYTES * 1.4) throw new P7mError(TOO_BIG);
	let text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1").replace(UTF8_BOM, "");
	const begin = /^\s*-----BEGIN [A-Z0-9 ]{1,40}-----/.exec(text);
	if (begin !== null) {
		const end = text.indexOf("-----END", begin[0].length);
		text = text.slice(begin[0].length, end < 0 ? text.length : end);
	}
	if (!/^[A-Za-z0-9+/=\s]*$/.test(text)) throw new P7mError(BROKEN);
	const bytes = Buffer.from(text, "base64");
	if (!isBinaryEnvelope(bytes)) throw new P7mError(BROKEN);
	if (bytes.length > MAX_P7M_BYTES) throw new P7mError(TOO_BIG);
	return bytes;
}

/** A UTF-8 byte order mark read as latin1: some programs put one before the base64 text. */
const UTF8_BOM = /^\xef\xbb\xbf/;

/**
 * The start of a base64 envelope as text, at most `max` characters, byte order mark and PEM line
 * out: «MI» is how a DER SEQUENCE with a long length begins in base64. Undefined when the bytes
 * do not start like one.
 */
function base64Start(data: Uint8Array, max = 128): string | undefined {
	const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, max + 128)).toString("latin1");
	let text = head.replace(UTF8_BOM, "").trimStart();
	if (text.startsWith("-----BEGIN ")) {
		const lineEnd = text.indexOf("\n");
		if (lineEnd < 0 || !/^-----BEGIN [A-Z0-9 ]{1,40}-----\s*$/.test(text.slice(0, lineEnd))) return undefined;
		text = text.slice(lineEnd + 1).trimStart();
	}
	return /^MI[A-Za-z0-9+/]{2}[A-Za-z0-9+/=\s]{0,96}$/.test(text.slice(0, 100)) ? text.slice(0, max) : undefined;
}

/**
 * ContentInfo { contentType signedData, [0] SignedData { version, digestAlgorithms,
 * encapContentInfo { eContentType, [0] eContent OCTET STRING } … } }: the eContent's bytes, at
 * most `max` of them: more is a P7mError, or with `start` only the first `max` are wanted. What
 * comes after the content (certificates, signers) is never read.
 */
function encapsulated(read: Reader, max: number, start: boolean): Uint8Array {
	const info = header(read, 0, read.data.length, 0);
	expect(info, 0, 16, true);
	const [type, wrapped] = children(read, info, 1, 2);
	if (type === undefined || wrapped === undefined) throw new P7mError(BROKEN);
	expect(type, 0, 6, false);
	expect(wrapped, 2, 0, true);
	const signed = children(read, wrapped, 2, 1)[0];
	if (signed === undefined) throw new P7mError(BROKEN);
	expect(signed, 0, 16, true);
	const [version, algorithms, encap] = children(read, signed, 3, 3);
	if (version === undefined || algorithms === undefined || encap === undefined) throw new P7mError(BROKEN);
	expect(version, 0, 2, false);
	expect(algorithms, 0, 17, true);
	expect(encap, 0, 16, true);
	const [, content] = children(read, encap, 4, 2);
	if (content === undefined) throw new P7mError("il file firmato non contiene il documento: la firma è separata dal file che firma");
	expect(content, 2, 0, true);
	const octets = children(read, content, 5, 1)[0];
	if (octets === undefined) throw new P7mError(BROKEN);
	const budget = { left: max, chunks: 0, over: false };
	collect(read, octets, 6, budget);
	if (budget.over && !start) throw new P7mError("il documento firmato è troppo grande da leggere");
	return joined(read);
}

/** The content's pieces as one buffer: their lengths summed first, then one copy (none for a single piece). */
function joined(read: Reader): Uint8Array {
	const { data, ranges } = read;
	if (ranges.length === 1) {
		const [from, to] = ranges[0] as [number, number];
		return data.subarray(from, to);
	}
	let total = 0;
	for (const [from, to] of ranges) total += to - from;
	const out = Buffer.allocUnsafe(total);
	let at = 0;
	for (const [from, to] of ranges) {
		out.set(data.subarray(from, to), at);
		at += to - from;
	}
	return out;
}

function expect(el: Header, cls: number, tag: number, constructed: boolean): void {
	if (el.cls !== cls || el.tag !== tag || el.constructed !== constructed) throw new P7mError(BROKEN);
}

/**
 * An OCTET STRING's bytes into the reader's ranges, read once from the start: a primitive one as
 * it is, a constructed one (BER) chunk by chunk, each again an OCTET STRING, up to its end or its
 * 00 00. Stops once `budget.left` bytes are taken. Returns where the element ends.
 */
function collect(read: Reader, el: Header, depth: number, budget: { left: number; chunks: number; over: boolean }): number {
	if (el.cls !== 0 || el.tag !== 4) throw new P7mError(BROKEN);
	if (!el.constructed) {
		const end = el.end as number;
		if (++budget.chunks > MAX_CHUNKS) throw new P7mError("il documento firmato è diviso in troppe parti per leggerlo");
		const take = Math.min(end - el.start, budget.left);
		if (take > 0) read.ranges.push([el.start, el.start + take]);
		budget.left -= take;
		if (take < end - el.start) budget.over = true;
		return end;
	}
	let at = el.start;
	for (;;) {
		if (atEnd(read, el, at)) return el.end ?? at + 2;
		if (budget.left <= 0) {
			budget.over = true;
			return at;
		}
		at = collect(read, header(read, at, el.end ?? el.limit, depth + 1), depth + 1, budget);
		if (budget.over) return at;
	}
}

/** Whether `at` is past the last child of `parent`: its end, or its 00 00. */
function atEnd(read: Reader, parent: Header, at: number): boolean {
	if (parent.end !== undefined) return at >= parent.end;
	if (at + 2 > parent.limit) throw new P7mError(BROKEN);
	return read.data[at] === 0 && read.data[at + 1] === 0;
}

/** Where an element ends: its length, or, for an indefinite one, past its children's 00 00, walked once. */
function next(read: Reader, el: Header, depth: number): number {
	if (el.end !== undefined) return el.end;
	let at = el.start;
	while (!atEnd(read, el, at)) at = next(read, header(read, at, el.limit, depth + 1), depth + 1);
	return at + 2;
}

/** The first `count` children of a constructed element (fewer if it has fewer); only those before the last are walked past. */
function children(read: Reader, parent: Header, depth: number, count: number): Header[] {
	const out: Header[] = [];
	let at = parent.start;
	while (out.length < count && !atEnd(read, parent, at)) {
		const child = header(read, at, parent.end ?? parent.limit, depth);
		out.push(child);
		if (out.length < count) at = next(read, child, depth);
	}
	return out;
}

/**
 * The header at `at`, inside [at, limit): tag, then a length of at most 4 bytes, or indefinite
 * (constructed only). A length past the limit is refused; a partial reader cuts it to the limit.
 */
function header(read: Reader, at: number, limit: number, depth: number): Header {
	if (depth > MAX_DEPTH) throw new P7mError("la busta della firma digitale (.p7m) è annidata troppo in profondità");
	if (++read.elements > MAX_ELEMENTS) throw new P7mError("la busta della firma digitale (.p7m) ha troppi elementi da leggere");
	const { data } = read;
	if (at + 2 > limit) throw new P7mError(BROKEN);
	const first = data[at] as number;
	const constructed = (first & 0x20) !== 0;
	const cls = first >> 6;
	let pos = at + 1;
	let tag = first & 0x1f;
	if (tag === 0x1f) {
		// A tag number in several bytes, 7 bits each: none of SignedData's needs more than 4.
		tag = 0;
		for (let i = 0; ; i++) {
			if (i === 4 || pos >= limit) throw new P7mError(BROKEN);
			const byte = data[pos++] as number;
			tag = tag * 128 + (byte & 0x7f);
			if ((byte & 0x80) === 0) break;
		}
	}
	if (pos >= limit) throw new P7mError(BROKEN);
	const lengthByte = data[pos++] as number;
	if (lengthByte === 0x80) {
		if (!constructed) throw new P7mError(BROKEN);
		return { cls, constructed, tag, start: pos, end: undefined, limit };
	}
	let length = lengthByte;
	if (lengthByte > 0x80) {
		const size = lengthByte & 0x7f;
		if (size > 4 || pos + size > limit) throw new P7mError(BROKEN);
		length = 0;
		for (let i = 0; i < size; i++) length = length * 256 + (data[pos++] as number);
	}
	if (pos + length > limit) {
		if (!read.partial) throw new P7mError(BROKEN);
		return { cls, constructed, tag, start: pos, end: limit, limit };
	}
	return { cls, constructed, tag, start: pos, end: pos + length, limit };
}
