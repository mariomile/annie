import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP (RFC 6238) on HMAC-SHA1, 30-second steps: what every authenticator app speaks.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(text: string): Buffer {
	const clean = text.toUpperCase().replace(/[\s=-]/g, "");
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		const index = ALPHABET.indexOf(char);
		if (index < 0) throw new Error("Invalid base32");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export function generateTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

function codeAt(key: Buffer, step: number, digits: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const mac = createHmac("sha1", key).update(counter).digest();
	const offset = (mac[mac.length - 1] as number) & 15;
	const binary = mac.readUInt32BE(offset) & 0x7fffffff;
	return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(secret: string, timeMs: number, digits = 6): string {
	return codeAt(base32Decode(secret), Math.floor(timeMs / STEP_MS), digits);
}

/**
 * The step a typed code belongs to (now, or one step either side for clock drift), or
 * undefined. A step at or before `lastStep` is refused: each code works once.
 */
export function verifyTotp(secret: string, typed: string, timeMs: number, lastStep = -1): number | undefined {
	const code = typed.replace(/\s/g, "");
	if (!/^\d{6}$/.test(code)) return undefined;
	const key = base32Decode(secret);
	const now = Math.floor(timeMs / STEP_MS);
	for (const step of [now - 1, now, now + 1]) {
		if (step <= lastStep) continue;
		if (timingSafeEqual(Buffer.from(codeAt(key, step, 6)), Buffer.from(code))) return step;
	}
	return undefined;
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
	return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
