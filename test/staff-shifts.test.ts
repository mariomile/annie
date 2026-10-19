import { describe, expect, it } from "vitest";
import { hoursWords, overlaps } from "../src/core/staff.ts";
import { balancesOf } from "../src/core/staff-balances.ts";
import { absenceDays, coverageGaps, dayOf, monthRows, permessoMinutes, resourceBlocks } from "../src/core/staff-shifts.ts";
import { absence, GIULIA, HOURS, MARCO, MARK } from "./staff-fixtures.ts";

const d = (absences = [] as ReturnType<typeof absence>[], o: { settings?: typeof HOURS | undefined } = { settings: HOURS }) => ({ people: [GIULIA, MARCO], absences, shifts: [], ...(o.settings === undefined ? {} : { settings: o.settings }) });

describe("the day's shifts", () => {
	it("from the usual week; a half day of ferie and a permesso cut it; a whole absence takes it", () => {
		// Thursday 22 October.
		const day = dayOf(d(), "2026-10-22");
		expect(day.people.map((p) => p.hours)).toEqual([[{ from: 540, to: 780 }, { from: 840, to: 1080 }], [{ from: 540, to: 780 }, { from: 900, to: 1140 }]]);
		const off = dayOf(d([absence({ person: "PE-0001", kind: "ferie", from: "2026-10-22", half: "mattina" }), absence({ person: "PE-0002", kind: "permesso", from: "2026-10-22", start: "15:00" })]), "2026-10-22");
		expect(off.people[0]?.hours).toEqual([{ from: 840, to: 1080 }]);
		expect(off.people[1]?.hours).toEqual([{ from: 540, to: 780 }]);
		expect(off.people[1]?.off).toMatchObject({ kind: "permesso", whole: false });
		const sick = dayOf(d([absence({ person: "PE-0002", kind: "malattia", from: "2026-10-20", to: undefined })]), "2026-10-29");
		expect(sick.people[1]).toMatchObject({ hours: [], off: { kind: "malattia", whole: true } });
	});

	it("closed on a national holiday and on the business's closures; with no business hours, the national holidays", () => {
		expect(dayOf(d(), "2026-12-08").people.every((p) => p.hours.length === 0)).toBe(true);
		expect(dayOf(d([], { settings: undefined }), "2026-12-08").closed).toBe(true);
		const closure = { ...HOURS, closures: [{ from: "2026-10-22", to: "2026-10-22" }] };
		expect(dayOf({ ...d(), settings: closure }, "2026-10-22").closed).toBe(true);
	});

	it("coverage gaps: open and nobody on; none when the hours are not known", () => {
		// Monday: Marco is off; Giulia 9-13 and 14-18; open until 19.
		expect(coverageGaps(d(), "2026-10-19")).toEqual([{ from: 1080, to: 1140 }]);
		// Saturday: only Marco, 9-13: covered.
		expect(coverageGaps(d(), "2026-10-24")).toEqual([]);
		expect(coverageGaps(d([absence({ person: "PE-0002", kind: "ferie", from: "2026-10-24" })]), "2026-10-24")).toEqual([{ from: 540, to: 780 }]);
		expect(coverageGaps(d([], { settings: undefined }), "2026-10-19")).toEqual([]);
	});

	it("the resources an absence blocks", () => {
		const list = [absence({ person: "PE-0002", kind: "permesso", from: "2026-10-22", start: "15:00", end: "17:00" }), absence({ person: "PE-0001", kind: "ferie", from: "2026-10-22" })];
		expect(resourceBlocks([GIULIA, MARCO], list, "2026-10-22")).toEqual([{ resource: "Marco", from: 900, to: 1020 }]);
		expect(resourceBlocks([GIULIA, MARCO], list, "2026-10-23")).toEqual([]);
	});
});

