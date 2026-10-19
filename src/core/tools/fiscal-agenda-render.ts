/**
 * L'agenda fiscale in the chat, in the brief and in a .ics: every deadline in order with its day in
 * words, what it is, the amount when a register gives one (a stima said as such), where it comes
 * from; the open ones gone by first. Text for the person never names an op or a parameter. Names
 * of suppliers and renewals go only inside one fence, and never to another agente; the brief's line
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

/** Where a deadline comes from, in words. */
export const SOURCE_WORDS: Readonly<Record<AgendaSource, string>> = {
	tasse: "tasse e contributi",
	iva: "liquidazione IVA",
	ritenute: "ritenute",
	rinnovi: "rinnovi",
	fatture: "scadenzario",
	regole: "calendario fiscale",
};

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

/** What it is, without a name: for another agente a supplier's invoice and a renewal stay nameless. */
function whatWords(i: AgendaItem, named: boolean): string {
	if (named || i.name === undefined) return i.what;
	return i.source === "fatture" ? `${i.what} a un fornitore` : i.what;
}

const OVERDUE: Readonly<Record<AgendaSource, string>> = {
	tasse: "scaduto, non segnato pagato",
	iva: "scaduto, non segnato pagato",
	ritenute: "scaduto",
	rinnovi: "scaduto, non segnato pagato",
	fatture: "scaduta, non segnata pagata",
	regole: "scaduto",
};

/** One row: «• Lunedì 16 novembre: F24 IVA di ottobre 2026, stima 1.240,00 €, codice 6010 (liquidazione IVA)», the name after a colon when said. */
function row(i: AgendaItem, today: string, named: boolean): string {
	const bits = [whatWords(i, named), amountWords(i), i.code === undefined ? "" : `codice ${i.code}`, i.note ?? ""].filter((b) => b !== "");
	const late = i.overdue === true ? `: ${OVERDUE[i.source]}` : "";
	const name = named && i.name !== undefined ? `: ${i.name.replace(/\s+/g, " ")}` : "";
	return `• ${dayWords(i, today)}: ${bits.join(", ")} (${SOURCE_WORDS[i.source]})${late}${name}`;
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

/** The agenda of a window: the open ones gone by first, then in order; the rows with a name in one fence. */
export function upcomingAnswer(v: UpcomingView): string {
	const shown = v.items.slice(0, AGENDA_LIMITS.listed);
	const left = v.items.length - shown.length;
	const lines: string[] = [];
	if (v.items.length === 0) lines.push(`Nessuna scadenza ${v.window.words}, con quello che so.`);
	else {
		const overdue = shown.filter((i) => i.overdue === true).length;
		lines.push(`Scadenze ${v.window.words}: ${n1(v.items.length, "1", "#")}${overdue > 0 ? `, di cui ${n1(overdue, "1 già scaduta e non segnata pagata", "# già scadute e non segnate pagate")}` : ""}.`);
		const plain = shown.filter((i) => !(v.named && i.name !== undefined));
		const withNames = shown.filter((i) => v.named && i.name !== undefined);
		lines.push(...plain.map((i) => row(i, v.today, v.named)));
		if (withNames.length > 0) lines.push(`${plain.length > 0 ? "E i pagamenti" : "I pagamenti"} a fornitori e rinnovi (i nomi sono nel riquadro):`, fenced(withNames.map((i) => row(i, v.today, true)).join("\n")));
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
		return `${whatWords(i, false)} ${when}${amount === "" ? "" : `, ${amount}`}`;
	});
	return `Scadenze: ${rows.join("; ")}.${items.some((i) => i.estimate === true) ? " Gli importi sono stime da verificare con il commercialista." : ""} Nel brief riporta questo in una riga.`;
}

/** The deadlines as events of a .ics: the summary with the amount, the description with where it comes from; the UID from source, key and the day written. */
export function icsEvents(items: readonly AgendaItem[], remindDays: number | undefined): IcsEvent[] {
	return items.map((i) => {
		const amount = amountWords(i);
		const summary = `${i.what}${i.name === undefined ? "" : `: ${i.name.replace(/\s+/g, " ")}`}${amount === "" ? "" : ` (${amount})`}`;
		const description = [
			`Da: ${SOURCE_WORDS[i.source]} di Annie.`,
			i.code === undefined ? undefined : `Codice tributo ${i.code}.`,
			i.note === undefined ? undefined : `${capitalized(i.note)}.`,
			i.slip === undefined ? undefined : `La scadenza scritta è ${withDate("il", i.due)}: ${offDayWhy(i.due, i.slip.holiday)}, slitta al giorno lavorativo dopo.`,
			i.estimate === true ? "L'importo è una stima: verificala con il commercialista prima di pagare." : undefined,
		].filter((x) => x !== undefined);
		return { uid: icsUid([i.source, i.key, i.due]), date: i.date, summary, description: description.join("\n"), ...(remindDays === undefined ? {} : { remindDays }) };
	});
}

/** What the export says: the file, how many, the reminder, how to import it. */
export function exportAnswer(o: { readonly path: string; readonly count: number; readonly left: number; readonly window: Window; readonly remindDays?: number; readonly estimates: boolean; readonly notes: readonly string[] }): string {
	const remind = o.remindDays === undefined ? "senza avvisi" : o.remindDays === 0 ? "ognuna con un avviso alle 9 del giorno stesso" : `ognuna con un avviso ${n1(o.remindDays, "1 giorno", "# giorni")} prima, alle 9`;
	const lines = [
		`Salvato ${o.path}: ${n1(o.count, "1 scadenza", "# scadenze")} ${o.window.words}, ${remind}, ciascuna come evento di un giorno intero.`,
		"Si importa in Google Calendar, Outlook o Calendario di Apple (Importa, poi scegli il file): io non scrivo nel calendario di nessuno. Se lo importi di nuovo, le stesse scadenze si aggiornano invece di raddoppiare.",
	];
	if (o.left > 0) lines.push(`Ne ho lasciate fuori ${o.left}: il file ne tiene al massimo ${AGENDA_LIMITS.events}, chiedimi un periodo più corto.`);
	lines.push(...o.notes);
	if (o.estimates) lines.push(ESTIMATE_NOTE);
	lines.push("Mandalo con file_send se chi ti scrive lo vuole.");
	return lines.join("\n");
}
