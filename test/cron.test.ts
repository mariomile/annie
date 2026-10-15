import { describe, expect, it } from "vitest";
import { nextRun, parseCron } from "../src/core/cron.ts";

const at = (iso: string) => new Date(iso);

describe("cron in a time zone", () => {
	it("weekdays at 8:30 in Rome, across the end of daylight saving time", () => {
		const cron = parseCron("30 8 * * 1-5");
		// Friday 23 Oct 2026, after 8:30 Rome (CEST, UTC+2): next is Monday 26 Oct 8:30 CET (UTC+1).
		expect(nextRun(cron, at("2026-10-23T07:00:00Z"), "Europe/Rome").toISOString()).toBe("2026-10-26T07:30:00.000Z");
		expect(nextRun(cron, at("2026-10-22T05:00:00Z"), "Europe/Rome").toISOString()).toBe("2026-10-22T06:30:00.000Z");
	});

	it("a run just after midnight on the day the clocks go back is not skipped", () => {
		// 25 Oct 2026, Rome goes from CEST to CET at 03:00. 00:30 on the 26th is 23:30Z on the 25th.
		expect(nextRun(parseCron("30 0 26 10 *"), at("2026-10-24T12:00:00Z"), "Europe/Rome").toISOString()).toBe("2026-10-25T23:30:00.000Z");
		expect(nextRun(parseCron("30 0 * * *"), at("2026-10-25T12:00:00Z"), "Europe/Rome").toISOString()).toBe("2026-10-25T23:30:00.000Z");
	});

	it("steps, lists and month days", () => {
		expect(nextRun(parseCron("*/15 * * * *"), at("2026-10-15T10:07:30Z"), "UTC").toISOString()).toBe("2026-10-15T10:15:00.000Z");
		expect(nextRun(parseCron("0 9,18 * * *"), at("2026-10-15T10:00:00Z"), "UTC").toISOString()).toBe("2026-10-15T18:00:00.000Z");
		expect(nextRun(parseCron("0 0 1 * *"), at("2026-10-15T10:00:00Z"), "UTC").toISOString()).toBe("2026-11-01T00:00:00.000Z");
		// Strictly after: a run exactly at `from` is not the next one.
		expect(nextRun(parseCron("0 18 * * *"), at("2026-10-15T18:00:00Z"), "UTC").toISOString()).toBe("2026-10-16T18:00:00.000Z");
	});

	it("rejects what it cannot read, with the field named", () => {
		expect(() => parseCron("61 * * * *")).toThrow("minute");
		expect(() => parseCron("* * *")).toThrow("5 fields");
		expect(() => parseCron("0 25 * * *")).toThrow("hour");
		expect(() => parseCron("0 9 * * 8")).toThrow("weekday");
		expect(() => parseCron("0 0 31 2 *")).not.toThrow();
		expect(() => nextRun(parseCron("0 0 31 2 *"), at("2026-01-01T00:00:00Z"), "UTC")).toThrow("never runs");
	});
});
