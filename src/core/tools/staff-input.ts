/**
 * What the person says about il personale, read and checked: the person named (the name, the first
 * name alone, or PE-0001), the days («dal 3 al 14 agosto», «domani», «da oggi», «lunedì scorso»,
 * read back or ahead as the field wants: a day of extra hours or of a balance is past, an absence's
 * day the nearest, asked when unclear, and a year not this one said), a time («dalle 15»), the
 * hours («2 ore», «un'ora e mezza», 1.5), the usual week («lun-ven 9-13 e 14-18», the appointments'
 * own reader), a decimal of days or hours, the protocol of a certificate (digits), the reason of
 * an «altro» (a closed list), the absence named. What does not read comes back as the answer to
 * give, the words said in the fence.
 */
import { type Opening, timeOf } from "../appointments.ts";
import { type Candidate, findNamed } from "../client-find.ts";
import { DateError, readDate } from "../dates.ts";
import { addDays, daysBetween, weekdayOf } from "../italian-calendar.ts";
import { italianDate, italianLongDate } from "../italian-format.ts";
import { type Absence, ABSENCE_ID, type AltroReason, isActive, looksHealth, type Person, PERSON_ID, PROTOCOL, STAFF_LIMITS, type Week } from "../staff.ts";
import { isProblem, readAmount } from "../text-input.ts";
import { daySaid, isAnswer, timeSaid } from "./appointment-input.ts";
import { isBadWeek, weekSaid } from "./appointment-settings.ts";
import { fencedStaff } from "./staff-render.ts";

export type Answer = { readonly answer: string };
export { isAnswer };

const folded = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");

/** The person named: exact (a name, a first name only one has, PE-0001), or close (asked), or none. */
export function personSaid(raw: unknown, people: readonly Person[]): { readonly person: Person; readonly close?: true } | Answer {
	if (typeof raw !== "string" || raw.trim() === "" || raw.length > STAFF_LIMITS.name) return { answer: "Errore: dimmi di chi, con il nome." };
	const candidates: Candidate<Person>[] = people.map((p) => {
		const first = p.name.split(/\s+/)[0] as string;
		const shared = people.some((q) => q.id !== p.id && folded(q.name.split(/\s+/)[0] as string) === folded(first));
		return { item: p, names: shared ? [p.name] : [p.name, first], ids: [p.id] };
	});
	const r = findNamed(candidates, raw, STAFF_LIMITS.name, PERSON_ID);
	if (r.kind === "exact") return { person: r.item };
	if (r.kind === "close" && r.candidates.length === 1) return { person: r.candidates[0] as Person, close: true };
	if (r.kind === "close") return { answer: ["Errore: il nome va bene per più persone: dimmi quale.", fencedStaff(r.candidates.map((p) => `• ${p.name}`).join("\n"))].join("\n") };
	return { answer: ["Errore: non trovo questa persona tra il personale. Se è nuova, aggiungila con il nome, il ruolo e il suo orario di lavoro.", fencedStaff(raw.slice(0, STAFF_LIMITS.name))].join("\n") };
}

/**
 * Which way a day without its year (or a bare weekday) is read: "past", the latest up to today (a
 * day of extra hours, a balance, the start of a malattia); "next", the first from today (a bare
 * weekday: after today, as the first day of someone hired); "nearest",
 * the closer of the two, asked when both are about as far.
 */
export type Direction = "past" | "next" | "nearest";

const WEEKDAY_NAMES: Readonly<Record<string, number>> = { domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6 };
const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));
/** «il 3 agosto», «l'11 gennaio». */
const theDay = (day: string) => `${day.slice(8, 10) === "08" || day.slice(8, 10) === "11" ? "l'" : "il "}${italianLongDate(day).replace(/ \d{4}$/, "")}`;
/** Two readings about as far (less than this many days of difference) are asked. */
const UNCLEAR = 60;

