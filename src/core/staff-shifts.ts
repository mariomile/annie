/**
 * I turni, day by day (no I/O, no clock): who works when, from the usual week or the day's own
 * shift said apart, less the absences and the days the business is closed (its hours, closures
 * and national holidays from the appointments' settings when there are some, else the national
 * holidays); who is off and why; the hours the business is open and nobody is on (coverage gaps);
 * the resources of the appointments an absence (or the shift) blocks. Only the people hired by
 * the day and not yet gone count.
 * Wall-clock minutes of the day, like the appointments: the summer-time changes move nothing.
 */
import { type AppointmentSettings, minutesOf, toMinutes } from "./appointments.ts";
import { type Block, type Open, openOn, type Span } from "./appointment-slots.ts";
import { addDays, holidayOn, weekdayOf } from "./italian-calendar.ts";
import { type Absence, type AbsenceKind, employed, isActive, lastDay, type Person, type ShiftChange, spanOf } from "./staff.ts";

export type StaffDay = {
	readonly people: readonly Person[];
	readonly absences: readonly Absence[];
	readonly shifts: readonly ShiftChange[];
	/** The appointments' settings: the business's hours, closures and holidays. */
	readonly settings?: AppointmentSettings;
};

/** A person's day: the hours on, and the absence taking some or all of it. */
export type PersonDay = { readonly person: Person; readonly hours: readonly Span[]; readonly planned: readonly Span[]; readonly off?: { readonly kind: AbsenceKind; readonly whole: boolean; readonly absence: Absence } };

/** Whether the business is closed on the day: by its settings, else on a national holiday. */
export function closedOn(settings: AppointmentSettings | undefined, day: string): { readonly closed: boolean; readonly open?: Open; readonly holiday?: string } {
	if (settings?.week !== undefined) {
		const open = openOn(settings, day);
		return { closed: open.spans.length === 0, open, ...(open.holiday === undefined ? {} : { holiday: open.holiday }) };
	}
	const holiday = settings?.holidaysOpen === true ? undefined : holidayOn(day);
	return holiday === undefined ? { closed: false } : { closed: true, holiday };
}

/** The hours planned: the day's own shift said apart, else the usual week's; none on a day the business is closed (unless said apart). */
export function plannedOn(person: Person, day: string, shifts: readonly ShiftChange[], closed: boolean): Span[] {
	const own = shifts.find((s) => s.person === person.id && s.day === day);
	if (own !== undefined) return own.hours.map((o) => ({ from: minutesOf(o.from), to: toMinutes(o.to) }));
	if (closed) return [];
	return (person.week?.[String(weekdayOf(day))] ?? []).map((o) => ({ from: minutesOf(o.from), to: toMinutes(o.to) }));
}

/** The person's absences on the day (not cancelled). */
export function absencesOn(absences: readonly Absence[], person: string, day: string): Absence[] {
	return absences.filter((a) => isActive(a) && a.person === person && a.from <= day && day <= (a.to ?? "9999-12-31"));
}

/** `spans` less `cut`. */
export function minus(spans: readonly Span[], cut: readonly Span[]): Span[] {
	let out = [...spans];
	for (const c of cut) {
		out = out.flatMap((s) => {
			if (c.to <= s.from || c.from >= s.to) return [s];
			return [...(s.from < c.from ? [{ from: s.from, to: c.from }] : []), ...(c.to < s.to ? [{ from: c.to, to: s.to }] : [])];
		});
	}
	return out;
}

export const minutesIn = (spans: readonly Span[]): number => spans.reduce((n, s) => n + (s.to - s.from), 0);

/** Every person's day: planned, less absences. */
export function dayOf(d: StaffDay, day: string): { readonly people: readonly PersonDay[]; readonly closed: boolean; readonly open?: Open; readonly holiday?: string } {
	const c = closedOn(d.settings, day);
	const people = d.people.filter((p) => employed(p, day)).map((person) => {
		const planned = plannedOn(person, day, d.shifts, c.closed);
		const mine = absencesOn(d.absences, person.id, day);
		const cut = mine.map((a) => spanOf(a));
		const hours = minus(planned, cut);
		const first = mine[0];
		const whole = cut.some((s) => s.from === 0 && s.to === 24 * 60);
		return { person, hours, planned, ...(first === undefined ? {} : { off: { kind: first.kind, whole, absence: first } }) };
	});
	return { people, closed: c.closed, ...(c.open === undefined ? {} : { open: c.open }), ...(c.holiday === undefined ? {} : { holiday: c.holiday }) };
}

/** The hours the business is open and nobody is on, at least `least` minutes; only when its hours are known. */
export function coverageGaps(d: StaffDay, day: string, least = 15): Span[] {
	const today = dayOf(d, day);
	if (today.open === undefined || !today.open.known || today.closed) return [];
	return minus(today.open.spans, today.people.flatMap((p) => p.hours)).filter((g) => g.to - g.from >= least);
}

