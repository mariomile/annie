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

/** The largest envelope and content read, in bytes, as for a file inside an archive (ADR 0026). */
export const MAX_P7M_BYTES = 30 * 1024 * 1024;

/** Envelopes inside envelopes (a file signed twice, one signature over the other): at most this many. */
const MAX_LAYERS = 3;

/** 1.2.840.113549.1.7.2, id-signedData, as written in DER after its tag and length. */
const SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];

const BROKEN = "la busta della firma digitale (.p7m) è rovinata o incompleta";

/** One element: its class and number, where its content starts and ends, and where the next one starts. */
type Element = { readonly cls: number; readonly constructed: boolean; readonly tag: number; readonly start: number; readonly end: number; readonly next: number };

/**
 * A reader over the envelope's bytes. `partial`: the bytes are only the beginning of the file
 * (the start of a base64 text), so lengths past the end are cut to what there is.
 */
type Reader = { readonly data: Uint8Array; readonly partial: boolean };

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
		bytes = encapsulated({ data: bytes, partial: false }, MAX_P7M_BYTES, false);
		if (!isBinaryEnvelope(bytes)) return bytes;
	}
	throw new P7mError("il file è firmato troppe volte, una busta dentro l'altra");
}

/**
 * The first `bytes` bytes of the signed content (or fewer, if there are not that many), read
 * from the start of the file only: enough to tell what the document is without opening all of
 * it. Undefined when that start is not a readable envelope.
 */
