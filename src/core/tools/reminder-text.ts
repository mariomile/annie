/**
 * The letter of a payment reminder (sollecito) to a customer who is late: polite (1), firmer (2)
 * or formal (3); who owes is reminder-debtors.ts, the rate, IBAN and address reminder-sources.ts.
 * The amount asked is what is overdue less that customer's credit notes, never below zero (the
 * same netting as the totals, invoice-sums.ts). Late counts from the day a payment could be
 * made: a due date on a weekend or a holiday is late only after the next working day.
 * Interest only at a rate the person gives, exact; the €40 of art. 6 D.Lgs. 231/2002 only when
 * asked, and only to a business or a public body. The IBAN to pay to is the company's own, as
 * saved; the address is the one the person gave or saved. What the files say is a fallback, said.
 */
import type { FatturaParty } from "../fattura-pa.ts";
import { addTo, type Invoice, type Sums } from "../invoices.ts";
import { isZero, payDay, sumsText, unitsText } from "../invoice-sums.ts";
import { holidayOn } from "../italian-calendar.ts";
import { italianDate, italianWeekday } from "../italian-format.ts";
import { bookKey, type ReminderItem, type ReminderLevel } from "../reminder-book.ts";
import { asideSums, type Debtor, invoicesOf, isLate, lastFormal, levelOf, type OverdueRow, owedDetail, remindedOn } from "./reminder-debtors.ts";
import { ofRate, type Payment, type Rate, type Recipient, simpleInterest } from "./reminder-sources.ts";

/** Customers reminded in one call; the rest are counted. */
export const MAX_REMINDERS = 10;
/** Invoice numbers in a subject before «e altre N». */
const MAX_SUBJECT_NUMBERS = 3;
/** The flat compensation per invoice paid late, art. 6 D.Lgs. 231/2002, in hundred-millionths of a euro. */
const COMPENSATION = 40n * 100_000_000n;
/** Days to pay asked by the firmer and the formal reminder, unless the person says otherwise. */
const PAY_WITHIN: Readonly<Record<2 | 3, number>> = { 2: 7, 3: 15 };
export const MAX_NOTE = 500;

export const LEVEL_NAMES: Readonly<Record<ReminderLevel, string>> = { 1: "primo sollecito, cortese", 2: "secondo sollecito, più fermo", 3: "sollecito formale" };

/** What the person asked to put in the reminder. */
export type ReminderTerms = {
	readonly level?: ReminderLevel;
	/** The €40 per invoice of art. 6 D.Lgs. 231/2002: only when the person asks. */
	readonly compensation?: boolean;
	readonly rate?: Rate;
	/** Days to pay, for the firmer and the formal one. */
	readonly payWithin?: number;
	/** A paragraph of the person's own. */
	readonly note?: string;
};

/** What a letter needs besides the debtor: today, who signs, where to pay, who it goes to, how to tell a local day. */
type ReminderContext = {
	readonly today: string;
	/** The company's name as saved: never one read from a file. */
	readonly sender?: string;
	readonly signature?: string;
	/** The company's partita IVA, to sign with when neither a name nor a signature is saved. */
	readonly vat?: string;
	readonly payment: Payment;
	readonly recipient: Recipient;
	readonly dayOf: (at: string) => string;
};

/** A reminder written: the mail, its recipient when known, what to record once it is sent, what to tell the person. */
export type ReminderDraft = {
	readonly debtor: Debtor;
	readonly level: ReminderLevel;
	readonly late: boolean;
	readonly items: readonly ReminderItem[];
	readonly subject: string;
	readonly body: string;
	readonly to?: string;
	readonly toFrom?: Recipient["from"];
	/** What the amount asked is, for the person. */
	readonly net: Sums;
	/** Remarks for the person: the address, the IBAN, compensation or interest left out, reminders already sent. */
	readonly notes: readonly string[];
};

