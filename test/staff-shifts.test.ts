import { describe, expect, it } from "vitest";
import { hoursWords, overlaps } from "../src/core/staff.ts";
import { balancesOf, monthsOn } from "../src/core/staff-balances.ts";
import { monthDetail, monthRows } from "../src/core/staff-month.ts";
import { absenceDays, coverageGaps, dayOf, FIVE, permessoMinutes, resourceBlocks, skippedIn } from "../src/core/staff-shifts.ts";
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

	it("the resources an absence blocks, and the time off the shift when there is a usual week", () => {
		const list = [absence({ person: "PE-0002", kind: "permesso", from: "2026-10-22", start: "15:00", end: "17:00" }), absence({ person: "PE-0001", kind: "ferie", from: "2026-10-22" })];
		const off = [{ resource: "Marco", from: 0, to: 540, why: "off" }, { resource: "Marco", from: 780, to: 900, why: "off" }, { resource: "Marco", from: 1140, to: 1440, why: "off" }];
		expect(resourceBlocks([GIULIA, MARCO], list, [], "2026-10-22")).toEqual([{ resource: "Marco", from: 900, to: 1020, why: "absent" }, ...off]);
		expect(resourceBlocks([GIULIA, MARCO], list, [], "2026-10-23")).toEqual(off);
		// Monday: Marco's day of rest; a shift said apart makes it a working day.
		expect(resourceBlocks([MARCO], [], [], "2026-10-26")).toEqual([{ resource: "Marco", from: 0, to: 1440, why: "rest" }]);
		expect(resourceBlocks([MARCO], [], [{ person: "PE-0002", day: "2026-10-26", hours: [{ from: "09:00", to: "19:00" }], ...MARK }], "2026-10-26")).toEqual([{ resource: "Marco", from: 0, to: 540, why: "off" }, { resource: "Marco", from: 1140, to: 1440, why: "off" }]);
		// No usual week: only the absences block.
		expect(resourceBlocks([{ ...MARCO, week: undefined }], [], [], "2026-10-26")).toEqual([]);
		// Outside the person's dates: the whole day.
		expect(resourceBlocks([{ ...MARCO, to: "2026-10-23" }], [], [], "2026-10-24")).toEqual([{ resource: "Marco", from: 0, to: 1440, why: "out" }]);
	});

	it("only the people hired by the day and not yet gone are in the day", () => {
		const day = dayOf({ ...d(), people: [{ ...GIULIA, from: "2026-10-26" }, { ...MARCO, to: "2026-10-21" }] }, "2026-10-22");
		expect(day.people).toEqual([]);
		expect(coverageGaps({ ...d(), people: [{ ...GIULIA, from: "2026-10-26" }, MARCO] }, "2026-10-19")).toEqual([{ from: 540, to: 780 }, { from: 840, to: 1140 }]);
	});
});