export function signedContentStart(data: Uint8Array, bytes: number): Uint8Array | undefined {
	try {
		let reader: Reader;
		if (isBinaryEnvelope(data)) reader = { data, partial: false };
		else {
			// Four characters are three bytes: enough of the text for the envelope's start and `bytes` of content.
			const chars = Math.ceil((bytes + 4096) / 3) * 4;
			const text = base64Start(data, chars * 2);
			if (text === undefined) return undefined;
			const clean = text.replace(/[^A-Za-z0-9+/]+/g, "").slice(0, chars);
			reader = { data: Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64"), partial: true };
		}
		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const content = encapsulated(reader, bytes, true);
			if (!isBinaryEnvelope(content)) return content.length === 0 ? undefined : content;
			reader = { data: content, partial: true };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** The envelope as bytes: binary as it is, base64 decoded (checked whole, so no garbage is decoded). */
function binary(data: Uint8Array): Uint8Array {
	if (data.length > MAX_P7M_BYTES) throw new P7mError("il file firmato è troppo grande da leggere");
	if (isBinaryEnvelope(data)) return data;
	if (base64Start(data) === undefined) throw new P7mError("non è un file firmato digitalmente (.p7m) che so aprire");
	let text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
	const begin = /^\s*-----BEGIN [A-Z0-9 ]{1,40}-----/.exec(text);
	if (begin !== null) {
		const end = text.indexOf("-----END", begin[0].length);
		text = text.slice(begin[0].length, end < 0 ? text.length : end);
	}
	if (!/^[A-Za-z0-9+/=\s]*$/.test(text)) throw new P7mError(BROKEN);
	const bytes = Buffer.from(text, "base64");
	if (!isBinaryEnvelope(bytes)) throw new P7mError(BROKEN);
	return bytes;
}

/**
 * The start of a base64 envelope as text, at most `max` characters, PEM line out: «MI» is how a
 * DER SEQUENCE with a long length begins in base64. Undefined when the bytes do not start like one.
 */
function base64Start(data: Uint8Array, max = 128): string | undefined {
	const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, max + 128)).toString("latin1");
	let text = head.trimStart();
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
 * most `max` of them: more is a P7mError, or with `start` only the first `max` are wanted.
 */
function encapsulated(reader: Reader, max: number, start: boolean): Uint8Array {
	const info = element(reader, 0, reader.data.length, 0);
	expect(info, 0, 16, true);
	const [type, wrapped] = children(reader, info, 1, 2);
	if (type === undefined || wrapped === undefined) throw new P7mError(BROKEN);
	expect(type, 0, 6, false);
	expect(wrapped, 2, 0, true);
	const signed = children(reader, wrapped, 2, 1)[0];
	if (signed === undefined) throw new P7mError(BROKEN);
	expect(signed, 0, 16, true);
	const [version, algorithms, encap] = children(reader, signed, 3, 3);
	if (version === undefined || algorithms === undefined || encap === undefined) throw new P7mError(BROKEN);
	expect(version, 0, 2, false);
	expect(algorithms, 0, 17, true);
	expect(encap, 0, 16, true);
	const [, content] = children(reader, encap, 4, 2);
	if (content === undefined) throw new P7mError("il file firmato non contiene il documento: la firma è separata dal file che firma");
	expect(content, 2, 0, true);
	const octets = children(reader, content, 5, 1)[0];
	if (octets === undefined) throw new P7mError(BROKEN);
	const chunks: Uint8Array[] = [];
	const taken = collect(reader, octets, 6, chunks, { left: max });
	if (taken.over && !start) throw new P7mError("il documento firmato è troppo grande da leggere");
	return chunks.length === 1 ? (chunks[0] as Uint8Array) : Buffer.concat(chunks);
}

function expect(el: Element, cls: number, tag: number, constructed: boolean): void {
	if (el.cls !== cls || el.tag !== tag || el.constructed !== constructed) throw new P7mError(BROKEN);
}

/**
 * An OCTET STRING's bytes into `chunks`: a primitive one as it is, a constructed one (BER) chunk
 * by chunk, each again an OCTET STRING. Stops once `budget.left` bytes are taken.
 */
function collect(reader: Reader, el: Element, depth: number, chunks: Uint8Array[], budget: { left: number }): { over: boolean } {
	if (el.cls !== 0 || el.tag !== 4) throw new P7mError(BROKEN);
	if (!el.constructed) {
		const length = el.end - el.start;
		const take = Math.min(length, budget.left);
		if (take > 0) chunks.push(reader.data.subarray(el.start, el.start + take));
		budget.left -= take;
		return { over: take < length };
	}
	let at = el.start;
	while (at < el.end) {
		if (budget.left <= 0) return { over: true };
		const chunk = element(reader, at, el.end, depth);
		if (collect(reader, chunk, depth + 1, chunks, budget).over) return { over: true };
		at = chunk.next;
	}
	return { over: false };
}

/** The first `count` children of a constructed element (fewer if it has fewer). */
function children(reader: Reader, parent: Element, depth: number, count: number): Element[] {
	const out: Element[] = [];
	let at = parent.start;
	while (at < parent.end && out.length < count) {
		const child = element(reader, at, parent.end, depth);
		out.push(child);
		at = child.next;
	}
	return out;
}

/**
 * The element at `at`, inside [at, limit): tag, length and, for an indefinite length, its end
 * found by walking its children to the end-of-contents marker (00 00). Lengths of more than 4
 * bytes, or past the limit, are refused; a partial reader cuts them to the data it has.
 */
function element(reader: Reader, at: number, limit: number, depth: number): Element {
	if (depth > MAX_DEPTH) throw new P7mError("la busta della firma digitale (.p7m) è annidata troppo in profondità");
	const { data, partial } = reader;
	// Past the end of what there is: broken, or, when only the file's start was read, cut there.
	const cut = (cls: number, constructed: boolean, tag: number, start: number): Element => {
		if (!partial) throw new P7mError(BROKEN);
		return { cls, constructed, tag, start: Math.min(start, limit), end: limit, next: limit };
	};
	if (at + 2 > limit) return cut(-1, false, -1, at);
	const first = data[at] as number;
	const constructed = (first & 0x20) !== 0;
	const cls = first >> 6;
	let pos = at + 1;
	let tag = first & 0x1f;
	if (tag === 0x1f) {
		// A tag number in several bytes, 7 bits each: none of SignedData's needs more than 4.
		tag = 0;
		for (let i = 0; ; i++) {
			if (i === 4) throw new P7mError(BROKEN);
			if (pos >= limit) return cut(cls, constructed, -1, pos);
			const byte = data[pos++] as number;
			tag = tag * 128 + (byte & 0x7f);
			if ((byte & 0x80) === 0) break;
		}
	}
	if (pos >= limit) return cut(cls, constructed, tag, pos);
	const lengthByte = data[pos++] as number;
	if (lengthByte === 0x80) {
		if (!constructed) throw new P7mError(BROKEN);
		// Indefinite: the children run up to 00 00.
		let child = pos;
		for (;;) {
			if (child + 2 > limit) return cut(cls, constructed, tag, pos);
			if (data[child] === 0 && data[child + 1] === 0) return { cls, constructed, tag, start: pos, end: child, next: child + 2 };
			child = element(reader, child, limit, depth + 1).next;
		}
	}
	let length = lengthByte;
	if (lengthByte > 0x80) {
		const size = lengthByte & 0x7f;
		if (size > 4) throw new P7mError(BROKEN);
		if (pos + size > limit) return cut(cls, constructed, tag, limit);
		length = 0;
		for (let i = 0; i < size; i++) length = length * 256 + (data[pos++] as number);
	}
	if (pos + length > limit) return cut(cls, constructed, tag, pos);
	return { cls, constructed, tag, start: pos, end: pos + length, next: pos + length };
}
