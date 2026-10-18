/**
 * Words and signs of a currency other than the euro in an amount as written («30 $», «USD 30»,
 * «20 dollari», «15 CHF»): spese and tariffe are in euros, so an amount like that is never read
 * as if it were. Shared by the expenses and the timesheet.
 */
const FOREIGN = /\$|£|¥|\b(?:usd|gbp|chf|jpy|cad|aud|dollar\w*|sterlin\w*|franch\w*|yen)\b/i;

/** Whether an amount as written is in another currency. */
export function foreignCurrency(value: unknown): boolean {
	return typeof value === "string" && FOREIGN.test(value);
}
