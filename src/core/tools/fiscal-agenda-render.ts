/**
 * L'agenda fiscale in the chat, in the brief and in a .ics: every deadline in order with its day in
 * words, what it is, the amount when a register gives one (a stima said as such); the open ones
 * gone by first; where it comes from only in the .ics description. Text for the person never names an op or a parameter. Names
 * of suppliers and renewals go only inside one fence (the whole list, so the order stays), and never to another agente; the brief's line
 * carries none. The .ics is the person's own file: the names and amounts are in it, escaped by
 * ics.ts.
 */
import { offDayWhy } from "../dates.ts";
import { type AgendaItem, AGENDA_LIMITS, type AgendaSource } from "../fiscal-agenda.ts";
import { euros, n1 } from "../format-words.ts";
import { type IcsEvent, icsUid } from "../ics.ts";
import { daysBetween } from "../italian-calendar.ts";
import { capitalized, italianDay, withDate, withNearDate } from "../italian-format.ts";
import { fenced, type Window } from "./fiscal-agenda-input.ts";

export const ESTIMATE_NOTE = "Gli importi con «stima» sono stime: verificale con il commercialista prima di pagare.";
const REPEAT = "Ripeti cifre e date come sono scritte, non rifare i conti a mente.";
export const BRIEF_NOTHING = "Niente da segnalare sulle scadenze: nel brief non scrivere niente sull'agenda fiscale.";

/** Where a deadline comes from, for a calendar's description: «Dai rinnovi di Annie.». The chat does not say it. */
export const SOURCE_FROM: Readonly<Record<AgendaSource, string>> = {
	tasse: "Dalle tasse e dai contributi di Annie.",
	iva: "Dalla liquidazione IVA di Annie.",
	ritenute: "Dalle ritenute di Annie.",
	rinnovi: "Dai rinnovi di Annie.",
	fatture: "Dallo scadenzario di Annie.",
	regole: "Dal calendario fiscale di Annie.",
};

/** The sources of the fiscal deadlines proper, for «La prossima scadenza fiscale»: not a supplier's invoice nor a renewal. */
const FISCAL: readonly AgendaSource[] = ["tasse", "iva", "ritenute", "regole"];

