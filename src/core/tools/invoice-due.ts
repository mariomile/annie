/**
 * The scadenzario's `due` answer: open instalments by date and direction, overdue first, never
 * adding what is to pay to what is to collect; credit notes come off their own party in a window
 * from today. Rows also say the reminders sent (reminder-book.ts).
 */
import { paymentSlip, slipPhrase } from "../dates.ts";
import { type FatturaParty, fromUnits, money } from "../fattura-pa.ts";
import { amountText, type Credit, creditSums, eur, netted, nettedText, payDay, type Share, sumsText } from "../invoice-sums.ts";
import { dayMonth, dayShort, type Window, windowOf } from "../invoice-windows.ts";
import { addTo, type Instalment, type Invoice, openAmount, partyKey, type Side, type Sums } from "../invoices.ts";
import { daysBetween, todayIn } from "../italian-calendar.ts";
import { answer, footer, type Loaded, type ReadArgs, type View } from "./invoice-fence.ts";
import { byName, capital, docLabel, docShort, filtered, MAX_ROWS, namesText, otherParty, partyName, short, to } from "./invoice-words.ts";

/** Directions shown when the company is not known (one per customer); the rest are counted. */
export const MAX_BUCKETS = 5;
/** One open instalment of an invoice. */
export type Row = { readonly invoice: Invoice; readonly instalment: Instalment };

/**
 * The invoices of one direction: to pay, to collect, or, when the company is not known, the ones
 * to one customer (from its suppliers). Never added to another.
 */
export type Bucket = {
	readonly key: string;
	readonly side?: Side;
	readonly customer: FatturaParty;
	readonly suppliers: FatturaParty[];
	readonly rows: Row[];
	readonly overdue: Row[];
	readonly undated: Row[];
	readonly credits: Credit[];
};

export function bucketKey(invoice: Invoice): string {
	return invoice.side ?? `dir:${partyKey(invoice.customer)}`;
}

/** «da pagare», «da incassare», «da Alfa e Delta a Beta». */
export function bucketLabel(bucket: Bucket): string {
	if (bucket.side === "passive") return "da pagare";
	if (bucket.side === "active") return "da incassare";
	return `da ${namesText(bucket.suppliers)} a ${partyName(bucket.customer)}`;
}

export function addParty(list: FatturaParty[], party: FatturaParty): void {
	if (!list.some((p) => partyKey(p) === partyKey(party))) list.push(party);
}

export function dueAnswer(loaded: Loaded, args: ReadArgs, view: View): string {
	const { today } = view;
	const warnings: string[] = [];
	const window = windowOf(args, today, warnings);
	const { party } = args;
	const mine = filtered(loaded.invoices, args);
	const oneParty = party !== undefined && new Set(mine.map((i) => partyKey(otherParty(i)))).size === 1;
	const buckets = collect(mine, window, today);
	const ordered = [...buckets.values()].filter((b) => b.rows.length + b.overdue.length + b.undated.length > 0).sort(bucketOrder);
	const shownBuckets = ordered.slice(0, MAX_BUCKETS);
	const byDue = (a: Row, b: Row) => (a.instalment.due ?? "").localeCompare(b.instalment.due ?? "") || (a.invoice.doc.date ?? "").localeCompare(b.invoice.doc.date ?? "");
	const lines: string[] = [summaryLine(window, shownBuckets, ordered.length - shownBuckets.length)];
	const fromToday = window.overdue && window.from !== undefined;
	let shown = 0;
	let hidden = 0;
	for (const bucket of shownBuckets) {
		lines.push("", `${capital(bucketLabel(bucket))}:`);
		const dated = [...bucket.overdue, ...bucket.rows].sort(byDue);
		for (const row of window.week ? dated : [...dated, ...bucket.undated]) {
			if (shown >= MAX_ROWS) {
				hidden++;
				continue;
			}
			lines.push(dueRow(row, bucket, { today, oneParty, timeZone: view.timeZone }));
			shown++;
		}
		if (window.week && bucket.undated.length > 0) {
			lines.push(`${bucket.undated.length === 1 ? "Una rata aperta" : `${bucket.undated.length} rate aperte`} senza scadenza indicata.`);
		}
		for (const credit of bucket.credits) lines.push(`• ${creditLine(credit, oneParty, today)}`);
		const total = totalLine(bucket, fromToday);
		if (total !== undefined) lines.push(total);
	}
	if (hidden > 0) lines.push("", `E altre ${hidden} rate non mostrate: restringi con range, from/to, side o party.`);
	if (ordered.length > shownBuckets.length) {
		lines.push("", `E altri ${ordered.length - shownBuckets.length} gruppi di fatture (fornitori di altri clienti) non mostrati: filtra con party.`);
	}
	const notes: string[] = warnings.map((w) => `Attenzione: ${w}.`);
	if (!fromToday) {
		const undated = mine
			.filter((i) => !i.credit && !i.doc.integration)
			.flatMap((i) => i.instalments.filter((n) => n.paid === undefined && n.due === undefined && n.extra !== true));
		if (undated.length > 0) {
			const which = undated.length === 1 ? "Una rata aperta è" : `${undated.length} rate aperte sono`;
			notes.push(`${which} senza scadenza indicata: le vedi con op list o chiedendo le prossime scadenze.`);
		}
	}
	const head = `${window.label}${party === undefined ? "" : `, controparte «${short(party)}»`} (fatture trovate: ${loaded.invoices.length}).`;
	return answer(head, lines, footer(loaded, view), notes);
}

