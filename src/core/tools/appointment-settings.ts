/**
 * The settings of gli appuntamenti, as the person says them: the business's name (for the
 * reminders), the opening hours by weekday with their breaks («mar-ven 9-13, 14:30-19», «lunedì
 * chiuso»), a closure (from a day to a day), open on the holidays or not, the slot step, the
 * resources, and how long each service lasts (the voce of the listino it is, and who may do it).
 * What does not read is the answer to give.
 */
import { APPOINTMENT_LIMITS, type AppointmentSettings, type Closure, type KnownService, type Opening, SLOTS, TIME, toMinutes } from "../appointments.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import { findItems, type PriceItem } from "../price-list.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { type Answer, daySaid, isAnswer, minutesSaid, resourceSaid } from "./appointment-input.ts";
import { fencedAppointments, hoursWords } from "./appointment-render.ts";

const DAY_NAMES: Readonly<Record<string, number>> = { dom: 0, lun: 1, mar: 2, mer: 3, gio: 4, ven: 5, sab: 6 };
const folded = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** «lun-ven», «mar, mer», «sabato», «tutti i giorni»: the weekdays (0 Sunday). */
function daysOf(raw: string): number[] | undefined {
	const t = folded(raw);
	if (/tutti/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
	const out = new Set<number>();
	for (const part of t.split(/\s*(?:,|\be\b)\s*/).filter((p) => p !== "")) {
		const range = /^([a-z]{3})[a-z]*\s*(?:-|a|al)\s*([a-z]{3})[a-z]*$/.exec(part);
		if (range !== null) {
			const a = DAY_NAMES[range[1] as string];
			const b = DAY_NAMES[range[2] as string];
			if (a === undefined || b === undefined) return undefined;
			for (let d = a; ; d = (d + 1) % 7) {
				out.add(d);
				if (d === b) break;
			}
			continue;
		}
		const one = DAY_NAMES[part.slice(0, 3)];
		if (one === undefined || !/^[a-z]+$/.test(part)) return undefined;
		out.add(one);
	}
	return out.size === 0 ? undefined : [...out];
}

const hhmm = (t: string): string | undefined => {
	const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(t.trim());
	if (m === null) return undefined;
	const v = `${String(Number(m[1])).padStart(2, "0")}:${m[2] ?? "00"}`;
	return TIME.test(v) || v === "24:00" ? v : undefined;
};

/** «9-13, 14:30-19» → the openings; «chiuso» → none. */
function openingsOf(raw: string): Opening[] | undefined {
	const t = folded(raw);
	if (/chius/.test(t)) return [];
	const out: Opening[] = [];
	for (const part of t.split(/\s*(?:,|;|\be\b)\s*/).filter((p) => p !== "")) {
		const m = /^(?:dalle\s*)?([\d:.]+)\s*(?:-|alle|a)\s*([\d:.]+)$/.exec(part);
		const from = m === null ? undefined : hhmm(m[1] as string);
		const to = m === null ? undefined : hhmm(m[2] as string);
		if (from === undefined || to === undefined || toMinutes(from) >= toMinutes(to)) return undefined;
		out.push({ from, to });
	}
	out.sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
	for (let i = 1; i < out.length; i++) if (toMinutes((out[i] as Opening).from) < toMinutes((out[i - 1] as Opening).to)) return undefined;
	return out.length === 0 || out.length > 4 ? undefined : out;
}

/** «mar-sab 9-13 e 14-19; chiuso domenica e lunedì» in one line: the same entries as the list. */
function hoursLine(raw: string): { days: string; open: string }[] | undefined {
	const out: { days: string; open: string }[] = [];
	for (const part of raw.split(/\s*;\s*|\s*,\s*(?=chius)/i).map((p) => p.trim()).filter((p) => p !== "")) {
		const shut = /^chius[oi]\s+(?:il |la |di )?(.+)$/i.exec(part);
		if (shut !== null) {
			out.push({ days: shut[1] as string, open: "chiuso" });
			continue;
		}
		const m = /^([^\d]+?)\s+(?:dalle\s*)?(\d.*)$/i.exec(part);
		if (m === null) return undefined;
		out.push({ days: m[1] as string, open: m[2] as string });
	}
	return out.length === 0 || out.length > 7 ? undefined : out;
}

/** What did not read of a week said (weekday keys are digits: never «bad»). */
export const isBadWeek = (w: unknown): w is { readonly bad: string } => typeof w === "object" && w !== null && typeof (w as { bad?: unknown }).bad === "string";

/**
 * A week of hours as said («mar-sab 9-13 e 14-19; chiuso domenica e lunedì», or [{days, open}])
 * over `current`: by weekday (0 Sunday), the openings; a weekday said «chiuso» goes. "list" when
 * it is not a list of hours; `bad` with what did not read (for the fence). Shared with the staff's
 * usual shifts (staff-input.ts).
 */
export function weekSaid(raw: unknown, current: Readonly<Record<string, readonly Opening[]>> | undefined): Record<string, Opening[]> | "list" | { readonly bad: string } {
	const hours = typeof raw === "string" ? hoursLine(raw) : raw;
	if (!Array.isArray(hours) || hours.length === 0 || hours.length > 7) return "list";
	const week: Record<string, Opening[]> = { ...(current ?? {}) } as Record<string, Opening[]>;
	for (const h of hours) {
		const o = typeof h === "object" && h !== null ? (h as Record<string, unknown>) : {};
		const days = typeof o.days === "string" ? daysOf(o.days) : undefined;
		const open = typeof o.open === "string" ? openingsOf(o.open) : undefined;
		if (days === undefined || open === undefined) return { bad: `${String(o.days ?? "")}: ${String(o.open ?? "")}`.slice(0, 200) };
		for (const d of days) {
			if (open.length === 0) delete week[String(d)];
			else week[String(d)] = open;
		}
	}
	return week;
}

/** The settings with what was said put in: the same object when nothing was said. */
export function settingsSaid(args: Record<string, unknown>, current: AppointmentSettings | undefined, voci: readonly PriceItem[], today: string, by: Marker): AppointmentSettings | undefined | Answer {
	let s: Omit<AppointmentSettings, "by" | "at"> = current === undefined ? {} : (({ by: _b, at: _a, ...rest }) => rest)(current);
	let said = false;
	if (args.business !== undefined) {
		const b = cleanText(args.business, APPOINTMENT_LIMITS.business, "il nome dell'attività");
		if (isProblem(b) || b === undefined) return { answer: `Errore: ${isProblem(b) ? b.problem : "il nome dell'attività è vuoto"}.` };
		s = { ...s, business: b };
		said = true;
	}
	if (args.hours !== undefined) {
		const week = weekSaid(args.hours, s.week);
		if (week === "list") return { answer: "Errore: gli orari sono un elenco, ognuno con i giorni («mar-ven») e l'orario («9-13, 14:30-19» o «chiuso»)." };
		if (isBadWeek(week)) return { answer: ["Errore: non capisco questi orari: i giorni come «mar-ven» o «sabato», l'orario come «9-13, 14:30-19» o «chiuso».", fencedAppointments(week.bad)].join("\n") };
		s = { ...s, week };
		said = true;
	}
	if (args.closure_from !== undefined || args.closure_to !== undefined) {
		const from = daySaid(args.closure_from ?? args.closure_to, today);
		if (isAnswer(from)) return from;
		const to = args.closure_to === undefined ? from : daySaid(args.closure_to, from);
		if (isAnswer(to)) return to;
		if (to < from) return { answer: "Errore: la chiusura finisce prima di cominciare." };
		const note = cleanText(args.closure_note, 120, "il motivo della chiusura");
		if (isProblem(note)) return { answer: `Errore: ${note.problem}.` };
		const c: Closure = { from, to, ...(note === undefined ? {} : { note }) };
		s = { ...s, closures: [...(s.closures ?? []).filter((x) => x.to >= today), c].slice(-APPOINTMENT_LIMITS.closures) };
		said = true;
	}
	if (args.closure_remove !== undefined) {
		const d = daySaid(args.closure_remove, today);
		if (isAnswer(d)) return d;
		const left = (s.closures ?? []).filter((c) => !(c.from <= d && d <= c.to));
		if (left.length === (s.closures ?? []).length) return { answer: "Non c'è una chiusura che comprenda quel giorno." };
		s = { ...s, closures: left };
		said = true;
	}
	if (args.holidays_open !== undefined) {
		if (typeof args.holidays_open !== "boolean") return { answer: "Errore: aperto nei festivi è sì o no." };
		const { holidaysOpen: _h, ...rest } = s;
		s = args.holidays_open ? { ...rest, holidaysOpen: true } : rest;
		said = true;
	}
	if (args.slot !== undefined) {
		if (!SLOTS.includes(args.slot as (typeof SLOTS)[number])) return { answer: `Errore: il passo degli appuntamenti è uno di questi minuti: ${SLOTS.join(", ")}.` };
		s = { ...s, slot: args.slot as number };
		said = true;
	}
	if (args.resources !== undefined) {
		if (!Array.isArray(args.resources) || args.resources.length > APPOINTMENT_LIMITS.resources) return { answer: `Errore: le risorse sono un elenco di nomi (al più ${APPOINTMENT_LIMITS.resources}).` };
		const names: string[] = [];
		for (const r of args.resources) {
			const n = cleanText(r, APPOINTMENT_LIMITS.resource, "la risorsa");
			if (isProblem(n) || n === undefined) return { answer: "Errore: ogni risorsa ha un nome, come «Marco» o «poltrona 2»." };
			if (!names.some((x) => spellingKey(x) === spellingKey(n))) names.push(n);
		}
		// A service that needed a resource gone needs any.
		const services = (s.services ?? []).map((k) => {
			const needs = k.needs?.filter((x) => names.includes(x));
			const { needs: _n, ...rest } = k;
			return needs === undefined || needs.length === 0 ? rest : { ...rest, needs };
		});
		s = names.length === 0 ? (({ resources: _r, ...rest }) => ({ ...rest, services }))(s) : { ...s, resources: names, services };
		said = true;
	}
	if (args.services !== undefined) {
		if (!Array.isArray(args.services) || args.services.length === 0 || args.services.length > 50) return { answer: "Errore: i servizi sono un elenco, ognuno con il nome e quanti minuti dura." };
		let known = [...(s.services ?? [])];
		for (const e of args.services) {
			const o = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
			const name = cleanText(o.name, APPOINTMENT_LIMITS.service, "il servizio");
			if (isProblem(name) || name === undefined) return { answer: "Errore: ogni servizio ha un nome." };
			const minutes = minutesSaid(o.minutes);
			if (isAnswer(minutes)) return minutes;
			if (minutes === undefined) return { answer: ["Errore: dimmi quanto dura questo servizio.", fencedAppointments(name)].join("\n") };
			const f = findItems(voci, name);
			const voce = f.kind === "exact" ? f.item : undefined;
			let needs: string[] | undefined;
			if (o.needs !== undefined) {
				if (!Array.isArray(o.needs)) return { answer: "Errore: chi fa il servizio è un elenco di risorse." };
				needs = [];
				for (const r of o.needs) {
					const found = resourceSaid(r, s as AppointmentSettings);
					if (isAnswer(found)) return found;
					if (found !== undefined) needs.push(found);
				}
			}
			const k: KnownService = { name: voce?.name ?? name, ...(voce === undefined ? {} : { item: voce.id }), minutes, ...(needs === undefined || needs.length === 0 ? {} : { needs }) };
			known = [...known.filter((x) => spellingKey(x.name) !== spellingKey(k.name) && (k.item === undefined || x.item !== k.item)), k];
		}
		s = { ...s, services: known.slice(-APPOINTMENT_LIMITS.known) };
		said = true;
	}
	return said ? { ...s, ...by } : undefined;
}

/** The settings, in short: hours outside the fence; names, resources and services inside. */
export function settingsWords(s: AppointmentSettings | undefined, today: string): string {
	const closures = (s?.closures ?? []).filter((c) => c.to >= today);
	const head = [
		`Orari: ${hoursWords(s)}.`,
		`Festivi nazionali: ${s?.holidaysOpen === true ? "aperto" : "chiuso"}. Un appuntamento si fissa ogni ${s?.slot ?? 15} minuti.`,
		closures.length === 0 ? "Nessuna chiusura in programma." : `Chiusure: ${closures.map((c) => (c.from === c.to ? c.from.split("-").reverse().join("/") : `dal ${c.from.split("-").reverse().join("/")} al ${c.to.split("-").reverse().join("/")}`)).join(", ")}.`,
	];
	const data = [
		`Attività: ${s?.business ?? "(nome non detto)"}`,
		`Risorse: ${(s?.resources ?? []).join(", ") || "nessuna"}`,
		...(s?.services ?? []).map((k) => `• ${k.name}: ${k.minutes} minuti${k.needs === undefined ? "" : ` (${k.needs.join(", ")})`}`),
	];
	return [...head, fencedAppointments(data.join("\n"))].join("\n");
}
