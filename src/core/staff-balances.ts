/**
 * Le ferie e i permessi left (no I/O, no clock but the day given): a year's entitlement (all at
 * once, or month by month when the owner said so), or the balance the owner said on a day, less
 * what is taken (up to today) and planned (after). An estimate: the consulente del lavoro has the
 * official figure (carried over from the years before, accruals of the contract). Hired or gone
 * during the year: the months on the staff only (a month counts from 15 days in it), said as an
 * estimate. Ferie in hundredths of a working day (counted as FerieRule says), permessi (ROL and
 * ex festività together) in minutes.
 */
import type { AppointmentSettings } from "./appointments.ts";
import { addDays, daysInMonth, isoDate } from "./italian-calendar.ts";
import { type Absence, employed, hundredths, isActive, type Person, type ShiftChange } from "./staff.ts";
import { absenceDays, type FerieRule, FIVE, permessoMinutes } from "./staff-shifts.ts";

export type Balance = {
	/** What the year gives (or the balance said), so far: hundredths of a day, minutes. */
	readonly entitled?: number;
	readonly taken: number;
	readonly planned: number;
	/** entitled less taken and planned. */
	readonly left?: number;
};

export type Balances = {
	readonly year: number;
	readonly ferie: Balance;
	readonly permessi: Balance;
	readonly fromOpening: boolean;
	readonly monthly: boolean;
	/** Hired or gone in the year: the months on the staff that count (of 12). */
	readonly months?: number;
};

/** The months of the year the person is on the staff for at least 15 days of, up to `upTo`'s month. */
export function monthsOn(person: Pick<Person, "from" | "to">, year: number, upTo = 12): number {
	let n = 0;
	for (let m = 1; m <= upTo; m++) {
		let on = 0;
		for (let d = 1; d <= daysInMonth(year, m); d++) if (employed(person, isoDate(year, m, d))) on++;
		if (on >= 15) n++;
	}
	return n;
}

/** The year's amount for `months` of 12, half up to the hundredth. */
const share = (yearly: number, months: number): number => Math.floor((yearly * months * 2 + 12) / 24);

export function balancesOf(person: Person, absences: readonly Absence[], shifts: readonly ShiftChange[], today: string, monthly: boolean, settings?: AppointmentSettings, rule: FerieRule = { ...FIVE, shifts, ...(settings === undefined ? {} : { settings }) }): Balances {
	const year = Number(today.slice(0, 4));
	const partial = (person.from !== undefined && person.from > `${year}-01-01`) || (person.to !== undefined && person.to < `${year}-12-31`);
	const months = monthsOn(person, year, monthly ? Number(today.slice(5, 7)) : 12);
	const accrued = (yearly: number) => (monthly || partial ? share(yearly, months) : yearly);
	const opening = person.opening !== undefined && Number(person.opening.day.slice(0, 4)) === year ? person.opening : undefined;
	// From the balance said: what is used from its day on; else the whole year.
	const from = opening?.day ?? `${year}-01-01`;
	const end = `${year}-12-31`;
	const mine = absences.filter((a) => isActive(a) && a.person === person.id && a.from <= end && (a.to ?? today) >= from);
	const split = (count: (a: Absence, lo: string, hi: string) => number, kind: Absence["kind"]) => {
		let taken = 0;
		let planned = 0;
		for (const a of mine.filter((x) => x.kind === kind)) {
			taken += count(a, from, today);
			if (today < end) planned += count(a, addDays(today, 1), end);
		}
		return { taken, planned };
	};
	const ferie = split((a, lo, hi) => (hi < lo ? 0 : absenceDays(person, a, lo, hi, today, rule)), "ferie");
	const permessi = split((a, lo, hi) => (a.from < lo || a.from > hi ? 0 : permessoMinutes(person, a, shifts, settings)), "permesso");
	const ferieEntitled = opening?.ferie !== undefined ? hundredths(opening.ferie) : person.ferieDays === undefined ? undefined : accrued(hundredths(person.ferieDays));
	const rolEntitled = opening?.rol !== undefined ? (hundredths(opening.rol) * 60) / 100 : person.rolHours === undefined ? undefined : (accrued(hundredths(person.rolHours)) * 60) / 100;
	const rol = rolEntitled === undefined ? undefined : Math.round(rolEntitled);
	return {
		year,
		ferie: { ...ferie, ...(ferieEntitled === undefined ? {} : { entitled: ferieEntitled, left: ferieEntitled - ferie.taken - ferie.planned }) },
		permessi: { ...permessi, ...(rol === undefined ? {} : { entitled: rol, left: rol - permessi.taken - permessi.planned }) },
		fromOpening: opening !== undefined,
		monthly: monthly && opening === undefined,
		...(partial && opening === undefined ? { months } : {}),
	};
}

