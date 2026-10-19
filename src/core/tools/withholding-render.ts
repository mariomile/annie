/**
 * The ritenute in the chat and in a CSV: short, phone length, amounts the Italian way, dates in
 * words, never a parameter's name. Names of clients and invoice numbers go only inside one fence
 * per answer (the tool's, withholding-input.ts), and never to another agente, who gets the totals.
 * The CU's figures are the person's words, repeated as said. The CSV is made inert by csvFile.
 */
import { type CsvCell, csvCents, csvFile } from "../csv.ts";
import { euros, n1 } from "../format-words.ts";
import { partyName, vatOf } from "../invoices.ts";
import { italianLongDate, withDate } from "../italian-format.ts";
import { eurosToCents } from "../quote-sums.ts";
import { sharesIn, type WithheldDoc } from "../withholding-docs.ts";
import { cuDeadline, ruleOf } from "../withholding-rules.ts";
import type { CuComparison, CuList, Explaining, PaymentCheck, ReceivedFrom, Verdict, YearSummary } from "../withholding-sums.ts";
import { type CuRecord, WITHHOLDING_LIMITS } from "../withholding.ts";
import { fenced } from "./withholding-input.ts";

export const REPEAT = "Ripeti cifre e date come sono scritte, non rifare i conti a mente.";

export const FORFETTARIO = "Nel regime forfettario i clienti non trattengono la ritenuta d'acconto (L. 190/2014, art. 1, comma 67): non c'è niente da controllare né credito per la dichiarazione. La CU, se un cliente te la manda, ha solo i compensi, senza ritenute.";

/** Said when the year was not given and last year is meant. */
export const DEFAULT_YEAR = "l'anno scorso: non mi hai detto l'anno";

/** A CU's client taken for the only one with a similar name (client-find.ts close, one candidate). */
export const SIMILAR_NOTE = "Nessun cliente si chiama esattamente così: ho preso l'unico con un nome simile, quello nel riquadro. Chiedi a chi ti scrive se è lui.";

export const BRIEF_NOTHING = "Niente da segnalare sulle ritenute: nel brief non scrivere niente sulle CU.";

/** «la fattura 12 del 3 marzo 2026», «la nota di credito NC-1 del 9 ottobre 2026»: inside the fence only (the number is the file's). */
export function docWords(d: WithheldDoc): string {
	return `${d.credit ? "nota di credito" : "fattura"}${d.number === undefined ? "" : ` ${d.number}`} ${withDate("del", d.date)}`;
}

const yearWords = (year: number, today: string) => (String(year) === today.slice(0, 4) ? `del ${year} finora` : `del ${year}`);

/** What a register that does not read, or a document left out, takes from the figures: said once, after them. */
export type LoadState = { readonly salesBroken: boolean; readonly bankBroken: boolean; readonly unread: number; readonly noDate: number; readonly foreign: number; readonly noCompany: boolean };

export function loadNotes(l: LoadState): string[] {
	const notes: string[] = [];
	if (l.noCompany) notes.push("Non so ancora qual è la tua azienda nelle fatture: senza, non distinguo le fatture emesse da quelle ricevute.");
	if (l.salesBroken) notes.push("Le fatture in uscita non si leggono: conto solo le fatture XML del workspace.");
	if (l.bankBroken) notes.push("L'estratto conto non si legge: per i pagamenti uso lo scadenzario.");
	if (l.unread > 0) notes.push(`${n1(l.unread, "Un file di fattura nel workspace non si legge ed è", "# file di fatture nel workspace non si leggono e sono")} fuori dal conto.`);
	if (l.noDate + l.foreign > 0) notes.push(`${n1(l.noDate + l.foreign, "Una fattura con ritenuta resta fuori", "# fatture con ritenuta restano fuori")} (senza data o in un'altra valuta).`);
	return notes;
}

