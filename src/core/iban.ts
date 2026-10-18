/**
 * IBAN check on paper (ISO 13616): the country, two check digits and the account, whose mod-97
 * is 1. Nothing is asked to any bank: a number that passes may still not be the right account.
 */

/** The IBAN without spaces, upper case, when it passes the check; undefined otherwise. */
export function validIban(text: string): string | undefined {
	const iban = text.replace(/[\s-]+/g, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return undefined;
	const moved = `${iban.slice(4)}${iban.slice(0, 4)}`;
	let rest = 0;
	for (const char of moved) {
		const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
		for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
	}
	return rest === 1 ? iban : undefined;
}
