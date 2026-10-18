import type { InboundMail } from "../connectors/types.ts";
import type { LeadFields, MissingField, TenantSegreteriaConfig } from "../core/practice.ts";
import { checkVatNumber } from "../core/tax-ids.ts";
import { extractEmailAddress } from "./classify.ts";

const TITLE_RE = /\b(Dott\.ssa|Dott\.|Avv\.|Ing\.|Arch\.|Prof\.ssa|Prof\.|Geom\.|Rag\.)\s+/i;

/** What stands before a VAT number: «P.IVA:», «P. IVA n.», «partita IVA», «VAT number», «P.I.». */
const VAT_LABEL = /\b(?:p\.?\s?iva|partita\s+iva|vat(?:\s+number)?|p\.\s?i\.)(?:\s*n\.|\s+n(?=\s))?\s*[:\-]?\s*/gi;
/**
 * The number after the label: a country prefix in capitals, then digits with single spaces, dots
 * or dashes between, and the letters some countries add («IT 012 345 678 90», «ATU12345678»,
 * «NL123456789B01»). Bounded quantifiers, and digits only in one place: no runaway backtracking.
 */
const VAT_VALUE = /(?:[A-Z]{2}[ .\-]?)?[A-Z]{0,2}\d(?:[ .\-]?\d){4,15}(?:[A-Z][A-Z0-9]{0,2})?(?!\w)/y;

/** The VAT number a mail gives after its label, as written; null if none. */
export function findVatNumber(body: string): string | null {
	for (const label of body.matchAll(VAT_LABEL)) {
		VAT_VALUE.lastIndex = label.index + label[0].length;
		const value = VAT_VALUE.exec(body)?.[0];
		if (value !== undefined) return withoutTail(value);
	}
	return null;
}

/**
 * «01234567890 333 1234567»: a phone number on the same line runs into the VAT number. The
 * longest part up to a space that passes the formal check, else the whole run, to be flagged.
 */
function withoutTail(value: string): string {
	for (let end = value.length; end > 0; end = value.lastIndexOf(" ", end - 1)) {
		const checked = checkVatNumber(value.slice(0, end));
		if (checked !== undefined && "number" in checked) return value.slice(0, end);
	}
	return value;
}

/**
 * A VAT number from a mail, checked on paper (tax-ids.ts, never online): kept normalized when
 * written right, `invalid` when the check fails. A person's codice fiscale is neither.
 */
export function vatField(text: string | null): { readonly vatNumber: string | null; readonly invalid: boolean } {
	const checked = text === null ? undefined : checkVatNumber(text);
	if (checked === undefined) return { vatNumber: null, invalid: false };
	return "number" in checked ? { vatNumber: checked.number, invalid: false } : { vatNumber: null, invalid: true };
}

/** Heuristic lead extraction for tests / faux CI (no live model). */
export function extractLead(
	mail: InboundMail,
	tenantConfig: TenantSegreteriaConfig = {},
): LeadFields {
	const email = extractEmailAddress(mail.from) ?? null;
	const fromName = mail.fromName ?? (/^([^<]+)</.exec(mail.from)?.[1]?.trim() || undefined);
	let title: LeadFields["title"] = null;
	let fullName = fromName ?? null;
	const tm = fromName ? TITLE_RE.exec(fromName) : null;
	if (tm) {
		const t = tm[1]!;
		const normalized = (t.endsWith(".") ? t : `${t}.`) as LeadFields["title"];
		const canon = ["Dott.", "Dott.ssa", "Avv.", "Ing.", "Arch.", "Prof.", "Prof.ssa", "Geom.", "Rag."] as const;
		title = canon.find((c) => c.toLowerCase() === normalized!.toLowerCase()) ?? null;
		fullName = fromName!.replace(TITLE_RE, "").trim();
	}

	const body = mail.bodyText ?? "";
	const company =
		/(?:azienda|società|ditta|ragione sociale)\s*[:\-]\s*([^\n.]+)/i.exec(body)?.[1]?.trim() ??
		/([A-Z][A-Za-z0-9 &]+ (?:Srl|S\.r\.l\.|Spa|S\.p\.A\.|Ltd|GmbH))/i.exec(body)?.[1]?.trim() ??
		null;

	const product =
		/(?:preventivo|richiedo|vorrei|interessat[oa])\s+(?:per|di|su)?\s*([^\n.]{5,80})/i.exec(body)?.[1]?.trim() ??
		/(?:prodotto|servizio)\s*[:\-]\s*([^\n.]+)/i.exec(body)?.[1]?.trim() ??
		null;

	const quantity =
		/(?:quantità|n\.?\s*pezzi|n°)\s*[:\-]?\s*(\d+[^\n.]{0,20})/i.exec(body)?.[1]?.trim() ??
		/\b(\d+)\s*(?:pezzi|unità|stampanti|macchine|mq|metri)\b/i.exec(body)?.[1]?.trim() ??
		null;

	const urgency =
		/(?:entro|scadenza|urgente|consegna)\s+([^\n.]{3,40})/i.exec(body)?.[1]?.trim() ?? null;

	const vat = vatField(findVatNumber(body));

	const deliverySite =
		/(?:sede|consegna presso|installazione|indirizzo)\s*[:\-]?\s*([^\n.]{3,60})/i.exec(body)?.[1]?.trim();

	const budget = /budget/i.test(body) ? /budget[^\d]*(\d+[.,]?\d*)/i.exec(body)?.[1] : undefined;
	const hasBudgetMention = /budget/i.test(body);

	const lang: LeadFields["originalLanguage"] = detectLanguage(body);

	const missing: MissingField[] = [];
	if (!fullName) missing.push("fullName");
	if (!company) missing.push("company");
	if (!email) missing.push("email");
	if (!product) missing.push("productOrService");
	if (!quantity) missing.push("quantity");
	if (!deliverySite) missing.push("deliverySite");
	if (!hasBudgetMention) missing.push("budget");
	if (!urgency) missing.push("deadline");
	const isPrivate = !company;
	// A wrong VAT number is asked again whoever gave it; a missing one never from private customers.
	if (vat.invalid) missing.push("vatNumberInvalid");
	else if (tenantConfig.requireVatNumber && !isPrivate && !vat.vatNumber) missing.push("vatNumber");

	const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);

	return {
		fullName,
		title,
		company,
		email,
		phone: /(?:tel|cell|phone)\s*[:\-]?\s*([+\d][\d\s.]{7,})/i.exec(body)?.[1]?.trim() ?? null,
		productOrService: product,
		quantity,
		urgency,
		vatNumber: vat.vatNumber,
		originalLanguage: lang,
		missingFields: missing,
		source: "email",
		rawSubject: mail.subject,
		rawSnippet: snippet,
		receivedAt: mail.receivedAt,
		mailMessageId: mail.messageId,
	};
}

function detectLanguage(text: string = ""): LeadFields["originalLanguage"] {
	const it = (text.match(/\b(il|la|di|per|che|una|sono|grazie|richiedo|preventivo)\b/gi) ?? []).length;
	const en = (text.match(/\b(the|and|for|please|quote|request|would|thanks)\b/gi) ?? []).length;
	if (it > 0 && en > 0 && Math.min(it, en) / Math.max(it, en) > 0.4) return "it+en";
	if (en > it * 1.5) return "en";
	if (it === 0 && en === 0) return "other";
	return "it";
}
