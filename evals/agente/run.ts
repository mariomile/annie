/**
 * Deterministic check of the general agent's eval cases (ADR 0099), in PR CI: every case has a
 * unique id and a text, and every tool it expects is one the agent really gets. A tool renamed
 * or removed turns this red before the nightly run measures the wrong thing.
 */
import { bootAnnie, loadCases } from "./annie.ts";

const cases = await loadCases();
const { annie, tools } = await bootAnnie({ ANNIE_MODEL_PROVIDER: "faux" });
await annie.stop();

const known = new Set(tools);
const errors: string[] = [];
const ids = new Set<string>();
for (const c of cases) {
	if (ids.has(c.id)) errors.push(`${c.id}: duplicate id`);
	ids.add(c.id);
	if (typeof c.text !== "string" || c.text.trim() === "") errors.push(`${c.id}: empty text`);
	if (!Array.isArray(c.expect)) errors.push(`${c.id}: expect must be a list`);
	for (const name of c.expect ?? []) if (!known.has(name)) errors.push(`${c.id}: the agent has no tool "${name}"`);
}
if (tools.length === 0) errors.push("the general agent got no tools");

for (const e of errors) console.error(`✗ ${e}`);
console.log(`eval:agente: ${cases.length} cases, ${tools.length} tools, ${errors.length} errors`);
process.exit(errors.length === 0 ? 0 : 1);
