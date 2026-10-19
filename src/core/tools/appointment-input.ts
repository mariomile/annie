/**
 * What the person says for an appointment, read and checked: the day («giovedì», «domani»,
 * «22/10»), the time («alle 15», «15:30»), the part of the day («pomeriggio»), a duration, the
 * client (a card, a client of an earlier appointment, or a new one as said), the services (a
 * service with its duration, a voce of the listino, or a name: an unknown duration is taken as
 * 30 minutes and said), the resource, the appointment named. What does not read comes back as
 * the answer to give, the words said inside the fence.
 */
import type { Appointment, AppointmentClient, AppointmentSettings, BookedService } from "../appointments.ts";
import { APPOINTMENT_ID, APPOINTMENT_LIMITS, DEFAULT_MINUTES, minutesOf } from "../appointments.ts";
import type { ClientCard } from "../clients.ts";
import { type Candidate, findNamed } from "../client-find.ts";
import { DateError, readDate } from "../dates.ts";
import { addDays, weekdayOf } from "../italian-calendar.ts";
import { spellingKey } from "../name-keys.ts";
import { findItems, type PriceItem } from "../price-list.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { fencedAppointments } from "./appointment-render.ts";

export type Answer = { readonly answer: string };
export const isAnswer = (v: unknown): v is Answer => typeof v === "object" && v !== null && "answer" in v;

const WEEKDAYS: Readonly<Record<string, number>> = { domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6 };
const folded = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");

/** The day said: a weekday (this one, today included; «prossimo»: after today), oggi, domani, a date. */
export function daySaid(raw: unknown, today: string): string | Answer {
	if (typeof raw !== "string" || raw.trim() === "" || raw.length > 40) return { answer: "Errore: il giorno è come «giovedì», «domani» o 22/10/2026." };
	const t = folded(raw).replace(/^(?:il |per |di |a )/, "");
	const m = /^([a-z]+)(?: (prossimo|prossima))?$/.exec(t);
	const wd = m === null ? undefined : WEEKDAYS[m[1] as string];
	if (wd !== undefined && m !== null) {
		const from = m[2] === undefined ? 0 : 1;
		for (let d = from; d < from + 7; d++) if (weekdayOf(addDays(today, d)) === wd) return addDays(today, d);
	}
	try {
		const r = readDate(t, today);
		if (r.warning !== undefined) return { answer: `Errore: ${r.warning}: dimmi quale dei due.` };
		return r.date;
	} catch (error) {
		if (error instanceof DateError) return { answer: ["Errore: non capisco il giorno: dimmelo come «giovedì» o 22/10/2026.", fencedAppointments(raw.slice(0, 40))].join("\n") };
		throw error;
	}
}