describe("counting", () => {
	it("ferie in working days: the person's days off and the national holidays do not count", () => {
		const a = absence({ person: "PE-0001", kind: "ferie", from: "2026-08-03", to: "2026-08-14" });
		expect(absenceDays(GIULIA, a, "2026-01-01", "2026-12-31", "2026-10-19")).toBe(1000);
		// 7-11 December: 8 December is the Immacolata.
		expect(absenceDays(GIULIA, absence({ person: "PE-0001", kind: "ferie", from: "2026-12-07", to: "2026-12-11" }), "2026-01-01", "2026-12-31", "2026-10-19")).toBe(400);
		// Marco works Saturdays, not Mondays.
		expect(absenceDays(MARCO, absence({ person: "PE-0002", kind: "ferie", from: "2026-10-19", to: "2026-10-25" }), "2026-01-01", "2026-12-31", "2026-10-19")).toBe(500);
		expect(absenceDays(GIULIA, absence({ person: "PE-0001", kind: "ferie", from: "2026-10-22", half: "pomeriggio" }), "2026-01-01", "2026-12-31", "2026-10-19")).toBe(50);
	});

	it("a permesso «dalle 15» is the rest of the shift; hours as exact decimals", () => {
		expect(permessoMinutes(MARCO, absence({ person: "PE-0002", kind: "permesso", from: "2026-10-20", start: "15:00" }), [], HOURS)).toBe(240);
		expect(permessoMinutes(GIULIA, absence({ person: "PE-0001", kind: "permesso", from: "2026-10-20", start: "12:00", end: "15:00" }), [], HOURS)).toBe(120);
		expect(hoursWords(450)).toBe("7,5");
		expect(hoursWords(20)).toBe("0,33");
	});

	it("overlaps by days, and on one day by the hours", () => {
		expect(overlaps({ from: "2026-08-03", to: "2026-08-14" }, { from: "2026-08-14", to: "2026-08-20" })).toBe(true);
		expect(overlaps({ from: "2026-10-22", to: "2026-10-22", half: "mattina" }, { from: "2026-10-22", to: "2026-10-22", start: "15:00" })).toBe(false);
		expect(overlaps({ from: "2026-10-20" }, { from: "2027-01-10", to: "2027-01-10" })).toBe(true);
	});
});

describe("balances: an estimate", () => {
	it("the year's at once, less taken and planned; month by month when said; from the balance said", () => {
		const list = [absence({ person: "PE-0001", kind: "ferie", from: "2026-08-03", to: "2026-08-14" }), absence({ person: "PE-0001", kind: "ferie", from: "2026-12-28", to: "2026-12-31" }), absence({ person: "PE-0001", kind: "permesso", from: "2026-10-16", start: "16:00" })];
		const b = balancesOf(GIULIA, list, [], "2026-10-19", false, HOURS);
		expect(b.ferie).toEqual({ entitled: 2600, taken: 1000, planned: 400, left: 1200 });
		expect(b.permessi).toEqual({ entitled: 72 * 60, taken: 120, planned: 0, left: 72 * 60 - 120 });
		// Ten months of 26 days: 21,67.
		expect(balancesOf(GIULIA, list, [], "2026-10-19", true, HOURS).ferie.entitled).toBe(2167);
		const said = { ...GIULIA, opening: { day: "2026-09-01", ferie: "15", rol: "40" } };
		const o = balancesOf(said, list, [], "2026-10-19", false, HOURS);
		expect(o.fromOpening).toBe(true);
		expect(o.ferie).toEqual({ entitled: 1500, taken: 0, planned: 400, left: 1100 });
		expect(o.permessi.left).toBe(40 * 60 - 120);
		expect(balancesOf({ ...GIULIA, ferieDays: undefined }, list, [], "2026-10-19", false).ferie.left).toBeUndefined();
	});
});

describe("the month for the consulente", () => {
	it("worked days and hours, ferie, permessi, malattia in calendar days, the extra hours", () => {
		const list = [absence({ person: "PE-0002", kind: "malattia", from: "2026-10-27", to: undefined }), absence({ person: "PE-0001", kind: "permesso", from: "2026-10-16", start: "16:00" }), absence({ person: "PE-0001", kind: "ferie", from: "2026-10-30" })];
		const rows = monthRows(d(list), [{ person: "PE-0002", day: "2026-10-20", minutes: 120, callId: "x", ...MARK }], "2026-10-01", "2026-10-31");
		// October 2026: Giulia 22 weekdays, one of ferie; 21 days of 8 hours less the 2 of the permesso.
		expect(rows[0]).toMatchObject({ workedDays: 21, workedMinutes: 21 * 480 - 120, ferie: 100, permesso: 120, malattia: 0, extra: 0 });
		// Marco: Tue-Sat; sick from the 27th to the 31st (5 calendar days).
		expect(rows[1]).toMatchObject({ malattia: 500, extra: 120 });
		expect(rows[1]?.workedDays).toBe(18);
	});
});