const lagging = (s: YearSummary): string[] => {
	const out: string[] = [];
	if (s.open > 0) out.push(`${n1(s.open, "Una fattura con ritenuta del", "# fatture con ritenuta del")} ${s.year} ${n1(s.open, "non è ancora segnata pagata", "non sono ancora segnate pagate")}: la ritenuta conta nell'anno in cui il cliente paga.`);
	if (s.partly > 0) out.push(`${n1(s.partly, "Una fattura è pagata", "# fatture sono pagate")} solo in parte: conto la parte pagata, nell'anno in cui è arrivata.`);
	if (s.unusedCredits > 0) out.push(`${n1(s.unusedCredits, "Una nota di credito con ritenuta non è segnata usata", "# note di credito con ritenuta non sono segnate usate")}: non la tolgo finché non lo è.`);
	if (s.notInWorkspace > 0) out.push(`${n1(s.notInWorkspace, "Una fattura in uscita non ha il suo file XML", "# fatture in uscita non hanno il loro file XML")} nel workspace: non so se è pagata.`);
	if (s.toCheck.length > 0) out.push(`${n1(s.toCheck.length, "Una fattura chiede", "# fatture chiedono")} il totale lordo nei dati di pagamento: guarda nell'estratto conto se il cliente ha trattenuto la ritenuta.`);
	return out;
};

/** The rows of the clients of a year, for the fence: «Cliente Uno Srl: 800,00 € di ritenute su 4.000,00 € (3 fatture)». */
function clientRows(s: YearSummary): string[] {
	const rows = s.clients.slice(0, WITHHOLDING_LIMITS.listed).map((c) => {
		const parts = [n1(c.count, "1 fattura", "# fatture"), ...(c.credits === 0 ? [] : [n1(c.credits, "1 nota di credito", "# note di credito")])];
		return `${partyName(c.client)}: ${euros(c.ritenuta)} di ritenute su ${euros(c.compensi)} (${parts.join(", ")})`;
	});
	if (s.clients.length > WITHHOLDING_LIMITS.listed) rows.push(`e altri ${s.clients.length - WITHHOLDING_LIMITS.listed}`);
	return rows;
}

export type SummaryView = { readonly summary: YearSummary; readonly today: string; readonly named: boolean; readonly notes: readonly string[] };

export function summaryAnswer(v: SummaryView): string {
	const s = v.summary;
	const head = `Ritenute d'acconto ${yearWords(s.year, v.today)}, sulle fatture pagate nell'anno (conta il giorno dell'incasso, non la data della fattura):`;
	if (s.clients.length === 0) return [`Nel ${s.year} non ho fatture con ritenuta d'acconto pagate.`, ...lagging(s), ...v.notes, REPEAT].join("\n");
	const docs = s.clients.reduce((n, c) => n + c.count, 0);
	const credits = s.clients.reduce((n, c) => n + c.credits, 0);
	const lines = [head, `• Trattenute dai clienti: ${euros(s.ritenuta)} su ${euros(s.compensi)} di compensi (${[n1(docs, "1 fattura", "# fatture"), ...(credits === 0 ? [] : [n1(credits, "1 nota di credito", "# note di credito")])].join(", ")}, ${n1(s.clients.length, "1 cliente", "# clienti")}).`];
	const excluded = s.ritenuta - s.credit;
	const credit = `• Credito per la dichiarazione dei redditi del ${s.year + 1} (redditi ${s.year}): ${euros(s.credit)}.`;
	lines.push(excluded === 0n ? credit : `${credit} Ho tolto ${euros(excluded)} di ${n1(s.gross.length, "una fattura che il cliente ha pagato", "# fatture che i clienti hanno pagato")} al lordo, senza trattenere (lo dice l'estratto conto).`);
	if (v.named) lines.push("Per cliente, nel riquadro:", fenced(clientRows(s).join("\n")));
	lines.push(...lagging(s), ...v.notes);
	lines.push(`Il cliente te le certifica nella CU entro il ${italianLongDate(cuDeadline(s.year))}.`);
	lines.push(REPEAT);
	return lines.join("\n");
}

// --- Payments -----------------------------------------------------------------------------------

const fromWords: Readonly<Record<Exclude<ReceivedFrom, "register">, string>> = {
	bank: "Secondo l'estratto conto sono arrivati",
	said: "Mi dici che sono arrivati",
};

