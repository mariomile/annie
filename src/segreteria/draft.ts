import type { LeadFields, MissingField } from "../core/practice.ts";

export type DraftResult = {
	readonly subject: string;
	readonly body: string;
	readonly language: "it" | "en";
};

const ASK: Record<MissingField, { it: string; en: string }> = {
	fullName: {
		it: "Può indicarci il nominativo del referente?",
		en: "Could you please share the contact person's name?",
	},
	company: {
		it: "Può indicarci la ragione sociale dell'azienda?",
		en: "Could you please share the company name?",
	},
	email: {
		it: "Può indicarci un indirizzo email di riferimento?",
		en: "Could you please share a contact email address?",
	},
	productOrService: {
		it: "Può indicarci quale prodotto o servizio Le interessa?",
		en: "Could you please clarify which product or service you need?",
	},
	quantity: {
		it: "Può indicarci la quantità richiesta?",
		en: "Could you please indicate the required quantity?",
	},
	deliverySite: {
		it: "Può indicarci la sede di installazione o il luogo di consegna?",
		en: "Could you please indicate the delivery or installation site?",
	},
	vatNumber: {
		it: "Può indicarci la partita IVA per i dati di fatturazione?",
		en: "Could you please share the VAT number for invoicing?",
	},
	budget: {
		it: "Può indicarci se ha un intervallo di budget di riferimento?",
		en: "Could you please share a budget range, if any?",
	},
	deadline: {
		it: "Può indicarci entro quando Le serve la fornitura?",
		en: "Could you please share the desired timeline?",
	},
};

const FEMALE_FIRST =
	/^(Maria|Anna|Giulia|Sara|Laura|Elena|Francesca|Paola|Chiara|Martina|Alessandra|Valentina|Silvia|Rita|Irene|Marta|Elisa|Sofia|Giada|Federica)$/i;
const MALE_FIRST =
	/^(Marco|Luca|Paolo|Andrea|Giovanni|Matteo|Francesco|Alessandro|Davide|Stefano|Roberto|Mario|Giuseppe|Antonio|Simone|Fabio|Daniele|Michele|James|John|Robert|William|Michael)$/i;

function surnameFrom(fullName: string | null | undefined): { first: string; surname: string; onlyFirst: boolean } {
	const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { first: "", surname: "", onlyFirst: true };
	if (parts.length === 1) return { first: parts[0]!, surname: "", onlyFirst: true };
	return { first: parts[0]!, surname: parts.slice(1).join(" "), onlyFirst: false };
}

function formalItSalutation(lead: LeadFields): string {
	const { first, surname, onlyFirst } = surnameFrom(lead.fullName);
	if (lead.title) {
		const who = surname || first || "Cliente";
		return `Gentile ${lead.title} ${who}`.replace(/\s+/g, " ").trim();
	}
	if (onlyFirst || !surname) {
		// Never open with first name alone ("Luca,") — gold mustNotMention.
		return "Gentile Cliente";
	}
	const female = FEMALE_FIRST.test(first) || (/a$/i.test(first) && !MALE_FIRST.test(first));
	return `Gentile ${female ? "Signora" : "Signor"} ${surname}`;
}

function formalEnSalutation(lead: LeadFields): string {
	const { first, surname, onlyFirst } = surnameFrom(lead.fullName);
	if (onlyFirst || !surname) return "Dear Customer";
	const female = FEMALE_FIRST.test(first) || (/a$/i.test(first) && !MALE_FIRST.test(first));
	return `Dear ${female ? "Ms" : "Mr"} ${surname}`;
}

function formalSubject(raw: string, language: "it" | "en"): string {
	const cleaned = raw
		.replace(/\bciao\b/gi, "")
		.replace(/\bhey\b/gi, "")
		.replace(/\bhi\b/gi, "")
		.replace(/^\s*,\s*/, "")
		.replace(/\s{2,}/g, " ")
		.trim();
	const base = cleaned || (language === "it" ? "Richiesta di informazioni" : "Enquiry");
	return `Re: ${base}`;
}

