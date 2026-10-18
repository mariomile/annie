/**
 * Amounts in euros as the person says them, read and checked: the one reader every register uses
 * for euros to the cent (expenses, renewals, cashflow, taxes, IVA). «8.400» is eight thousand four
 * hundred euros, «1,5k» and «8 mila» are thousands, «1.500k» is refused as ambiguous; another
 * currency is refused; what does not read is echoed inside the caller's fence.
 */
import { CASHFLOW_LIMITS } from "./cashflow.ts";
import { foreignCurrency } from "./currency-words.ts";
import { scaled } from "./quote-sums.ts";
import { isProblem, type Problem, readAmount } from "./text-input.ts";
import type { Fenced } from "./untrusted.ts";

export type EuroWords = {
	/** Echoes what is not digits inside the caller's fence. */
	readonly fence: (text: string) => string;
	readonly max: number;
	/** Why another currency is refused, and what to do. */
	readonly foreign: string;
	readonly negative: string;
	readonly zero: string;
};

/** An amount in euros to the cent: more than zero, at most `max`; undefined when not given. */
export function readEuros(value: unknown, w: EuroWords): string | undefined | Problem {
	if (value === undefined) return undefined;
	if (foreignCurrency(value)) return { problem: w.foreign };
	if ((typeof value === "number" && value < 0) || (typeof value === "string" && /^\s*(?:€|eur\w*)?\s*-/i.test(value))) return { problem: w.negative };
	const read = readAmount(value, 2, "amount", w.fence);
	if (isProblem(read) || read === undefined) return read;
	if (Number(read) <= 0) return { problem: w.zero };
	if (Number(read) > w.max) return { problem: `l'importo è oltre ${w.max.toLocaleString("it-IT")} €: ricontrollalo con chi ti scrive` };
	return read;
}

const FOREIGN = "l'importo è in un'altra valuta: convertilo in euro con exchange_rate e passa gli euro";

const THOUSANDS = /^(\d{1,7}(?:[.,]\d{1,3})?)\s*(?:k|mila)$/i;
/** «1.500k», «1,250 mila»: thousands of thousands, or a decimal? Nobody can tell. */
const GROUPED_THOUSANDS = /^\d{1,3}(?:[.,]\d{3})+\s*(?:k|mila)$/i;
const DOT_GROUPED = /^\d{1,3}(?:\.\d{3})+$/;

/** The person's way of writing euros made plain: «8.400» → «8400», «1,5k» → «1500», «8 mila» → «8000»; anything else as it is. */
export function plainEuros(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const t = bare(value);
	const k = THOUSANDS.exec(t);
	if (k !== null) return String(scaled((k[1] as string).replace(",", "."), 3));
	if (DOT_GROUPED.test(t)) return t.replace(/\./g, "");
	return value;
}

function bare(value: string): string {
	return value
		.trim()
		.replace(/^(?:€|eur(?:o)?)\s*/i, "")
		.replace(/\s*(?:€|eur(?:o)?)$/i, "")
		.trim();
}

/** «1.500k» is refused: 1.500 or 1.500.000? */
function ambiguousThousands(value: unknown, what: string): Problem | undefined {
	if (typeof value !== "string" || !GROUPED_THOUSANDS.test(bare(value).replace(/^[-−–]\s*/, ""))) return undefined;
	const said = /^[\d .,€kKmila-]{1,20}$/.test(value) ? `«${value}»` : "l'importo";
	return { problem: `${what}: ${said} può voler dire migliaia o milioni. Chiedi a chi ti scrive, o passa il valore come numero JSON (1500 o 1500000)` };
}

/** An amount of a voce in euros: more than zero, at most the cap. */
export function readItemAmount(value: unknown, fence: Fenced): string | undefined | Problem {
	const ambiguous = ambiguousThousands(value, "amount");
	if (ambiguous !== undefined) return ambiguous;
	return readEuros(plainEuros(value), {
		fence,
		max: CASHFLOW_LIMITS.maxAmount,
		foreign: FOREIGN,
		negative: "amount è sempre positivo: se sono soldi che escono, kind uscita",
		zero: "amount deve essere più di zero",
	});
}

/** A balance in euros, a minus in front when the account is overdrawn («-350,50», «− 1.200»); 0 is a balance too. */
export function readSignedEuros(value: unknown, fence: Fenced, what: string): string | undefined | Problem {
	if (value === undefined) return undefined;
	const ambiguous = ambiguousThousands(value, what);
	if (ambiguous !== undefined) return ambiguous;
	let said: unknown = value;
	let negative = false;
	if (typeof value === "number") {
		negative = value < 0;
		said = Math.abs(value);
	} else if (typeof value === "string") {
		const m = /^\s*(?:€|eur(?:o)?)?\s*[-−–]\s*(.*)$/i.exec(value);
		if (m !== null) {
			negative = true;
			said = m[1] as string;
		}
	}
	said = plainEuros(said);
	if (said === 0 || (typeof said === "string" && /^\s*(?:€\s*)?0+(?:[.,]0{1,2})?\s*(?:€|euro?)?\s*$/i.test(said))) return "0";
	const read = readEuros(said, { fence, max: CASHFLOW_LIMITS.maxAmount, foreign: FOREIGN, negative: `${what}: un solo segno meno davanti`, zero: `${what}: dammi un numero` });
	if (read === undefined || isProblem(read)) return isProblem(read) ? { problem: `${what}: ${read.problem.replace(/^amount: /, "")}` } : read;
	return negative ? `-${read}` : read;
}
