/**
 * The business report in the chat and in a CSV: short, phone length, amounts the Italian way,
 * dates in words. The summary, a comparison (the three biggest changes first), a trend by month,
 * the ranking, the brief's line. Every answer with taxes says they are an estimate to check with
 * the commercialista. Names of clients, categories and suppliers go only inside one fence per
 * answer; the comparison and the trend carry none, the summary only the payments that may be
 * counted twice, and never for another agente (who reads it). An empty register
 * is said in one line, never shown as zeros. The CSV is made inert by csvFile.
 */
import { type Figures, type MoneyKey, type Receivables, REPORT_LIMITS, type Span, type TaxPart } from "../business-report.ts";
import { biggest, type Delta } from "../business-report-compare.ts";
import type { Presence } from "../business-report-sums.ts";
import type { TopClients } from "../business-report-top.ts";
import { type CsvCell, csvCents, csvFile } from "../csv.ts";
import { hm, hoursText } from "../durations.ts";
import { type CategoryTotal, cents as expenseCents } from "../expense-sums.ts";
import { euros, n1 } from "../format-words.ts";
import { partyName } from "../invoices.ts";
import { daysInMonth, MONTH_NAMES } from "../italian-calendar.ts";
import { capitalized, signOf, withDate, withPercent } from "../italian-format.ts";
import { fenced } from "./business-report-input.ts";

/** Said once in every answer that shows taxes. */
export const TAX_NOTE = "Le tasse sono una stima: verificale con il commercialista.";
const REPEAT = "Ripeti cifre e date come sono scritte, non rifare i conti a mente.";

