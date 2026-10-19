/**
 * When the business is open and what is free, in wall-clock minutes of one day (no I/O, no
 * clock but the one given). An appointment never crosses midnight and the summer-time changes
 * happen at night, so slots are counted on the day's own clock: the same on 25 October as on
 * any day. «Now» is read in the business's time zone (localNow) and only compared with them.
 * Resources: with none set, the business is one lane (every appointment against every other);
 * with some, each appointment takes one (the one said, or the first free of those its service
 * needs, or of all) and meets only the appointments of the same.
 */
import { type Appointment, type AppointmentSettings, APPOINTMENT_LIMITS, DEFAULT_SLOT, minutesOf, takesTime, toMinutes } from "./appointments.ts";
import { addDays, holidayOn, weekdayOf } from "./italian-calendar.ts";

/** Minutes from midnight, from included, to excluded. */
export type Span = { readonly from: number; readonly to: number };

export type Open = { readonly known: boolean; readonly spans: readonly Span[]; readonly why?: "weekday" | "closure" | "holiday"; readonly holiday?: string; readonly note?: string };

const WHOLE_DAY: Span = { from: 0, to: 24 * 60 };

/** The day's openings: by weekday, less the closures and (unless open on them) the national holidays. `known` false when no hours are set: the whole day. */
export function openOn(settings: AppointmentSettings | undefined, day: string): Open {
	if (settings?.week === undefined) return { known: false, spans: [WHOLE_DAY] };
	const closure = (settings.closures ?? []).find((c) => c.from <= day && day <= c.to);
	if (closure !== undefined) return { known: true, spans: [], why: "closure", ...(closure.note === undefined ? {} : { note: closure.note }) };
	const holiday = settings.holidaysOpen === true ? undefined : holidayOn(day);
	if (holiday !== undefined) return { known: true, spans: [], why: "holiday", holiday };
	const list = settings.week[String(weekdayOf(day))] ?? [];
	if (list.length === 0) return { known: true, spans: [], why: "weekday" };
	return { known: true, spans: list.map((o) => ({ from: minutesOf(o.from), to: toMinutes(o.to) })) };
}

/** The lanes an appointment may take: the one said, those its service needs, every resource; [undefined] with no resources. */
function lanes(settings: AppointmentSettings | undefined, resource?: string, needs?: readonly string[]): (string | undefined)[] {
	if (resource !== undefined) return [resource];
	if (needs !== undefined && needs.length > 0) return [...needs];
	const all = settings?.resources ?? [];
	return all.length === 0 ? [undefined] : [...all];
}

const sameLane = (a: Appointment, lane: string | undefined, settings: AppointmentSettings | undefined) => lane === undefined || (settings?.resources ?? []).length === 0 || a.resource === undefined || a.resource === lane;

/** What takes time on the day in `lane`, but `except` (the appointment being moved). */
function busy(appointments: readonly Appointment[], day: string, lane: string | undefined, settings: AppointmentSettings | undefined, except?: string): { span: Span; id: string }[] {
	return appointments.filter((a) => a.day === day && takesTime(a) && a.id !== except && sameLane(a, lane, settings)).map((a) => ({ span: { from: minutesOf(a.start), to: minutesOf(a.start) + a.minutes }, id: a.id }));
}

export type FitInput = {
	readonly settings: AppointmentSettings | undefined;
	readonly appointments: readonly Appointment[];
	readonly day: string;
	/** Minutes from midnight. */
	readonly start: number;
	readonly minutes: number;
	readonly resource?: string;
	readonly needs?: readonly string[];
	readonly except?: string;
	readonly now?: { readonly day: string; readonly minutes: number };
};

export type Fit = { readonly ok: true; readonly resource?: string } | { readonly ok: false; readonly why: "closed" | "outside" | "overlap" | "past"; readonly with?: string; readonly open?: Open };