/** A day said, and a note when the year read is not this one. */
export function staffDayNoted(raw: unknown, today: string, dir: Direction = "nearest"): { readonly day: string; readonly note?: string } | Answer {
	const bad = { answer: ["Errore: non capisco il giorno: dimmelo come «domani», «lunedì», «lunedì scorso» o 03/08/2026.", fencedStaff(String(raw ?? "").slice(0, 40))].join("\n") };
	if (typeof raw !== "string" || raw.trim() === "" || raw.length > 40) return bad;
	const t = folded(raw).replace(/^(?:da |dal |dall'|a |al |fino a |fino al |il |l')/, "");
	const near = (day: string): { day: string } | Answer => (daysBetween(day, today) > 400 ? { answer: "Errore: quel giorno è più di un anno fa: dimmi una data più vicina." } : { day });
	const fixed: Readonly<Record<string, string>> = {
		oggi: today,
		ieri: addDays(today, -1),
		domani: addDays(today, 1),
		dopodomani: addDays(today, 2),
		"altro ieri": addDays(today, -2),
		altroieri: addDays(today, -2),
		"la settimana scorsa": addDays(mondayOf(today), -7),
		"settimana scorsa": addDays(mondayOf(today), -7),
		"la settimana prossima": addDays(mondayOf(today), 7),
		"settimana prossima": addDays(mondayOf(today), 7),
	};
	if (fixed[t] !== undefined) return { day: fixed[t] as string };
	const wd = /^([a-z]+)(?: (scorso|scorsa|prossimo|prossima))?$/.exec(t);
	const n = wd === null ? undefined : WEEKDAY_NAMES[wd[1] as string];
	if (wd !== null && n !== undefined) {
		const back = wd[2] === "scorso" || wd[2] === "scorsa" || (wd[2] === undefined && dir === "past");
		if (back) {
			// «lunedì scorso»: the last before today; «lunedì» read back: today too.
			for (let d = wd[2] === undefined ? 0 : 1; d < 8; d++) if (weekdayOf(addDays(today, -d)) === n) return { day: addDays(today, -d) };
		}
		const d = daySaid(t, today);
		if (isAnswer(d)) return bad;
		// Read ahead, «lunedì» said on a Monday is the next one.
		return { day: dir === "next" && d === today ? addDays(d, 7) : d };
	}
	try {
		const ahead = readDate(t, today, { rule: "next" });
		if (ahead.warning !== undefined) return { answer: `Errore: ${ahead.warning}: dimmi quale dei due.` };
		if (!ahead.yearless) {
			if (daysBetween(today, ahead.date) > 366) return { answer: "Errore: quel giorno è più di un anno avanti: dimmi una data entro un anno." };
			return near(ahead.date);
		}
		const back = readDate(t, today, { rule: "past" }).date;
		const toNext = daysBetween(today, ahead.date);
		const toBack = daysBetween(back, today);
		let day = ahead.date;
		if (dir === "past") day = back;
		else if (dir === "nearest" && back !== ahead.date) {
			if (Math.abs(toNext - toBack) < UNCLEAR) return { answer: `Errore: ${theDay(ahead.date)} è quello già passato (${italianDate(back)}) o quello che viene (${italianDate(ahead.date)})? Dimmelo con l'anno.` };
			if (toBack < toNext) day = back;
		}
		const r = near(day);
		const year = Number(day.slice(0, 4)) - Number(today.slice(0, 4));
		if (isAnswer(r) || year === 0) return r;
		return { day, note: `Ho letto ${theDay(day)} come ${italianDate(day)}, ${year > 0 ? "dell'anno prossimo" : "dell'anno scorso"}: se intendevi un altro anno, dimmelo.` };
	} catch (error) {
		if (error instanceof DateError) return bad;
		throw error;
	}
}

/** A day said, the note left out. */
export function staffDay(raw: unknown, today: string, dir: Direction = "nearest"): string | Answer {
	const r = staffDayNoted(raw, today, dir);
	return isAnswer(r) ? r : r.day;
}

const WEEK_WORDS = /^(?:la )?settimana (?:scorsa|prossima)$/;