const lastDay = (from: string) => `${from.slice(0, 8)}${String(daysInMonth(Number(from.slice(0, 4)), Number(from.slice(5, 7)))).padStart(2, "0")}`;
const monthLabel = (day: string) => `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

/** «ottobre 2026», «ottobre 2026 fino al 18», «3º trimestre 2026», «2026», «dal 1º gennaio al 18 ottobre 2026». */
export function spanWords(span: Span): string {
	const { from, to } = span;
	const year = from.slice(0, 4);
	const firstOfMonth = from.slice(8) === "01";
	if (firstOfMonth && from.slice(0, 7) === to.slice(0, 7)) return to === lastDay(from) ? monthLabel(from) : `${monthLabel(from)} fino al ${Number(to.slice(8)) === 1 ? "1º" : Number(to.slice(8))}`;
	if (from === `${year}-01-01` && to === `${year}-12-31`) return year;
	const month = Number(from.slice(5, 7));
	if (firstOfMonth && (month - 1) % 3 === 0 && to === lastDay(`${year}-${String(month + 2).padStart(2, "0")}-01`)) return `${(month + 2) / 3}º trimestre ${year}`;
	const start = withDate("dal", from);
	const short = from.slice(0, 7) === to.slice(0, 7) ? start.replace(/ \S+ \d{4}$/, "") : from.slice(0, 4) === to.slice(0, 4) ? start.replace(/ \d{4}$/, "") : start;
	return `${short} ${withDate("al", to)}`;
}

/** A month of a trend: «novembre 2025», «ottobre 2026 (fino al 18)». */
function monthWords(span: Span): string {
	return span.to === lastDay(span.from) ? monthLabel(span.from) : `${monthLabel(span.from)} (fino al ${Number(span.to.slice(8)) === 1 ? "1º" : Number(span.to.slice(8))})`;
}

/** The ordinario's taxes are the IVA only: what is left after them is not in the pocket yet. */
const ordinario = (f: Figures) => f.tasse?.kind === "iva";
/** What is left after the taxes, said honestly: in the pocket for the forfettario; for the ordinario after the IVA only. */
export const AFTER_IVA = "prima di IRPEF e contributi, che non stimo";

function label(key: MoneyKey, f: Figures): string {
	if (key === "inTasca") return ordinario(f) ? "dopo l'IVA" : "ti resta in tasca";
	return { fatturato: "fatturato", incassato: "incassato", spese: "spese", margine: "margine", tasse: "tasse stimate" }[key];
}

function taxLine(t: TaxPart): string {
	switch (t.kind) {
		case "forfettario":
			return `• Tasse e contributi da accantonare: ${euros(t.cents)}${t.percent === undefined ? "" : `, circa ${withPercent("il", t.percent)} di ogni incasso`}`;
		case "iva":
			return t.credit ? "• IVA: nel periodo è a credito, niente da versare (IRPEF e contributi non stimati)" : `• IVA da versare: ${euros(t.cents)} (IRPEF e contributi non stimati)`;
		case "none":
			return "• Tasse: non stimate (il perché è in fondo).";
	}
}

/** Why the taxes are not estimated: said once, after the figures. */
function noTaxWhy(why: Extract<TaxPart, { kind: "none" }>["why"]): string {
	return `Tasse non stimate: ${noTaxReason(why)}`;
}

function noTaxReason(why: Extract<TaxPart, { kind: "none" }>["why"]): string {
	switch (why) {
		case "no_regime":
			return "non so se chi ti scrive è nel forfettario o nell'ordinario: chiediglielo; per il forfettario serve il suo profilo delle tasse (taxes op set_profile), per l'ordinario il regime nei dati dell'azienda (invoices op set_company).";
		case "no_profile":
			return "manca il profilo delle tasse del forfettario: chiedi a chi ti scrive la sua attività e la cassa previdenziale e salvalo con taxes op set_profile.";
		case "unreadable_taxes":
			return "il profilo delle tasse non si legge.";
		case "unreadable_vat":
			return "la liquidazione IVA non si legge.";
		case "unreadable_invoices":
			return "lo stato delle fatture non si legge.";
	}
}

/** The lines of a span's figures; an empty register in one line. */
function figureLines(f: Figures, presence: Presence): string[] {
	const lines: string[] = [];
	if (!presence.invoices) lines.push("• Fatture: nessuna nei registri, quindi niente fatturato né incassi.");
	else {
		if (f.fatturato !== undefined) {
			const parts = [n1(f.fatturato.count, "1 fattura", "# fatture"), ...(f.fatturato.credits === 0 ? [] : [n1(f.fatturato.credits, "1 nota di credito", "# note di credito")])];
			lines.push(`• Fatturato: ${euros(f.fatturato.cents)} di imponibile (${parts.join(", ")})`);
		}
		if (f.incassato !== undefined) lines.push(`• Incassato: ${euros(f.incassato)}`);
	}
	if (!presence.expenses) lines.push("• Spese: nessuna registrata.");
	else if (f.spese !== undefined) {
		const parts = [n1(f.spese.expenses, "1 spesa registrata", "# spese registrate"), ...(f.spese.suppliers === 0 ? [] : [n1(f.spese.suppliers, "1 fattura di fornitore pagata", "# fatture di fornitori pagate")])];
		lines.push(`• Spese: ${euros(f.spese.cents)} (${parts.join(", ")})`);
	}
	if (f.margine !== undefined) lines.push(`• Margine: ${euros(f.margine)}${presence.expenses ? "" : " (senza spese registrate)"}`);
	if (f.tasse !== undefined && presence.invoices) lines.push(taxLine(f.tasse));
	if (f.inTasca !== undefined && presence.invoices) lines.push(ordinario(f) ? `• Dopo l'IVA: ${euros(f.inTasca)} (${AFTER_IVA})` : `• Ti resta in tasca: ${euros(f.inTasca)}`);
	if (presence.entries && f.ore !== undefined) lines.push(f.ore.minutes === 0 ? "• Ore: nessuna registrata nel periodo." : `• Ore lavorate: ${hoursText(f.ore.minutes)}${f.ore.perHour === undefined ? "" : `; fatturato diviso le ore registrate: ${euros(f.ore.perHour)} l'ora`}`);
	if (presence.quotes && f.preventivi !== undefined) {
		const p = f.preventivi;
		const open = p.made - p.accepted - p.declined;
		lines.push(p.made === 0 ? "• Preventivi: nessuno fatto nel periodo." : `• Preventivi: ${n1(p.made, "1 fatto", "# fatti")}, ${n1(p.accepted, "1 accettato", "# accettati")} (${withPercent("il", Math.round((p.accepted * 100) / p.made))})${p.declined === 0 ? "" : `, ${n1(p.declined, "1 rifiutato", "# rifiutati")}`}${open === 0 ? "" : `, ${n1(open, "1 aperto", "# aperti")}`}`);
	}
	return lines;
}

