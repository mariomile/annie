/**
 * The estratto conto's answers in Italian: the counts («32 movimenti: 18 abbinati, 9 da
 * confermare, 5 senza spiegazione»), the movements with what explains them, the totals per month,
 * what looks odd, the brief's line and the CSV for the commercialista. Descriptions, names and
 * labels come from the file and the registers: always inside the bank's fence.
 */
import { type BankImport, type BankMatch, type BankMovement, BRIEF_STALE_DAYS, isLive, movementCents, TWIN_DAYS } from "../bank.ts";
import { csvCents, csvFile } from "../csv.ts";
import { euros } from "../format-words.ts";
import { daysBetween, MONTH_NAMES } from "../italian-calendar.ts";
import { italianDate, withDate } from "../italian-format.ts";
import { fold } from "../text-match.ts";
import { fenced } from "./bank-input.ts";

export type Counts = { readonly total: number; readonly matched: number; readonly toConfirm: number; readonly unexplained: number };

/** The live match of each movement (one at most), and its hint when unexplained. */
export function liveOf(matches: readonly BankMatch[]): { readonly live: Map<string, BankMatch>; readonly hints: Map<string, BankMatch> } {
	const live = new Map<string, BankMatch>();
	const hints = new Map<string, BankMatch>();
	for (const m of matches) {
		if (isLive(m)) live.set(m.movement, m);
		else if (m.state === "hint") hints.set(m.movement, m);
	}
	return { live, hints };
}

export function countsOf(movements: readonly BankMovement[], live: ReadonlyMap<string, BankMatch>): Counts {
	let matched = 0;
	let toConfirm = 0;
	for (const m of movements) {
		const s = live.get(m.id)?.state;
		if (s === "auto" || s === "confirmed") matched++;
		else if (s === "proposed" || s === "ask") toConfirm++;
	}
	return { total: movements.length, matched, toConfirm, unexplained: movements.length - matched - toConfirm };
}

export function countLine(c: Counts): string {
	const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
	return `${n(c.total, "movimento", "movimenti")}: ${n(c.matched, "abbinato", "abbinati")}, ${c.toConfirm} da confermare, ${c.unexplained} senza spiegazione.`;
}

/** «+1.220,00 €» in, «−45,50 €» out. */
export function signed(cents: bigint): string {
	return cents > 0n ? `+${euros(cents)}` : euros(cents);
}

/** What explains a movement, in words (inside the fence with the rest of its row). */
export function stateWords(match: BankMatch | undefined, hint: BankMatch | undefined): string {
	if (match === undefined) return hint?.note === "partial" && hint.label !== undefined ? `senza spiegazione: forse un pagamento parziale della ${hint.label}` : "senza spiegazione";
	switch (match.state) {
		case "auto":
			return `abbinato: ${match.label}`;
		case "confirmed":
			return `confermato: ${match.label}${match.expense === undefined ? "" : " (registrata ora)"}`;
		case "proposed":
			return `da confermare: ${match.label}${match.strong === true ? "" : " (coincide solo l'importo)"}${match.note === "oldest" ? "; ci sono più fatture uguali dello stesso cliente, propongo la più vecchia" : ""}`;
		case "ask":
			return `più possibilità, chiedi quale: ${(match.candidates ?? []).map((c, i) => `${i + 1}) ${c.label}`).join("; ")}`;
		default:
			return "senza spiegazione";
	}
}

export function movementLine(m: BankMovement, match: BankMatch | undefined, hint: BankMatch | undefined): string {
	return `${m.id} · ${italianDate(m.date)} · ${signed(movementCents(m.amount))} · ${m.description} → ${stateWords(match, hint)}`;
}

/** Rows of movements, fenced, at most `max`, with how many more. */
export function rowsBlock(rows: readonly BankMovement[], matches: readonly BankMatch[], max: number): string {
	if (rows.length === 0) return "";
	const { live, hints } = liveOf(matches);
	const shown = rows.slice(0, max).map((m) => movementLine(m, live.get(m.id), hints.get(m.id)));
	return [fenced(shown.join("\n")), ...(rows.length > max ? [`(e altri ${rows.length - max}: filtra con month, status o direction)`] : [])].join("\n");
}

