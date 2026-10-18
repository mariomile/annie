/**
 * set_company's details besides the partita IVA and the name: the IBANs and signature of the
 * reminders, and the letterhead of the quotes (address, phone, email, codice fiscale, REA) with
 * the VAT regime as the owner states it. Read and checked here; shown back inside the fence.
 */
import { validAddress } from "../email-address.ts";
import { validIban } from "../iban.ts";
import { COMPANY_LIMITS } from "../invoice-store.ts";
import { type Company, REGIMES, type Regime } from "../invoices.ts";
import { oneLine } from "../plain-text.ts";
import { checkCodiceFiscale, partitaIvaProblem } from "../tax-ids.ts";

export type CompanyExtras = { ibans?: string[]; signature?: string; address?: string; phone?: string; email?: string; cf?: string; rea?: string; regime?: Regime };

const EXTRA_KEYS = ["ibans", "signature", "address", "phone", "email", "cf", "rea", "regime"] as const;

const PHONE = /^\+?[\d\s./()-]{6,30}$/;
const REA = /^([A-Z]{2})[\s-]*(\d{1,7})$/;


/** The extras given to set_company, checked; or what is wrong. */
export function companyExtras(args: Record<string, unknown>): CompanyExtras | { problem: string } {
	const out: CompanyExtras = {};
	if (args.iban !== undefined) {
		if (typeof args.iban !== "string") return { problem: "iban è un testo" };
		const parts = args.iban
			.split(/[,;]+/)
			.map((p) => p.trim())
			.filter((p) => p !== "");
		if (parts.length === 0 || parts.length > COMPANY_LIMITS.ibans) return { problem: `iban: da uno a ${COMPANY_LIMITS.ibans} IBAN, separati da virgole` };
		const ibans: string[] = [];
		for (const part of parts) {
			const iban = validIban(part);
			if (iban === undefined) return { problem: `l'IBAN ${part.slice(0, 40)} non è valido: le cifre di controllo non tornano, ricontrollalo` };
			if (!ibans.includes(iban)) ibans.push(iban);
		}
		out.ibans = ibans;
	}
	if (args.signature !== undefined) {
		if (typeof args.signature !== "string") return { problem: "signature è un testo" };
		const lines = args.signature
			.split(/\r?\n/)
			.map((l) => l.trim().replace(/\s+/g, " "))
			.filter((l) => l !== "");
		const signature = lines.join("\n");
		if (signature === "" || lines.length > COMPANY_LIMITS.signatureLines || signature.length > COMPANY_LIMITS.signature) return { problem: `signature: al più ${COMPANY_LIMITS.signatureLines} righe e ${COMPANY_LIMITS.signature} caratteri` };
		out.signature = signature;
	}
	for (const key of ["address", "phone", "email", "cf", "rea", "regime"] as const) {
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || oneLine(value) === "") return { problem: `${key} è un testo` };
		const text = oneLine(value);
		if (key !== "regime" && text.length > COMPANY_LIMITS[key]) return { problem: `${key}: al più ${COMPANY_LIMITS[key]} caratteri` };
		if (key === "address") out.address = text;
		else if (key === "phone") {
			if (!PHONE.test(text) || (text.match(/\d/g) ?? []).length < 6) return { problem: "phone: il numero di telefono ha cifre, spazi e al più un + davanti" };
			out.phone = text;
		} else if (key === "email") {
			if (!validAddress(text)) return { problem: "email: l'indirizzo non sembra valido" };
			out.email = text;
		} else if (key === "cf") {
			const cf = text.toUpperCase().replace(/\s+/g, "");
			if (/^\d{11}$/.test(cf)) {
				const wrong = partitaIvaProblem(cf);
				if (wrong !== undefined) return { problem: `cf: il codice fiscale numerico non va: ${wrong}` };
			} else {
				const checked = checkCodiceFiscale(cf);
				if ("problem" in checked) return { problem: `cf: il codice fiscale non va: ${checked.problem}` };
			}
			out.cf = cf;
		} else if (key === "rea") {
			const m = REA.exec(text.toUpperCase().replace(/^REA\s*/, ""));
			if (m === null) return { problem: "rea: il numero REA è la sigla della provincia e il numero, per esempio MI-1234567" };
			out.rea = `${m[1]}-${m[2]}`;
		} else {
			if (!REGIMES.includes(text as Regime)) return { problem: "regime è ordinario o forfettario, come lo dice chi ti scrive" };
			out.regime = text as Regime;
		}
	}
	return out;
}

/** Whether any extra is given. */
export function touchesExtras(extras: CompanyExtras): boolean {
	return EXTRA_KEYS.some((k) => extras[k] !== undefined);
}

/**
 * Whether the partita IVA or name given is the company already saved: the same partita IVA, or
 * with none saved the same name (a partita IVA added to the saved name, or a new name for the
 * saved partita IVA, is the same company too). Only then its other details stay.
 */
export function sameCompany(old: Company | undefined, given: { vat?: string; name?: string }): boolean {
	if (old === undefined) return false;
	const sameName = (a?: string, b?: string) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
	if (given.vat !== undefined) return old.vat === undefined ? given.name === undefined || sameName(old.name, given.name) : old.vat === given.vat;
	return old.vat !== undefined || sameName(old.name, given.name);
}

/** The extras already saved, kept when the partita IVA or the name is given again. */
export function savedExtras(company: Company | undefined): CompanyExtras {
	if (company === undefined) return {};
	const out: Record<string, unknown> = {};
	for (const key of EXTRA_KEYS) if (company[key] !== undefined) out[key] = company[key];
	return out as CompanyExtras;
}

/** What was saved, in words: «IBAN per i solleciti: …; firma: …; indirizzo: …». */
export function extrasText(extras: CompanyExtras): string {
	const parts = [
		extras.ibans === undefined ? undefined : `IBAN per i solleciti: ${extras.ibans.join(", ")}`,
		extras.signature === undefined ? undefined : `firma: ${extras.signature}`,
		extras.address === undefined ? undefined : `indirizzo: ${extras.address}`,
		extras.phone === undefined ? undefined : `telefono: ${extras.phone}`,
		extras.email === undefined ? undefined : `email: ${extras.email}`,
		extras.cf === undefined ? undefined : `codice fiscale: ${extras.cf}`,
		extras.rea === undefined ? undefined : `REA: ${extras.rea}`,
		extras.regime === undefined ? undefined : `regime: ${extras.regime}`,
	];
	return parts.filter((p) => p !== undefined).join("; ");
}

/** The saved company's other details, one per line, for set_company with nothing to set. */
export function extrasLines(company: Company): string {
	const lines = [
		company.ibans === undefined || company.ibans.length === 0 ? undefined : `IBAN: ${company.ibans.join(", ")}`,
		company.signature === undefined ? undefined : `Firma: ${company.signature}`,
		company.address === undefined ? undefined : `Indirizzo: ${company.address}`,
		company.phone === undefined ? undefined : `Telefono: ${company.phone}`,
		company.email === undefined ? undefined : `Email: ${company.email}`,
		company.cf === undefined ? undefined : `Codice fiscale: ${company.cf}`,
		company.rea === undefined ? undefined : `REA: ${company.rea}`,
		company.regime === undefined ? undefined : `Regime: ${company.regime}`,
	];
	return lines
		.filter((l) => l !== undefined)
		.map((l) => `\n${l}`)
		.join("");
}
