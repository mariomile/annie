/**
 * Nightly LLM-judge entrypoint. PR CI must not require secrets.
 * Without ANNIE_JUDGE_MODEL_KEY, exits 0 after printing skip.
 */
if (!process.env.ANNIE_JUDGE_MODEL_KEY) {
	console.log("eval:segreteria:judge skipped (no ANNIE_JUDGE_MODEL_KEY)");
	process.exit(0);
}
console.error("Live judge not wired in week-3 stub; set fixtures and re-run.");
process.exit(0);
