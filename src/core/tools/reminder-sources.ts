/**
 * What a payment reminder takes from outside the register: the interest rate the person gives
 * (exact), the IBAN to pay to (the company's saved one, or one all the issued invoices agree on)
 * and the address (given, saved, the SdI PEC, or the invoice's non-standard email, in that order).
 */
import { validIban } from "../iban.ts";
import type { Company, Invoice } from "../invoices.ts";
import type { Contact } from "../reminder-book.ts";
import { collectable, type Debtor, invoicesOf } from "./reminder-debtors.ts";

/** Domains of PEC providers: an address there takes mail only from another PEC. */
const PEC_DOMAINS = ["pec.it", "legalmail.it", "postecert.it", "arubapec.it", "pec.aruba.it", "pecimprese.it", "sicurezzapostale.it", "cert.legalmail.it", "pec.libero.it", "registerpec.it", "gigapec.it", "pecveneto.it", "postacert.it", "cgn.legalmail.it"];

/** A yearly rate as the person writes it («8», «8,5%», «10.15»): exact, as digits and a power of ten. */
export type Rate = { readonly digits: bigint; readonly scale: bigint; readonly text: string };

/** The rate, or why it does not read: up to 4 decimals, more than 0 and at most 100. */
export function parseRate(text: string): Rate | { problem: string } {
	const m = /^\s*(\d{1,3})(?:[.,](\d{1,4}))?\s*%?\s*$/.exec(text);
	if (m === null) return { problem: "il tasso è un numero di percentuale annua, per esempio 8 o 10,15" };
	const decimals = m[2] ?? "";
	const digits = BigInt(`${m[1]}${decimals}`);
	const scale = 10n ** BigInt(decimals.length);
	if (digits === 0n || digits > 100n * scale) return { problem: "il tasso va da più di 0 a 100" };
	const trimmed = decimals.replace(/0+$/, "");
	return { digits, scale, text: `${BigInt(m[1] as string)}${trimmed === "" ? "" : `,${trimmed}`}` };
}

/**
 * Simple interest on `units` (hundred-millionths) at `rate` a year for `days` days, on a 365-day
 * year: units × rate/100 × days/365, rounded half up to the cent, back in hundred-millionths.
 */
export function simpleInterest(units: bigint, rate: Rate, days: number): bigint {
	if (units <= 0n || days <= 0) return 0n;
	const numerator = units * rate.digits * BigInt(days);
	// Units are 1e-8 of the currency, a cent 1e-2: one cent is 1e6 units.
	const denominator = rate.scale * 100n * 365n * 1_000_000n;
	const cents = (numerator * 2n + denominator) / (denominator * 2n);
	return cents * 1_000_000n;
}

/** «del 10%», «dell'8%», «dell'11%»: the article as the number is said. */
export function ofRate(rate: Rate): string {
	return /^(?:8|11(?!\d)|1(?!\d))/.test(rate.text) ? `dell'${rate.text}%` : `del ${rate.text}%`;
}

/** Where the money goes: the company's saved IBANs; else one IBAN all its issued invoices agree on, said; else none, said. */
export type Payment = { readonly ibans: readonly string[]; readonly note?: string };

export function paymentOf(company: Company | undefined, invoices: readonly Invoice[]): Payment {
	const saved = (company?.ibans ?? []).map((i) => validIban(i)).filter((i): i is string => i !== undefined);
	if (saved.length > 0) return { ibans: saved.slice(0, 2) };
	const written = new Set<string>();
	let bad = false;
	for (const invoice of invoices) {
		if (!collectable(invoice)) continue;
		for (const instalment of invoice.instalments) {
			if (instalment.iban === undefined) continue;
			const iban = validIban(instalment.iban);
			if (iban === undefined) bad = true;
			else written.add(iban);
		}
	}
	const save = "salva il tuo IBAN con set_company (iban)";
	if (bad) return { ibans: [], note: `un IBAN scritto nelle fatture emesse non è valido: non ho messo le coordinate per pagare, ${save}` };
	if (written.size > 1) return { ibans: [], note: `le fatture emesse riportano IBAN diversi: non ho messo le coordinate per pagare, ${save}` };
	const only = [...written][0];
	if (only === undefined) return { ibans: [] };
	return { ibans: [only], note: "IBAN preso dalle fatture: salvalo con set_company così non dipende dai file" };
}

/** Whether an address looks like a PEC: a PEC provider's domain, or «pec» as a part of it. */
export function looksLikePec(address: string): boolean {
	const domain = address.split("@")[1]?.toLowerCase() ?? "";
	return PEC_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)) || domain.split(".").includes("pec");
}

/** Who the letter goes to, where that came from, and what to say about it. */
export type Recipient = { readonly to?: string; readonly from?: "given" | "saved" | "pec" | "file"; readonly notes: readonly string[] };

/**
 * The address: the one the person gave, else the one saved for this customer, else the PEC the
 * SdI delivered to (maybe an intermediary's), else an email written in the invoice where the
 * format has no place for one. The last two are said; a PEC-looking address is said in any case.
 */
export function recipientOf(debtor: Debtor, given: string | undefined, contacts: readonly Contact[], isAddress: (a: string) => boolean): Recipient {
	const pecNote = "l'indirizzo sembra una PEC: da una casella normale la mail può essere rifiutata";
	const flagged = (to: string, from: Recipient["from"], notes: string[] = []): Recipient => ({ to, from, notes: looksLikePec(to) && from !== "pec" ? [...notes, pecNote] : notes });
	if (given !== undefined) return flagged(given.trim().toLowerCase(), "given");
	const saved = contacts.find((c) => c.key === debtor.key);
	if (saved !== undefined) return flagged(saved.email, "saved");
	const newest = invoicesOf(debtor).sort((a, b) => (b.doc.date ?? "").localeCompare(a.doc.date ?? ""));
	let bad = false;
	for (const [from, read] of [
		["pec", (i: Invoice) => i.pec],
		["file", (i: Invoice) => i.customer.email],
	] as const) {
		for (const invoice of newest) {
			const raw = read(invoice);
			if (raw === undefined) continue;
			const address = raw.trim().toLowerCase();
			if (!isAddress(address)) {
				bad = true;
				continue;
			}
			if (from === "pec") return { to: address, from, notes: ["è la PEC di recapito SdI, può essere dell'intermediario: controlla che sia del cliente, e da una casella normale la mail può essere rifiutata"] };
			return flagged(address, from, ["l'indirizzo viene da un campo della fattura che il formato non prevede per il cliente: controllalo prima di usarlo"]);
		}
	}
	return { notes: [bad ? "l'indirizzo scritto in fattura non è valido: chiedi l'indirizzo a chi ti scrive" : "non ho un indirizzo per questo cliente: chiedilo a chi ti scrive"] };
}

/** A mailto: link that opens the letter ready in the phone's mail app; undefined past ~1800 characters, which some apps cut. */
export function mailtoLink(to: string | undefined, subject: string, body: string): string | undefined {
	const link = `mailto:${to === undefined ? "" : encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
	return link.length > 1800 ? undefined : link;
}