/** «incassati 1.220,00 €, spese 400,00 €, margine 820,00 €, ti restano 620,00 €» (the ordinario: «dopo l'IVA 620,00 €, prima di IRPEF e contributi, che non stimo»): a span in one line. */
function shortLine(f: Figures): string {
	const parts: string[] = [];
	if (f.incassato !== undefined) parts.push(`incassati ${euros(f.incassato)}`);
	if (f.spese !== undefined) parts.push(`spese ${euros(f.spese.cents)}`);
	if (f.margine !== undefined) parts.push(`margine ${euros(f.margine)}`);
	if (f.inTasca !== undefined) parts.push(ordinario(f) ? `dopo l'IVA ${euros(f.inTasca)}, ${AFTER_IVA}` : `ti restano ${euros(f.inTasca)}`);
	return parts.join(", ");
}

function receivablesLine(r: Receivables): string {
	if (r.open === 0n) return "Ancora da incassare: niente.";
	return `Ancora da incassare: ${euros(r.open)}${r.overdue === 0n ? ", niente di scaduto" : `, di cui ${euros(r.overdue)} scaduti (${n1(r.overdueCount, "1 rata", "# rate")})`}.`;
}

export const EMPTY = "Per l'andamento dell'attività non ho ancora niente: nei registri non ci sono fatture, spese, ore o preventivi. Quando ci sono fatture nel workspace o spese registrate, te lo dico.";

const hasTaxes = (f: Figures) => f.tasse !== undefined && f.tasse.kind !== "none";

/** `named`: the person asked (names may go in the fence); another agente gets the numbers only. */
export type SummaryView = { readonly main: Figures; readonly ytd?: Figures; readonly receivables?: Receivables; readonly presence: Presence; readonly notes: readonly string[]; readonly named: boolean };

/** At most this many payments that may be counted twice are named, then «e altri N». */
const MAYBE_SHOWN = 3;

/** The supplier payments an expense with another name may be: both counted, said; the names only inside the fence, and never to another agente. */
function maybeLines(f: Figures, named: boolean): string[] {
	const list = f.spese?.maybe ?? [];
	if (list.length === 0) return [];
	if (!named) return [`${n1(list.length, "Un pagamento a un fornitore forse è contato due volte", "# pagamenti a fornitori forse sono contati due volte")}: una spesa registrata e una fattura di fornitore pagata.`];
	const rows = list.slice(0, MAYBE_SHOWN).map((t) =>
		t.why === "partial"
			? `la spesa «${t.expense.supplier ?? t.expense.id}» ${withDate("del", t.expense.date)} (${euros(expenseCents(t.expense.amount))}), forse un acconto della rata di ${euros(t.paid.cents)} della fattura${t.paid.invoice.doc.number === undefined ? "" : ` ${t.paid.invoice.doc.number}`} di ${partyName(t.paid.invoice.supplier)}`
			: `la spesa «${t.expense.supplier ?? t.expense.id}» ${withDate("del", t.expense.date)} e la fattura di ${partyName(t.paid.invoice.supplier)} (${euros(t.paid.cents)})`,
	);
	if (list.length > MAYBE_SHOWN) rows.push(`e altri ${list.length - MAYBE_SHOWN}`);
	return [`Forse è lo stesso pagamento, contato due volte (nel riquadro): chiedi a chi ti scrive.`, fenced(rows.join("\n"))];
}