/** The open instalments of the window by direction, and the open credit notes of the parties listed, once each. */
export function collect(invoices: readonly Invoice[], window: Window, today: string): Map<string, Bucket> {
	const buckets = new Map<string, Bucket>();
	const bucketOf = (invoice: Invoice): Bucket => {
		const key = bucketKey(invoice);
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			const side = invoice.side === undefined ? {} : { side: invoice.side };
			bucket = { key, ...side, customer: invoice.customer, suppliers: [], rows: [], overdue: [], undated: [], credits: [] };
			buckets.set(key, bucket);
		}
		return bucket;
	};
	const fromToday = window.overdue && window.from !== undefined;
	const inWindow = (due: string) => {
		if (window.from === undefined || window.to === undefined) return false;
		// From today, what is due before but payable from today on (a weekend just gone) is in it too.
		return fromToday ? due <= window.to : due >= window.from && due <= window.to;
	};
	for (const invoice of invoices) {
		if (invoice.credit || invoice.doc.integration) continue;
		for (const instalment of invoice.instalments) {
			if (instalment.paid !== undefined || instalment.extra === true) continue;
			const row = { invoice, instalment };
			const due = instalment.due;
			if (due === undefined) {
				if (fromToday) bucketOf(invoice).undated.push(row);
				continue;
			}
			if (window.overdue && payDay(due) < today) bucketOf(invoice).overdue.push(row);
			else if (inWindow(due)) bucketOf(invoice).rows.push(row);
			else continue;
			addParty(bucketOf(invoice).suppliers, invoice.supplier);
		}
	}
	for (const invoice of invoices) {
		if (!invoice.credit || invoice.paid || invoice.doc.integration) continue;
		const bucket = buckets.get(bucketKey(invoice));
		if (bucket === undefined) continue;
		const listed = [...bucket.rows, ...bucket.overdue].some((r) => partyKey(otherParty(r.invoice)) === partyKey(otherParty(invoice)));
		if (listed) bucket.credits.push({ invoice, units: openAmount(invoice) });
	}
	return buckets;
}

/** To pay, to collect, then the directions by amount (euros), then by name. */
export function bucketOrder(a: Bucket, b: Bucket): number {
	const rank = (x: Bucket) => (x.side === "passive" ? 0 : x.side === "active" ? 1 : 2);
	const euros = (x: Bucket) => eur(rowSums([...x.rows, ...x.overdue]));
	return rank(a) - rank(b) || Number(euros(b) - euros(a)) || byName(partyName(a.customer), partyName(b.customer));
}

/** «Fino a domenica 25/10: da pagare 3.002,40 €, più 626,75 € già scaduti; da incassare 99,90 €.» */
export function summaryLine(window: Window, buckets: readonly Bucket[], more: number): string {
	const parts: string[] = [];
	for (const bucket of buckets) {
		if (bucket.rows.length + bucket.overdue.length === 0) continue;
		const label = bucket.side === undefined ? `${bucketLabel(bucket)}:` : bucketLabel(bucket);
		const within = bucket.rows.length === 0 ? "niente in scadenza" : rowsText(bucket.rows);
		if (window.from === undefined) parts.push(`${label} ${rowsText(bucket.overdue)}`);
		else parts.push(`${label} ${within}${bucket.overdue.length === 0 ? "" : `, più ${rowsText(bucket.overdue)} già scaduti`}`);
	}
	if (parts.length === 0) return window.from === undefined ? "Nessuna fattura scaduta e non segnata pagata." : `${window.lead}: nessuna rata aperta.`;
	const rest = more > 0 ? `; e altri ${more} gruppi` : "";
	return `${window.lead}: ${parts.join("; ")}${rest}.`;
}

export function rowSums(rows: readonly Row[]): Sums {
	const sums: Sums = new Map();
	for (const r of rows) if (r.instalment.amount !== undefined) addTo(sums, r.invoice.doc.currency, r.instalment.amount);
	return sums;
}

/** The sum of rows, by currency; with «(più importi non leggibili)» when some amount does not read. */
export function rowsText(rows: readonly Row[]): string {
	return `${sumsText(rowSums(rows))}${rows.some((r) => r.instalment.amount === undefined) ? " (più importi non leggibili)" : ""}`;
}

/**
 * «Totale da pagare, scadute comprese: 3.529,15 € (3.629,15 € meno la nota di credito di 100,00 €)»:
 * said when something is overdue or a credit note comes off. Each party's credit notes come off
 * its own rows only, never below zero, in a window from today (it holds everything due until its
 * end); a month or a from/to window lists them without taking them off, or each window would.
 */
