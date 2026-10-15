/**
 * Pure metrics for the nightly segreteria eval (judge.ts): field-level extraction scores
 * against the gold lead, and parsing of the judge's verdict. Thresholds: spec §7.2.
 */

/**
 * Fields compared with the gold lead. Free-text ones match on word overlap. Not `email`:
 * it comes from the From header, not from the model.
 */
export const LEAD_FIELDS = ["fullName", "title", "company", "phone", "productOrService", "quantity", "urgency", "vatNumber", "originalLanguage"] as const;
const FREE_TEXT = new Set<string>(["productOrService", "urgency"]);

export type FieldCounts = { tp: number; fp: number; fn: number };

function normalize(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const text = String(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}@.+ ]/gu, " ").replace(/\s+/g, " ").trim();
	return text === "" ? null : text;
}

function digits(value: string): string {
	return value.replace(/\D/g, "");
}

/** Do a predicted and a gold value of `field` say the same thing? */
export function fieldMatches(field: string, predicted: unknown, gold: unknown): boolean {
	const p = normalize(predicted);
	const g = normalize(gold);
	if (p === null || g === null) return p === g;
	if (field === "phone" || field === "vatNumber" || field === "quantity") {
		const dp = digits(p);
		const dg = digits(g);
		if (dg !== "") return dp === dg;
	}
	if (FREE_TEXT.has(field)) {
		const pw = new Set(p.split(" ").filter((w) => w.length > 2));
		const gw = g.split(" ").filter((w) => w.length > 2);
		if (gw.length === 0) return p === g;
		return gw.filter((w) => pw.has(w)).length / gw.length >= 0.5;
	}
	return p === g;
}

/** Per-field counts for one lead: a wrong value counts as one false positive and one false negative. */
export function compareLead(predicted: Record<string, unknown>, gold: Record<string, unknown>): { counts: FieldCounts; exact: boolean; mismatches: string[] } {
	const counts: FieldCounts = { tp: 0, fp: 0, fn: 0 };
	const mismatches: string[] = [];
	for (const field of LEAD_FIELDS) {
		const p = normalize(predicted[field]);
		const g = normalize(gold[field]);
		if (fieldMatches(field, p, g)) {
			if (g !== null) counts.tp++;
			continue;
		}
		mismatches.push(field);
		if (p !== null) counts.fp++;
		if (g !== null) counts.fn++;
	}
	return { counts, exact: mismatches.length === 0, mismatches };
}

export function microF1(all: readonly FieldCounts[]): number {
	const tp = all.reduce((n, c) => n + c.tp, 0);
	const fp = all.reduce((n, c) => n + c.fp, 0);
	const fn = all.reduce((n, c) => n + c.fn, 0);
	if (tp === 0) return 0;
	const precision = tp / (tp + fp);
	const recall = tp / (tp + fn);
	return (2 * precision * recall) / (precision + recall);
}

export const JUDGE_CRITERIA = ["factual", "questions", "tone", "noHallucination", "pii", "cta"] as const;
export type JudgeVerdict = { scores: Record<(typeof JUDGE_CRITERIA)[number], number>; pass: boolean; rationale: string };

/** The judge's JSON verdict, validated: every criterion an integer 1-5. */
export function parseVerdict(raw: Record<string, unknown>): JudgeVerdict {
	const scores = raw.scores as Record<string, unknown> | undefined;
	if (scores === undefined || typeof scores !== "object") throw new Error("verdict without scores");
	const out = {} as JudgeVerdict["scores"];
	for (const criterion of JUDGE_CRITERIA) {
		const value = Number(scores[criterion]);
		if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`verdict: ${criterion} is not 1-5`);
		out[criterion] = value;
	}
	return { scores: out, pass: raw.pass === true, rationale: typeof raw.rationale === "string" ? raw.rationale : "" };
}

export function meanScore(verdict: JudgeVerdict): number {
	return JUDGE_CRITERIA.reduce((n, c) => n + verdict.scores[c], 0) / JUDGE_CRITERIA.length;
}

/** Rubric hard stop: any of these at 1 fails the case, whatever the mean. */
export function hardFail(verdict: JudgeVerdict): boolean {
	return verdict.scores.factual === 1 || verdict.scores.noHallucination === 1 || verdict.scores.pii === 1;
}