export function summaryAnswer(v: SummaryView): string {
	const lines = [`${capitalized(spanWords(v.main.span))}:`, ...figureLines(v.main, v.presence), ...maybeLines(v.main, v.named)];
	if (v.ytd !== undefined) {
		const line = shortLine(v.ytd);
		if (line !== "") lines.push(`${capitalized(spanWords(v.ytd.span))}: ${line}.`);
	}
	if (v.receivables !== undefined && v.presence.invoices) lines.push(receivablesLine(v.receivables));
	lines.push(...v.notes);
	if (v.main.tasse?.kind === "none" && v.presence.invoices) lines.push(noTaxWhy(v.main.tasse.why));
	if (v.presence.invoices && (hasTaxes(v.main) || (v.ytd !== undefined && hasTaxes(v.ytd)))) lines.push(TAX_NOTE);
	lines.push(REPEAT);
	return lines.join("\n");
}

/** «+549,00 € (+56,3%)»; no percent when it would mislead: «+1.209,00 € (da −100,00 € a 1.109,00 €)»; from zero, the change alone. */
function deltaText(d: Delta): string {
	const change = `${d.diff > 0n ? signOf(false) : ""}${euros(d.diff)}`;
	if (d.percent !== undefined) return `${change} (${d.percent})`;
	return d.before === 0n ? change : `${change} (da ${euros(d.before)} a ${euros(d.now)})`;
}

/** «a» before a word, «ad» only before an «a» (as periods.ts writes it): «ad agosto», «a ottobre». */
const toWord = (w: string) => (w.startsWith("a") ? `ad ${w}` : `a ${w}`);

/** When the figures before were: «a settembre 2026», «nel 3º trimestre 2026», «nel 2025», «dal 1º al 18 settembre 2026». */
function whenWords(span: Span): string {
	const w = spanWords(span);
	if (w.startsWith("dal ") || w.startsWith("dall'")) return w;
	if (/^\d{4}$/.test(w) || w.includes("trimestre")) return `nel ${w}`;
	return toWord(w);
}

/** What a period is compared with: «rispetto ad agosto 2026», «rispetto al 2025», «rispetto al 2º trimestre 2026», «rispetto ai giorni dal 21 al 30 settembre 2026». */
function againstWords(span: Span): string {
	const w = spanWords(span);
	if (w.startsWith("dal ") || w.startsWith("dall'")) return `rispetto ai giorni ${w}`;
	if (/^\d{4}$/.test(w) || w.includes("trimestre")) return `rispetto al ${w}`;
	return `rispetto ${toWord(w)}`;
}

export type CompareView = { readonly now: Figures; readonly before: Figures; readonly deltas: readonly Delta[]; readonly biggest: readonly Delta[]; readonly presence: Presence; readonly notes: readonly string[] };