/** The last day of a span said: a day without its year from the first day on («dal 28 dicembre al 3 gennaio»). */
function endSaid(to: unknown, first: string, today: string): string | Answer {
	if (typeof to === "string") {
		try {
			const r = readDate(folded(to).replace(/^(?:a |al |fino a |fino al |all')/, ""), today, { rule: "next", reference: first });
			if (r.yearless && r.warning === undefined) return r.date;
		} catch (error) {
			if (!(error instanceof DateError)) throw error;
		}
	}
	return staffDay(to, today, "nearest");
}

/** From and to («dal 3 al 14 agosto» comes as from and to); to before from is asked; «la settimana scorsa» is that whole week. */
export function rangeSaid(from: unknown, to: unknown, today: string, open = false, dir: Direction = "nearest"): { readonly from: string; readonly to?: string; readonly notes: readonly string[] } | Answer {
	const a = staffDayNoted(from ?? "oggi", today, dir);
	if (isAnswer(a)) return a;
	const notes = a.note === undefined ? [] : [a.note];
	if (to === undefined) {
		if (typeof from === "string" && WEEK_WORDS.test(folded(from))) return { from: a.day, to: addDays(a.day, 6), notes };
		return open ? { from: a.day, notes } : { from: a.day, to: a.day, notes };
	}
	const end = endSaid(to, a.day, today);
	if (isAnswer(end)) return end;
	if (end < a.day) return { answer: "Errore: l'ultimo giorno viene prima del primo: dimmeli di nuovo." };
	if (daysBetween(a.day, end) >= STAFF_LIMITS.absenceDays) return { answer: "Errore: un'assenza dura al più un anno: dividila in due." };
	return { from: a.day, to: end, notes };
}

/** A time said («15», «15:30», «alle 3»: the afternoon from 1 to 7, as a shift would be): «HH:MM». */
export function staffTime(raw: unknown): string | Answer {
	const t = timeSaid(raw);
	if (isAnswer(t)) return { answer: "Errore: l'ora è come 15 o 15:30." };
	return timeOf(t.pm !== undefined && t.minutes < 8 * 60 ? t.pm : t.minutes);
}

/** Hours said: «2», «2 ore», «1,5», «un'ora e mezza», «mezz'ora», «45 minuti»: whole minutes. */
export function minutesOfHours(raw: unknown): number | Answer {
	const bad = { answer: "Errore: le ore sono come «2», «1,5» o «45 minuti»." };
	if (typeof raw === "number") return Number.isInteger(raw * 60) && raw > 0 ? raw * 60 : bad;
	if (typeof raw !== "string") return bad;
	const t = folded(raw).replace(/\s*in piu$/, "");
	const words: Readonly<Record<string, number>> = { "un'ora": 60, "un ora": 60, "un'ora e mezza": 90, "un ora e mezza": 90, "mezz'ora": 30, "mezza ora": 30, "due ore": 120, "tre ore": 180, "un'ora e un quarto": 75, "un quarto d'ora": 15 };
	if (words[t] !== undefined) return words[t] as number;
	const min = /^(\d{1,3}) ?(?:minuti|min)$/.exec(t);
	if (min !== null) return Number(min[1]) > 0 ? Number(min[1]) : bad;
	const h = readAmount(t.replace(/ ?(?:ore|ora|h)$/, ""), 2, "le ore", fencedStaff);
	if (h === undefined || isProblem(h)) return bad;
	const hundredths = Math.round(Number(h) * 100);
	if ((hundredths * 60) % 100 !== 0 || hundredths <= 0) return bad;
	return (hundredths * 60) / 100;
}

/** A decimal of days or hours («26», «22,5»), at most `max`: the canonical decimal. */
export function decimalSaid(raw: unknown, max: number, what: string): string | undefined | Answer {
	if (raw === undefined) return undefined;
	const d = readAmount(raw, 2, what, fencedStaff);
	if (isProblem(d)) return { answer: `Errore: ${d.problem}.` };
	if (d === undefined || Number(d) > max) return { answer: `Errore: ${what} è un numero da 0 a ${max}.` };
	return d;
}

/** The usual week said: «lun-ven 9-13 e 14-18; sab 9-13». */
export function weekOfPerson(raw: unknown, current: Week | undefined): Week | Answer {
	const w = weekSaid(raw, current as Readonly<Record<string, readonly Opening[]>> | undefined);
	if (w === "list") return { answer: "Errore: l'orario di lavoro è come «lun-ven 9-13 e 14-18; sab 9-13»." };
	if (isBadWeek(w)) return { answer: ["Errore: non capisco questo orario: i giorni come «lun-ven», le ore come «9-13 e 14-18».", fencedStaff(w.bad)].join("\n") };
	return w;
}

/** The hours of one day said apart: «9-13 e 15-19»; «riposo», «libero», «non lavora»: none. */
export function dayHours(raw: unknown): readonly Opening[] | Answer {
	if (typeof raw === "string" && /^(?:riposo|libero|libera|non lavora|a casa|chiuso)$/i.test(raw.trim())) return [];
	const w = weekSaid([{ days: "lunedì", open: typeof raw === "string" ? raw : "" }], undefined);
	if (w === "list" || isBadWeek(w)) return { answer: "Errore: le ore del turno sono come «9-13 e 15-19», oppure «riposo»." };
	return w["1"] ?? [];
}

/** A certificate's protocol as said: its digits only (spaces, «/» and «-» taken out), else "bad" (a diagnosis is never taken for it). */
export function protocolSaid(raw: unknown): string | undefined | "bad" {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" && typeof raw !== "number") return "bad";
	const t = String(raw).trim().replace(/^(?:protocollo|prot\.?|n\.?|numero|nr\.?)\s*:?\s*/i, "").replace(/[\s/-]+/g, "");
	return PROTOCOL.test(t) ? t : "bad";
}

/** The reason of an «altro» as said, to the closed list; "health" when it says something of someone's health; "unknown" otherwise. */
export function reasonSaid(raw: unknown): AltroReason | "health" | "unknown" {
	if (typeof raw !== "string" || raw.trim() === "") return "unknown";
	const t = folded(raw);
	// «Malattia del figlio» is a congedo, not the person's own health.
	if (/\bfigli[oa]?\b|\bbambin[oa]\b/.test(t) && /malat|febbre|sta male|influenz/.test(t)) return "congedo malattia figlio";
	if (looksHealth(t)) return "health";
	const list: [RegExp, AltroReason][] = [
		[/\blutto\b|decess|funeral|\bmort[oae]\b|scompars/, "lutto"],
		[/\b104\b/, "L.104"],
		[/congedo parentale|maternita|paternita|parentale|\bcongedo\b/, "congedo parentale"],
		[/matrimon|nozze|si sposa/, "matrimoniale"],
		[/donazion|dona(?:re)? (?:il )?sangue|\bavis\b/, "donazione sangue"],
		[/\bstudio\b|esami? universitar|\besame\b|diritto allo studio|150 ore/, "studio"],
		[/sindacal|sindacato/, "sindacale"],
		[/non retribuit|aspettativa/, "non retribuito"],
		[/^altro$/, "altro"],
	];
	for (const [re, reason] of list) if (re.test(t)) return reason;
	return "unknown";
}

/** A usual week said too vaguely to keep («mattina», «part time»): the word, to ask what hours. */
export function vagueWeek(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	return /^(?:la |di |al )?(?:mattina|mattino|pomeriggio|sera|part[- ]?time|full[- ]?time|tempo pieno|mezza giornata|mezzo tempo)$/.test(folded(raw)) ? raw.trim() : undefined;
}

/** The absence named: AS-0001, or the person's on a day (or their next, or the only one going on). */
export function absenceNamed(args: Record<string, unknown>, absences: readonly Absence[], people: readonly Person[], today: string): { readonly absence: Absence; readonly person: Person; readonly close?: true } | Answer {
	if (typeof args.absence === "string" && ABSENCE_ID.test(args.absence.trim().toUpperCase())) {
		const a = absences.find((x) => x.id === (args.absence as string).trim().toUpperCase() && isActive(x));
		const p = a === undefined ? undefined : people.find((x) => x.id === a.person);
		return a === undefined || p === undefined ? { answer: "Errore: non trovo questa assenza, o è già annullata." } : { absence: a, person: p };
	}
	const who = personSaid(args.person, people);
	if (isAnswer(who)) return who;
	const mine = absences.filter((a) => isActive(a) && a.person === who.person.id);
	let list = mine;
	if (args.on !== undefined) {
		const day = staffDay(args.on, today, "nearest");
		if (isAnswer(day)) return day;
		list = mine.filter((a) => a.from <= day && day <= (a.to ?? "9999-12-31"));
	} else {
		// Going on, or to come: one only, else asked.
		list = mine.filter((a) => (a.to ?? "9999-12-31") >= today).sort((a, b) => a.from.localeCompare(b.from));
		if (list.length > 1) return { answer: ["Errore: questa persona ha più di un'assenza segnata da oggi in poi: dimmi il giorno di quella che intendi.", fencedStaff(list.slice(0, STAFF_LIMITS.shown).map((a) => `• ${a.kind} dal ${italianDate(a.from)}${a.to === undefined ? "" : ` al ${italianDate(a.to)}`}`).join("\n"))].join("\n") };
	}
	if (list.length === 0) return { answer: "Errore: non trovo un'assenza così per questa persona: dimmi il giorno in cui cade." };
	if (list.length > 1) return { answer: "Errore: quel giorno ha più di un'assenza: dimmi anche l'ora." };
	return { absence: list[0] as Absence, person: who.person, ...(who.close === true ? { close: true as const } : {}) };
}