/**
 * What the staff blocks of the appointments' resources on the day: an absence (its time), the
 * day outside the person's dates (all of it), and, when the person has a usual week, the time
 * outside the shift (a day of rest: all of it). The business's own closures are the
 * appointments' to say.
 */
export function resourceBlocks(people: readonly Person[], absences: readonly Absence[], shifts: readonly ShiftChange[], day: string): Block[] {
	const DAY = { from: 0, to: 24 * 60 };
	return people.flatMap((p): Block[] => {
		if (p.resource === undefined) return [];
		const resource = p.resource;
		if (!employed(p, day)) return [{ resource, ...DAY, why: "out" }];
		const out: Block[] = absencesOn(absences, p.id, day).map((a) => ({ resource, ...spanOf(a), why: "absent" as const }));
		const own = shifts.some((s) => s.person === p.id && s.day === day);
		if (p.week === undefined && !own) return out;
		const planned = plannedOn(p, day, shifts, false);
		if (planned.length === 0) return [...out, { resource, ...DAY, why: "rest" }];
		return [...out, ...minus([DAY], planned).map((s) => ({ resource, ...s, why: "off" as const }))];
	});
}

/** How ferie days are counted: on a week of 5 days (Monday to Friday) or 6 (to Saturday), with the business's closures and the days said apart. */
export type FerieRule = { readonly six: boolean; readonly shifts: readonly ShiftChange[]; readonly settings?: AppointmentSettings };

export const FIVE: FerieRule = { six: false, shifts: [] };

const closedFor = (settings: AppointmentSettings | undefined, day: string) => (settings?.closures ?? []).some((c) => c.from <= day && day <= c.to);

/** Why a day of the ferie week does not count: a national holiday (its name), a closure, a day off said apart, not a working day of the person. */
export function notCounted(person: Person, day: string, rule: FerieRule): { readonly why: "week" | "holiday" | "closure" | "off" | "person"; readonly holiday?: string } | undefined {
	const wd = weekdayOf(day);
	if (wd === 0 || (wd === 6 && !rule.six)) return { why: "week" };
	if (!employed(person, day)) return { why: "person" };
	const holiday = holidayOn(day);
	if (holiday !== undefined) return { why: "holiday", holiday };
	if (closedFor(rule.settings, day)) return { why: "closure" };
	const own = rule.shifts.find((s) => s.person === person.id && s.day === day);
	if (own !== undefined) return own.hours.length === 0 ? { why: "off" } : undefined;
	// A usual day off of the person does not count; on a week of 6, Saturday does.
	if (person.week !== undefined && (person.week[String(wd)] ?? []).length === 0 && !(rule.six && wd === 6)) return { why: "person" };
	return undefined;
}

/**
 * The working days an absence takes in from–to, in hundredths: a day of the ferie week that the
 * person works, not a national holiday, a closure or a day off said apart, counts 100, a half day
 * 50. An open malattia counts up to `until`.
 */
export function absenceDays(person: Person, a: Absence, from: string, to: string, until: string, rule: FerieRule = FIVE): number {
	const lo = a.from > from ? a.from : from;
	const last = lastDay(a, until);
	const hi = last < to ? last : to;
	let n = 0;
	for (let day = lo; day <= hi; day = addDays(day, 1)) if (notCounted(person, day, rule) === undefined) n += a.half === undefined ? 100 : 50;
	return n;
}

/** What an absence does not count in its days, said: the holidays by name, the closures and the days off. */
export function skippedIn(person: Person, a: Absence, rule: FerieRule): { readonly holidays: readonly string[]; readonly closures: number; readonly off: number } {
	const holidays: string[] = [];
	let closures = 0;
	let off = 0;
	for (let day = a.from; day <= (a.to ?? a.from); day = addDays(day, 1)) {
		const n = notCounted(person, day, rule);
		if (n?.why === "holiday") holidays.push(n.holiday as string);
		else if (n?.why === "closure") closures++;
		else if (n?.why === "off") off++;
	}
	return { holidays, closures, off };
}

/** Calendar days an absence takes in from–to, in hundredths (a malattia, as INPS counts them), an open one up to `until`. */
export function calendarDays(a: Absence, from: string, to: string, until: string): number {
	const lo = a.from > from ? a.from : from;
	const last = lastDay(a, until);
	const hi = last < to ? last : to;
	let n = 0;
	for (let day = lo; day <= hi; day = addDays(day, 1)) n += 100;
	return n;
}

/** The minutes of a permesso (or an «altro» by the hour): its time within the person's planned hours of the day (or the time said, with no usual week). */
export function permessoMinutes(person: Person, a: Absence, shifts: readonly ShiftChange[], settings?: AppointmentSettings): number {
	const span = spanOf(a);
	const planned = plannedOn(person, a.from, shifts, closedOn(settings, a.from).closed);
	if (planned.length === 0) return a.end === undefined ? 0 : span.to - span.from;
	return minutesIn(planned.map((p) => ({ from: Math.max(p.from, span.from), to: Math.min(p.to, span.to) })).filter((s) => s.to > s.from));
}
