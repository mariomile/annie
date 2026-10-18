/**
 * The riepilogo ore for a client, in Markdown for the same document makers the preventivi use
 * (quote-document.ts' letterhead and escaping: what the person wrote stays text, never a heading,
 * a link or a table cell of its own), and as a CSV for Excel (csv.ts). One row per billable
 * entry, oldest first: day, project, description, hours billed (h:mm) and, when the entries have
 * rates, rate and amount; then the totals, the hours also in decimals. With no rate at all the
 * report is of hours only: no rate or amount column, never 0,00 €. Amounts are VAT excluded.
 */
import { type CsvCell, csvCents, csvFile } from "../csv.ts";
import { hm } from "../durations.ts";
import type { Company } from "../invoices.ts";
import { italianDate } from "../italian-format.ts";
import { type Period, spanText } from "../periods.ts";
import { hoursHundredths, type Priced, rateCents } from "../timesheet-sums.ts";
import { lead, letterhead, md } from "./quote-document.ts";
import { euros } from "./quote-render.ts";
import { rateText } from "./timesheet-render.ts";

export type ReportTotals = {
	/** Minutes billed (rounded where the client has a rounding). */
	readonly minutes: number;
	readonly amount: bigint;
	/** Rows without a rate: all of them in a report of hours only, none otherwise. */
	readonly unpriced: number;
	readonly roundings: readonly number[];
};

export function reportTotals(rows: readonly Priced[]): ReportTotals {
	const roundings = [...new Set(rows.map((r) => r.rounding).filter((r) => r > 0))].sort((a, b) => a - b);
	return { minutes: rows.reduce((s, r) => s + r.billed, 0), amount: rows.reduce((s, r) => s + (r.amount ?? 0n), 0n), unpriced: rows.filter((r) => r.rate === undefined).length, roundings };
}

/** Whether the report has amounts: every row has a rate (the tool refuses a report where only some have one). */
export function withAmounts(rows: readonly Priced[]): boolean {
	return rows.every((r) => r.rate !== undefined);
}

/** «3,00» hours: minutes in hours with two decimals, half up. */
export function decimalHours(minutes: number): string {
	return csvCents(hoursHundredths(minutes)).number;
}

/** The report's document: letterhead, title, client, period and date, the table, the totals and the notes. */
export function reportMarkdown(client: string, period: Period, rows: readonly Priced[], company: Partial<Company>, today: string): string {
	const t = reportTotals(rows);
	const money = withAmounts(rows);
	const out: string[] = [];
	const head = letterhead(company);
	if (head.length > 0) out.push(head.join("\n"), "");
	out.push("# Riepilogo ore", "");
	out.push([`**Cliente:** ${md(client)}`, `**Periodo:** ${period.label} (${spanText(period.from, period.to)})`, `**Data:** ${italianDate(today)}`].join("  \n"), "");
	out.push("## Dettaglio", "");
	out.push(money ? "| Data | Progetto | Descrizione | Ore | Tariffa | Importo |" : "| Data | Progetto | Descrizione | Ore |", money ? "|---|---|---|---:|---:|---:|" : "|---|---|---|---:|");
	for (const r of rows) {
		const e = r.entry;
		const cells = [italianDate(e.date), e.project === undefined ? "" : lead(md(e.project)), e.description === undefined ? "" : lead(md(e.description)), hm(r.billed), ...(money ? [rateText(r.rate as string), euros(r.amount ?? 0n)] : [])];
		out.push(`| ${cells.join(" | ")} |`);
	}
	out.push("", "## Totale", "", "| Voce | Totale |", "|---|---:|");
	out.push(`| **Ore** | **${hm(t.minutes)}** (${decimalHours(t.minutes)} h) |`);
	if (money) out.push(`| **Importo** | **${euros(t.amount)}** |`);
	out.push("");
	if (t.roundings.length > 0) out.push(`Ore arrotondate per voce ai ${t.roundings.join(" o ")} minuti superiori.`, "");
	if (money) out.push("Importi IVA esclusa.", "");
	if (company.signature !== undefined) out.push(company.signature.split("\n").map((x) => lead(md(x))).join("\n"), "");
	return `${out.join("\n").trim()}\n`;
}

/** The report as a CSV for Excel: one row per entry, the totals at the end; rate and amount only when the entries have rates. */
export function reportCsv(rows: readonly Priced[]): string {
	const t = reportTotals(rows);
	const money = withAmounts(rows);
	const lines = rows.map((r): CsvCell[] => [
		italianDate(r.entry.date),
		r.entry.id,
		r.entry.project ?? "",
		(r.entry.description ?? "").replace(/\n/g, " "),
		hm(r.billed),
		{ number: decimalHours(r.billed) },
		...(money ? [csvCents(rateCents(r.rate as string)), csvCents(r.amount ?? 0n)] : []),
	]);
	lines.push(["", "Totale", "", "", hm(t.minutes), { number: decimalHours(t.minutes) }, ...(money ? ["", csvCents(t.amount)] : [])]);
	return csvFile(["Data", "Rif.", "Progetto", "Descrizione", "Ore (h:mm)", "Ore (decimali)", ...(money ? ["Tariffa €/h", "Importo €"] : [])], lines);
}