export type ImportFacts = {
	readonly file: string;
	readonly from: string;
	readonly to: string;
	readonly added: number;
	readonly duplicates: number;
	readonly skipped: number;
	readonly truncated: boolean;
	readonly counts: Counts;
	readonly closing?: { readonly cents: bigint; readonly date: string };
	readonly auto: number;
	readonly pending: readonly BankMovement[];
	readonly matches: readonly BankMatch[];
	readonly format: BankImport["format"];
};

export const ROW_CAP_NOTE = "Il file ha più righe di quante ne leggo in una volta: ho letto le prime; carica il resto in un altro file (per esempio un mese alla volta).";

export function importAnswer(f: ImportFacts): string {
	const lines = [`Estratto conto ${withDate("dal", f.from)} ${withDate("al", f.to)} (${f.format === "camt" ? "CAMT.053" : f.format === "xlsx" ? "Excel" : "CSV"}): ${f.added === 1 ? "un movimento nuovo" : `${f.added} movimenti nuovi`}${f.duplicates > 0 ? `, ${f.duplicates} già caricati prima (non li ripeto)` : ""}.`, countLine(f.counts)];
	if (f.auto > 0) lines.push(`Come mi hai chiesto, ho segnato da sola ${f.auto === 1 ? "una fattura sicura" : `${f.auto} fatture sicure`} con il giorno della banca.`);
	if (f.skipped > 0) lines.push(`Ho saltato ${f.skipped === 1 ? "una riga" : `${f.skipped} righe`} senza data o importo (totali, note).`);
	if (f.truncated) lines.push(ROW_CAP_NOTE);
	if (f.pending.length > 0) lines.push("Da confermare:", rowsBlock(f.pending, f.matches, 12), "Per confermare: confirm con all true (le proposte sicure) o con ids; per scartarne una: refuse. Le fatture si segnano incassate o pagate con il giorno della banca solo dopo il sì di chi ti scrive.");
	if (f.counts.unexplained > 0) lines.push("Per i movimenti senza spiegazione: list con status unexplained, o anomalies; le uscite possono diventare spese con to_expense (solo con il sì).");
	if (f.closing !== undefined) lines.push(`Il saldo finale dell'estratto conto è ${euros(f.closing.cents)} ${withDate("al", f.closing.date)}: dillo a chi ti scrive e chiedi se vuole salvarlo come saldo della previsione di cassa (set_balance con confirm true dopo il sì).`);
	return lines.join("\n");
}

export type MonthTotal = { readonly month: string; readonly inCents: bigint; readonly outCents: bigint; readonly count: number };

export function monthTotals(movements: readonly BankMovement[]): MonthTotal[] {
	const by = new Map<string, { inCents: bigint; outCents: bigint; count: number }>();
	for (const m of movements) {
		const key = m.date.slice(0, 7);
		const t = by.get(key) ?? { inCents: 0n, outCents: 0n, count: 0 };
		const c = movementCents(m.amount);
		if (c > 0n) t.inCents += c;
		else t.outCents += -c;
		t.count++;
		by.set(key, t);
	}
	return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, t]) => ({ month, ...t }));
}

const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

export function totalsAnswer(totals: readonly MonthTotal[], label: string | undefined): string {
	if (totals.length === 0) return label === undefined ? "Non ho ancora movimenti dell'estratto conto: chiedi a chi ti scrive di caricare il file della banca." : `Non ho movimenti dell'estratto conto per ${label}.`;
	const rows = totals.slice(0, 12).map((t) => `${monthLabel(t.month)}: entrate ${euros(t.inCents)}, uscite ${euros(t.outCents)}, saldo del mese ${t.inCents >= t.outCents ? "+" : ""}${euros(t.inCents - t.outCents)} (${t.count} movimenti)`);
	return [`Secondo la banca${label === undefined ? "" : ` (${label})`}:`, ...rows, "Sono i movimenti caricati dagli estratti conto: un giorno mancante nei file manca anche qui."].join("\n");
}

