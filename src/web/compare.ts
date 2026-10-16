import { createHash, timingSafeEqual } from "node:crypto";

/** Compare two secrets (or hashes of secrets) in constant time, whatever their length. */
export function sameSecret(given: string, expected: string): boolean {
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}
