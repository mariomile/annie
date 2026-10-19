/**
 * I turni, day by day (no I/O, no clock): who works when, from the usual week or the day's own
 * shift said apart, less the absences and the days the business is closed (its hours, closures
 * and national holidays from the appointments' settings when there are some, else the national
 * holidays); who is off and why; the hours the business is open and nobody is on (coverage gaps);
 * the resources of the appointments an absence blocks; a month for the consulente del lavoro.
 * Wall-clock minutes of the day, like the appointments: the summer-time changes move nothing.
 */
import { type AppointmentSettings, minutesOf, toMinutes } from "./appointments.ts";
import { type Open, openOn, type Span } from "./appointment-slots.ts";
import { addDays, daysInMonth, holidayOn, weekdayOf } from "./italian-calendar.ts";
import { type Absence, type AbsenceKind, type ExtraHours, isActive, lastDay, type Person, type ShiftChange, spanOf } from "./staff.ts";

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
	const people = d.people.map((person) => {
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

/** What absences block of the appointments' resources on the day: the resource and the time. */
export function resourceBlocks(people: readonly Person[], absences: readonly Absence[], day: string): { readonly resource: string; readonly from: number; readonly to: number }[] {
	return people.flatMap((p) => (p.resource === undefined ? [] : absencesOn(absences, p.id, day).map((a) => ({ resource: p.resource as string, ...spanOf(a) }))));
}

/** Whether the person works on the weekday as usual (no usual week: Monday to Friday). */
export function usualWorkday(person: Person, day: string): boolean {
	const wd = weekdayOf(day);
	if (person.week === undefined) return wd >= 1 && wd <= 5;
	return (person.week[String(wd)] ?? []).length > 0;
}

/**
 * The working days an absence takes in from–to, in hundredths: a usual working day of the
 * person that is not a national holiday counts 100, a half day 50. An open malattia counts up to
 * `until`.
 */
export function absenceDays(person: Person, a: Absence, from: string, to: string, until: string): number {
	const lo = a.from > from ? a.from : from;
	const last = lastDay(a, until);
	const hi = last < to ? last : to;
	let n = 0;
	for (let day = lo; day <= hi; day = addDays(day, 1)) if (usualWorkday(person, day) && holidayOn(day) === undefined) n += a.half === undefined ? 100 : 50;
	return n;
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

/** The minutes of a permesso: its time within the person's planned hours of the day (or the time said, with no usual week). */
export function permessoMinutes(person: Person, a: Absence, shifts: readonly ShiftChange[], settings?: AppointmentSettings): number {
	const span = spanOf(a);
	const planned = plannedOn(person, a.from, shifts, closedOn(settings, a.from).closed);
	if (planned.length === 0) return a.end === undefined ? 0 : span.to - span.from;
	return minutesIn(planned.map((p) => ({ from: Math.max(p.from, span.from), to: Math.min(p.to, span.to) })).filter((s) => s.to > s.from));
}

/** A person's month for the consulente del lavoro. Days in hundredths, hours in minutes. */
export type MonthRow = {
	readonly person: Person;
	readonly workedDays: number;
	readonly workedMinutes: number;
	readonly ferie: number;
	readonly permesso: number;
	readonly malattia: number;
	readonly altro: number;
	readonly extra: number;
};

/** The month (from its first day) up to its last day: planned shifts less absences; open malattie up to `until`. */
export function monthRows(d: StaffDay, extras: readonly ExtraHours[], first: string, until: string): MonthRow[] {
	const year = Number(first.slice(0, 4));
	const month = Number(first.slice(5, 7));
	const last = `${first.slice(0, 8)}${String(daysInMonth(year, month)).padStart(2, "0")}`;
	const days: string[] = [];
	for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
	const plans = days.map((day) => dayOf(d, day));
	return d.people.map((person) => {
		let workedDays = 0;
		let workedMinutes = 0;
		for (const plan of plans) {
			const p = plan.people.find((x) => x.person.id === person.id);
			const m = p === undefined ? 0 : minutesIn(p.hours);
			if (m > 0) workedDays++;
			workedMinutes += m;
		}
		const mine = d.absences.filter((a) => isActive(a) && a.person === person.id && a.from <= last && lastDay(a, until) >= first);
		const sum = (kind: AbsenceKind, f: (a: Absence) => number) => mine.filter((a) => a.kind === kind).reduce((n, a) => n + f(a), 0);
		return {
			person,
			workedDays,
			workedMinutes,
			ferie: sum("ferie", (a) => absenceDays(person, a, first, last, until)),
			permesso: sum("permesso", (a) => permessoMinutes(person, a, d.shifts, d.settings)),
			malattia: sum("malattia", (a) => calendarDays(a, first, last, until)),
			altro: sum("altro", (a) => absenceDays(person, a, first, last, until)),
			extra: extras.filter((e) => e.person === person.id && e.day >= first && e.day <= last).reduce((n, e) => n + e.minutes, 0),
		};
	});
}

