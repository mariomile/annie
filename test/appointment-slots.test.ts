import { describe, expect, it } from "vitest";
import type { Appointment, AppointmentSettings } from "../src/core/appointments.ts";
import { fits, freeSlots, gapsOf, localNow, nearestFree, openOn } from "../src/core/appointment-slots.ts";

// Synthetic data only.
const MARK = { by: "test:u", at: "2026-10-19T08:00:00.000Z" };
const DAY = { from: "09:00", to: "13:00" };
const AFTERNOON = { from: "14:30", to: "19:00" };
// Tuesday to Saturday, a lunch break; Sunday and Monday closed.
const SETTINGS: AppointmentSettings = { ...MARK, week: { 2: [DAY, AFTERNOON], 3: [DAY, AFTERNOON], 4: [DAY, AFTERNOON], 5: [DAY, AFTERNOON], 6: [DAY] }, closures: [{ from: "2026-12-24", to: "2026-12-31", note: "ferie" }] };

const appt = (id: string, day: string, start: string, minutes: number, more: Partial<Appointment> = {}): Appointment => ({ ...MARK, id, status: "booked", client: { name: "Cliente Prova" }, services: [{ name: "Taglio", minutes }], day, start, minutes, callId: id, ...more });

describe("opening hours", () => {
	it("by weekday with the break; closed on Monday, on a closure and on the national holidays (Easter Monday too)", () => {
		expect(openOn(SETTINGS, "2026-10-22")).toEqual({ known: true, spans: [{ from: 540, to: 780 }, { from: 870, to: 1140 }] });
		expect(openOn(SETTINGS, "2026-10-19")).toMatchObject({ known: true, spans: [], why: "weekday" });
		expect(openOn(SETTINGS, "2026-12-29")).toMatchObject({ spans: [], why: "closure" });
		// 8 December 2026 is a Tuesday, Easter Monday 2027 is 29 March (a Monday: closed anyway), 1 May 2027 a Saturday.
		expect(openOn(SETTINGS, "2026-12-08")).toMatchObject({ spans: [], why: "holiday", holiday: "Immacolata Concezione" });
		expect(openOn(SETTINGS, "2027-05-01")).toMatchObject({ spans: [], why: "holiday" });
		expect(openOn({ ...SETTINGS, week: { ...SETTINGS.week, 1: [DAY] } }, "2027-03-29")).toMatchObject({ spans: [], why: "holiday", holiday: "Lunedì dell'Angelo (Pasquetta)" });
		expect(openOn({ ...SETTINGS, holidaysOpen: true }, "2026-12-08").spans).toHaveLength(2);
		// No hours said: the whole day, not known.
		expect(openOn(undefined, "2026-10-19")).toEqual({ known: false, spans: [{ from: 0, to: 1440 }] });
	});
});

