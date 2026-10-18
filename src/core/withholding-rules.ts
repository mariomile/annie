/**
 * The rules of the ritenuta d'acconto a professional in regime ordinario bears, each with its
 * source. Where the source is not certain, or the rule changes often, the comment says «da
 * verificare». Pure constants and the few functions that only read them (the ritenuta of a base,
 * the deadline of a year's CU); the sums are in withholding-sums.ts.
 */
import { addDays, workingDay } from "./italian-calendar.ts";
import { halfUp, scaled } from "./quote-sums.ts";

/**
 * Lavoro autonomo (professionals): 20% of the compenso (art. 25, comma 1, DPR 600/1973). The
 * fatture in uscita apply it (quote-sums.ts RITENUTA_RATE, the same 20).
 */
export const PROFESSIONAL_RATE = "20";

/**
 * Agents and representatives: the rate of the first IRPEF bracket, 23% (art. 11 TUIR as in force
 * from 2024, D.Lgs. 216/2023 and L. 207/2024), on 50% of the provvigioni, or on 20% when the agent
 * uses employees or third parties continuously and says so to the customer (art. 25-bis, commi 1
 * e 2, DPR 600/1973). Da verificare when the first bracket's rate changes.
 */
export const AGENT_RATE = "23";
export const AGENT_BASE_PERCENT = "50";
export const AGENT_REDUCED_BASE_PERCENT = "20";

/** The causali of the CU for agents and representatives (Q monomandatario, R plurimandatario; istruzioni della Certificazione Unica, da verificare each year). */
export const AGENT_CAUSALI: readonly string[] = ["Q", "R"];

/** TipoRitenuta of FatturaPA that are a ritenuta d'acconto on income (RT01 persone fisiche, RT02 persone giuridiche); RT03 to RT06 are contributions withheld, not a credit for the dichiarazione (specifiche tecniche FatturaPA 1.2). */
export const TAX_WITHHOLDINGS: readonly string[] = ["RT01", "RT02"];

/**
 * The customer (sostituto d'imposta) pays the ritenuta with F24 by the 16th of the month after the
 * payment (art. 18, comma 1, D.Lgs. 241/1997; art. 8 DPR 602/1973), codice tributo 1040 for lavoro
 * autonomo and 1038 for the provvigioni of agents (risoluzioni dell'Agenzia delle Entrate; da verificare on the tables of the codici tributo).
 */
export const F24_DAY = 16;
export const F24_CODE = "1040";
export const F24_AGENT_CODE = "1038";

/**
 * The CU (Certificazione Unica) is given to the person by 16 March of the year after the payments
 * (art. 4, comma 6-quater, DPR 322/1998, as amended by art. 1, comma 949, L. 208/2015 from 2016).
 * A deadline on a Saturday, a Sunday or a holiday moves to the next working day (art. 7, comma 1,
 * lett. h, DL 70/2011). Da verificare each year: the deadline for sending the CU to the Agenzia has
 * moved more than once, the one to the person has stayed 16 March since 2016.
 */
export const CU_DUE = "03-16";

/**
 * The ritenute d'acconto suffered are a credit against the IRPEF of the year in which the income
 * they were withheld on is counted (art. 22, comma 1, lett. c, TUIR); for lavoro autonomo that is
 * the year the compenso was paid (principio di cassa, art. 54, comma 1, TUIR). A ritenuta the
 * customer did not withhold (paid gross) is no credit.
 */
export const CREDIT_RULE = "art. 22 TUIR";

/** The brief speaks about missing CU from the day after the deadline to the end of March. */
export const BRIEF_FROM = "03-17";
export const BRIEF_TO = "03-31";

/** How a ritenuta is computed: the professional's 20% of the compenso, an agent's 23% on 50% or 20% of the provvigioni, or another rate on the whole base. */
export type RitenutaRule = { readonly kind: "professional" } | { readonly kind: "agent"; readonly reduced?: boolean } | { readonly kind: "other"; readonly rate: string };

/** `percent` of `cents`, half up: the percent a canonical decimal with up to two decimals. */
function percentOf(cents: bigint, percent: string): bigint {
	return halfUp(cents * scaled(percent, 2), 10_000n);
}

/** The ritenuta on a compenso (or provvigione) of `base` cents, by its rule; one rounding, half up to the cent. */
export function ritenutaOf(base: bigint, rule: RitenutaRule): bigint {
	switch (rule.kind) {
		case "professional":
			return percentOf(base, PROFESSIONAL_RATE);
		case "agent": {
			const share = rule.reduced === true ? AGENT_REDUCED_BASE_PERCENT : AGENT_BASE_PERCENT;
			// 23% of 50% is 11,5% of the provvigione; computed as one product so it rounds once.
			return halfUp(base * scaled(AGENT_RATE, 2) * scaled(share, 2), 100_000_000n);
		}
		case "other":
			return percentOf(base, rule.rate);
	}
}

/**
 * Which rule a ritenuta of `ritenuta` cents on a compenso of `base` cents follows, within a cent:
 * the professional's 20%, an agent's 23% on 50% or on 20%; undefined when none (another rate, or a
 * base that is not the compenso).
 */
export function ruleOf(base: bigint, ritenuta: bigint): RitenutaRule | undefined {
	const abs = (n: bigint) => (n < 0n ? -n : n);
	const rules: RitenutaRule[] = [{ kind: "professional" }, { kind: "agent" }, { kind: "agent", reduced: true }];
	return rules.find((r) => abs(ritenutaOf(abs(base), r) - abs(ritenuta)) <= 1n);
}

/** The CU of the payments of `year`: due on 16 March of the next year, moved to the next working day. */
export function cuDeadline(year: number): string {
	let day = `${year + 1}-${CU_DUE}`;
	while (!workingDay(day)) day = addDays(day, 1);
	return day;
}

/** Whether `today` is past the deadline of the CU of `year`: the CU not received is late. */
export function cuLate(year: number, today: string): boolean {
	return today > cuDeadline(year);
}

/** Whether the brief speaks about the missing CU today, and of which year: from 17 to 31 March, the year before. */
export function briefYear(today: string): number | undefined {
	const md = today.slice(5);
	return md >= BRIEF_FROM && md <= BRIEF_TO ? Number(today.slice(0, 4)) - 1 : undefined;
}