export function compareAnswer(v: CompareView): string {
	const lines = [`${capitalized(spanWords(v.now.span))} ${againstWords(v.before.span)}:`];
	if (!v.presence.invoices && !v.presence.expenses) return [lines[0], "Nei registri non ci sono né fatture né spese: non c'è niente da confrontare.", ...v.notes].join("\n");
	const at = (key: MoneyKey) => v.deltas.find((d) => d.key === key);
	const inc = at("incassato");
	const out = at("spese");
	// No incassi nor spese before: said once, with what there is now; the margine and what is left come from them.
	const empty = inc !== undefined && out !== undefined && inc.before === 0n && out.before === 0n && (inc.now !== 0n || out.now !== 0n);
	// What else changed: the fatturato and the taxes (incassi and spese are said, the rest comes from them).
	const rest = empty ? biggest(v.deltas.filter((d) => d.key === "fatturato" || d.key === "tasse")) : v.biggest;
	if (empty) {
		const year = v.before.span.from.slice(0, 4);
		const nowWhen = whenWords(v.now.span);
		const when = v.now.span.from.slice(0, 4) === year ? nowWhen.replace(new RegExp(` ${year}$`), "") : nowWhen;
		lines.push(`${capitalized(whenWords(v.before.span))} non c'erano incassi né spese; ${when}: incassati ${euros(inc.now)}, spese ${euros(out.now)}.`);
		const only = rest[0];
		if (rest.length === 1 && only !== undefined) lines.push(`${only.key === "fatturato" ? "Il fatturato" : capitalized(label(only.key, v.now))}: ${deltaText(only)}.`);
		else if (rest.length > 1) lines.push(`Inoltre: ${rest.map((d) => `${label(d.key, v.now)} ${deltaText(d)}`).join("; ")}.`);
	} else if (v.biggest.length === 0) lines.push("Niente è cambiato nelle cifre.");
	else lines.push(`Cosa è cambiato di più: ${v.biggest.map((d) => `${label(d.key, v.now)} ${deltaText(d)}`).join("; ")}.`);
	for (const d of v.deltas) lines.push(`• ${capitalized(label(d.key, v.now))}: ${euros(d.now)}, prima ${euros(d.before)}, ${deltaText(d)}`);
	const ore = v.now.ore;
	const oreBefore = v.before.ore;
	const hours = (m: number) => (m === 0 ? "nessuna" : hoursText(m));
	if (v.presence.entries && ore !== undefined && oreBefore !== undefined && (ore.minutes > 0 || oreBefore.minutes > 0)) lines.push(`• Ore lavorate: ${hours(ore.minutes)}, prima ${hours(oreBefore.minutes)}`);
	const p = v.now.preventivi;
	const pb = v.before.preventivi;
	if (v.presence.quotes && p !== undefined && pb !== undefined && (p.made > 0 || pb.made > 0)) lines.push(`• Preventivi accettati: ${p.accepted} su ${p.made}, prima ${pb.made === 0 ? "nessun preventivo" : `${pb.accepted} su ${pb.made}`}`);
	if (!v.presence.expenses) lines.push("Spese: nessuna registrata, quindi il margine è solo gli incassi.");
	if (v.deltas.some((d) => d.key === "inTasca") && ordinario(v.now)) lines.push(`Dopo l'IVA vuol dire ${AFTER_IVA}.`);
	lines.push(...v.notes);
	if (hasTaxes(v.now) || hasTaxes(v.before)) lines.push(TAX_NOTE);
	lines.push(REPEAT);
	return lines.join("\n");
}

export type TrendView = { readonly months: readonly Figures[]; readonly cut: boolean; readonly presence: Presence; readonly notes: readonly string[] };

/** A month with nothing in it: no fatturato, no incassi, no spese. */
const emptyMonth = (f: Figures) => (f.fatturato?.cents ?? 0n) === 0n && (f.incassato ?? 0n) === 0n && (f.spese?.cents ?? 0n) === 0n;

export function trendAnswer(v: TrendView): string {
	const lines = [`Gli ultimi ${v.months.length === 1 ? "mese" : `${v.months.length} mesi`}, mese per mese:`];
	if (v.cut) lines.unshift(`Al massimo ${REPORT_LIMITS.maxTrendMonths} mesi: ti mostro gli ultimi ${REPORT_LIMITS.maxTrendMonths}.`);
	if (!v.presence.invoices && !v.presence.expenses) return [...lines.slice(0, -1), "Nei registri non ci sono né fatture né spese: non c'è ancora un andamento da mostrare.", ...v.notes].join("\n");
	const cell = (c: bigint | undefined) => (c === undefined ? "n.d." : euros(c));
	const row = (o: { fatturato: bigint | undefined; incassato: bigint | undefined; spese: bigint | undefined; margine: bigint | undefined }) => `fatturati ${cell(o.fatturato)}, incassati ${cell(o.incassato)}, spese ${cell(o.spese)}, margine ${cell(o.margine)}`;
	// The empty months before the first that holds anything, in one line.
	let lead = 0;
	while (lead < v.months.length && emptyMonth(v.months[lead] as Figures)) lead++;
	if (lead > 0) {
		const first = v.months[0] as Figures;
		const last = v.months[lead - 1] as Figures;
		lines.push(lead === 1 ? `${capitalized(monthWords(first.span))}: niente.` : `Da ${monthWords(first.span)} a ${monthWords(last.span)}: niente.`);
	}
	const shown = v.months.slice(lead);
	for (const f of shown) lines.push(`• ${monthWords(f.span)}: ${row({ fatturato: f.fatturato?.cents, incassato: f.incassato, spese: f.spese?.cents, margine: f.margine })}`);
	const sum = (pick: (f: Figures) => bigint | undefined) => v.months.reduce<bigint | undefined>((n, f) => (n === undefined || pick(f) === undefined ? undefined : n + (pick(f) as bigint)), 0n);
	if (shown.length > 1) lines.push(`Totale: ${row({ fatturato: sum((f) => f.fatturato?.cents), incassato: sum((f) => f.incassato), spese: sum((f) => f.spese?.cents), margine: sum((f) => f.margine) })}.`);
	if (!v.presence.invoices) lines.push("Fatture: nessuna nei registri, quindi niente fatturato né incassi.");
	if (!v.presence.expenses) lines.push("Spese: nessuna registrata.");
	lines.push(...v.notes, REPEAT);
	return lines.join("\n");
}

