import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

/**
 * The PDF standard security handler with an empty user password (ADR 0026): the PDFs that open
 * without asking anything but are "protected" against copying or printing (bank statements,
 * bills). RC4 and AES-128 (revisions 2 to 4), AES-256 (5 and 6). A PDF that does ask for a
 * password gives undefined: its text stays unread.
 *
 * Only erasable TypeScript here: the document worker runs this file by stripping the types.
 */
export type PdfCipher = (num: number, gen: number, data: Buffer) => Buffer;

export type PdfEncryption = {
	readonly v: number;
	readonly r: number;
	/** Key length in bits (40 to 256). */
	readonly length: number;
	readonly o: Buffer;
	readonly u: Buffer;
	readonly ue?: Buffer;
	readonly p: number;
	/** The first element of the trailer's ID. */
	readonly id: Buffer;
	readonly encryptMetadata: boolean;
	/** How streams are encrypted: from V, or the crypt filter that StmF names. */
	readonly method: "rc4" | "aes128" | "aes256" | "none";
};

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

export function pdfCipher(e: PdfEncryption): PdfCipher | undefined {
	if (e.method === "none") return (_num, _gen, data) => data;
	if (e.r >= 5) {
		const key = aes256Key(e);
		if (key === undefined) return undefined;
		return (_num, _gen, data) => aesDecrypt("aes-256-cbc", key, data);
	}
	const key = rc4Key(e);
	if (key === undefined) return undefined;
	const aes = e.method === "aes128";
	return (num, gen, data) => {
		const salt = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
		const objectKey = md5(key, salt, aes ? Buffer.from("sAlT", "latin1") : Buffer.alloc(0)).subarray(0, Math.min(key.length + 5, 16));
		return aes ? aesDecrypt("aes-128-cbc", objectKey, data) : rc4(objectKey, data);
	};
}

/** Revisions 2 to 4: the file key from the empty password, checked against U. */
function rc4Key(e: PdfEncryption): Buffer | undefined {
	const n = e.r === 2 ? 5 : Math.max(5, Math.min(16, Math.floor(e.length / 8)));
	const p = Buffer.alloc(4);
	p.writeInt32LE(e.p | 0);
	let key = md5(PAD, e.o.subarray(0, 32), p, e.id, e.r >= 4 && !e.encryptMetadata ? Buffer.from([0xff, 0xff, 0xff, 0xff]) : Buffer.alloc(0));
	if (e.r >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
	key = key.subarray(0, n);
	if (e.r === 2) return rc4(key, PAD).equals(e.u.subarray(0, 32)) ? key : undefined;
	let check = rc4(key, md5(PAD, e.id));
	for (let i = 1; i <= 19; i++) check = rc4(Buffer.from(key.map((b) => b ^ i)), check);
	return check.equals(e.u.subarray(0, 16)) ? key : undefined;
}

/** Revisions 5 and 6: the empty password checked against U, the file key out of UE. */
function aes256Key(e: PdfEncryption): Buffer | undefined {
	if (e.u.length < 48 || e.ue === undefined || e.ue.length < 32) return undefined;
	const hash = (salt: Buffer) => (e.r === 5 ? createHash("sha256").update(salt).digest() : hardenedHash(salt));
	if (!hash(e.u.subarray(32, 40)).equals(e.u.subarray(0, 32))) return undefined;
	const decipher = createDecipheriv("aes-256-cbc", hash(e.u.subarray(40, 48)), Buffer.alloc(16));
	decipher.setAutoPadding(false);
	return Buffer.concat([decipher.update(e.ue.subarray(0, 32)), decipher.final()]);
}

/** ISO 32000-2, algorithm 2.B, for the empty password and no user data. */
function hardenedHash(salt: Buffer): Buffer {
	let k = createHash("sha256").update(salt).digest();
	let e = Buffer.alloc(0);
	for (let round = 0; round < 64 || (e.at(-1) as number) > round - 32; round++) {
		const block = Buffer.concat(Array.from({ length: 64 }, () => k));
		const cipher = createCipheriv("aes-128-cbc", k.subarray(0, 16), k.subarray(16, 32));
		cipher.setAutoPadding(false);
		e = Buffer.concat([cipher.update(block), cipher.final()]);
		let sum = 0;
		for (const b of e.subarray(0, 16)) sum += b;
		k = createHash(["sha256", "sha384", "sha512"][sum % 3] as string)
			.update(e)
			.digest();
	}
	return k.subarray(0, 32);
}

function aesDecrypt(algorithm: "aes-128-cbc" | "aes-256-cbc", key: Buffer, data: Buffer): Buffer {
	if (data.length < 32 || data.length % 16 !== 0) return Buffer.alloc(0);
	const iv = data.subarray(0, 16);
	const body = data.subarray(16);
	try {
		const decipher = createDecipheriv(algorithm, key, iv);
		return Buffer.concat([decipher.update(body), decipher.final()]);
	} catch {
		// Bad padding: keep the bytes, the filters after may still read them.
		const decipher = createDecipheriv(algorithm, key, iv);
		decipher.setAutoPadding(false);
		return Buffer.concat([decipher.update(body), decipher.final()]);
	}
}

/** RC4: not offered by OpenSSL 3 without the legacy provider, and small enough to write here. */
function rc4(key: Uint8Array, data: Uint8Array): Buffer {
	const s = new Uint8Array(256);
	for (let i = 0; i < 256; i++) s[i] = i;
	for (let i = 0, j = 0; i < 256; i++) {
		j = (j + (s[i] as number) + (key[i % key.length] as number)) & 0xff;
		[s[i], s[j]] = [s[j] as number, s[i] as number];
	}
	const out = Buffer.alloc(data.length);
	for (let k = 0, i = 0, j = 0; k < data.length; k++) {
		i = (i + 1) & 0xff;
		j = (j + (s[i] as number)) & 0xff;
		[s[i], s[j]] = [s[j] as number, s[i] as number];
		out[k] = (data[k] as number) ^ (s[((s[i] as number) + (s[j] as number)) & 0xff] as number);
	}
	return out;
}

function md5(...parts: Uint8Array[]): Buffer {
	const hash = createHash("md5");
	for (const part of parts) hash.update(part);
	return hash.digest();
}