/** Build a formal draft (lei / formal EN) without inventing prices. Deterministic for CI. */
export function buildDraft(
	lead: LeadFields,
	options: {
		mustAsk?: readonly MissingField[];
		requests?: readonly string[];
		allowedAmounts?: readonly string[];
		language?: "it" | "en";
	} = {},
): DraftResult {
	const language = options.language ?? (lead.originalLanguage === "en" ? "en" : "it");
	const mustAsk = options.mustAsk ?? lead.missingFields;
	const companyLine = lead.company ? (language === "it" ? ` per ${lead.company}` : ` for ${lead.company}`) : "";
	const product = lead.productOrService ?? (language === "it" ? "la Sua richiesta" : "your request");
	const subject = formalSubject(lead.rawSubject, language);
	const items = options.requests ?? [];

	if (language === "en") {
		const asks = mustAsk.map((f) => ASK[f]?.en).filter(Boolean);
		const list =
			items.length > 1
				? `\n\nWe noted the following items:\n${items.map((r) => `- ${r}`).join("\n")}\n\nWhich item would you like us to prioritize?\n`
				: "";
		const body = `${formalEnSalutation(lead)},

thank you for your enquiry${companyLine}. We have received your request regarding ${product}.${list}
${asks.length ? `\nTo prepare an accurate quote, ${asks.join(" ")}\n` : "\n"}
We remain at your disposal.
Kind regards
[Sales contact] · [Company]`;
		return { subject, body: scrubPii(body, lead), language };
	}

	const asks = mustAsk.map((f) => ASK[f]?.it).filter(Boolean);
	const list =
		items.length > 1
			? `\n\nAbbiamo preso nota delle seguenti voci:\n${items.map((r) => `- ${r}`).join("\n")}\n\nDa quale prodotto o servizio preferisce che partiamo in priorità?\n`
			: "";
	const body = `${formalItSalutation(lead)},

La ringraziamo per la richiesta${companyLine}. Abbiamo preso in carico la domanda relativa a ${product}.${list}
${asks.length ? `\nPer prepararle un preventivo accurato, ${asks.join(" ")}\n` : "\n"}
Restiamo a disposizione.
Cordiali saluti
[Nome commerciale] · [Azienda]`;

	return { subject, body: scrubPii(body, lead), language };
}

/** Strip phones, IBAN, CF, street addresses, customer email from draft (A7). */
export function scrubPii(body: string, lead: LeadFields): string {
	let out = body;
	if (lead.email) {
		out = out.split(lead.email).join("");
	}
	out = out.replace(/(?:\+39[\s.]?)?\b3\d{2}[\s.]?\d{3}[\s.]?\d{3,4}\b/g, "");
	out = out.replace(/\b0\d{1,3}[\s.]?\d{5,8}\b/g, "");
	out = out.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "");
	out = out.replace(/\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/gi, "");
	out = out.replace(/\b(?:via|viale|piazza|corso|vicolo|largo|strada)\s+[A-Za-zÀ-ú' ]{2,40}\s*,?\s*\d{1,4}\b/gi, "");
	out = out.replace(/\b\d{11}\b/g, "");
	return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
}

/** Apply a free-text commercial edit instruction (or full paste). */
export function applyEdit(previous: DraftResult, instruction: string): DraftResult {
	const trimmed = instruction.trim();
	if (trimmed.length > 200 && /gentile|dear |cordiali|kind regards/i.test(trimmed)) {
		return { ...previous, body: trimmed };
	}
	const note =
		previous.language === "en"
			? `\n\n(Update per your sales note: ${trimmed.slice(0, 280)})\n`
			: `\n\n(Nota di aggiornamento: ${trimmed.slice(0, 280)})\n`;
	return {
		...previous,
		body: previous.body.replace(/\nRestiamo a disposizione\.|\nWe remain at your disposal\./, `${note}\nRestiamo a disposizione.`),
	};
}
