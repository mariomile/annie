/**
 * The month for the consulente del lavoro (no I/O, no clock but the day given): per person, a row
 * per day with the hours planned, the hours on (planned less absences), the absence's code (FE,
 * PE, MA, 104, LU, CP…) and the extra hours the owner said, marked on a Sunday or a national
 * holiday; then the malattie with their protocol, the other absences by reason, the day of hiring
 * or leaving when it falls in the month, and the totals. Presenze are the planned shifts, not
 * clockings. The month in course stops at `until` (today). Days in hundredths, hours in minutes.
 */
import type { Span } from "./appointment-slots.ts";
import { addDays, daysInMonth, holidayOn, weekdayOf } from "./italian-calendar.ts";
import { type Absence, type AltroReason, codeOf, employed, type ExtraHours, isActive, lastDay, type Person } from "./staff.ts";
import { absenceDays, absencesOn, calendarDays, dayOf, type FerieRule, FIVE, minutesIn, permessoMinutes, type StaffDay } from "./staff-shifts.ts";

/** A person's day: what was planned, what was on, the codes of the absences, the extra minutes, a Sunday or a holiday. */
export type MonthDay = {
	readonly day: string;
	readonly planned: readonly Span[];
	readonly closed: boolean;
	readonly minutes: number;
	readonly codes: readonly string[];
	readonly extra: number;
	/** «domenica», or the holiday's name. */
	readonly festivo?: string;
};

/** A person's month in totals. Days in hundredths, hours in minutes. */
export type MonthRow = {
	readonly person: Person;
	readonly workedDays: number;
	readonly workedMinutes: number;
	readonly ferie: number;
	readonly permesso: number;
	readonly malattia: number;
	/** «Altro» by the day (hundredths) and by the hour (minutes). */
	readonly altro: number;
	readonly altroMinutes: number;
	readonly extra: number;
	/** Of the extra minutes, those on a Sunday or a national holiday. */
	readonly extraFestivo: number;
};

export type MonthPerson = {
	readonly person: Person;
	readonly days: readonly MonthDay[];
	readonly malattie: readonly { readonly from: string; readonly to?: string; readonly protocol?: string }[];
	readonly altre: readonly { readonly reason: AltroReason; readonly days: number; readonly minutes: number; readonly spans: readonly { readonly from: string; readonly to: string }[] }[];
	/** Hired or gone on a day of the month. */
	readonly hired?: string;
	readonly left?: string;
	readonly totals: MonthRow;
};

export const monthEnd = (first: string): string => `${first.slice(0, 8)}${String(daysInMonth(Number(first.slice(0, 4)), Number(first.slice(5, 7)))).padStart(2, "0")}`;

/** «domenica», the holiday's name, or nothing. */
export const festivoOn = (day: string): string | undefined => holidayOn(day) ?? (weekdayOf(day) === 0 ? "domenica" : undefined);

/** The month from its first day to its last, or to `until` when sooner (the month in course). The people on the staff on some day of it. */
export function monthDetail(d: StaffDay, extras: readonly ExtraHours[], first: string, until: string, rule: FerieRule = FIVE): MonthPerson[] {
	const end = monthEnd(first);
	const last = until < end ? until : end;
	const all: string[] = [];
	for (let day = first; day <= last; day = addDays(day, 1)) all.push(day);
	const plans = new Map(all.map((day) => [day, dayOf(d, day)]));
	return d.people
		.filter((p) => all.some((day) => employed(p, day)))
		.map((person) => {
			const days = all.filter((day) => employed(person, day));
			const rows: MonthDay[] = days.map((day) => {
				const plan = plans.get(day);
				const p = plan?.people.find((x) => x.person.id === person.id);
				const codes = [...new Set(absencesOn(d.absences, person.id, day).map(codeOf))];
				const extra = extras.filter((e) => e.person === person.id && e.day === day).reduce((n, e) => n + e.minutes, 0);
				const festivo = festivoOn(day);
				return { day, planned: p?.planned ?? [], closed: plan?.closed ?? false, minutes: p === undefined ? 0 : minutesIn(p.hours), codes, extra, ...(festivo === undefined ? {} : { festivo }) };
			});
			const mine = d.absences.filter((a) => isActive(a) && a.person === person.id && a.from <= last && lastDay(a, until) >= first);
			const sum = (f: (a: Absence) => number, kind: Absence["kind"], hourly?: boolean) => mine.filter((a) => a.kind === kind && (hourly === undefined || (a.start !== undefined) === hourly)).reduce((n, a) => n + f(a), 0);
			const inMonth = (a: Absence) => a.from >= first && a.from <= last;
			const altre = new Map<AltroReason, { days: number; minutes: number; spans: { from: string; to: string }[] }>();
			for (const a of mine.filter((x) => x.kind === "altro")) {
				const reason = a.reason ?? "altro";
				const g = altre.get(reason) ?? { days: 0, minutes: 0, spans: [] };
				if (a.start !== undefined) g.minutes += inMonth(a) ? permessoMinutes(person, a, d.shifts, d.settings) : 0;
				else g.days += absenceDays(person, a, first, last, until, rule);
				g.spans.push({ from: a.from > first ? a.from : first, to: lastDay(a, until) < last ? lastDay(a, until) : last });
				altre.set(reason, g);
			}
			const extraAll = rows.reduce((n, r) => n + r.extra, 0);
			const totals: MonthRow = {
				person,
				workedDays: rows.filter((r) => r.minutes > 0).length,
				workedMinutes: rows.reduce((n, r) => n + r.minutes, 0),
				ferie: sum((a) => absenceDays(person, a, first, last, until, rule), "ferie"),
				permesso: sum((a) => (inMonth(a) ? permessoMinutes(person, a, d.shifts, d.settings) : 0), "permesso"),
				malattia: sum((a) => calendarDays(a, first, last, until), "malattia"),
				altro: sum((a) => absenceDays(person, a, first, last, until, rule), "altro", false),
				altroMinutes: sum((a) => (inMonth(a) ? permessoMinutes(person, a, d.shifts, d.settings) : 0), "altro", true),
				extra: extraAll,
				extraFestivo: rows.filter((r) => r.festivo !== undefined).reduce((n, r) => n + r.extra, 0),
			};
			const malattie = mine.filter((a) => a.kind === "malattia").sort((a, b) => a.from.localeCompare(b.from)).map((a) => ({ from: a.from, ...(a.to === undefined ? {} : { to: a.to }), ...(a.protocol === undefined ? {} : { protocol: a.protocol }) }));
			return {
				person,
				days: rows,
				malattie,
				altre: [...altre.entries()].map(([reason, g]) => ({ reason, ...g })),
				...(person.from !== undefined && person.from > first && person.from <= last ? { hired: person.from } : {}),
				...(person.to !== undefined && person.to >= first && person.to < end ? { left: person.to } : {}),
				totals,
			};
		});
}

/** The month's totals alone. */
export const monthRows = (d: StaffDay, extras: readonly ExtraHours[], first: string, until: string, rule: FerieRule = FIVE): MonthRow[] => monthDetail(d, extras, first, until, rule).map((m) => m.totals);
