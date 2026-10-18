/**
 * The riepilogo ore for a client, in Markdown for the same document makers the preventivi use
 * (quote-document.ts' letterhead and escaping: what the person wrote stays text, never a heading,
 * a link or a table cell of its own), and as a CSV for Excel (csv.ts). One row per billable
 * entry, oldest first: day, project, description, hours billed (h:mm), rate, amount; then the
 * totals. Amounts are VAT excluded.
 */
import { type CsvCell, csvCents, csvFile } from "../csv.ts";
import { hm } from "../durations.ts";
import type { Company } from "../invoices.ts";
import { italianDate } from "../italian-format.ts";
import type { Period } from "../periods.ts";
import { type Priced, rateCents } from "../timesheet-sums.ts";
import { lead, letterhead, md } from "./quote-document.ts";
import { euros } from "./quote-render.ts";
import { rateText } from "./timesheet-render.ts";

export type ReportTotals = { readonly minutes: number; readonly amount: bigint; readonly unpriced: number; readonly roundings: readonly number[] };

export function reportTotals(rows: readonly Priced[]): ReportTotals {
	const roundings = [...new Set(rows.map((r) => r.rounding).filter((r) => r > 0))].sort((a, b) => a - b);
	return { minutes: rows.reduce((s, r) => s + r.billed, 0), amount: rows.reduce((s, r) => s + (r.amount ?? 0n), 0n), unpriced: rows.filter((r) => r.rate === undefined).length, roundings };
}

/** The report's document: letterhead, title, client and period, the table, the totals and the notes. */
export function reportMarkdown(client: string, period: Period, rows: readonly Priced[], company: Partial<Company>): string {
	const t = reportTotals(rows);
	const out: string[] = [];
	const head = letterhead(company);
	if (head.length > 0) out.push(head.join("\n"), "");
	out.push("# Riepilogo ore", "");
	out.push(`**Cliente:** ${md(client)}\nPeriodo: ${period.label} (dal ${italianDate(period.from)} al ${italianDate(period.to)})`, "");
	out.push("## Dettaglio", "");
	out.push("| Data | Progetto | Descrizione | Ore | Tariffa | Importo |", "|---|---|---|---:|---:|---:|");
	for (const r of rows) {
		const e = r.entry;
		const cells = [italianDate(e.date), e.project === undefined ? "" : lead(md(e.project)), e.description === undefined ? "" : lead(md(e.description)), hm(r.billed), r.rate === undefined ? "—" : rateText(r.rate), r.amount === undefined ? "—" : euros(r.amount)];
		out.push(`| ${cells.join(" | ")} |`);
	}
	out.push("", "## Totali", "", "| Voce | Totale |", "|---|---:|");
	out.push(`| Ore | ${hm(t.minutes)} |`);
	out.push(`| **Importo (IVA esclusa)** | **${euros(t.amount)}** |`, "");
	if (t.roundings.length > 0) out.push(`Ore arrotondate per voce ai ${t.roundings.join(" o ")} minuti superiori.`, "");
	if (t.unpriced > 0) out.push(`${t.unpriced === 1 ? "Una voce è" : `${t.unpriced} voci sono`} senza tariffa e non ${t.unpriced === 1 ? "è contata" : "sono contate"} nell'importo.`, "");
	out.push("Importi IVA esclusa.", "");
	if (company.signature !== undefined) out.push(company.signature.split("\n").map((x) => lead(md(x))).join("\n"), "");
	return `${out.join("\n").trim()}\n`;
}

/** The report as a CSV for Excel: one row per entry, the totals at the end. */
export function reportCsv(rows: readonly Priced[]): string {
	const t = reportTotals(rows);
	const lines = rows.map((r): CsvCell[] => [
		italianDate(r.entry.date),
		r.entry.id,
		r.entry.project ?? "",
		(r.entry.description ?? "").replace(/\n/g, " "),
		hm(r.billed),
		{ number: (r.billed / 60).toFixed(2).replace(".", ",") },
		r.rate === undefined ? "" : csvCents(rateCents(r.rate)),
		r.amount === undefined ? "" : csvCents(r.amount),
	]);
	lines.push(["", "Totale", "", "", hm(t.minutes), { number: (t.minutes / 60).toFixed(2).replace(".", ",") }, "", csvCents(t.amount)]);
	return csvFile(["Data", "Rif.", "Progetto", "Descrizione", "Ore (h:mm)", "Ore (decimali)", "Tariffa €/h", "Importo €"], lines);
}
