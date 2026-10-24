import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadChecks, type DraftCheckInput } from "../src/segreteria/checks.ts";
import { GENERIC_NOOP, preflight } from "../evals/segreteria/preflight.ts";

const checks = await loadChecks(join(import.meta.dirname, "../evals/segreteria"));
const gold: DraftCheckInput = {
	subject: "Re: Preventivo",
	body: "Gentile Signora Rossi,\nla ringraziamo per la richiesta. Può indicarci la quantità richiesta?\nLa ricontatteremo a breve. Cordiali saluti",
	language: "it",
	mustAsk: ["quantity"],
	expectedSalutationContains: "Gentile Signora Rossi",
};
const rows = [{ id: "001-test", gold }];

describe("eval preflight", () => {
	it("accepts a gold that passes and no-ops that fail what discriminates", () => {
		expect(preflight(checks, rows)).toEqual([]);
	});

	it("names the case and the check when the gold fails one (impossible check)", () => {
		const impossible = { ...checks, prices: { ...checks.prices, alsoForbidden: ["ringraziamo"] } };
		expect(preflight(impossible, rows)).toEqual(['001-test: gold fails prices (forbidden phrase "ringraziamo")']);
	});

	it("names the case and the check when a no-op passes it (lax check)", () => {
		const lax = { ...checks, register: { ...checks.register, leiMarkersRequired: { minMatches: 0, patterns: [] } } };
		expect(preflight(lax, rows)).toEqual(["001-test: empty no-op passes register"]);
	});

	it("flags a requirement the generic answer already satisfies, but not a salutation it contains", () => {
		expect(GENERIC_NOOP).toContain("ricontatteremo");
		const easy = { ...gold, mustMention: ["ricontatteremo"], expectedSalutationContains: "Gentile" };
		expect(preflight(checks, [{ id: "002-test", gold: easy }])).toEqual(["002-test: generic no-op passes mustMention (ricontatteremo)"]);
	});
});