/** The scadenzario's figure is the invoice's own: it says what the invoice asks, never what came in. */
function registerWords(c: PaymentCheck): string {
	const asked = c.verdict === "net" ? "il netto che chiede la fattura" : c.verdict === "gross" ? "il totale lordo che chiede la fattura nei dati di pagamento" : "quello che chiede la fattura";
	const then = c.verdict === "gross" ? "Guarda nell'estratto conto quanto è arrivato: se il cliente ha pagato il lordo, quella ritenuta non è un credito per te." : "Per saperlo carica l'estratto conto o dimmi quanto è arrivato.";
	return `Lo scadenzario conta ${euros(c.received)}, ma è ${asked}, non quello arrivato davvero. ${then}`;
}

function verdictWords(c: PaymentCheck): string {
	const v: Verdict = c.verdict;
	switch (v) {
		case "net":
			return "ha pagato al netto della ritenuta, come deve. La ritenuta è un credito per la tua dichiarazione.";
		case "gross":
			return "ha pagato il lordo, senza trattenere la ritenuta. Quella ritenuta non è un credito per te: non metterla in dichiarazione. E il cliente non dovrebbe certificarla nella CU.";
		case "under":
			return `mancano ${euros(-c.diff)} rispetto al netto. Chiedi al cliente.`;
		case "other":
			return `è diverso sia dal netto sia dal lordo (${euros(c.diff)} rispetto al netto). Controlla con il cliente.`;
	}
}

/** One invoice checked: its figures outside the fence, its client and number inside. */
export function checkOneAnswer(c: PaymentCheck, notes: readonly string[]): string {
	const d = c.doc;
	const lines = [`La fattura nel riquadro: totale ${euros(d.total)}, ritenuta ${euros(d.ritenuta)}, netto da ricevere ${euros(d.net)}.`, fenced(`${docWords(d)}, cliente ${partyName(d.client)}`)];
	if (d.paidOn === undefined) lines.push(d.partly ? "È pagata solo in parte: la controllo quando è saldata." : "Non è ancora segnata pagata: quando il cliente paga, segnala pagata e la controllo.");
	else lines.push(`Pagata ${withDate("il", d.paidOn)}. ${c.from === "register" ? registerWords(c) : `${fromWords[c.from]} ${euros(c.received)}: ${verdictWords(c)}`}`);
	lines.push(...notes, REPEAT);
	return lines.join("\n");
}

const verdictShort = (c: PaymentCheck): string => ({ net: "al netto, giusto", gross: "al lordo, ritenuta non trattenuta", under: `mancano ${euros(-c.diff)}`, other: `diverso di ${euros(c.diff)}` })[c.verdict];

/** A row of the list: the scadenzario's says only what the invoice asks, to verify. */
const checkRow = (c: PaymentCheck): string =>
	c.from === "register"
		? `${docWords(c.doc)}, ${partyName(c.doc.client)}: netto ${euros(c.doc.net)}, ${c.verdict === "gross" ? "chiede il lordo: da verificare" : "da verificare"}`
		: `${docWords(c.doc)}, ${partyName(c.doc.client)}: netto ${euros(c.doc.net)}, arrivati ${euros(c.received)}, ${verdictShort(c)}`;

const BANK_NEEDED = "Per sapere cosa è arrivato serve l'estratto conto: caricalo, o dimmi quanto è arrivato per una fattura.";
/** After a line that already says «non quello arrivato davvero». */
const BANK_NEEDED_AFTER = "Per saperlo serve l'estratto conto: caricalo, o dimmi quanto è arrivato per una fattura.";