export type TopView = { readonly span: Span; readonly clients?: TopClients; readonly categories?: { readonly rows: readonly CategoryTotal[]; readonly total: bigint }; readonly presence: Presence; readonly notes: readonly string[] };

export function topAnswer(v: TopView): string {
	const lines = [`${capitalized(spanWords(v.span))}:`];
	const inside: string[] = [];
	const c = v.clients;
	if (!v.presence.invoices) lines.push("Clienti: nessuna fattura nei registri, quindi nessun incasso da mettere in fila.");
	else if (c !== undefined) {
		if (c.rows.length === 0) lines.push("Clienti: nessun incasso nel periodo.");
		else {
			lines.push(`Clienti per incassato (nel riquadro): ${euros(c.total)} da ${n1(c.clients, "1 cliente", "# clienti")}.`);
			c.rows.forEach((r, i) => inside.push(`${i + 1}. ${r.client.name}: ${euros(r.cents)}, ${r.percent}%`));
			if (c.even) lines.push("Gli incassi vengono da 2 clienti, quasi alla pari.");
			else if (c.clients > 1) lines.push(`Il primo cliente vale ${withPercent("il", Number(c.first))} degli incassi${c.clients > 3 ? `, i primi tre ${withPercent("il", Number(c.firstThree))}` : ""}${c.concentrated ? ": dipendi molto da un solo cliente" : ""}.`);
			else lines.push("Tutti gli incassi vengono da un solo cliente.");
		}
	}
	const k = v.categories;
	if (!v.presence.expenses) lines.push("Spese: nessuna registrata.");
	else if (k !== undefined) {
		if (k.rows.length === 0) lines.push("Spese: nessuna spesa registrata nel periodo.");
		else {
			lines.push(`Le categorie di spesa più alte (nel riquadro), su ${euros(k.total)} di spese registrate.`);
			for (const r of k.rows) inside.push(`${capitalized(r.category)}: ${euros(r.total)} (${n1(r.count, "1 spesa", "# spese")})`);
		}
	}
	if (inside.length > 0) lines.push(fenced(inside.join("\n")));
	lines.push(...v.notes, REPEAT);
	return lines.join("\n");
}

/** The brief's line, the month just closed: «Ottobre chiuso: incassati X, spese Y, margine Z (+N% su settembre)»; without a fair percent, the margine before («a settembre −100,00 €»). */
export function briefLine(closed: Figures, before: Figures, percent: string | undefined): string {
	const month = capitalized(MONTH_NAMES[Number(closed.span.from.slice(5, 7)) - 1] ?? "");
	const prev = MONTH_NAMES[Number(before.span.from.slice(5, 7)) - 1] ?? "";
	const was = before.margine ?? 0n;
	const change = percent !== undefined ? `${percent} su ${prev}` : was === 0n ? `${toWord(prev)} non c'era niente` : `${toWord(prev)} ${euros(was)}`;
	return `${month} chiuso: incassati ${euros(closed.incassato ?? 0n)}, spese ${euros(closed.spese?.cents ?? 0n)}, margine ${euros(closed.margine ?? 0n)} (${change}). Nel brief riporta questo in una riga.`;
}

export const BRIEF_NOTHING = "Niente da segnalare sull'andamento: nel brief non scrivere niente sull'andamento.";

