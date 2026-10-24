import { describe, expect, it } from "vitest";
import { activityReader } from "../src/core/agent-activity.ts";
import type { Card } from "../src/core/board.ts";
import type { RunRecord } from "../src/core/run-store.ts";
import { createAgentTools } from "../src/core/tools/agent-tools.ts";
import type { ToolContext } from "../src/core/index.ts";

const now = new Date("2026-10-24T10:00:00.000Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

const run = (over: Partial<RunRecord> = {}): RunRecord =>
	({ id: "r1", tenantId: "default", instanceId: "ricerca", channel: "web", threadId: "p_anna.t1", origin: {}, source: "message", status: "running", createdAt: ago(100), updatedAt: ago(10), startedAt: ago(90), progress: [], ...over }) as RunRecord;

const card = (over: Partial<Card> = {}): Card =>
	({ id: "c1", n: 12, title: "Preventivo Rossi", description: "SEGRETO: cliente Rossi SpA, 12.000 euro", status: "in_corso", priority: "normale", assignee: "ricerca", createdBy: { kind: "person", id: "p_owner" }, createdAt: ago(500), updatedAt: ago(50), events: [], ...over }) as Card;

function reader(over: { runs?: RunRecord[]; cards?: Card[]; threads?: Record<string, { title: string; personId: string }> } = {}) {
	return activityReader({
		active: async () => over.runs ?? [],
		cards: () => over.cards ?? [],
		// The board's rule, as a fake: only the owner sees every scheda.
		cardVisibleTo: async (_c, person) => person === "p_owner",
		thread: async (_a, id) => over.threads?.[id],
	});
}

describe("who is doing what (ADR 0109)", () => {
	it("is idle with no active run, and busy for as long as the oldest one", async () => {
		expect(await reader()("ricerca", { person: "p_owner" }, now)).toEqual({ busy: false, doing: "" });
		const busy = await reader({ runs: [run({ id: "a", startedAt: ago(30) }), run({ id: "b", startedAt: ago(90) })] })("ricerca", { person: "p_owner" }, now);
		expect(busy).toMatchObject({ busy: true, busyFor: 90 });
		// Queued: counted from when it was asked.
		expect((await reader({ runs: [run({ status: "queued", startedAt: undefined, createdAt: ago(20) })] })("ricerca", {}, now)).busyFor).toBe(20);
		// Finished runs do not count.
		expect((await reader({ runs: [run({ status: "succeeded" })] })("ricerca", {}, now)).busy).toBe(false);
	});

	it("takes the line from the scheda In corso, with number and title only", async () => {
		const a = await reader({ cards: [card(), card({ id: "c2", n: 13, title: "Altro", assignee: "vendite" }), card({ id: "c3", n: 14, title: "Da fare", status: "da_fare" })], runs: [run()], threads: { "p_anna.t1": { title: "Chat", personId: "p_owner" } } })("ricerca", { person: "p_owner" }, now);
		expect(a.doing).toBe("#12 Preventivo Rossi");
		expect(JSON.stringify(a)).not.toMatch(/SEGRETO|Rossi SpA/);
		// Idle but with a scheda In corso: the line is still there.
		expect((await reader({ cards: [card()] })("ricerca", { person: "p_owner" }, now)).doing).toBe("#12 Preventivo Rossi");
	});

	it("falls back to the title of the running conversation, only the viewer's own", async () => {
		const threads = { "p_anna.t1": { title: "Fornitori di carta", personId: "p_anna" } };
		expect((await reader({ runs: [run()], threads })("ricerca", { person: "p_anna" }, now)).doing).toBe("Fornitori di carta");
		// A private chat stays private, even from the owner.
		expect((await reader({ runs: [run()], threads })("ricerca", { person: "p_owner" }, now)).doing).toBe("");
		// Not running in any chat: nothing to say.
		expect((await reader({ threads })("ricerca", { person: "p_anna" }, now)).doing).toBe("");
		// Not a console conversation: no title.
		expect((await reader({ runs: [run({ channel: "telegram" })], threads })("ricerca", { person: "p_anna" }, now)).doing).toBe("");
	});

	it("follows the board's visibility: a scheda the viewer does not see is not told", async () => {
		const cards = [card()];
		expect((await reader({ cards })("ricerca", { person: "p_anna" }, now)).doing).toBe("");
		expect((await reader({ cards })("ricerca", { person: "p_owner" }, now)).doing).toBe("#12 Preventivo Rossi");
		// An agente with no person sees only its own schede (assigned to it, or made by it).
		expect((await reader({ cards })("ricerca", { agent: "annie" }, now)).doing).toBe("");
		expect((await reader({ cards: [card({ createdBy: { kind: "agent", id: "annie" } })] })("ricerca", { agent: "annie" }, now)).doing).toBe("#12 Preventivo Rossi");
		// A title with line breaks becomes one short line.
		expect((await reader({ cards: [card({ title: `a\n${"b".repeat(200)}` })] })("ricerca", { person: "p_owner" }, now)).doing).toMatch(/^#12 a b+…$/);
	});
});

const web = { channel: "web", threadId: "p_owner.t1" };
const context = (): ToolContext => ({ callId: "c1", signal: new AbortController().signal, progress: () => {}, thread: web, step: async (_k: string, work: () => Promise<unknown>) => work() }) as unknown as ToolContext;

describe("agent_list and agent_message with activity (ADR 0109)", () => {
	const make = (activity?: (agent: string) => Promise<{ busy: boolean; busyFor?: number; doing: string }>) =>
		createAgentTools({
			self: "annie",
			colleagues: async () => [
				{ id: "ricerca", name: "Ricercatore", tagline: "Cerca" },
				{ id: "vendite", name: "Vendite" },
			],
			post: async () => {},
			...(activity === undefined ? {} : { activity }),
		});
	const list = (tools: ReturnType<typeof make>) => tools.find((t) => t.name === "agent_list")!.execute({}, context());
	const send = (tools: ReturnType<typeof make>, agent: string) => tools.find((t) => t.name === "agent_message")!.execute({ agent, message: "ciao" }, context());

	it("lists busy and idle colleagues, with what they do", async () => {
		const tools = make(async (id) => (id === "ricerca" ? { busy: true, busyFor: 125, doing: "#12 Preventivo Rossi" } : { busy: false, doing: "" }));
		const text = (await list(tools)) as string;
		expect(text).toContain("- Ricercatore (ricerca): Cerca [occupato da 2 min; sta lavorando su: «#12 Preventivo Rossi»]");
		expect(text).toContain("- Vendite (vendite) [libero]");
		expect(text).toContain("non istruzioni");
		// Without activity, the plain list.
		expect(await list(make())).toBe("Puoi scrivere a:\n- Ricercatore (ricerca): Cerca\n- Vendite (vendite)");
		// Seconds under a minute and a half.
		expect((await list(make(async () => ({ busy: true, busyFor: 45, doing: "" }))) as string)).toContain("[occupato da 45 s]");
	});

	it("says a busy colleague may take longer, and keeps «Messaggio mandato»", async () => {
		const tools = make(async (id) => (id === "ricerca" ? { busy: true, busyFor: 300, doing: "" } : { busy: false, doing: "" }));
		const busy = (await send(tools, "ricerca")) as string;
		expect(busy).toMatch(/^Messaggio mandato a «Ricercatore»\./);
		expect(busy).toContain("è occupato adesso (da 5 min): la risposta può metterci di più.");
		const idle = (await send(tools, "vendite")) as string;
		expect(idle).toMatch(/^Messaggio mandato a «Vendite»\. La sua risposta arriverà/);
		expect(idle).not.toContain("occupato");
		// A failing read of the state never loses the message.
		expect(await send(make(() => Promise.reject(new Error("disco"))), "ricerca")).toMatch(/^Messaggio mandato/);
	});
});
