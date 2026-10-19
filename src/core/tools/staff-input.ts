/**
 * What the person says about il personale, read and checked: the person named (the name, the first
 * name alone, or PE-0001), the days («dal 3 al 14 agosto», «domani», «da oggi»), a time («dalle
 * 15»), the hours («2 ore», «un'ora e mezza», 1.5), the usual week («lun-ven 9-13 e 14-18», the
 * appointments' own reader), a decimal of days or hours, the protocol of a certificate, the
 * absence named. What does not read comes back as the answer to give, the words said in the fence.
 */
import { type Opening, timeOf } from "../appointments.ts";
import { type Candidate, findNamed } from "../client-find.ts";
import { addDays, daysBetween } from "../italian-calendar.ts";
import { type Absence, ABSENCE_ID, isActive, type Person, PERSON_ID, PROTOCOL, STAFF_LIMITS, type Week } from "../staff.ts";
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

/** A day said: «domani», «lunedì», «3 agosto», «03/08/2026», back up to a year or ahead up to a year. */
export function staffDay(raw: unknown, today: string): string | Answer {
	if (typeof raw === "string") {
		const t = folded(raw).replace(/^(?:da |dal |dall'|a |al |fino a |fino al |il |l')/, "");
		if (t === "oggi") return today;
		if (t === "ieri") return addDays(today, -1);
		if (t === "domani") return addDays(today, 1);
		if (t === "dopodomani") return addDays(today, 2);
		const d = daySaid(t, today);
		if (!isAnswer(d)) return daysBetween(d, today) > 400 ? { answer: "Errore: quel giorno è più di un anno fa: dimmi una data più vicina." } : d;
	}
	return { answer: ["Errore: non capisco il giorno: dimmelo come «domani», «lunedì» o 03/08/2026.", fencedStaff(String(raw ?? "").slice(0, 40))].join("\n") };
}

/** From and to («dal 3 al 14 agosto» comes as from and to); to before from is asked. */
export function rangeSaid(from: unknown, to: unknown, today: string, open = false): { readonly from: string; readonly to?: string } | Answer {
	const a = staffDay(from ?? "oggi", today);
	if (isAnswer(a)) return a;
	if (to === undefined) return open ? { from: a } : { from: a, to: a };
	const b = staffDay(to, today);
	if (isAnswer(b)) return b;
	// «dal 28 dicembre al 3 gennaio»: the end read in the year after.
	const end = b < a && daysBetween(b, a) < 200 && b.slice(0, 4) === a.slice(0, 4) ? `${Number(b.slice(0, 4)) + 1}${b.slice(4)}` : b;
	if (end < a) return { answer: "Errore: l'ultimo giorno viene prima del primo: dimmeli di nuovo." };
	if (daysBetween(a, end) >= STAFF_LIMITS.absenceDays) return { answer: "Errore: un'assenza dura al più un anno: dividila in due." };
	return { from: a, to: end };
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

/** A certificate's protocol as said: the code only, else asked (a diagnosis is never taken for it). */
export function protocolSaid(raw: unknown): string | undefined | "bad" {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") return "bad";
	const t = raw.trim().replace(/^(?:protocollo|prot\.?|n\.?|numero)\s*/i, "").replace(/\s+/g, "");
	return PROTOCOL.test(t) ? t : "bad";
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
		const day = staffDay(args.on, today);
		if (isAnswer(day)) return day;
		list = mine.filter((a) => a.from <= day && day <= (a.to ?? "9999-12-31"));
	} else {
		// Going on, or the next.
		const now = mine.filter((a) => (a.to ?? "9999-12-31") >= today).sort((a, b) => a.from.localeCompare(b.from));
		list = now.slice(0, 1);
	}
	if (list.length === 0) return { answer: "Errore: non trovo un'assenza così per questa persona: dimmi il giorno in cui cade." };
	if (list.length > 1) return { answer: "Errore: quel giorno ha più di un'assenza: dimmi anche l'ora." };
	return { absence: list[0] as Absence, person: who.person, ...(who.close === true ? { close: true as const } : {}) };
}