/** Whether the appointment fits: open, inside an opening, not in the past, free in a lane (the first free one taken). */
export function fits(i: FitInput): Fit {
	if (i.now !== undefined && (i.day < i.now.day || (i.day === i.now.day && i.start < i.now.minutes))) return { ok: false, why: "past" };
	const open = openOn(i.settings, i.day);
	if (open.spans.length === 0) return { ok: false, why: "closed", open };
	const end = i.start + i.minutes;
	if (!open.spans.some((s) => s.from <= i.start && end <= s.to)) return { ok: false, why: "outside", open };
	let first: string | undefined;
	for (const lane of lanes(i.settings, i.resource, i.needs)) {
		const hit = busy(i.appointments, i.day, lane, i.settings, i.except).find((b) => b.span.from < end && i.start < b.span.to);
		if (hit === undefined) return lane === undefined ? { ok: true } : { ok: true, resource: lane };
		first ??= hit.id;
	}
	return { ok: false, why: "overlap", ...(first === undefined ? {} : { with: first }) };
}

export type SlotInput = Omit<FitInput, "start"> & { readonly from?: number; readonly to?: number };

/** Where an appointment of `minutes` could start on the day, on the slot step, within from–to. */
export function freeSlots(i: SlotInput): { readonly start: number; readonly resource?: string }[] {
	const step = i.settings?.slot ?? DEFAULT_SLOT;
	const open = openOn(i.settings, i.day);
	const out: { start: number; resource?: string }[] = [];
	for (const s of open.spans) {
		const lo = Math.max(s.from, i.from ?? 0);
		for (let t = Math.ceil(lo / step) * step; t + i.minutes <= s.to && (i.to === undefined || t < i.to); t += step) {
			const f = fits({ ...i, start: t });
			if (f.ok) out.push(f.resource === undefined ? { start: t } : { start: t, resource: f.resource });
		}
	}
	return out;
}

/** The free slots nearest the one asked: that day by distance, then the next open days from the morning. */
export function nearestFree(i: FitInput, count: number = APPOINTMENT_LIMITS.proposals): { readonly day: string; readonly start: number; readonly resource?: string }[] {
	const same = freeSlots({ ...i, from: 0 })
		.map((s) => ({ ...s, day: i.day }))
		.sort((a, b) => Math.abs(a.start - i.start) - Math.abs(b.start - i.start) || a.start - b.start);
	const out = same.slice(0, count);
	for (let d = 1; out.length < count && d <= APPOINTMENT_LIMITS.ahead; d++) {
		const day = addDays(i.day, d);
		for (const s of freeSlots({ ...i, day, from: 0 })) {
			if (out.length >= count) break;
			out.push({ ...s, day });
		}
	}
	return out.map(({ day, start, resource }) => (resource === undefined ? { day, start } : { day, start, resource }));
}

/** The open time of the day no appointment takes (one lane: the business), longer than the slot step. */
export function gapsOf(settings: AppointmentSettings | undefined, appointments: readonly Appointment[], day: string): Span[] {
	const step = settings?.slot ?? DEFAULT_SLOT;
	const taken = appointments.filter((a) => a.day === day && takesTime(a)).map((a) => ({ from: minutesOf(a.start), to: minutesOf(a.start) + a.minutes }));
	const out: Span[] = [];
	for (const s of openOn(settings, day).spans) {
		let at = s.from;
		for (const t of [...taken].sort((a, b) => a.from - b.from)) {
			if (t.to <= at || t.from >= s.to) continue;
			if (t.from > at) out.push({ from: at, to: t.from });
			at = Math.max(at, t.to);
		}
		if (at < s.to) out.push({ from: at, to: s.to });
	}
	return out.filter((g) => g.to - g.from >= step);
}

/** The day and the minutes from midnight of an instant, in `timeZone`. */
export function localNow(timeZone: string, now: Date): { readonly day: string; readonly minutes: number } {
	const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
	return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
