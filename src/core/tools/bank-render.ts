/**
 * The estratto conto's answers in Italian: the counts («Movimenti caricati: 13 (2 abbinati, 5 da
 * confermare, 6 senza spiegazione).»), the movements with what explains them, short enough for a
 * phone, the totals per month, what looks odd, the brief's line and the CSV for the
 * commercialista. Descriptions, names and labels come from the file and the registers: always
 * inside the bank's fence.
 */
import { BANK_LIMITS, type BankImport, type BankMatch, type BankMovement, BRIEF_STALE_DAYS, dayWords, isLive, TWIN_DAYS } from "../bank.ts";
import { csvCents, csvFile } from "../csv.ts";
import { euros } from "../format-words.ts";
import { daysBetween, MONTH_NAMES } from "../italian-calendar.ts";
import { italianDate, withDate } from "../italian-format.ts";
import { eurosToCents } from "../quote-sums.ts";
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

/** «Movimenti caricati: 13 (2 abbinati, 5 da confermare, 6 senza spiegazione).» */
export function countLine(head: string, c: Counts): string {
	return `${head}: ${c.total} (${c.matched} ${c.matched === 1 ? "abbinato" : "abbinati"}, ${c.toConfirm} da confermare, ${c.unexplained} senza spiegazione).`;
}

/** «+1.220,00 €» in, «−45,50 €» out. */
export function signed(cents: bigint): string {
	return cents > 0n ? `+${euros(cents)}` : euros(cents);
}

/** A proposal that matches only the amount: asked one by one, never confirmed with the others. */
export const isWeak = (m: Pick<BankMatch, "state" | "strong" | "kind">): boolean => m.state === "proposed" && m.strong !== true;

const NOTE_WORDS = { oldest: " (la più vecchia tra fatture uguali dello stesso cliente)", rate: " (la fattura ha rate uguali: propongo la prima)", partial: "" } as const;

/** What explains a movement, in few words (inside the fence with the rest of its row). */
export function stateWords(match: BankMatch | undefined, hint: BankMatch | undefined): string {
	if (match === undefined) return hint?.note === "partial" && hint.label !== undefined ? `forse un acconto sulla ${hint.label}: il pagamento parziale non lo segno, la fattura resta aperta` : "senza spiegazione";
	const note = match.note === undefined ? "" : NOTE_WORDS[match.note];
	switch (match.state) {
		case "auto":
			return `${match.label} (abbinato)`;
		case "confirmed":
			return `${match.label} (confermato)`;
		case "proposed":
			return `${match.label}${note}${isWeak(match) ? " (coincide solo l'importo)" : ""}`;
		case "ask":
			return `quale? ${(match.candidates ?? []).map((c, i) => `${i + 1}) ${c.label}`).join("; ")}`;
		default:
			return "senza spiegazione";
	}
}

/** «3/10». */
const shortDay = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

/** The description cut for a phone. */
const cut = (text: string) => (text.length > BANK_LIMITS.rowText ? `${text.slice(0, BANK_LIMITS.rowText - 1).trimEnd()}…` : text);

/** «B-000004 3/10 +1.500,00 € ROSSI ARREDAMENTI… → fattura 21 di Rossi Srl». */
export function movementLine(m: BankMovement, match: BankMatch | undefined, hint: BankMatch | undefined): string {
	return `${m.id} ${shortDay(m.date)} ${signed(eurosToCents(m.amount))} ${cut(m.description)} → ${stateWords(match, hint)}`;
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
	/** New movements of the same day and amount as one loaded before, with another description: kept, to check. */
	readonly maybeLoaded: readonly (readonly [BankMovement, BankMovement])[];
	readonly skipped: number;
	readonly badDates: number;
	readonly bothSides: number;
	readonly otherCurrency: number;
	readonly assumed?: string;
	readonly truncated: boolean;
	readonly counts: Counts;
	readonly closing?: { readonly cents: bigint; readonly date: string };
	readonly auto: number;
	readonly pending: readonly BankMovement[];
	readonly hints: number;
	readonly matches: readonly BankMatch[];
	readonly format: BankImport["format"];
};

export const ROW_CAP_NOTE = "Il file ha più righe di quante ne leggo in una volta: ho letto le prime; carica il resto in un altro file (per esempio un mese alla volta).";

const rows = (n: number) => (n === 1 ? "una riga" : `${n} righe`);