/** A name from the files on one line, at most 80 characters (FatturaPA's own limit). */
export function oneLine(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function nameOf(party: FatturaParty): string {
	return party.name === undefined || party.name.trim() === "" ? "Cliente" : oneLine(party.name);
}

function numberOf(invoice: Invoice): string {
	return invoice.doc.number === undefined ? "senza numero" : oneLine(invoice.doc.number, 40);
}

/** «n. B-77 del 01/10/2026». */
function invoiceRef(invoice: Invoice): string {
	return `n. ${numberOf(invoice)}${invoice.doc.date === undefined ? "" : ` del ${italianDate(invoice.doc.date)}`}`;
}

/** «sabato: pagabile dal 12/10/2026», «festivo: pagabile dal 09/12/2026» when the due date moved. */
function slipText(due: string): string | undefined {
	const to = payDay(due);
	if (to === due) return undefined;
	return `${holidayOn(due) === undefined ? italianWeekday(due) : "festivo"}: pagabile dal ${italianDate(to)}`;
}

/** «- fattura n. B-77 del 01/10/2026, rata 1/2, scaduta il 10/10/2026 (sabato: pagabile dal 12/10/2026; 6 giorni di ritardo): 99,90 €». */
function rowLine(row: OverdueRow): string {
	const { invoice, instalment, days } = row;
	const count = invoice.instalments.length;
	const rata = count > 1 ? `, rata ${instalment.n}/${count}` : "";
	let due = "";
	if (instalment.due !== undefined) {
		const slip = slipText(instalment.due);
		const late = days > 0 ? `${days === 1 ? "un giorno" : `${days} giorni`} di ritardo` : undefined;
		const why = [slip, late].filter((x) => x !== undefined).join("; ");
		due = `, ${days > 0 ? "scaduta" : "in scadenza"} il ${italianDate(instalment.due)}${why === "" ? "" : ` (${why})`}`;
	}
	return `- fattura ${invoiceRef(invoice)}${rata}${due}: ${unitsText(instalment.amount as bigint, invoice.doc.currency)}`;
}

/** The subject: who writes, what it is, and the invoices («fatture n. 12, 15 e altre 2»). */
function subjectOf(level: ReminderLevel, late: boolean, invoices: readonly Invoice[], sender: string | undefined): string {
	const numbers = invoices.slice(0, MAX_SUBJECT_NUMBERS).map(numberOf);
	const more = invoices.length - numbers.length;
	const which = invoices.length === 1 ? `fattura n. ${numbers[0]}` : `fatture n. ${numbers.join(", ")}${more > 0 ? ` e altre ${more}` : ""}`;
	const head = !late ? "promemoria di scadenza" : level === 1 ? "promemoria di pagamento" : level === 2 ? "secondo sollecito di pagamento" : "sollecito formale di pagamento";
	if (sender !== undefined && sender.trim() !== "") return `${oneLine(sender, 60)}: ${head} ${which}`;
	return `${head.charAt(0).toUpperCase()}${head.slice(1)} ${which}`;
}

/** A person, not a business nor a public body: no partita IVA, no numeric codice fiscale. */
function isPrivate(debtor: Debtor): boolean {
	const { customer } = debtor;
	return customer.vat === undefined && !/^\d{11}$/.test(customer.fiscal ?? "") && !invoicesOf(debtor).some((i) => i.publicAdmin === true);
}

/** The phrases of a letter, to a business (voi) or to a person (Lei). */
type Voice = {
	readonly greeting: (name: string) => string;
	readonly remind: string;
	readonly recall: string;
	readonly formally: string;
	readonly askKindly: string;
	readonly askWithin: (days: number) => string;
	readonly payBy: string;
	readonly paidPolite: string;
	readonly paidFirm: string;
	readonly paidFormal: string;
};

const BUSINESS: Voice = {
	greeting: (name) => `Spett.le ${name},`,
	remind: "vi scriviamo per ricordarvi che",
	recall: "vi ricordiamo",
	formally: "con la presente vi invitiamo formalmente a pagare quanto ancora dovuto",
	askKindly: "Vi chiediamo cortesemente di provvedere al pagamento",
	askWithin: (days) => `Vi chiediamo di provvedere al pagamento entro ${days} giorni dal ricevimento di questa mail.`,
	payBy: "Potete pagare con bonifico",
	paidPolite: "Se avete già provveduto al pagamento, non tenete conto di questo messaggio. Grazie.",
	paidFirm: "Se avete già pagato, non tenete conto di questo messaggio e mandateci gli estremi del pagamento.",
	paidFormal: "Se avete già pagato, non tenete conto di questa comunicazione e mandateci gli estremi del pagamento.",
};

const PERSON: Voice = {
	greeting: (name) => `Gentile ${name},`,
	remind: "Le scriviamo per ricordarLe che",
	recall: "Le ricordiamo",
	formally: "con la presente La invitiamo formalmente a pagare quanto ancora dovuto",
	askKindly: "Le chiediamo cortesemente di provvedere al pagamento",
	askWithin: (days) => `Le chiediamo di provvedere al pagamento entro ${days} giorni dal ricevimento di questa mail.`,
	payBy: "Può pagare con bonifico",
	paidPolite: "Se ha già provveduto al pagamento, non tenga conto di questo messaggio. Grazie.",
	paidFirm: "Se ha già pagato, non tenga conto di questo messaggio e ci mandi gli estremi del pagamento.",
	paidFormal: "Se ha già pagato, non tenga conto di questa comunicazione e ci mandi gli estremi del pagamento.",
};

/** The opening and the rows: what was already reminded apart from what was not (M3); the not yet due as a neutral reminder. */
function opening(level: ReminderLevel, late: boolean, debtor: Debtor, voice: Voice): string[] {
	if (!late) {
		const dates = [...new Set(debtor.rows.map((r) => r.instalment.due).filter((d): d is string => d !== undefined))];
		const when = dates.length === 1 ? `la scadenza del ${italianDate(dates[0] as string)}` : "le prossime scadenze";
		return [`${voice.recall} ${when} per:`, ...debtor.rows.map(rowLine)];
	}
	const reminded = debtor.rows.filter((r) => (r.invoice.reminders ?? []).length > 0);
	const fresh = debtor.rows.filter((r) => (r.invoice.reminders ?? []).length === 0);
	if (level === 1 || reminded.length === 0) {
		const head = level === 3 ? `${voice.formally}:` : level === 2 ? `${voice.recall} che non ci risulta ancora il pagamento di:` : `${voice.remind} non ci risulta ancora il pagamento di:`;
		return [head, ...debtor.rows.map(rowLine)];
	}
	const first = level === 3 ? `${voice.formally}, già sollecitato in precedenza:` : "nonostante il nostro precedente sollecito, non ci risulta ancora il pagamento di:";
	const then = fresh.length === 0 ? [] : [level === 3 ? "e inoltre:" : "Non ci risulta inoltre il pagamento di:", ...fresh.map(rowLine)];
	return [first, ...reminded.map(rowLine), ...then];
}

/**
 * The reminder for one debtor. A debtor with nothing late gets only a neutral level-1 reminder
 * of the due date. The level is the one asked, else one past those recorded.
 */
export function composeReminder(debtor: Debtor, terms: ReminderTerms, context: ReminderContext): ReminderDraft {
	const late = isLate(debtor);
	const level: ReminderLevel = late ? levelOf(debtor, terms.level) : 1;
	const invoices = invoicesOf(debtor);
	const voice = isPrivate(debtor) ? PERSON : BUSINESS;
	const { gross, applied, net } = owedDetail(debtor);
	const notes: string[] = [];
	if (debtor.upcoming.length > 0) {
		const which = debtor.upcoming.map((r) => `fattura n. ${numberOf(r.invoice)}${r.invoice.instalments.length > 1 ? ` rata ${r.instalment.n}/${r.invoice.instalments.length}` : ""}${r.instalment.due === undefined ? "" : ` (scade il ${italianDate(r.instalment.due)})`}`);
		notes.push(`non ancora scadute, quindi non nel sollecito: ${which.join(", ")}`);
	}
	const aside = asideSums(debtor);
	if (!isZero(aside)) notes.push(`il cliente ha note di credito per ${sumsText(aside)} da regolare: non le ho scalate, perché questo sollecito non copre tutto il suo scaduto`);
	const credits = debtor.credits.filter((c) => c.units > 0n);
	let total = `Totale da saldare: ${sumsText(net)}`;
	if (credits.length > 0 && !isZero(applied)) {
		const which = credits.length === 1 ? `la nota di credito ${invoiceRef(credits[0]?.invoice as Invoice)}` : `le note di credito ${credits.map((c) => `n. ${numberOf(c.invoice)}`).join(", ")}`;
		total += ` (${sumsText(gross)} meno ${which}, ${sumsText(applied)})`;
	}
	const extras: string[] = [];
	const all: Sums = new Map(net);
	let extra = false;
	if (terms.rate !== undefined) {
		const rate = terms.rate;
		const lateRows = debtor.rows.filter((r) => r.days > 0);
		if (lateRows.length === 0) notes.push("nessuna rata è ancora in ritardo: niente interessi");
		else if (!isZero(applied)) {
			notes.push("non ho messo gli interessi: le note di credito di questo cliente cambiano l'importo su cui calcolarli; se servono, calcolali sull'importo netto e aggiungili con note");
		} else {
			const lines = lateRows.map((r) => {
				const currency = r.invoice.doc.currency;
				const units = simpleInterest(r.instalment.amount as bigint, rate, r.days);
				addTo(all, currency, units);
				return `- fattura n. ${numberOf(r.invoice)}${r.invoice.instalments.length > 1 ? ` rata ${r.instalment.n}` : ""}: ${unitsText(r.instalment.amount as bigint, currency)} × ${rate.text}% × ${r.days}/365 = ${unitsText(units, currency)}`;
			});
			extra = true;
			extras.push("", `Interessi di mora al tasso ${ofRate(rate)} annuo, calcolati in modo semplice sui giorni di ritardo a oggi (importo × tasso × giorni/365):`, ...lines);
		}
	}
	if (terms.compensation === true) {
		if (isPrivate(debtor)) {
			notes.push("il cliente non ha partita IVA in fattura: il forfait di 40 € vale solo tra imprese o con la pubblica amministrazione, non l'ho messo");
		} else {
			const count = invoices.filter((i) => debtor.rows.some((r) => r.invoice === i && r.days > 0)).length;
			if (count > 0) {
				const units = COMPENSATION * BigInt(count);
				addTo(all, "EUR", units);
				extra = true;
				const per = count === 1 ? "per la fattura in ritardo" : `per ${count} fatture in ritardo, 40,00 € × ${count}`;
				extras.push("", `Ai sensi dell'art. 6 del D.Lgs. 231/2002 ci spetta inoltre un importo forfettario di 40,00 € per ogni fattura pagata in ritardo, a titolo di risarcimento dei costi di recupero: ${per} = ${unitsText(units, "EUR")}.`);
			}
		}
	}
	if (extra) extras.push("", `In tutto: ${sumsText(all)}.`);
	const { ibans } = context.payment;
	if (context.payment.note !== undefined) notes.push(context.payment.note);
	const pay = ibans.length === 0 ? [] : ["", `${voice.payBy} ${ibans.length === 1 ? `all'IBAN ${ibans[0]}` : `a uno di questi IBAN: ${ibans.join(", ")}`}.`];
	const within = terms.payWithin ?? (level === 1 ? undefined : PAY_WITHIN[level]);
	const note = terms.note === undefined || terms.note.trim() === "" ? [] : ["", terms.note.trim()];
	let closing: string[];
	if (!late) closing = ["", `${voice.askKindly} entro la scadenza.`, "", voice.paidPolite, "", "Cordiali saluti"];
	else if (level === 1) closing = ["", `${voice.askKindly}.`, "", voice.paidPolite, "", "Cordiali saluti"];
	else if (level === 2) closing = ["", voice.askWithin(within as number), "", voice.paidFirm, "", "Cordiali saluti"];
	else {
		closing = [
			"",
			`Il pagamento va eseguito entro ${within} giorni dal ricevimento della presente, che vale come costituzione in mora ai sensi dell'art. 1219 del Codice civile, anche ai fini dell'interruzione della prescrizione (art. 2943 c.c.).`,
			"Trascorso questo termine senza pagamento, ci riserviamo di tutelare i nostri diritti nelle sedi opportune.",
			"",
			voice.paidFormal,
			"",
			"Distinti saluti",
		];
		notes.push("per valere come messa in mora serve una prova di ricezione: meglio PEC o raccomandata A/R");
	}
	const formal = lastFormal(debtor);
	if (formal !== undefined) notes.push(`il sollecito formale è già stato mandato il ${italianDate(context.dayOf(formal.at))}: di solito il passo successivo è un legale o il decreto ingiuntivo; chiedi prima di rimandarlo`);
	for (const invoice of remindedOn(debtor, context.today, context.dayOf)) notes.push(`un sollecito per la fattura n. ${numberOf(invoice)} è già annotato oggi`);
	if (invoices.some((i) => i.publicAdmin === true)) {
		notes.push("la fattura è verso una pubblica amministrazione: il sollecito va mandato via PEC all'ufficio che l'ha ricevuta (codice ufficio in fattura); con lo split payment l'importo chiesto è già senza l'IVA, che l'ente versa all'Erario");
	}
	notes.push(...context.recipient.notes);
	if (context.sender === undefined) notes.push("salva il nome dell'azienda con set_company (name): così compare nell'oggetto e nella firma");
	const signed = context.signature ?? context.sender ?? (context.vat === undefined ? "" : `P.IVA ${context.vat}`);
	const sign = signed.split("\n").map((l) => l.trim()).filter((l) => l !== "");
	const body = [voice.greeting(nameOf(debtor.customer)), "", ...opening(level, late, debtor, voice), "", `${total}.`, ...extras, ...pay, ...note, ...closing, ...sign].join("\n");
	const { to, from } = context.recipient;
	return {
		debtor,
		level,
		late,
		items: invoices.map((i): ReminderItem => ({ invoice: bookKey(i.key), level })),
		subject: subjectOf(level, late, invoices, context.sender),
		body,
		...(to === undefined ? {} : { to }),
		...(from === undefined ? {} : { toFrom: from }),
		net,
		notes,
	};
}

/** Whether a draft asks for anything: the credit notes may cover what is due. */
export function asksSomething(draft: ReminderDraft): boolean {
	return !isZero(draft.net);
}