/** Charges alike within TWIN_DAYS: the same amount out and the same description, maybe taken twice. */
export function twins(movements: readonly BankMovement[]): [BankMovement, BankMovement][] {
	const out: [BankMovement, BankMovement][] = [];
	const key = (m: BankMovement) => `${m.amount}|${fold(m.description).replace(/[^a-z]+/g, " ").trim()}`;
	const outs = movements.filter((m) => m.amount.startsWith("-")).sort((a, b) => a.date.localeCompare(b.date));
	for (let i = 0; i < outs.length; i++) {
		for (let j = i + 1; j < outs.length; j++) {
			const a = outs[i] as BankMovement;
			const b = outs[j] as BankMovement;
			if (daysBetween(a.date, b.date) > TWIN_DAYS) break;
			if (key(a) === key(b)) out.push([a, b]);
		}
	}
	return out.slice(0, 20);
}

export function anomaliesAnswer(unexplained: readonly BankMovement[], pairs: readonly [BankMovement, BankMovement][], matches: readonly BankMatch[]): string {
	if (unexplained.length === 0 && pairs.length === 0) return "Niente di strano: ogni movimento caricato ha una spiegazione e non vedo addebiti doppi.";
	const lines: string[] = [];
	if (unexplained.length > 0) lines.push(`Senza spiegazione (${unexplained.length}):`, rowsBlock(unexplained, matches, 25));
	if (pairs.length > 0) lines.push("Forse addebitati due volte (stesso importo e stessa descrizione a pochi giorni):", fenced(pairs.map(([a, b]) => `${a.id} ${withDate("del", a.date)} e ${b.id} ${withDate("del", b.date)}: ${euros(-movementCents(a.amount))}, ${a.description}`).join("\n")), "Possono essere due spese vere: chiedi a chi ti scrive prima di dire che sono un errore.");
	return lines.join("\n");
}

export const BRIEF_NOTHING = "Niente da segnalare sull'estratto conto: nel brief non scrivere niente sulla banca.";

/** The brief's line: the last statement older than BRIEF_STALE_DAYS, or proposals waiting. */
export function briefAnswer(latest: BankImport | undefined, waiting: number, today: string): string {
	const parts: string[] = [];
	if (latest !== undefined && daysBetween(latest.to, today) > BRIEF_STALE_DAYS) {
		const next = monthLabel(nextMonth(latest.to.slice(0, 7))).replace(/ \d{4}$/, "");
		parts.push(`l'ultimo estratto conto è di ${monthLabel(latest.to.slice(0, 7)).replace(/ \d{4}$/, "")}: caricami quello di ${next}`);
	}
	if (waiting > 0) parts.push(`${waiting === 1 ? "un abbinamento" : `${waiting} abbinamenti`} dell'estratto conto da confermare`);
	if (parts.length === 0) return BRIEF_NOTHING;
	return `Banca: ${parts.join("; ")}. Nel brief riporta questo in una riga.`;
}

function nextMonth(key: string): string {
	const y = Number(key.slice(0, 4));
	const m = Number(key.slice(5, 7));
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

const KIND_WORDS: Readonly<Record<string, string>> = { invoice_in: "fattura incassata", invoice_out: "fattura pagata", expense: "spesa", renewal: "rinnovo", f24: "F24", transfer: "giroconto", withdrawal: "prelievo" };

/** The CSV of the movements explained, for the commercialista: the bank's text made inert for a spreadsheet. */
export function reconciledCsv(rows: readonly BankMovement[], live: ReadonlyMap<string, BankMatch>): string {
	const header = ["Data contabile", "Data valuta", "Importo", "Descrizione", "Tipo", "Abbinato a", "Stato"];
	return csvFile(
		header,
		rows.map((m) => {
			const x = live.get(m.id) as BankMatch;
			return [italianDate(m.date), m.valueDate === undefined ? "" : italianDate(m.valueDate), csvCents(movementCents(m.amount)), m.description, KIND_WORDS[x.kind ?? ""] ?? "", x.label ?? "", x.state === "auto" ? "automatico" : "confermato"];
		}),
	);
}