/** The invoices paid in a period checked: counts outside, the rows inside one fence. */
export function checkListAnswer(checks: readonly PaymentCheck[], periodWords: string, notes: readonly string[]): string {
	if (checks.length === 0) return [`Nessuna fattura con ritenuta pagata (${periodWords}).`, ...notes, REPEAT].join("\n");
	const fromRegister = checks.filter((c) => c.from === "register");
	if (fromRegister.length === checks.length) {
		const asksGross = fromRegister.filter((c) => c.verdict === "gross").length;
		const lines = [`${n1(checks.length, "Una fattura con ritenuta pagata", "# fatture con ritenuta pagate")} (${periodWords}): lo scadenzario conta il netto che chiede la fattura, non quello arrivato davvero.`];
		if (asksGross > 0) lines.push(`${n1(asksGross, "Una chiede", "# chiedono")} il totale lordo nei dati di pagamento: da verificare.`);
		lines.push(BANK_NEEDED_AFTER, ...notes, REPEAT);
		return lines.join("\n");
	}
	const count = (v: Verdict, from?: ReceivedFrom) => checks.filter((c) => c.verdict === v && (from === undefined ? c.from !== "register" : c.from === from)).length;
	const parts = [
		count("net") > 0 ? `${count("net")} al netto della ritenuta` : undefined,
		count("gross") > 0 ? `${count("gross")} al lordo, senza ritenuta trattenuta` : undefined,
		count("under") + count("other") > 0 ? `${count("under") + count("other")} con un importo diverso` : undefined,
		fromRegister.length > 0 ? `${fromRegister.length} da verificare (manca l'estratto conto)` : undefined,
	].filter((p) => p !== undefined);
	const rows = checks.slice(0, WITHHOLDING_LIMITS.listed).map(checkRow);
	if (checks.length > WITHHOLDING_LIMITS.listed) rows.push(`e altre ${checks.length - WITHHOLDING_LIMITS.listed}`);
	const lines = [`${n1(checks.length, "Una fattura con ritenuta pagata", "# fatture con ritenuta pagate")} (${periodWords}): ${parts.join(", ")}.`, fenced(rows.join("\n"))];
	if (count("gross") > 0) lines.push("Una ritenuta che il cliente non ha trattenuto non è un credito per te: non metterla in dichiarazione.");
	if (fromRegister.length > 0) lines.push(BANK_NEEDED);
	lines.push(...notes, REPEAT);
	return lines.join("\n");
}

// --- The CU -------------------------------------------------------------------------------------

const reasonWords = (e: Explaining): string => {
	const y = e.year ?? Number(e.doc.date.slice(0, 4));
	switch (e.reason) {
		case "paid_next_year":
			return e.effect === e.doc.ritenuta ? `pagata nel ${y}: è nella CU di quell'anno` : `pagata in parte nel ${y}: quella parte è nella CU di quell'anno`;
		case "paid_this_year":
			return `di un anno prima ma pagata nel ${y}: la conto nel ${y}`;
		case "not_marked":
			return e.doc.partly ? "pagata solo in parte: se il cliente ha pagato il resto, segnalo pagato" : "non è segnata pagata: se il cliente l'ha pagata, segnala pagata";
		case "credit_counted":
			return "la tolgo io: forse il cliente non l'ha tolta";
		case "credit_unused":
			return "non è segnata usata: forse il cliente l'ha già tolta";
		case "paid_gross":
			return "pagata al lordo secondo l'estratto conto: il cliente non ha trattenuto";
	}
};

/** The ritenuta (or the share of it) a reason is about, with its sign: what is counted takes it off, what is not adds it. */
const shareOf = (e: Explaining): bigint => (e.reason === "paid_this_year" || e.reason === "credit_counted" || e.reason === "paid_gross" ? -e.effect : e.effect);

