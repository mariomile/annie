/**
 * The document of a preventivo, in Markdown for document_create's makers: the company's
 * letterhead, the title, customer, items, totals, acconto, delivery, terms, IBAN, signature and a
 * «Per accettazione» line. Everything the person or a customer wrote is escaped, so it stays text:
 * it never opens a heading, a list, a link or a table cell. When every line is at 0% the VAT
 * column and rows go, and the reasons are a footnote.
 */
import type { Company } from "../invoices.ts";
import { italianDate } from "../italian-format.ts";
import { type Quote, validUntil } from "../quotes.ts";
import { BOLLO_THRESHOLD_CENTS, decimalText, RITENUTA_RATE } from "../quote-sums.ts";
import { lead, letterhead, md } from "../markdown-text.ts";
import { depositText, euros, priceText, quantityText, totalsOf } from "./quote-render.ts";


const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

export function quoteMarkdown(quote: Quote, company: Partial<Company>): string {
	const t = totalsOf(quote);
	const zero = quote.lines.every((l) => l.vat === 0);
	const gross = quote.pricesIncludeVat === true;
	const out: string[] = [];
	const head = letterhead(company);
	if (head.length > 0) out.push(head.join("\n"), "");
	out.push(`# Preventivo n. ${quote.base}${quote.revision === 0 ? "" : ` (rev. ${quote.revision})`}`, "");
	out.push(`Data: ${italianDate(quote.date)}\nValido fino al: ${italianDate(validUntil(quote))} (${quote.validDays} giorni)`, "");
	const c = quote.customer;
	const ids = [...(c.vat === undefined ? [] : [`P.IVA ${c.vat}`]), ...(c.fiscal === undefined ? [] : [`C.F. ${c.fiscal}`])];
	out.push("## Cliente", "", [`**${md(c.name)}**`, ...ids.map((x) => lead(md(x))), ...(c.address === undefined ? [] : [lead(md(c.address))]), ...(c.email === undefined ? [] : [lead(md(c.email))])].join("\n"), "");

	out.push("## Dettaglio", "");
	const discounted = quote.lines.some((l) => l.discount !== undefined);
	const columns = ["Descrizione", "Quantità", gross ? "Prezzo IVA incl." : "Prezzo unitario", ...(discounted ? ["Sconto"] : []), ...(zero ? [] : ["IVA"]), gross ? "Importo IVA incl." : "Importo"];
	out.push(`| ${columns.join(" | ")} |`, `|---|${columns.slice(1).map(() => "---:").join("|")}|`);
	quote.lines.forEach((line, i) => {
		const cells = [lead(md(line.description)), lead(md(quantityText(line))), priceText(line.price), ...(discounted ? [line.discount === undefined ? "" : `${decimalText(line.discount)}%`] : []), ...(zero ? [] : [`${line.vat}%`]), euros(t.lines[i] as bigint)];
		out.push(`| ${cells.join(" | ")} |`);
	});

	out.push("", "## Totali", "", "| Voce | Importo |", "|---|---:|");
	if (quote.cassa !== undefined) {
		out.push(`| Totale voci | ${euros(t.rates.reduce((s, r) => s + r.lines, 0n))} |`);
		out.push(`| ${lead(md(quote.cassa.label))} | ${euros(t.cassa)} |`);
	}
	if (!zero) {
		for (const r of t.rates) out.push(`| ${r.rate === 0 ? "Imponibile senza IVA" : `Imponibile IVA ${r.rate}%`} | ${euros(r.taxable)} |`);
		for (const r of t.rates.filter((x) => x.rate !== 0)) out.push(`| IVA ${r.rate}% | ${euros(r.vat)} |`);
	}
	if (t.bollo > 0n) out.push(`| Imposta di bollo | ${euros(t.bollo)} |`);
	out.push(`| **Totale** | **${euros(t.total)}** |`);
	if (t.ritenuta > 0n) out.push(`| Ritenuta d'acconto ${RITENUTA_RATE}% | \\-${euros(t.ritenuta)} |`, `| **Netto a pagare** | **${euros(t.net)}** |`);
	out.push("");
	if (quote.deposit !== undefined) out.push(`${lead(md(depositText(quote.deposit, t)))}.`, "");

	const reasons = [...new Set(quote.lines.filter((l) => l.vat === 0).map((l) => l.vatNote as string))];
	if (zero) for (const r of reasons) out.push(lead(md(sentence(r))), "");
	else if (reasons.length > 0) out.push(`IVA 0: ${reasons.map(md).join("; ")}.`, "");
	if (t.bollo > 0n) out.push(`Imposta di bollo di ${euros(t.bollo)} a carico del cliente (importi senza IVA oltre ${euros(BOLLO_THRESHOLD_CENTS)}).`, "");
	if (quote.delivery !== undefined) out.push(`**Tempi di consegna:** ${md(quote.delivery)}`, "");
	if (quote.terms !== undefined) out.push(`**Condizioni di pagamento:** ${md(quote.terms)}`, "");
	const iban = company.ibans?.[0];
	if (iban !== undefined) out.push(`IBAN: ${md(iban)}`, "");
	if (quote.notes !== undefined) out.push(`**Note:** ${md(quote.notes)}`, "");
	if (company.signature !== undefined) out.push(company.signature.split("\n").map((x) => lead(md(x))).join("\n"), "");
	out.push("**Per accettazione**", "", md("Data ____________   Timbro e firma ________________________"), "");
	return `${out.join("\n").trim()}\n`;
}