describe("fitting an appointment", () => {
	const booked = [appt("AP-0001", "2026-10-22", "15:00", 60)];

	it("inside the hours and free: fits; over the break, outside or on another appointment: why", () => {
		expect(fits({ settings: SETTINGS, appointments: booked, day: "2026-10-22", start: 16 * 60, minutes: 45 })).toEqual({ ok: true });
		expect(fits({ settings: SETTINGS, appointments: booked, day: "2026-10-22", start: 12 * 60 + 30, minutes: 60 })).toMatchObject({ ok: false, why: "outside" });
		expect(fits({ settings: SETTINGS, appointments: booked, day: "2026-10-22", start: 15 * 60 + 30, minutes: 30 })).toMatchObject({ ok: false, why: "overlap", with: "AP-0001" });
		expect(fits({ settings: SETTINGS, appointments: booked, day: "2026-10-19", start: 10 * 60, minutes: 30 })).toMatchObject({ ok: false, why: "closed" });
		// Back to back is fine; a cancelled one frees its time; the one being moved does not block itself.
		expect(fits({ settings: SETTINGS, appointments: booked, day: "2026-10-22", start: 16 * 60, minutes: 30 })).toEqual({ ok: true });
		expect(fits({ settings: SETTINGS, appointments: [appt("AP-0001", "2026-10-22", "15:00", 60, { status: "cancelled", closed: MARK })], day: "2026-10-22", start: 15 * 60, minutes: 30 })).toEqual({ ok: true });
		expect(fits({ settings: SETTINGS, appointments: booked, day: "2026-10-22", start: 15 * 60 + 15, minutes: 60, except: "AP-0001" })).toEqual({ ok: true });
		// In the past: never.
		expect(fits({ settings: SETTINGS, appointments: [], day: "2026-10-22", start: 9 * 60, minutes: 30, now: { day: "2026-10-22", minutes: 10 * 60 } })).toMatchObject({ ok: false, why: "past" });
	});

	it("per resource: another resource is free; a service that needs one takes the first free of those", () => {
		const two = { ...SETTINGS, resources: ["Marco", "Giulia"] };
		const marco = [appt("AP-0001", "2026-10-22", "15:00", 60, { resource: "Marco" })];
		expect(fits({ settings: two, appointments: marco, day: "2026-10-22", start: 15 * 60, minutes: 30 })).toEqual({ ok: true, resource: "Giulia" });
		expect(fits({ settings: two, appointments: marco, day: "2026-10-22", start: 15 * 60, minutes: 30, resource: "Marco" })).toMatchObject({ ok: false, why: "overlap" });
		expect(fits({ settings: two, appointments: marco, day: "2026-10-22", start: 15 * 60, minutes: 30, needs: ["Marco"] })).toMatchObject({ ok: false, why: "overlap" });
		expect(fits({ settings: two, appointments: marco, day: "2026-10-22", start: 16 * 60, minutes: 30, needs: ["Marco"] })).toEqual({ ok: true, resource: "Marco" });
	});
});

describe("free slots", () => {
	it("on the slot step, around the appointments and the break, in a window («giovedì pomeriggio»)", () => {
		const booked = [appt("AP-0001", "2026-10-22", "15:00", 60)];
		const pm = freeSlots({ settings: SETTINGS, appointments: booked, day: "2026-10-22", minutes: 60, from: 13 * 60, to: 19 * 60 });
		expect(pm.map((s) => s.start)).toEqual([960, 975, 990, 1005, 1020, 1035, 1050, 1065, 1080]);
		expect(freeSlots({ settings: { ...SETTINGS, slot: 30 }, appointments: booked, day: "2026-10-22", minutes: 60, from: 13 * 60 }).map((s) => s.start)).toEqual([960, 990, 1020, 1050, 1080]);
		expect(freeSlots({ settings: SETTINGS, appointments: [], day: "2026-10-19", minutes: 30 })).toEqual([]);
	});

	it("the nearest free slots in place of a conflict: the same day first, then the next days", () => {
		const full = [appt("AP-0001", "2026-10-24", "09:00", 240)];
		const near = nearestFree({ settings: SETTINGS, appointments: full, day: "2026-10-24", start: 10 * 60, minutes: 60 });
		// Saturday is full, Sunday and Monday closed: Tuesday morning.
		expect(near).toEqual([
			{ day: "2026-10-27", start: 540 },
			{ day: "2026-10-27", start: 555 },
			{ day: "2026-10-27", start: 570 },
		]);
		const busy = [appt("AP-0001", "2026-10-22", "15:00", 60)];
		expect(nearestFree({ settings: SETTINGS, appointments: busy, day: "2026-10-22", start: 15 * 60, minutes: 60 }).map((s) => s.start)).toEqual([960, 975, 990]);
	});

	it("the gaps of a day, for the brief", () => {
		const booked = [appt("AP-0001", "2026-10-22", "09:00", 60), appt("AP-0002", "2026-10-22", "11:00", 120), appt("AP-0003", "2026-10-22", "14:30", 270)];
		expect(gapsOf(SETTINGS, booked, "2026-10-22")).toEqual([{ from: 600, to: 660 }]);
	});
});