/** How a CU compares, in words: the differences outside, the invoices that make them inside `rows`. */
function comparisonLines(c: CuComparison, rows: string[]): string[] {
	const year = c.cu.year;
	if (c.matches) {
		const lines = [`Torna con le mie fatture: ${euros(c.ritenuta)} di ritenute su ${n1(c.count, "1 fattura pagata", "# fatture pagate")} nel ${year}.`];
		if (c.diffCompensi !== 0n) lines.push(`I compensi invece differiscono di ${euros(c.diffCompensi)} (CU meno le mie fatture): può essere il contributo della cassa o una spesa rimborsata; le ritenute sono quelle che contano per il credito.`);
		return lines;
	}
	const more = c.diffRitenuta > 0n;
	const lines = [`Non torna: la CU dice ${euros(more ? c.diffRitenuta : -c.diffRitenuta)} di ritenute ${more ? "in più" : "in meno"} delle mie (${euros(c.ritenuta)} su ${n1(c.count, "1 fattura pagata", "# fatture pagate")} nel ${year}).`];
	const shown = c.explained.slice(0, WITHHOLDING_LIMITS.explained);
	if (shown.length > 0) {
		lines.push(c.exact ? "La differenza si spiega con le fatture nel riquadro." : "Non trovo fatture che la spieghino tutta; guarda queste, nel riquadro.");
		for (const e of shown) rows.push(`${docWords(e.doc)}: ritenuta ${euros(shareOf(e))}, ${reasonWords(e)}`);
		if (c.explained.length > shown.length) rows.push(`e altre ${c.explained.length - shown.length}`);
	}
	if (c.missing) lines.push("Forse mancano fatture nel workspace: chiedi al cliente l'elenco delle fatture che ha certificato, o caricale.");
	else if (!more && shown.length === 0) lines.push("Forse il cliente ha dimenticato una fattura nella CU: chiedigli di controllare, e se serve una CU corretta.");
	return lines;
}

/** `note`: how the client was taken, when not by its exact name (client-find.ts FORM_NOTE, SIMILAR_NOTE). */
export type CuView = { readonly kind: "new" | "replaced" | "again"; readonly comparison: CuComparison; readonly known: boolean; readonly note?: string; readonly notes: readonly string[] };

export function cuAnswer(v: CuView): string {
	const c = v.comparison;
	const cu = c.cu;
	const rows = [`cliente: ${cu.client.name}`];
	const saved = v.kind === "replaced" ? `Ho sostituito la CU del ${cu.year} del cliente nel riquadro (${cu.id}) con questa` : v.kind === "again" ? `La CU del ${cu.year} del cliente nel riquadro era già salvata (${cu.id})` : `Salvata la CU del ${cu.year} del cliente nel riquadro (${cu.id})`;
	const lines = [`${saved}: compensi ${euros(eurosToCents(cu.gross))}, ritenute ${euros(eurosToCents(cu.withheld))}.`];
	if (v.note !== undefined) lines.push(v.note);
	if (!v.known) lines.push(`Nelle mie fatture non c'è nessuna ritenuta di questo cliente: la confronto quando ci saranno le sue fatture. Se l'hai salvata per sbaglio, dimmi di togliere la ${cu.id}.`);
	else lines.push(...comparisonLines(c, rows));
	return [...lines.slice(0, 1), fenced(rows.join("\n")), ...lines.slice(1), ...v.notes, REPEAT].join("\n");
}

/** A CU removed: its client inside the fence. */
export function cuRemovedAnswer(cu: CuRecord): string {
	return [`Ho tolto la ${cu.id} del ${cu.year} del cliente nel riquadro: compensi ${euros(eurosToCents(cu.gross))}, ritenute ${euros(eurosToCents(cu.withheld))}.`, fenced(`cliente: ${cu.client.name}`), "Se ti arriva quella giusta, dimmela e la confronto con le mie fatture."].join("\n");
}

/** A client said for a CU that is close to several: asked, the candidates inside the fence. */
export function askClient(candidates: readonly string[]): string {
	return [`Errore: non so quale cliente intendi, ce ne sono ${candidates.length} con un nome simile (nel riquadro): chiedi a chi ti scrive quale, o dammi la partita IVA.`, fenced(candidates.slice(0, WITHHOLDING_LIMITS.listed).join("\n"))].join("\n");
}

/** The first reason a CU does not match, for its row: the invoice and why, or that none explains it. */
function firstReason(r: CuComparison): string {
	const e = r.explained[0];
	if (e === undefined) return r.missing ? "forse mancano fatture nel workspace" : "nessuna fattura lo spiega";
	return `forse ${docWords(e.doc)}, ${reasonWords(e)}`;
}