export function totalLine(bucket: Bucket, fromToday: boolean): string | undefined {
	const credits = fromToday ? bucket.credits : [];
	if (bucket.overdue.length === 0 && credits.length === 0) return undefined;
	const rows = [...bucket.rows, ...bucket.overdue];
	if (rows.length === 0) return undefined;
	const parties = new Map<string, { rows: Row[]; credits: Credit[] }>();
	const of = (invoice: Invoice) => {
		const key = partyKey(otherParty(invoice));
		const entry = parties.get(key) ?? { rows: [], credits: [] };
		parties.set(key, entry);
		return entry;
	};
	for (const row of rows) of(row.invoice).rows.push(row);
	for (const credit of credits) of(credit.invoice).credits.push(credit);
	const shares = [...parties.values()].map((p): Share => ({ gross: rowSums(p.rows), credit: creditSums(p.credits), notes: p.credits.length }));
	return `Totale ${bucketLabel(bucket)}${bucket.overdue.length === 0 ? "" : ", scadute comprese"}: ${nettedText(netted(shares))}.`;
}

/**
 * «• lun 12/10 (da 5 giorni): 626,75 € ad Alfa Forniture S.r.l., fatt. 2026/0153 rata 1/2». Late
 * from the day the payment can be made; a weekend or holiday with the day it moves to. No name
 * when the answer is about one party, or the section already says it.
 */
export function dueRow(row: Row, bucket: Bucket, context: { readonly today: string; readonly oneParty: boolean; readonly timeZone: string }): string {
	const { invoice, instalment } = row;
	const { today } = context;
	const due = instalment.due;
	let when: string;
	if (due === undefined) when = instalment.dueText === undefined ? "senza scadenza" : `scadenza ${instalment.dueText} (data non valida)`;
	else when = `${dayShort(due, today)}${dueNote(due, today)}`;
	let who = "";
	if (!context.oneParty) {
		if (invoice.side === "passive") who = ` ${to(partyName(invoice.supplier))}`;
		else if (invoice.side === "active") who = ` da ${partyName(invoice.customer)}`;
		else if (bucket.suppliers.length > 1) who = `, fornitore ${partyName(invoice.supplier)}`;
	}
	const count = invoice.instalments.length;
	const rata = count > 1 ? ` rata ${instalment.n}/${count}` : "";
	const flags = invoice.mismatch ? " (rate che non tornano con il totale)" : "";
	const reminded = remindedText(invoice, (at) => dayMonth(todayIn(context.timeZone, new Date(at)), today));
	return `• ${when}: ${amountText(instalment, invoice.doc.currency)}${who}, ${docShort(invoice, today)}${rata}${flags}${reminded === undefined ? "" : `; ${reminded}`}`;
}

/** «sollecitata 2 volte, l'ultima il 12/10» (reminder-book.ts). */
export function remindedText(invoice: Invoice, day: (at: string) => string): string | undefined {
	const sent = invoice.reminders ?? [];
	const last = sent.at(-1);
	if (last === undefined) return undefined;
	return sent.length === 1 ? `sollecitata il ${day(last.at)}` : `sollecitata ${sent.length} volte, l'ultima il ${day(last.at)}`;
}

/** « (da 5 giorni)», « (oggi)», « (slitta a lun 02/11)», « (festivo, Immacolata: slitta a mer 09/12)». */
export function dueNote(due: string, today: string): string {
	const late = daysBetween(payDay(due), today);
	if (late > 0) return late === 1 ? " (da ieri)" : ` (da ${late} giorni)`;
	const slip = paymentSlip(due);
	if (slip !== undefined) {
		const day = (d: string) => (d === today ? "oggi" : dayShort(d, today));
		return ` (${slipPhrase(due, slip, { day, holiday: shortHoliday, compact: true })})`;
	}
	return due === today ? " (oggi)" : "";
}

export const SHORT_HOLIDAYS: Readonly<Record<string, string>> = {
	"Immacolata Concezione": "Immacolata",
	"Lunedì dell'Angelo (Pasquetta)": "Pasquetta",
	"San Francesco d'Assisi, patrono d'Italia": "San Francesco",
	"Festa della Liberazione": "Liberazione",
};

export function shortHoliday(name: string): string {
	return SHORT_HOLIDAYS[name] ?? name;
}

/** «nota di credito NC 2026/9 del 05/10 di Alfa Forniture S.r.l. da scalare: 100,00 €». */
export function creditLine(credit: Credit, oneParty: boolean, today: string): string {
	const { invoice } = credit;
	const of = oneParty ? "" : invoice.side === "active" ? ` a ${partyName(invoice.customer)}` : ` di ${partyName(invoice.supplier)}`;
	const negative = invoice.negative ? " (fattura con importo negativo, conta come nota di credito)" : "";
	return `${docLabel(invoice, today)}${of}${negative} da scalare: ${money(fromUnits(credit.units), invoice.doc.currency)}`;
}
