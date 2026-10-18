/**
 * Words shared by the registers' answers: an amount of euros written the Italian way, how a
 * renewal is named, one or many, a short date after its preposition. Names come from the person: whoever uses `renewalName` puts it in a fence.
 */
import { unitsText } from "./invoice-sums.ts";
import { dayMonth } from "./invoice-windows.ts";
import type { DatePreposition } from "./italian-format.ts";
import type { Renewal } from "./renewals.ts";

/** Cents written the Italian way: 1.234,56 €; a negative with the minus sign: −12,00 €. */
export function euros(value: bigint): string {
	return unitsText(value * 1_000_000n, "EUR").replace(/^-/, "−");
}

/** The renewal's name, with its provider when it has one: to be fenced. */
export function renewalName(r: Pick<Renewal, "name" | "provider">): string {
	return `${r.name}${r.provider === undefined ? "" : ` (${r.provider})`}`;
}

/** One or many: `one` for 1, else `many` with «#» for the number («# fatture», «contate»/«contata»). */
export function n1(n: number, one: string, many: string): string {
	return n === 1 ? one : many.replace("#", String(n));
}

const ELIDED: Readonly<Record<DatePreposition, string>> = { il: "l'", del: "dell'", dal: "dall'", al: "all'", nel: "nell'", sul: "sull'" };

/** A short date after its preposition, the year only when not this one: «il 12/11», «l'08/11», «dall'11/11/2027». */
export function withShortDate(preposition: DatePreposition, date: string, today: string): string {
	const day = Number(date.slice(8, 10));
	const text = dayMonth(date, today);
	return day === 8 || day === 11 ? `${ELIDED[preposition]}${text}` : `${preposition} ${text}`;
}