/** `defaulted`: the year was not said (last year is meant), said in the header. */
export function cuListAnswer(l: CuList, today: string, notes: readonly string[], defaulted = false): string {
	const deadline = italianLongDate(l.deadline);
	const status = l.missing.length === 0 ? `scadenza ${deadline}` : l.late ? `scadenza ${deadline}, passata: chi non l'ha mandata è in ritardo` : today >= `${l.year + 1}-01-01` ? `scadenza ${deadline}` : `arriveranno dopo la fine dell'anno, entro il ${deadline}`;
	const total = l.missing.length + l.received.length;
	if (total === 0 && l.unexpected.length === 0) return [`Nel ${l.year} non ho fatture con ritenuta pagate, quindi nessuna CU da aspettare.`, ...notes, REPEAT].join("\n");
	const rows: string[] = [];
	for (const m of l.missing.slice(0, WITHHOLDING_LIMITS.listed)) rows.push(`${partyName(m.client)}: manca${l.late ? ", in ritardo" : ""} (ritenute ${euros(m.ritenuta)})`);
	if (l.missing.length > WITHHOLDING_LIMITS.listed) rows.push(`e altri ${l.missing.length - WITHHOLDING_LIMITS.listed} che mancano`);
	for (const r of l.received.slice(0, WITHHOLDING_LIMITS.listed)) rows.push(`${r.cu.client.name}: ricevuta (${r.cu.id}), ${r.matches ? "torna" : `non torna (differenza ${euros(r.diffRitenuta)}): ${firstReason(r)}`}`);
	for (const r of l.unexpected.slice(0, WITHHOLDING_LIMITS.explained)) rows.push(`${r.cu.client.name}: ricevuta (${r.cu.id}), ma nelle mie fatture non ha ritenute del ${l.year}`);
	const count =
		l.missing.length === 0
			? `le hai tutte, ${n1(total, "1 cliente", "# clienti")} con ritenute`
			: l.missing.length === total
				? total === 1
					? "manca quella dell'unico cliente con ritenute"
					: `mancano tutte e ${total}, una per cliente con ritenute`
				: `ne ${n1(l.missing.length, "manca 1", "mancano #")} su ${n1(total, "1 cliente", "# clienti")} con ritenute`;
	const head = defaulted ? `CU del ${l.year}, ${DEFAULT_YEAR}. ${capitalize(count)} (${status}).` : `CU del ${l.year} (${status}): ${count}.`;
	const lines = [head, fenced(rows.join("\n"))];
	const wrong = l.received.filter((r) => !r.matches).length;
	if (wrong > 0) lines.push(`${n1(wrong, "Una CU non torna", "# CU non tornano")} con le mie fatture: il perché più probabile è nel riquadro, accanto al cliente.`);
	if (l.missing.length > 0) lines.push(l.late ? "Chiedile ai clienti: senza, le ritenute vanno comunque in dichiarazione, ma con le fatture e i pagamenti a provarle." : "Quando ti arrivano, dimmele e le confronto con le mie fatture.");
	lines.push(...notes, REPEAT);
	return lines.join("\n");
}

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The brief's line: the CU missing for last year, in the days after the deadline. */
export function briefLine(missing: number, year: number): string {
	return `${n1(missing, "Manca 1 CU", "Mancano # CU")} per il ${year}: chiedile ai clienti.`;
}

// --- The export ---------------------------------------------------------------------------------

const RULE_WORDS = { professional: "20% sul compenso", agent: "23% sul 50% (agenti)", agentReduced: "23% sul 20% (agenti con dipendenti)" } as const;

function ruleWords(d: WithheldDoc): string {
	const r = ruleOf(d.compensi, d.ritenuta);
	if (r === undefined) return d.rate === undefined ? "altra" : `${d.rate.replace(".", ",")}%`;
	return r.kind === "professional" ? RULE_WORDS.professional : r.kind === "agent" && r.reduced === true ? RULE_WORDS.agentReduced : RULE_WORDS.agent;
}

const VERDICT_CSV: Readonly<Record<Verdict, string>> = { net: "al netto", gross: "al lordo", under: "meno del netto", other: "diverso" };
const FROM_CSV: Readonly<Record<ReceivedFrom, string>> = { bank: "estratto conto", said: "detto", register: "scadenzario" };