describe("the summer-time changes", () => {
	it("now in Rome across the October and March changes; wall-clock slots do not move on those days", () => {
		// 25 October 2026: at 03:00 CEST the clocks go back to 02:00 CET.
		expect(localNow("Europe/Rome", new Date("2026-10-24T22:30:00Z"))).toEqual({ day: "2026-10-25", minutes: 30 });
		expect(localNow("Europe/Rome", new Date("2026-10-25T08:00:00Z"))).toEqual({ day: "2026-10-25", minutes: 9 * 60 });
		expect(localNow("Europe/Rome", new Date("2026-10-24T08:00:00Z"))).toEqual({ day: "2026-10-24", minutes: 10 * 60 });
		// 29 March 2026: at 02:00 CET the clocks go forward to 03:00 CEST.
		expect(localNow("Europe/Rome", new Date("2026-03-28T08:00:00Z"))).toEqual({ day: "2026-03-28", minutes: 9 * 60 });
		expect(localNow("Europe/Rome", new Date("2026-03-29T08:00:00Z"))).toEqual({ day: "2026-03-29", minutes: 10 * 60 });
		// A Sunday open for once: the same slots as any day, the hour that repeats or goes missing is at night.
		const sunday = { ...SETTINGS, week: { 0: [{ from: "09:00", to: "11:00" }] } };
		const oct = freeSlots({ settings: sunday, appointments: [], day: "2026-10-25", minutes: 60 }).map((s) => s.start);
		const mar = freeSlots({ settings: sunday, appointments: [], day: "2026-03-29", minutes: 60 }).map((s) => s.start);
		expect(oct).toEqual([540, 555, 570, 585, 600]);
		expect(mar).toEqual(oct);
		expect(fits({ settings: sunday, appointments: [], day: "2026-10-25", start: 9 * 60, minutes: 60, now: localNow("Europe/Rome", new Date("2026-10-25T08:30:00Z")) })).toMatchObject({ ok: false, why: "past" });
		expect(fits({ settings: sunday, appointments: [], day: "2026-03-29", start: 9 * 60, minutes: 60, now: localNow("Europe/Rome", new Date("2026-03-29T06:30:00Z")) })).toEqual({ ok: true });
	});
});

describe("week 74 review: days indexed, gaps per resource, the room left", () => {
	it("L5: thousands of appointments on other days change nothing on this one; nearestFree reads them by day", () => {
		const others = Array.from({ length: 2000 }, (_, n) => appt(`AP-${String(n + 10).padStart(4, "0")}`, `2026-11-${String((n % 28) + 1).padStart(2, "0")}`, "10:00", 30));
		const booked = [appt("AP-0001", "2026-10-22", "15:00", 60)];
		const alone = freeSlots({ settings: SETTINGS, appointments: booked, day: "2026-10-22", minutes: 60 });
		expect(freeSlots({ settings: SETTINGS, appointments: [...others, ...booked], day: "2026-10-22", minutes: 60 })).toEqual(alone);
		expect(nearestFree({ settings: SETTINGS, appointments: [...others, ...booked], day: "2026-10-22", start: 15 * 60, minutes: 60 })[0]).toEqual(nearestFree({ settings: SETTINGS, appointments: booked, day: "2026-10-22", start: 15 * 60, minutes: 60 })[0]);
	});

	it("UX5: gaps per lane, shorter than the shortest service dropped; UX1: the room until the break", () => {
		const settings: AppointmentSettings = { ...SETTINGS, resources: ["Marco", "Giulia"], services: [{ name: "Taglio", minutes: 30 }] };
		const booked = [appt("AP-0001", "2026-10-22", "09:15", 30, { resource: "Giulia" }), appt("AP-0002", "2026-10-22", "10:00", 60, { resource: "Marco" })];
		expect(gapsOf(settings, booked, "2026-10-22", "Giulia")[0]).toEqual({ from: 585, to: 780 });
		expect(gapsOf(settings, booked, "2026-10-22", "Marco").slice(0, 2)).toEqual([{ from: 540, to: 600 }, { from: 660, to: 780 }]);
		const fit = fits({ settings: SETTINGS, appointments: [], day: "2026-10-22", start: 12 * 60 + 30, minutes: 60 });
		expect(fit).toMatchObject({ ok: false, why: "outside", room: { until: 780, pause: true } });
		expect(fits({ settings: SETTINGS, appointments: [], day: "2026-10-22", start: 12 * 60 + 30, minutes: 60, force: true })).toEqual({ ok: true });
	});
});
