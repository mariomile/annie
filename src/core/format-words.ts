/**
 * Words shared by the registers' answers, with no domain in them: an amount of euros written the
 * Italian way, one or many.
 */

/** Cents written the Italian way: 1.234,56 €; a negative with the minus sign: −12,00 €. */
export function euros(value: bigint): string {
	const digits = (value < 0n ? -value : value).toString().padStart(3, "0");
	const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+$)/g, ".");
	return `${value < 0n ? "−" : ""}${whole},${digits.slice(-2)} €`;
}

/** One or many: `one` for 1, else `many` with «#» for the number («# fatture», «contate»/«contata»). */
export function n1(n: number, one: string, many: string): string {
	return n === 1 ? one : many.replace("#", String(n));
}
