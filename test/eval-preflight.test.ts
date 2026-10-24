import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadChecks, type DraftCheckInput } from "../src/segreteria/checks.ts";
import { GENERIC_NOOP, noopMustFail, preflight } from "../evals/segreteria/preflight.ts";

const checks = await loadChecks(join(import.meta.dirname, "../evals/segreteria"));
// Only the expectations count: the preflight ignores subject and body of a case.
const it1: DraftCheckInput = {
	subject: "",
	body: "",
	language: "it",
	mustAsk: ["quantity"],
	expectedSalutationContains: "Gentile Signora Rossi",
};
const en1: DraftCheckInput = { subject: "", body: "", language: "en", expectedSalutationContains: "Dear Mr Whitfield" };
const multi: DraftCheckInput = { subject: "", body: "", language: "it", mustListItemsAsBullets: true, requestCount: 3, mustMention: ["abbattitore"] };

describe("eval preflight", () => {
	it("accepts checks whose no-ops fail what discriminates", () => {
		expect(preflight(checks, [{ id: "001-test", draft: it1 }, { id: "020-test", draft: en1 }, { id: "017-test", draft: multi }])).toEqual([]);
	});

	it("ignores the draft text of a case: a broken buildDraft is not the preflight's business", () => {
		expect(preflight(checks, [{ id: "001-test", draft: { ...it1, subject: "sconto", body: "sconto 50%" } }])).toEqual([]);
	});

	it("names the case and the check when a no-op passes it (lax register)", () => {
		const lax = { ...checks, register: { ...checks.register, leiMarkersRequired: { minMatches: 0, patterns: [] } } };
		expect(preflight(lax, [{ id: "001-test", draft: it1 }])).toEqual(["001-test: empty no-op passes register"]);
	});

	it("covers registerEn on an English case", () => {
		const lax = { ...checks, registerEn: { requiredAny: [""], forbidden: [] } };
		expect(preflight(lax, [{ id: "020-test", draft: en1 }])).toEqual(["020-test: empty no-op passes registerEn"]);
		expect(noopMustFail(en1, true).map((w) => w.check)).toContain("registerEn");
		expect(noopMustFail(en1, true).map((w) => w.check)).not.toContain("register");
	});

	it("requires both multiRequest failures, bullets and priority question, from both no-ops", () => {
		for (const empty of [true, false]) {
			expect(noopMustFail(multi, empty).filter((w) => w.check === "multiRequest").map((w) => w.detail)).toEqual(["bullets ", "missing priority question"]);
		}
		expect(noopMustFail({ ...multi, requestCount: 1 }, true).some((w) => w.check === "multiRequest")).toBe(false);
	});

	it("flags a requirement the generic answer already satisfies, but not a salutation it contains", () => {
		expect(GENERIC_NOOP).toContain("ricontatteremo");
		const easy = { ...it1, mustMention: ["ricontatteremo"], expectedSalutationContains: "Gentile" };
		expect(preflight(checks, [{ id: "002-test", draft: easy }])).toEqual(["002-test: generic no-op passes mustMention (ricontatteremo)"]);
	});
});