const money = (c: bigint | undefined): CsvCell => (c === undefined ? "" : csvCents(c));
const taxCents = (f: Figures): bigint | undefined => (f.tasse === undefined || f.tasse.kind === "none" ? undefined : f.tasse.cents);

/** The report for the commercialista: the period month by month and its total, then the clients and the categories. */
export function reportCsv(o: { readonly months: readonly Figures[]; readonly total: Figures; readonly clients?: TopClients; readonly categories?: { readonly rows: readonly CategoryTotal[] } }): { readonly csv: string; readonly rows: number } {
	const ord = ordinario(o.total);
	const header = ["Periodo", "Fatturato (imponibile)", "Incassato", "Spese", "Margine", ord ? "IVA da versare" : "Tasse stimate", ord ? "Dopo l'IVA (prima di IRPEF e contributi, non stimati)" : "Ti resta in tasca", "Ore"];
	const line = (label: string, f: Figures): CsvCell[] => [label, money(f.fatturato?.cents), money(f.incassato), money(f.spese?.cents), money(f.margine), money(taxCents(f)), money(f.inTasca), f.ore === undefined ? "" : hm(f.ore.minutes)];
	const rows: CsvCell[][] = o.months.map((f) => line(monthWords(f.span), f));
	rows.push(line(`Totale ${spanWords(o.total.span)}`, o.total));
	if (o.clients !== undefined && o.clients.rows.length > 0) {
		rows.push([], ["Cliente", "Incassato", "Quota %"]);
		for (const r of o.clients.rows) rows.push([r.client.name, csvCents(r.cents), r.percent.toString()]);
	}
	if (o.categories !== undefined && o.categories.rows.length > 0) {
		rows.push([], ["Categoria di spesa", "Importo", "Spese"]);
		for (const r of o.categories.rows) rows.push([r.category, csvCents(r.total), String(r.count)]);
	}
	const twins = o.total.spese?.twins ?? 0;
	if (twins > 0) rows.push([], [`${n1(twins, "1 fattura di fornitore pagata è già nelle spese registrate", "# fatture di fornitori pagate sono già nelle spese registrate")}: contate una volta.`]);
	rows.push([], ["Le tasse sono una stima da verificare con il commercialista."]);
	return { csv: csvFile(header, rows), rows: rows.length };
}


/** What did not read while the registers were loaded, each said once in every answer. */
export type LoadState = {
	readonly invoicesBroken: boolean;
	/** The scadenzario holds invoices but the company is not known. */
	readonly noCompany: boolean;
	/** Invoice files in the workspace that do not read. */
	readonly unread: number;
	readonly salesBroken: boolean;
	readonly expensesBroken: boolean;
	readonly quotesBroken: boolean;
	readonly hoursBroken: boolean;
	/** Issued invoices left out of the fatturato. */
	readonly uncounted: number;
};

export function loadNotes(l: LoadState): string[] {
	const notes: string[] = [];
	if (l.invoicesBroken) notes.push("Lo stato delle fatture non si legge: fatturato, incassi e crediti qui non ci sono.");
	if (l.noCompany) notes.push("Non so ancora qual è la tua azienda nelle fatture: senza, non distinguo le fatture emesse da quelle ricevute.");
	if (l.unread > 0) notes.push(`${n1(l.unread, "Un file di fattura nel workspace non si legge ed è", "# file di fatture nel workspace non si leggono e sono")} fuori dal conto.`);
	if (l.salesBroken) notes.push("Le fatture in uscita non si leggono: il fatturato conta solo le fatture XML.");
	if (l.expensesBroken) notes.push("Il registro delle spese non si legge: spese e margine qui non ci sono.");
	if (l.quotesBroken) notes.push("L'archivio dei preventivi non si legge: i preventivi qui non ci sono.");
	if (l.hoursBroken) notes.push("Il registro delle ore non si legge: le ore qui non ci sono.");
	if (l.uncounted > 0) notes.push(`${n1(l.uncounted, "Una fattura emessa non entra", "# fatture emesse non entrano")} nel fatturato (senza riepilogo IVA, senza data o in un'altra valuta).`);
	return notes;
}