export function importAnswer(f: ImportFacts): string {
	const lines = [`Estratto conto ${withDate("dal", f.from)} ${withDate("al", f.to)} (${f.format === "camt" ? "CAMT.053" : f.format === "xlsx" ? "Excel" : "CSV"}): ${f.added === 1 ? "un movimento nuovo" : `${f.added} movimenti nuovi`}${f.duplicates > 0 ? `, ${f.duplicates} già caricati prima (non li ripeto)` : ""}.`, countLine("Movimenti caricati", f.counts)];
	if (f.assumed !== undefined) lines.push(f.assumed);
	if (f.maybeLoaded.length > 0) lines.push("Forse già caricati (stesso giorno e stesso importo di un movimento di un estratto conto di prima, ma con un'altra descrizione): li ho tenuti, chiedi a chi ti scrive se sono lo stesso movimento.", fenced(f.maybeLoaded.map(([a, b]) => `${a.id} e ${b.id}, ${withDate("del", a.date)}: ${signed(eurosToCents(a.amount))}`).join("\n")));
	if (f.auto > 0) lines.push(`Come mi hai chiesto, ho segnato da sola ${f.auto === 1 ? "una fattura sicura" : `${f.auto} fatture sicure`} con il giorno della banca.`);
	if (f.skipped > 0) lines.push(`Ho saltato ${rows(f.skipped)} senza data o importo (totali, note).`);
	if (f.badDates > 0) lines.push(`${rows(f.badDates)} con un importo ma una data che non leggo: ${f.badDates === 1 ? "l'ho lasciata fuori, controllala" : "le ho lasciate fuori, controllale"} nel file.`.replace(/^./, (c) => c.toUpperCase()));
	if (f.bothSides > 0) lines.push(`${rows(f.bothSides)} con un importo sia in Dare sia in Avere: ${f.bothSides === 1 ? "l'ho lasciata fuori, controllala" : "le ho lasciate fuori, controllale"} nel file.`.replace(/^./, (c) => c.toUpperCase()));
	if (f.otherCurrency > 0) lines.push(`${f.otherCurrency === 1 ? "Un movimento (o saldo) è" : `${f.otherCurrency} movimenti (o saldi) sono`} in un'altra valuta: leggo solo gli euro, li ho lasciati fuori.`);
	if (f.truncated) lines.push(ROW_CAP_NOTE);
	const { live } = liveOf(f.matches);
	const weak = f.pending.filter((m) => isWeak(live.get(m.id) ?? { state: "auto" }));
	const sure = f.pending.filter((m) => !weak.includes(m));
	if (sure.length > 0) lines.push("Da confermare:", rowsBlock(sure, f.matches, BANK_LIMITS.pending));
	if (weak.length > 0) lines.push("Coincide solo l'importo, chiedi una per una:", rowsBlock(weak, f.matches, BANK_LIMITS.pending));
	if (f.pending.length > 0) lines.push("Per confermare: confirm con all true (solo le proposte sicure) o con ids; quelle in cui coincide solo l'importo con ids e weak_ok true, una per volta dopo il sì; per scartarne una: refuse. Le fatture si segnano incassate o pagate con il giorno della banca solo dopo il sì di chi ti scrive.");
	if (f.hints > 0) lines.push(`${f.hints === 1 ? "Un movimento sembra un acconto" : `${f.hints} movimenti sembrano acconti`} su una fattura: il pagamento parziale non lo segno e la fattura resta aperta (list con status unexplained).`);
	if (f.counts.unexplained > 0) lines.push("Per i movimenti senza spiegazione: list con status unexplained, o anomalies; le uscite possono diventare spese con to_expense (solo con il sì).");
	if (f.closing !== undefined) lines.push(`Il saldo finale dell'estratto conto è ${euros(f.closing.cents)} ${withDate("al", f.closing.date)}: dillo a chi ti scrive e chiedi se vuole salvarlo come saldo della previsione di cassa (set_balance con confirm true dopo il sì).`);
	return lines.join("\n");
}

export type MonthTotal = { readonly month: string; readonly inCents: bigint; readonly outCents: bigint; readonly count: number };

/** In and out per month, newest first; the transfers between the person's own accounts left out, and their sum. */
export function monthTotals(movements: readonly BankMovement[], live: ReadonlyMap<string, BankMatch>): { readonly months: MonthTotal[]; readonly transfers: bigint } {
	const by = new Map<string, { inCents: bigint; outCents: bigint; count: number }>();
	let transfers = 0n;
	for (const m of movements) {
		const c = eurosToCents(m.amount);
		if (live.get(m.id)?.kind === "transfer") {
			transfers += c < 0n ? -c : c;
			continue;
		}
		const key = m.date.slice(0, 7);
		const t = by.get(key) ?? { inCents: 0n, outCents: 0n, count: 0 };
		if (c > 0n) t.inCents += c;
		else t.outCents += -c;
		t.count++;
		by.set(key, t);
	}
	return { months: [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, t]) => ({ month, ...t })), transfers };
}

const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

