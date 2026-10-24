/**
 * Preflight of the deterministic checks, before any case is scored: a check that is too lax
 * would distort the score without anyone noticing.
 *
 * Only the checks are under test here, not the product: the draft buildDraft produces from the
 * gold is not run through the checks by the preflight, that is left to the scoring loop of run.ts
 * (a buildDraft regression must show up in the report, not abort the run). What the preflight
 * takes from a case is its expectations (mustAsk, mustMention, ...), never its draft text.
 *
 * No-op answers: an empty draft and a generic one ("Gentile cliente, la ricontatteremo a breve.").
 * Checks of the "must not contain / must not do" kind (prices, tu markers, mustNotMention, pii,
 * mustNotAskVatNumber) are legitimately satisfied by a no-op, so nothing is expected of them.
 * The positive checks the case switches on must fail, one failure per requirement:
 *   - mustAsk: one per field, "missing question for <field>"  (both no-ops)
 *   - mustMention: one per string                              (both no-ops)
 *   - multiRequest: when mustListItemsAsBullets and requestCount > 1: both the bullet count and
 *     "missing priority question" must fail, so one cannot hide the other  (both no-ops)
 *   - salutation: when expectedSalutationContains is set       (both, unless the generic text
 *     itself contains it, e.g. "Gentile")
 *   - register / registerEn: the empty draft only; the generic one is a valid formal letter.
 */
import type { CheckFailure, ChecksConfig, DraftCheckInput } from "../../src/segreteria/checks.ts";
import { runDeterministicChecks } from "../../src/segreteria/checks.ts";

export const GENERIC_NOOP = "Gentile cliente, la ricontatteremo a breve. Cordiali saluti.";

/** The failures a no-op must produce; `detail` is matched as a prefix of what the check emits. */
export function noopMustFail(draft: DraftCheckInput, empty: boolean): CheckFailure[] {
	const want: CheckFailure[] = [];
	if (empty) want.push({ check: draft.language === "en" ? "registerEn" : "register", detail: "" });
	for (const f of draft.mustAsk ?? []) want.push({ check: "mustAsk", detail: `missing question for ${f}` });
	for (const m of draft.mustMention ?? []) want.push({ check: "mustMention", detail: m });
	if (draft.mustListItemsAsBullets && (draft.requestCount ?? 0) > 1) {
		want.push({ check: "multiRequest", detail: "bullets " });
		want.push({ check: "multiRequest", detail: "missing priority question" });
	}
	const salutation = draft.expectedSalutationContains;
	if (salutation && (empty || !GENERIC_NOOP.toLowerCase().includes(salutation.toLowerCase()))) want.push({ check: "salutation", detail: salutation });
	return want;
}

/** Violations as readable lines naming the case and the check; empty when every case behaves. */
export function preflight(cfg: ChecksConfig, rows: ReadonlyArray<{ id: string; draft: DraftCheckInput }>): string[] {
	const out: string[] = [];
	for (const { id, draft } of rows) {
		for (const [name, body] of [["empty", ""], ["generic", GENERIC_NOOP]] as const) {
			const fails = runDeterministicChecks(cfg, { ...draft, subject: "", body });
			for (const w of noopMustFail(draft, name === "empty")) {
				if (!fails.some((f) => f.check === w.check && f.detail.startsWith(w.detail))) {
					out.push(`${id}: ${name} no-op passes ${w.check}${w.detail ? ` (${w.detail.trim()})` : ""}`);
				}
			}
		}
	}
	return out;
}