/** The scadenzario's figure is the invoice's own: never a verdict on what came in. */
const verdictCsv = (c: PaymentCheck): string => (c.from !== "register" ? VERDICT_CSV[c.verdict] : c.verdict === "gross" ? "chiede il lordo: da verificare" : "da verificare (manca l'estratto conto)");

/** `paidGross`: the bank says the client paid it gross (withholding-sums.ts paidGrossByBank): no credit. */
export type CsvView = { readonly year: number; readonly docs: readonly WithheldDoc[]; readonly checks: (d: WithheldDoc) => PaymentCheck; readonly paidGross: (d: WithheldDoc) => boolean; readonly comparisons: ReadonlyMap<string, CuComparison> };

/**
 * One row per invoice given (counted in the year, or dated in it and counted in another, to say
 * why), with the shares paid in the year, the credit for the dichiarazione (the share, none when
 * the bank says it was paid gross: the summary's credit) and the client's CU; the CU's columns only on the rows
 * counted in that CU's year, «nella CU del 2027» on the others. Last, the year's total of the rows
 * counted.
 */
export function withholdingCsv(v: CsvView): { readonly csv: string; readonly rows: number } {
	const y = v.year;
	const header = ["Cliente", "P.IVA o codice fiscale", "Documento", "Numero", "Data", "Pagata il", "Anni di cassa", "Compensi", "Ritenuta", "Regola", "Totale", "Netto da ricevere", `Compensi del ${y}`, `Ritenuta del ${y}`, `Credito del ${y}`, "Ricevuto", "Fonte del ricevuto", "Esito del pagamento", "CU: ritenute dichiarate", "CU: differenza con le fatture", "CU"];
	const rows: CsvCell[][] = [];
	let compensi = 0n;
	let ritenuta = 0n;
	let credit = 0n;
	for (const d of v.docs) {
		const share = sharesIn(d, y);
		const years = [...new Set(d.payments.map((p) => Number(p.day.slice(0, 4))))];
		const check = d.paidOn === undefined || d.credit ? undefined : v.checks(d);
		const cmp = share === undefined ? undefined : v.comparisons.get(d.clientKey);
		const other = years.find((n) => n !== y);
		const owed = share === undefined ? undefined : v.paidGross(d) ? 0n : share.ritenuta;
		if (share !== undefined) {
			compensi += share.compensi;
			ritenuta += share.ritenuta;
			credit += owed ?? 0n;
		}
		const last = d.payments[d.payments.length - 1];
		rows.push([
			partyName(d.client),
			vatOf(d.client) ?? d.client.fiscal ?? "",
			d.credit ? "nota di credito" : "fattura",
			d.number ?? "",
			d.date,
			d.paidOn ?? (last === undefined ? "non pagata" : `${last.day} (in parte)`),
			years.join(", "),
			csvCents(d.compensi),
			csvCents(d.ritenuta),
			ruleWords(d),
			csvCents(d.total),
			csvCents(d.net),
			share === undefined ? "" : csvCents(share.compensi),
			share === undefined ? "" : csvCents(share.ritenuta),
			owed === undefined ? "" : csvCents(owed),
			check === undefined ? "" : csvCents(check.received),
			check === undefined ? "" : FROM_CSV[check.from],
			check === undefined ? "" : verdictCsv(check),
			cmp === undefined ? "" : csvCents(eurosToCents(cmp.cu.withheld)),
			cmp === undefined ? "" : csvCents(cmp.diffRitenuta),
			share === undefined ? (other === undefined ? "" : `nella CU del ${other}`) : cmp === undefined ? "non ricevuta" : cmp.matches ? "torna" : "non torna",
		]);
	}
	const total: CsvCell[] = header.map(() => "");
	total[0] = `Totale ${y}`;
	total[12] = csvCents(compensi);
	total[13] = csvCents(ritenuta);
	total[14] = csvCents(credit);
	return { csv: csvFile(header, [...rows, total]), rows: rows.length };
}