export function totalsAnswer(t: { readonly months: readonly MonthTotal[]; readonly transfers: bigint }, label: string | undefined): string {
	if (t.months.length === 0 && t.transfers === 0n) return label === undefined ? "Non ho ancora movimenti dell'estratto conto: chiedi a chi ti scrive di caricare il file della banca." : `Non ho movimenti dell'estratto conto per ${label}.`;
	const figures = (m: MonthTotal) => `entrate ${euros(m.inCents)}, uscite ${euros(m.outCents)}, saldo del mese ${m.inCents >= m.outCents ? "+" : ""}${euros(m.inCents - m.outCents)} (${m.count} ${m.count === 1 ? "movimento" : "movimenti"})`;
	const left = t.transfers > 0n ? ` (esclusi ${euros(t.transfers)} di giroconti tra i tuoi conti)` : "";
	const after = "Sono i movimenti caricati dagli estratti conto: un giorno mancante nei file manca anche qui.";
	const only = t.months[0];
	if (label !== undefined && t.months.length === 1 && only !== undefined && monthLabel(only.month) === label) return [`A ${label}, secondo la banca: ${figures(only)}${left}.`, after].join("\n");
	return [`Secondo la banca${label === undefined ? "" : ` (${label})`}${left}:`, ...t.months.slice(0, 12).map((m) => `${monthLabel(m.month)}: ${figures(m)}`), after].join("\n");
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
	if (unexplained.length > 0) lines.push(`Senza spiegazione (${unexplained.length}):`, rowsBlock(unexplained, matches, BANK_LIMITS.listed));
	if (pairs.length > 0) lines.push("Forse addebitati due volte (stesso importo e stessa descrizione a pochi giorni):", fenced(pairs.map(([a, b]) => `${a.id} ${withDate("del", a.date)} e ${b.id} ${withDate("del", b.date)}: ${euros(-eurosToCents(a.amount))}, ${cut(a.description)}`).join("\n")), "Possono essere due spese vere: chiedi a chi ti scrive prima di dire che sono un errore.");
	return lines.join("\n");
}

export const BRIEF_NOTHING = "Niente da segnalare sull'estratto conto: nel brief non scrivere niente sulla banca.";

const lastDayOf = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10);

function nextMonth(key: string): string {
	const y = Number(key.slice(0, 4));
	const m = Number(key.slice(5, 7));
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The months that have finished and are missing after the last statement: the rest of its own, then the whole ones. */
function missing(to: string, today: string): string {
	const month = to.slice(0, 7);
	const parts: string[] = [];
	const partial = to < lastDayOf(month);
	if (partial) parts.push(`il resto di ${MONTH_NAMES[Number(month.slice(5, 7)) - 1]}`);
	const whole: string[] = [];
	for (let k = nextMonth(month); lastDayOf(k) < today && whole.length < 12; k = nextMonth(k)) whole.push(MONTH_NAMES[Number(k.slice(5, 7)) - 1] as string);
	const list = (words: readonly string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} e ${words.at(-1)}`);
	if (partial) return list([...parts, ...whole]);
	return whole.length === 1 ? `quello di ${whole[0]}` : `quelli di ${list(whole)}`;
}

/** The brief's line: the last statement older than BRIEF_STALE_DAYS (only the months that have finished are asked for), or proposals waiting. */
export function briefAnswer(latest: BankImport | undefined, waiting: number, today: string): string {
	const parts: string[] = [];
	if (latest !== undefined && daysBetween(latest.to, today) > BRIEF_STALE_DAYS) parts.push(`l'ultimo estratto conto arriva ${withDate("al", latest.to).replace(/ \d{4}$/, "")}: caricami ${missing(latest.to, today)}`);
	if (waiting > 0) parts.push(`${waiting === 1 ? "un abbinamento" : `${waiting} abbinamenti`} dell'estratto conto da confermare`);
	if (parts.length === 0) return BRIEF_NOTHING;
	return `Banca: ${parts.join("; ")}. Nel brief riporta questo in una riga.`;
}

const KIND_WORDS: Readonly<Record<string, string>> = { invoice_in: "fattura incassata", invoice_out: "fattura pagata", expense: "spesa", renewal: "rinnovo", f24: "F24", transfer: "giroconto", withdrawal: "prelievo" };

/** The CSV of the movements explained, for the commercialista: the bank's text made inert for a spreadsheet. */
export function reconciledCsv(movements: readonly BankMovement[], live: ReadonlyMap<string, BankMatch>): string {
	const header = ["Data contabile", "Data valuta", "Importo", "Descrizione", "Tipo", "Abbinato a", "Stato"];
	return csvFile(
		header,
		movements.map((m) => {
			const x = live.get(m.id) as BankMatch;
			return [italianDate(m.date), m.valueDate === undefined ? "" : italianDate(m.valueDate), csvCents(eurosToCents(m.amount)), m.description, KIND_WORDS[x.kind ?? ""] ?? "", x.label ?? "", x.state === "auto" ? "automatico" : "confermato"];
		}),
	);
}

/** «la fattura 21 di Rossi (3 ottobre)»: a confirmed invoice in the confirm's answer, with the bank's day. */
export const markedWords = (label: string, date: string, first: boolean): string => `la ${first ? label : label.replace(/^fattura /, "")} (${dayWords(date)})`;
