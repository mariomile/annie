/**
 * What the scadenzario tool (invoice-tools.ts) says besides due and by_party: the list of
 * invoices and what a mark changed. What comes from the files goes inside the fence.
 */
import { amountText } from "../invoice-sums.ts";
import { dayShort } from "../invoice-windows.ts";
import { type Instalment, type Invoice, paidDay } from "../invoices.ts";
import { dayOfIn } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import { answer, fenced, footer, type Loaded, type ReadArgs, type View } from "./invoice-fence.ts";
import { counterparties, docLabel, filtered, joinedWords, MAX_ROWS, partyName, short, worthText } from "./invoice-words.ts";

export function listAnswer(loaded: Loaded, args: ReadArgs, view: View): string {
	const { party } = args;
	const mine = filtered(loaded.invoices, args);
	if (mine.length === 0) {
		const of = party === undefined ? "" : ` di ${fenced(party)}`;
		return `Non trovo fatture${of} tra le ${loaded.invoices.length} del workspace: prova con un'altra parola del nome o con la partita IVA.`;
	}
	const lines = mine.slice(0, MAX_ROWS).flatMap((invoice) => {
		const date = invoice.doc.date === undefined ? "senza data" : italianDate(invoice.doc.date);
		const first = `• ${date}, ${docLabel(invoice, false)}: ${counterparties(invoice)}${worthText(invoice)}`;
		return [first, `  ${joinedWords([dueSummary(invoice, view.today), status(invoice, view.timeZone), `file ${invoice.path}`], "; ")}`];
	});
	if (mine.length > MAX_ROWS) lines.push(`E altre ${mine.length - MAX_ROWS} fatture, più vecchie: filtra con party.`);
	return answer(`Fatture${party === undefined ? "" : ` di «${short(party)}»`}: ${mine.length}, dalla più recente.`, lines, footer(loaded, view));
}

/** «scadenza lun 30/11», «2 rate, la prossima aperta lun 30/11», «senza scadenza indicata». */
function dueSummary(invoice: Invoice, today: string): string | undefined {
	if (invoice.doc.integration || invoice.credit) return undefined;
	const dated = invoice.instalments.filter((i) => i.due !== undefined && i.extra !== true);
	if (dated.length === 0) return "senza scadenza indicata";
	const next = dated.find((i) => i.paid === undefined) ?? dated.at(-1);
	const day = dayShort(next?.due as string, today);
	const count = invoice.instalments.length;
	if (count === 1) return `scadenza ${day}`;
	return dated.some((i) => i.paid === undefined) ? `${count} rate, la prossima aperta ${day}` : `${count} rate, l'ultima ${day}`;
}

export function status(invoice: Invoice, timeZone: string): string {
	if (invoice.doc.integration) return "integrazione per il reverse charge, niente da pagare";
	const marked = invoice.instalments.filter((i) => i.paid !== undefined);
	// The bank's day when the mark came from the estratto conto, else the day it was marked.
	const at = (i: Instalment | undefined) => (i?.paid === undefined ? "" : ` il ${italianDate(paidDay(i.paid, dayOfIn(timeZone)))}`);
	const negative = invoice.negative ? "importo negativo, conta come nota di credito, " : "";
	if (invoice.credit) return `${negative}${invoice.paid ? `già scalata (segnata${at(marked[0])})` : "da scalare"}`;
	const mismatch = invoice.mismatch ? ", rate che non tornano con il totale" : "";
	if (invoice.paid) return `pagata (segnata${at(marked[0])})${mismatch}`;
	const side = invoice.side === "passive" ? " (da pagare)" : invoice.side === "active" ? " (da incassare)" : "";
	const count = invoice.instalments.length;
	if (marked.length > 0) return `pagata in parte (${marked.length} ${marked.length === 1 ? "rata" : "rate"} su ${count})${side}${mismatch}`;
	return `aperta${side}${mismatch}`;
}

/**
 * What was marked, without the state: «nota di credito NC 2026/9 del 05/10/2026 di Alfa Forniture
 * S.r.l., 100,00 €», «rata 1/2 (626,75 €, scadenza lun 12/10) della fattura 2026/0153 …».
 */
export function markedText(invoice: Invoice, n: number | undefined, today: string): string {
	let of: string;
	if (invoice.side === "active") of = ` a ${partyName(invoice.customer)}`;
	else if (invoice.side === "passive") of = ` di ${partyName(invoice.supplier)}`;
	else of = `, ${counterparties(invoice)}`;
	const doc = `${docLabel(invoice)}${of}${worthText(invoice)}`;
	const count = invoice.instalments.length;
	if (n === undefined) return `${doc}${count === 2 ? ", entrambe le rate" : count > 2 ? `, tutte le ${count} rate` : ""}`;
	const instalment = invoice.instalments[n - 1] as Instalment;
	const due = instalment.due === undefined ? "" : `, scadenza ${dayShort(instalment.due, today)}`;
	return `rata ${n}/${count} (${amountText(instalment, invoice.doc.currency)}${due}) della ${doc}`;
}