/** The time said: «15», «alle 15», «15:30», «15.30»; «alle 3» read as 15:00 and said. */
export function timeSaid(raw: unknown): { readonly minutes: number; readonly note?: string } | Answer {
	const t = typeof raw === "string" ? folded(raw).replace(/^(?:alle|all'|ore|dalle|le) ?/, "") : typeof raw === "number" ? String(raw) : "";
	const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(t);
	if (m === null || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) return { answer: "Errore: l'ora è come 15 o 15:30." };
	let h = Number(m[1]);
	const min = Number(m[2] ?? 0);
	let note: string | undefined;
	if (h >= 1 && h <= 7) {
		h += 12;
		note = `Le ${m[1]}${m[2] === undefined ? "" : `:${m[2]}`} le ho intese come le ${h}${m[2] === undefined ? "" : `:${m[2]}`} del pomeriggio.`;
	}
	return { minutes: h * 60 + min, ...(note === undefined ? {} : { note }) };
}

/** «mattina», «pomeriggio», «sera»: the window of the day. */
export function windowSaid(raw: unknown): { readonly from: number; readonly to: number } | undefined | Answer {
	if (raw === undefined) return undefined;
	const t = typeof raw === "string" ? folded(raw) : "";
	if (/mattin/.test(t)) return { from: 0, to: 13 * 60 };
	if (/pomerigg/.test(t)) return { from: 13 * 60, to: 19 * 60 };
	if (/sera/.test(t)) return { from: 18 * 60, to: 24 * 60 };
	if (/giorn|tutto/.test(t)) return { from: 0, to: 24 * 60 };
	return { answer: "Errore: la parte del giorno è mattina, pomeriggio o sera." };
}

/** A duration: minutes (90), «1h30», «45 minuti», «un'ora», «mezz'ora». */
export function minutesSaid(raw: unknown): number | undefined | Answer {
	if (raw === undefined) return undefined;
	const t = typeof raw === "number" ? String(raw) : typeof raw === "string" ? folded(raw) : "";
	let m: number | undefined;
	if (/^\d{1,3}$/.test(t)) m = Number(t);
	else if (/^\d{1,3} ?(?:min|minuti)$/.test(t)) m = Number(/\d+/.exec(t)?.[0]);
	else if (/^(?:un'?ora|1 ora|un ora)$/.test(t)) m = 60;
	else if (/^mezz'?ora$/.test(t)) m = 30;
	else {
		const h = /^(\d{1,2}) ?(?:h|ore|ora)(?: ?e? ?(\d{1,2}))?(?: ?min(?:uti)?)?$/.exec(t);
		if (h !== null) m = Number(h[1]) * 60 + Number(h[2] ?? 0);
	}
	if (m === undefined || m < 5 || m > APPOINTMENT_LIMITS.minutes) return { answer: "Errore: la durata è in minuti, come 45, o come «1h30», al più 12 ore." };
	return m;
}

/** The client found: `close` a card only near what was said (a check first), `fresh` known nowhere. */
export type ClientFound = { readonly client: AppointmentClient; readonly close?: true; readonly fresh?: true };

const HONORIFIC = /^(?:(?:la|il|lo) )?(?:signora|signorina|signor|signore|sig\.ra|sig\.na|sig\.?|dott\.ssa|dottoressa|dott\.?|dottor|avv\.?|ing\.?)\s+/i;

/** The client said: a card (by name, alias or id), a client of an earlier appointment, or new as said. */
export function clientSaid(raw: unknown, cards: readonly ClientCard[], appointments: readonly Appointment[]): ClientFound | Answer {
	const said = cleanText(raw, APPOINTMENT_LIMITS.name, "il cliente");
	if (isProblem(said)) return { answer: `Errore: ${said.problem}.` };
	if (said === undefined) return { answer: "Errore: dimmi per chi è l'appuntamento." };
	const bare = said.replace(HONORIFIC, "").trim() || said;
	const candidates: Candidate<AppointmentClient>[] = cards.map((c) => ({ item: { name: c.name, card: c.id }, names: [c.name, ...c.aliases], ids: [c.id] }));
	const known = new Set(cards.flatMap((c) => [c.name, ...c.aliases].map(spellingKey)));
	for (const a of [...appointments].reverse()) {
		const k = spellingKey(a.client.name);
		if (a.client.card !== undefined || known.has(k)) continue;
		known.add(k);
		candidates.push({ item: { name: a.client.name }, names: [a.client.name] });
	}
	const r = findNamed(candidates, bare, APPOINTMENT_LIMITS.name);
	if (r.kind === "exact") return r.form === true ? { client: r.item, close: true } : { client: r.item };
	if (r.kind === "close") {
		if (r.candidates.length === 1) return { client: r.candidates[0] as AppointmentClient, close: true };
		return { answer: ["Intendi uno di questi? Non so dire quale:", fencedAppointments(r.candidates.slice(0, 10).map((c) => `• ${c.name}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui."].join("\n") };
	}
	return { client: { name: bare }, fresh: true };
}

/** The services found: `guess` a voce only near what was said, `assumed` the names whose duration is not known (30 minutes taken). */
export type ServicesFound = { readonly services: readonly BookedService[]; readonly guess: readonly string[]; readonly assumed: readonly string[]; readonly needs?: readonly string[] };

/** The services said, in order: a service with its duration, else a voce of the listino, else the name as said. */
export function servicesSaid(raw: unknown, settings: AppointmentSettings | undefined, voci: readonly PriceItem[]): ServicesFound | Answer {
	const list = typeof raw === "string" ? [raw] : raw;
	if (!Array.isArray(list) || list.length === 0 || list.length > APPOINTMENT_LIMITS.services) return { answer: `Errore: dimmi per cosa è l'appuntamento (al più ${APPOINTMENT_LIMITS.services} servizi), come «taglio e piega».` };
	const known = settings?.services ?? [];
	const services: BookedService[] = [];
	const guess: string[] = [];
	const assumed: string[] = [];
	let needs: string[] | undefined;
	for (const entry of list) {
		const said = cleanText(entry, APPOINTMENT_LIMITS.service, "il servizio");
		if (isProblem(said)) return { answer: `Errore: ${said.problem}.` };
		if (said === undefined) return { answer: "Errore: ogni servizio ha un nome." };
		const key = spellingKey(said);
		let k = known.find((s) => spellingKey(s.name) === key);
		let voce = k?.item === undefined ? undefined : voci.find((v) => v.id === k?.item);
		if (k === undefined) {
			const f = findItems(voci, said);
			if (f.kind === "exact") voce = f.item;
			else if ((f.kind === "close" || f.kind === "unit") && f.items.length === 1) {
				voce = f.items[0] as PriceItem;
				guess.push(said);
			} else if (f.kind !== "none") return { answer: ["Nel listino ci sono più voci così: dimmi quale.", fencedAppointments(f.items.slice(0, 10).map((i) => `• ${i.name}`).join("\n"))].join("\n") };
			k = voce === undefined ? undefined : known.find((s) => s.item === voce?.id);
		}
		const name = (voce?.name ?? k?.name ?? said).slice(0, APPOINTMENT_LIMITS.service);
		if (k === undefined) assumed.push(name);
		if (k?.needs !== undefined) needs = needs === undefined ? [...k.needs] : needs.filter((r) => k?.needs?.includes(r));
		services.push({ name, ...(voce === undefined ? (k?.item === undefined ? {} : { item: k.item }) : { item: voce.id }), minutes: k?.minutes ?? DEFAULT_MINUTES });
	}
	if (services.reduce((n, s) => n + s.minutes, 0) > APPOINTMENT_LIMITS.minutes) return { answer: "Errore: un appuntamento dura al più 12 ore." };
	if (needs !== undefined && needs.length === 0) return { answer: "Errore: questi servizi li fanno risorse diverse: fissali come appuntamenti separati." };
	return { services, guess, assumed, ...(needs === undefined ? {} : { needs }) };
}

/** The resource said, as the settings write it. */
export function resourceSaid(raw: unknown, settings: AppointmentSettings | undefined): string | undefined | Answer {
	if (raw === undefined) return undefined;
	const said = cleanText(raw, APPOINTMENT_LIMITS.resource, "la risorsa");
	if (isProblem(said)) return { answer: `Errore: ${said.problem}.` };
	if (said === undefined) return undefined;
	const all = settings?.resources ?? [];
	const found = all.find((r) => spellingKey(r) === spellingKey(said));
	if (found !== undefined) return found;
	if (all.length === 0) return { answer: "Non ho risorse salvate (persone, poltrone, postazioni): se vuoi dividere gli appuntamenti così, dimmi quali sono e le salvo." };
	return { answer: ["Questa risorsa non la conosco. Quelle salvate sono nel riquadro:", fencedAppointments([`Detta: ${said}`, ...all.map((r) => `• ${r}`)].join("\n"))].join("\n") };
}

/**
 * The appointment named: by its reference (AP-0001, for the model), or the client's; `pick`
 * keeps those that may be acted on; with several, the day said, else the next one (or, for the
 * past, the latest). The answer otherwise.
 */
export function appointmentNamed(args: Record<string, unknown>, appointments: readonly Appointment[], cards: readonly ClientCard[], today: string, pick: (a: Appointment) => boolean, past = false): Appointment | Answer {
	if (typeof args.appointment === "string" && APPOINTMENT_ID.test(args.appointment.trim().toUpperCase())) {
		const a = appointments.find((x) => x.id === (args.appointment as string).trim().toUpperCase());
		return a === undefined ? { answer: "Errore: non trovo questo appuntamento." } : a;
	}
	if (args.client === undefined) return { answer: "Errore: dimmi di quale cliente è l'appuntamento." };
	const who = clientSaid(args.client, cards, appointments);
	if (isAnswer(who)) return who;
	const key = (c: AppointmentClient) => (c.card ?? `n:${spellingKey(c.name)}`);
	let pool = appointments.filter((a) => key(a.client) === key(who.client) && pick(a));
	if (args.from_date !== undefined) {
		const d = daySaid(args.from_date, today);
		if (isAnswer(d)) return d;
		pool = pool.filter((a) => a.day === d);
	}
	if (pool.length === 0) return { answer: ["Non trovo un appuntamento così per questo cliente.", fencedAppointments(who.client.name)].join("\n") };
	const sorted = [...pool].sort((a, b) => a.day.localeCompare(b.day) || minutesOf(a.start) - minutesOf(b.start));
	if (past) return sorted.filter((a) => a.day <= today).at(-1) ?? (sorted[0] as Appointment);
	return sorted.find((a) => a.day >= today) ?? (sorted.at(-1) as Appointment);
}