describe("counting", () => {
	it("ferie in working days: the person's days off and the national holidays do not count", () => {
		const a = absence({ person: "PE-0001", kind: "ferie", from: "2026-08-03", to: "2026-08-14" });
		expect(absenceDays(GIULIA, a, "2026-01-01", "2026-12-31", "2026-10-19")).toBe(1000);
		// 7-11 December: 8 December is the Immacolata.
		expect(absenceDays(GIULIA, absence({ person: "PE-0001", kind: "ferie", from: "2026-12-07", to: "2026-12-11" }), "2026-01-01", "2026-12-31", "2026-10-19")).toBe(400);
		// Marco works Saturdays, not Mondays: on a week of 5 his Saturday does not count, on a week of 6 it does.
		const week = absence({ person: "PE-0002", kind: "ferie", from: "2026-10-19", to: "2026-10-25" });
		expect(absenceDays(MARCO, week, "2026-01-01", "2026-12-31", "2026-10-19")).toBe(400);
		expect(absenceDays(MARCO, week, "2026-01-01", "2026-12-31", "2026-10-19", { ...FIVE, six: true })).toBe(500);
		// On a week of 6, Saturday counts for Giulia too.
		expect(absenceDays(GIULIA, absence({ person: "PE-0001", kind: "ferie", from: "2026-10-19", to: "2026-10-25" }), "2026-01-01", "2026-12-31", "2026-10-19", { ...FIVE, six: true })).toBe(600);
		expect(absenceDays(GIULIA, absence({ person: "PE-0001", kind: "ferie", from: "2026-10-22", half: "pomeriggio" }), "2026-01-01", "2026-12-31", "2026-10-19")).toBe(50);
	});

	it("the business's closures and the days off said apart do not count, and are said", () => {
		const a = absence({ person: "PE-0001", kind: "ferie", from: "2026-12-07", to: "2026-12-11" });
		const rule = { six: false, shifts: [{ person: "PE-0001", day: "2026-12-10", hours: [], ...MARK }], settings: { ...HOURS, closures: [{ from: "2026-12-09", to: "2026-12-09" }] } };
		expect(absenceDays(GIULIA, a, "2026-01-01", "2026-12-31", "2026-10-19", rule)).toBe(200);
		expect(skippedIn(GIULIA, a, rule)).toEqual({ holidays: ["Immacolata Concezione"], closures: 1, off: 1 });
		expect(skippedIn(GIULIA, absence({ person: "PE-0001", kind: "ferie", from: "2026-08-10", to: "2026-08-21" }), FIVE).holidays).toEqual([]);
		expect(skippedIn(GIULIA, absence({ person: "PE-0001", kind: "ferie", from: "2025-08-11", to: "2025-08-22" }), FIVE).holidays).toEqual(["Ferragosto"]);
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

	it("hired or gone during the year: the months on the staff, a month counting from 15 days", () => {
		expect(monthsOn({ from: "2026-10-01" }, 2026)).toBe(3);
		expect(monthsOn({ from: "2026-10-18" }, 2026)).toBe(2);
		expect(monthsOn({ from: "2026-10-17" }, 2026)).toBe(3);
		expect(monthsOn({ to: "2026-03-15" }, 2026)).toBe(3);
		expect(monthsOn({}, 2026)).toBe(12);
		const b = balancesOf({ ...GIULIA, from: "2026-10-01" }, [], [], "2026-10-19", false, HOURS);
		// 26 days for 3 months: 6,5.
		expect(b.ferie.entitled).toBe(650);
		expect(b.months).toBe(3);
		expect(b.permessi.entitled).toBe(18 * 60);
		expect(balancesOf(GIULIA, [], [], "2026-10-19", false, HOURS).months).toBeUndefined();
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

	it("day by day: the hours planned and on, the codes, the extra hours on a Sunday; malattie with the protocol; other absences by reason; stops at the day given", () => {
		const list = [
			absence({ person: "PE-0002", kind: "malattia", from: "2026-10-06", to: "2026-10-09", protocol: "123456789" }),
			absence({ person: "PE-0002", kind: "malattia", from: "2026-10-16", to: undefined }),
			absence({ person: "PE-0001", kind: "altro", reason: "L.104", from: "2026-10-12", start: "09:00", end: "11:00" }),
			absence({ person: "PE-0001", kind: "altro", reason: "lutto", from: "2026-10-14", to: "2026-10-15" }),
		];
		const [g, m] = monthDetail(d(list), [{ person: "PE-0002", day: "2026-10-11", minutes: 120, callId: "x", ...MARK }], "2026-10-01", "2026-10-19");
		expect(g?.days).toHaveLength(19);
		expect(g?.days.find((x) => x.day === "2026-10-12")).toMatchObject({ minutes: 360, codes: ["104"] });
		expect(g?.days.find((x) => x.day === "2026-10-14")).toMatchObject({ minutes: 0, codes: ["LU"] });
		expect(g?.altre).toEqual([
			{ reason: "L.104", days: 0, minutes: 120, spans: [{ from: "2026-10-12", to: "2026-10-12" }] },
			{ reason: "lutto", days: 200, minutes: 0, spans: [{ from: "2026-10-14", to: "2026-10-15" }] },
		]);
		expect(g?.totals).toMatchObject({ altro: 200, altroMinutes: 120 });
		expect(m?.days.find((x) => x.day === "2026-10-11")).toMatchObject({ extra: 120, festivo: "domenica", minutes: 0 });
		expect(m?.days.find((x) => x.day === "2026-10-07")).toMatchObject({ codes: ["MA"], minutes: 0, planned: [{ from: 540, to: 780 }, { from: 900, to: 1140 }] });
		expect(m?.malattie).toEqual([{ from: "2026-10-06", to: "2026-10-09", protocol: "123456789" }, { from: "2026-10-16" }]);
		// 6 to 9 and 16 to 19: 8 calendar days so far.
		expect(m?.totals).toMatchObject({ malattia: 800, extra: 120, extraFestivo: 120 });
		// Hired on the 14th: from then on, and said.
		const [h] = monthDetail({ ...d(), people: [{ ...GIULIA, from: "2026-10-14" }] }, [], "2026-10-01", "2026-10-31");
		expect(h?.days[0]?.day).toBe("2026-10-14");
		expect(h?.hired).toBe("2026-10-14");
	});
});
