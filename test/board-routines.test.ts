import { describe, expect, it } from "vitest";
import { BoardStore } from "../src/core/board.ts";
import { describeWhen, nextTime, routineCron, RoutineStore, routineWhen, runRoutines } from "../src/core/board-routines.ts";
import { BoardWork, type BoardWorkDeps } from "../src/core/board-work.ts";
import { tempDataDir } from "./helpers.ts";

function setup(over: Partial<BoardWorkDeps> = {}) {
	const dir = tempDataDir();
	const store = new BoardStore(dir);
	const routines = new RoutineStore(dir);
	const posts: { agent: string; personId: string; text: string }[] = [];
	const work = new BoardWork({
		store,
		agentName: async (id) => ({ ricerca: "Ricercatore" })[id],
		canChat: async (_agent, person) => person === "p_anna",
		isOwner: async (person) => person === "p_owner",
		owners: async () => ["p_owner"],
		personName: async () => "Anna",
		openThread: async (_agent, _personId, _title, reuse) => reuse ?? `t${posts.length + 1}`,
		post: async (agent, _threadId, personId, text) => void posts.push({ agent, personId, text }),
		...over,
	});
	const logs: string[] = [];
	const run = (at: string) => runRoutines(routines, work, store, (m) => void logs.push(m), new Date(at));
	return { store, routines, work, posts, run, logs };
}

describe("schede that come back (ADR 0069)", () => {
	it("when: checked, said in Italian, and turned into the next time in Rome, across daylight saving", () => {
		expect(routineWhen({ every: "settimana", time: "9:00", day: 1 })).toEqual({ every: "settimana", time: "09:00", day: 1 });
		expect(() => routineWhen({ every: "ora", time: "9:00" })).toThrow(/ogni quanto/);
		expect(() => routineWhen({ every: "giorno", time: "25:00" })).toThrow(/9:00/);
		expect(() => routineWhen({ every: "mese", time: "9:00", day: 31 })).toThrow(/dall'1 al 28/);
		expect(() => routineWhen({ every: "settimana", time: "9:00" })).toThrow(/giorno della settimana/);
		expect(routineWhen({ every: "giorno", time: "08:30", day: 3 })).toEqual({ every: "giorno", time: "08:30" });
		expect(describeWhen({ every: "settimana", time: "09:00", day: 1 })).toBe("ogni lunedì alle 9:00");
		expect(describeWhen({ every: "feriali", time: "18:30" })).toBe("dal lunedì al venerdì alle 18:30");
		expect(describeWhen({ every: "mese", time: "07:05", day: 5 })).toBe("ogni mese il 5 alle 7:05");
		expect(routineCron({ every: "settimana", time: "09:00", day: 7 })).toBe("0 9 * * 0");
		// Saturday 25 October 2026, before the clocks go back: next Monday 9:00 Rome is 8:00 UTC.
		expect(nextTime({ every: "settimana", time: "09:00", day: 1 }, new Date("2026-10-24T10:00:00Z"))).toBe("2026-10-26T08:00:00.000Z");
		expect(nextTime({ every: "feriali", time: "09:00" }, new Date("2026-10-23T08:00:00Z"))).toBe("2026-10-26T08:00:00.000Z");
	});

	it("at its time a scheda is made and started with the person, alone if asked; the next time is set; a missed week makes one", async () => {
		const { store, routines, posts, run } = setup();
		const r = routines.create({ title: "Report vendite", description: "Le vendite della settimana", assignee: "ricerca", auto: true, when: { every: "settimana", time: "09:00", day: 1 }, personId: "p_anna" }, new Date("2026-10-18T10:00:00Z"));
		expect(r.next).toBe("2026-10-19T07:00:00.000Z");
		expect(await run("2026-10-19T06:59:00Z")).toBe(0);
		expect(await run("2026-10-19T07:00:30Z")).toBe(1);
		const card = store.list()[0];
		expect(card).toMatchObject({ title: "Report vendite", status: "in_corso", assignee: "ricerca", work: { personId: "p_anna" }, createdBy: { kind: "person", id: "p_anna" } });
		expect(card?.auto).toBeDefined();
		expect(posts[0]?.text).toContain("Le vendite della settimana");
		expect(routines.get(r.id)).toMatchObject({ next: "2026-10-26T08:00:00.000Z", last: card?.id });
		// Same tick again: nothing more.
		expect(await run("2026-10-19T07:00:40Z")).toBe(0);
		store.update(card?.id as string, { status: "fatto" }, { kind: "person", id: "p_anna" });
		// Annie off for two weeks: one scheda, and the next time is the one after now.
		expect(await run("2026-11-05T12:00:00Z")).toBe(1);
		expect(routines.get(r.id)?.next).toBe("2026-11-09T08:00:00.000Z");
	});

	it("while the last scheda is open no new one, with a comment on it; what cannot start is said on the routine; paused ones wait", async () => {
		const { store, routines, run } = setup();
		const r = routines.create({ title: "Controlla la posta", assignee: "ricerca", when: { every: "giorno", time: "09:00" }, personId: "p_anna" }, new Date("2026-10-18T10:00:00Z"));
		await run("2026-10-19T07:01:00Z");
		const first = store.list()[0];
		expect(await run("2026-10-20T07:01:00Z")).toBe(0);
		expect(store.list()).toHaveLength(1);
		expect(store.get(first?.id as string)?.events.at(-1)?.text).toMatch(/^Doveva ripartire martedì 20 ottobre.*non è ancora chiusa/);
		expect(routines.get(r.id)?.problem).toBe(`la scheda #${first?.n} non era ancora chiusa`);
		// A person who can no longer talk to the agente: no scheda, and why.
		const lost = routines.create({ title: "Di Marco", assignee: "ricerca", when: { every: "giorno", time: "09:00" }, personId: "p_marco" }, new Date("2026-10-18T10:00:00Z"));
		await run("2026-10-19T07:02:00Z");
		expect(routines.get(lost.id)?.problem).toMatch(/Non puoi affidare schede a Ricercatore/);
		routines.update(lost.id, (x) => ({ ...x, paused: true as const }));
		routines.pauseAgent("ricerca");
		expect(routines.get(r.id)).toMatchObject({ paused: true, problem: "l'agente è stato eliminato" });
		expect(await run("2026-10-30T07:02:00Z")).toBe(0);
	});

	it("at most 50, with a title", () => {
		const { routines } = setup();
		expect(() => routines.create({ title: " ", assignee: "ricerca", when: { every: "giorno", time: "09:00" }, personId: "p_anna" })).toThrow(/titolo/);
		for (let i = 0; i < 50; i++) routines.create({ title: `R${i}`, assignee: "ricerca", when: { every: "giorno", time: "09:00" }, personId: "p_anna" });
		expect(() => routines.create({ title: "Una di troppo", assignee: "ricerca", when: { every: "giorno", time: "09:00" }, personId: "p_anna" })).toThrow(/già 50/);
	});
});