/** «Lunedì 16 novembre», «Martedì 2 marzo 2027», with why it moved: «(il 15 cade di domenica)». */
export function dayWords(i: Pick<AgendaItem, "date" | "due" | "slip">, today: string): string {
	const day = `${capitalized(italianDay(i.date))}${i.date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${i.date.slice(0, 4)}`}`;
	if (i.slip === undefined) return day;
	const was = withDate("il", i.due).replace(i.due.slice(0, 7) === i.date.slice(0, 7) ? / \S+ \d{4}$/ : / \d{4}$/, "");
	return `${day} (${was} ${offDayWhy(i.due, i.slip.holiday)})`;
}

/** «stima 1.240,00 €», «300,00 €», «stima 80,00 € finora», «importo ancora da calcolare»; empty without one. */
export function amountWords(i: AgendaItem): string {
	if (i.cents === undefined || i.cents <= 0n) return i.source === "tasse" && i.partial === true ? "importo ancora da calcolare" : i.source === "iva" ? "importo ancora da calcolare" : "";
	const more = i.partial !== true ? "" : i.source === "tasse" ? " più una parte da calcolare" : " finora";
	return `${i.estimate === true ? "stima " : ""}${euros(i.cents)}${more}`;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * What it is, with the name when said: «fattura da pagare a Fornitore Uno Srl, n. A2», «Adobe CC si
 * rinnova da solo, poi da pagare», «Hosting, rinnovo da pagare». For another agente a supplier and a
 * renewal stay nameless: «fattura da pagare a un fornitore».
 */
function whatWords(i: AgendaItem, named: boolean): string {
	if (i.name === undefined) return i.what;
	if (i.source === "fatture") return named ? `${i.what} a ${oneLine(i.name)}${i.ref === undefined ? "" : `, n. ${oneLine(i.ref)}`}` : `${i.what} a un fornitore`;
	if (!named) return i.what.startsWith("si ") ? `un rinnovo ${i.what}` : i.what;
	return i.what.startsWith("si ") ? `${oneLine(i.name)} ${i.what}` : `${oneLine(i.name)}, ${i.what}`;
}

/** An open deadline gone by: only a source that tracks payment says one. */
const OVERDUE: Readonly<Record<AgendaSource, string>> = {
	tasse: "scaduto e non segnato pagato",
	iva: "scaduto e non segnato pagato",
	ritenute: "scaduto",
	rinnovi: "scaduto e non segnato pagato",
	fatture: "scaduta e non segnata pagata",
	regole: "scaduto",
};

/** One row: «• Lunedì 16 novembre: F24 IVA di ottobre 2026, stima 1.240,00 €, codice 6010»; gone by: «• Lunedì 5 ottobre, scaduta e non segnata pagata: fattura da pagare a Fornitore Uno Srl, n. A2, 305,00 €». */
function row(i: AgendaItem, today: string, named: boolean): string {
	const bits = [whatWords(i, named), amountWords(i), i.code === undefined ? "" : `codice ${i.code}`, i.note ?? ""].filter((b) => b !== "");
	const late = i.overdue === true ? `, ${OVERDUE[i.source]}` : "";
	return `• ${dayWords(i, today)}${late}: ${bits.join(", ")}`;
}

/** «La prossima scadenza fiscale: lunedì 2 novembre, dichiarazione dei redditi 2025.»: the first fiscal deadline not gone by; undefined: none. */
function nextFiscal(items: readonly AgendaItem[]): AgendaItem | undefined {
	return items.find((i) => i.overdue !== true && FISCAL.includes(i.source));
}

export type UpcomingView = {
	readonly items: readonly AgendaItem[];
	readonly window: Window;
	readonly today: string;
	/** False for another agente: no names, no fence. */
	readonly named: boolean;
	/** A register that does not read, said in one line each. */
	readonly notes: readonly string[];
	/** What would add more deadlines, in one line. */
	readonly more?: string;
};

/**
 * The agenda of a window: the next fiscal deadline first (unless a period's list starts with it),
 * then the open ones gone by, then in order. With a name among the rows the whole list goes in one
 * fence, still in order; without, plain.
 */
export function upcomingAnswer(v: UpcomingView): string {
	const shown = v.items.slice(0, AGENDA_LIMITS.listed);
	const left = v.items.length - shown.length;
	const lines: string[] = [];
	const next = nextFiscal(v.items);
	if (next !== undefined && !(v.window.period && shown[0] === next)) lines.push(`La prossima scadenza fiscale: ${italianDay(next.date)}${next.date.slice(0, 4) === v.today.slice(0, 4) ? "" : ` ${next.date.slice(0, 4)}`}, ${next.title}.`);
	if (v.items.length === 0) lines.push(`Nessuna scadenza ${v.window.words}, con quello che so.`);
	else {
		const overdue = shown.filter((i) => i.overdue === true).length;
		lines.push(`Scadenze ${v.window.words}: ${n1(v.items.length, "1", "#")}${overdue > 0 ? `, di cui ${n1(overdue, "1 già scaduta e non segnata pagata", "# già scadute e non segnate pagate")}` : ""}.`);
		const rows = shown.map((i) => row(i, v.today, v.named));
		if (v.named && shown.some((i) => i.name !== undefined)) lines.push("Le scadenze, in ordine (i nomi di fornitori e rinnovi sono nel riquadro):", fenced(rows.join("\n")));
		else lines.push(...rows);
		if (left > 0) lines.push(`E altre ${left}: chiedimi un periodo più corto per vederle.`);
	}
	if (v.window.period && v.window.from < v.today) lines.push("Le scadenze già passate le dico solo dove so se sono state pagate.");
	lines.push(...v.notes);
	if (v.more !== undefined) lines.push(v.more);
	if (shown.some((i) => i.estimate === true)) lines.push(ESTIMATE_NOTE);
	if (shown.some((i) => i.cents !== undefined)) lines.push(REPEAT);
	return lines.join("\n");
}

/** «oggi», «domani», «tra 5 giorni». */
function inDays(date: string, today: string): string {
	const days = daysBetween(today, date);
	return days === 0 ? "oggi" : days === 1 ? "domani" : `tra ${days} giorni`;
}

/** The brief's line: the deadlines of the next days no other brief line says, in one line; no names. */
export function briefLine(items: readonly AgendaItem[], today: string): string {
	if (items.length === 0) return BRIEF_NOTHING;
	const rows = items.map((i) => {
		const amount = amountWords(i);
		const when = i.overdue === true ? `${OVERDUE[i.source]} ${withNearDate("il", i.date, today)}` : `${withNearDate("il", i.date, today)} (${inDays(i.date, today)})`;
		return `${i.name === undefined ? i.title : whatWords(i, false)} ${when}${amount === "" ? "" : `, ${amount}`}`;
	});
	return `Scadenze: ${rows.join("; ")}.${items.some((i) => i.estimate === true) ? " Gli importi sono stime da verificare con il commercialista." : ""} Nel brief riporta questo in una riga.`;
}

/**
 * A calendar's title, short, the name first: «Adobe CC: rinnovo automatico (120,00 €)», «Fornitore
 * Uno Srl n. A1: fattura da pagare (1.220,00 €)», «F24 bollo fatture 3º trim. 2026 (4,00 €)»,
 * «Dichiarazione dei redditi 2025: invio».
 */
export function icsSummary(i: AgendaItem): string {
	const amount = amountWords(i);
	const head = i.name === undefined ? capitalized(i.title) : `${oneLine(i.name)}${i.ref === undefined ? "" : ` n. ${oneLine(i.ref)}`}: ${i.title}`;
	return `${head}${i.filing === true ? ": invio" : ""}${amount === "" ? "" : ` (${amount})`}`;
}

/** The deadlines as events of a .ics: the short title, the long text in the description with where it comes from; the UID from source, key and the day written. */
export function icsEvents(items: readonly AgendaItem[], remindDays: number | undefined): IcsEvent[] {
	return items.map((i) => {
		const description = [
			// The long text when the title shortened it.
			i.what === i.title ? undefined : `${capitalized(i.what)}.`,
			SOURCE_FROM[i.source],
			i.code === undefined ? undefined : `Codice tributo ${i.code}.`,
			i.note === undefined ? undefined : `${capitalized(i.note)}.`,
			i.slip === undefined ? undefined : `La scadenza scritta è ${withDate("il", i.due)}: ${offDayWhy(i.due, i.slip.holiday)}, slitta al giorno lavorativo dopo.`,
			i.estimate === true ? "L'importo è una stima: verificala con il commercialista prima di pagare." : undefined,
		].filter((x) => x !== undefined);
		return { uid: icsUid([i.source, i.key, i.due]), date: i.date, summary: icsSummary(i), description: description.join("\n"), ...(remindDays === undefined ? {} : { remindDays }) };
	});
}

export const IMPORT_HOWTO = "Sul telefono, l'iPhone lo apre con Calendario («Aggiungi tutto»). Google Calendar lo importa solo dal computer (Impostazioni, Importa) e lì gli avvisi diventano quelli predefiniti del calendario. Il file non tocca il tuo calendario finché non lo importi.";
export const REIMPORT = "Se lo importi di nuovo, di solito il calendario riconosce le stesse scadenze e non le raddoppia.";

/** What the export says: the file, how many, the reminder when asked, how to import it. */
export function exportAnswer(o: { readonly path: string; readonly count: number; readonly left: number; readonly window: Window; readonly remindDays?: number; readonly estimates: boolean; readonly notes: readonly string[] }): string {
	const remind = o.remindDays === undefined ? "" : o.remindDays === 0 ? " con un avviso alle 9 del giorno stesso" : ` con un avviso ${n1(o.remindDays, "1 giorno", "# giorni")} prima alle 9`;
	const lines = [`Salvato ${o.path}: ${n1(o.count, "1 scadenza", "# scadenze")} ${o.window.words}, come eventi di un giorno intero${remind}.`, IMPORT_HOWTO, REIMPORT];
	if (o.left > 0) lines.push(`Ne ho lasciate fuori ${o.left}: il file ne tiene al massimo ${AGENDA_LIMITS.events}, chiedimi un periodo più corto.`);
	lines.push(...o.notes);
	if (o.estimates) lines.push(ESTIMATE_NOTE);
	lines.push("Mandalo con file_send se chi ti scrive lo vuole.");
	return lines.join("\n");
}
