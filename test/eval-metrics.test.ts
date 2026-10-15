import { describe, expect, it } from "vitest";
import { compareLead, fieldMatches, hardFail, meanScore, microF1, parseVerdict } from "../evals/segreteria/metrics.ts";

describe("nightly eval metrics", () => {
	it("matches fields the way a person would: case, accents, digits, word overlap for free text", () => {
		expect(fieldMatches("fullName", "Niccolò  Rossi", "niccolo rossi")).toBe(true);
		expect(fieldMatches("phone", "+39 0172-000111", "0172 000111")).toBe(false);
		expect(fieldMatches("phone", "0172.000.111", "0172 000111")).toBe(true);
		expect(fieldMatches("quantity", "2 pezzi", "2")).toBe(true);
		expect(fieldMatches("productOrService", "2 torni CNC a 3 assi", "tornio CNC 3 assi")).toBe(true);
		expect(fieldMatches("productOrService", "lavastoviglie", "tornio CNC 3 assi")).toBe(false);
		expect(fieldMatches("company", null, null)).toBe(true);
		expect(fieldMatches("company", "Acme", null)).toBe(false);
	});

	it("counts a wrong value as one false positive and one false negative", () => {
		const gold = { fullName: "Giulia Ferraresi", title: null, company: "Tornerie Valdorme Srl", email: "g@x.example", phone: null, productOrService: "tornio CNC", quantity: "2", urgency: null, vatNumber: null, originalLanguage: "it" };
		const right = compareLead({ ...gold }, gold);
		expect(right).toEqual({ counts: { tp: 5, fp: 0, fn: 0 }, exact: true, mismatches: [] });
		const wrong = compareLead({ ...gold, company: "Valdorme Spa", phone: "333", quantity: null }, gold);
		expect(wrong.counts).toEqual({ tp: 3, fp: 2, fn: 2 });
		expect(wrong.mismatches).toEqual(["company", "phone", "quantity"]);
		// tp 8, fp 2, fn 2: precision = recall = 0.8.
		expect(microF1([right.counts, wrong.counts])).toBeCloseTo(0.8, 6);
		// email is not scored: it comes from the From header.
		expect(compareLead({ ...gold, email: "other@x.example" }, gold).exact).toBe(true);
		expect(microF1([])).toBe(0);
	});

	it("accepts only complete verdicts with scores 1-5, and applies the rubric's hard stops", () => {
		const scores = { factual: 5, questions: 4, tone: 5, noHallucination: 5, pii: 5, cta: 3 };
		const verdict = parseVerdict({ scores, pass: true, rationale: "ok" });
		expect(meanScore(verdict)).toBeCloseTo(27 / 6, 6);
		expect(hardFail(verdict)).toBe(false);
		expect(hardFail(parseVerdict({ scores: { ...scores, pii: 1 } }))).toBe(true);
		expect(() => parseVerdict({ scores: { ...scores, tone: 6 } })).toThrow("tone is not 1-5");
		expect(() => parseVerdict({ pass: true })).toThrow("without scores");
	});
});
