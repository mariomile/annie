import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/channels/types.ts";
import { WebChannel } from "../src/web/channel.ts";
import { mentioned, ROOM_LIMITS, type RoomEntry, RoomStore, Rooms } from "../src/web/rooms.ts";
import { tempDataDir, waitFor } from "./helpers.ts";

const PERSON = "p_000000000001";
const NAMES: Record<string, string> = { ricerca: "Ricercatore", vendite: "Assistente vendite", conti: "Contabile" };

/** Three agenti whose answers are `reply(text)`; what each received is in `got`. */
function setup(reply: (instanceId: string, text: string) => string | undefined, reachable: (id: string) => boolean = () => true) {
	const dir = tempDataDir();
	const channels = new Map<string, WebChannel>();
	const got: Record<string, string[]> = {};
	let n = 0;
	for (const id of Object.keys(NAMES)) {
		const channel = new WebChannel({ tenantId: "acme", instanceId: id }, join(dir, id));
		got[id] = [];
		channel.onInbound(async (message: InboundMessage) => {
			got[id]?.push(message.text);
			const answer = reply(id, message.text);
			n += 1;
			if (answer !== undefined) setTimeout(() => void channel.send({ tenantId: "acme", instanceId: id, channel: "web", threadId: message.threadId, text: answer, idempotencyKey: `r:${id}:${n}` }), 5);
		});
		channels.set(id, channel);
	}
	const rooms = new Rooms(new RoomStore(join(dir, "rooms")), { channel: (id) => channels.get(id), reachable: async (_p, id) => (reachable(id) ? NAMES[id] : undefined) });
	for (const c of channels.values()) rooms.attach(c);
	const seen: RoomEntry[] = [];
	rooms.events.on(PERSON, (e: { entry: RoomEntry }) => seen.push(e.entry));
	return { rooms, channels, got, seen };
}

describe("stanze", () => {
	it("reads @nome, the first word when it is only one agente's, and @tutti", () => {
		const agents = Object.entries(NAMES).map(([instanceId, name]) => ({ instanceId, name }));
		expect(mentioned("@ricercatore cerca i bandi, poi @Assistente-vendite", agents)).toEqual(["ricerca", "vendite"]);
		expect(mentioned("@assistente prepara l'offerta", agents)).toEqual(["vendite"]);
		expect(mentioned("scrivi a mario@contabile.it", agents)).toEqual([]);
		expect(mentioned("@tutti pronti?", agents)).toEqual(["ricerca", "vendite", "conti"]);
	});

	it("a message goes to the agenti it calls, or to the last one that spoke; seats are not among the person's chats", async () => {
		const { rooms, channels, got, seen } = setup((id) => `ciao da ${id}`);
		const room = await rooms.create(PERSON, "Bando", ["ricerca", "vendite"]);
		expect(await channels.get("ricerca")?.threads(PERSON)).toEqual([]);

		await rooms.post(PERSON, room.id, "@ricercatore trova il bando");
		await waitFor(() => seen.some((e) => e.text === "ciao da ricerca"));
		expect(got.vendite).toEqual([]);
		expect(got.ricerca?.[0]).toContain("trova il bando");
		expect(got.ricerca?.[0]).toContain("Assistente vendite (@assistente-vendite)");

		await rooms.post(PERSON, room.id, "e la scadenza?");
		await waitFor(() => seen.filter((e) => e.from === "agent").length === 2);
		expect(got.ricerca).toHaveLength(2);
		expect(got.vendite).toEqual([]);

		await rooms.post(PERSON, room.id, "@vendite che ne pensi?");
		await waitFor(() => seen.some((e) => e.text === "ciao da vendite"));
		// What it missed, fenced as data: the person's earlier words and the other agente's answers.
		const toVendite = got.vendite?.[0] ?? "";
		expect(toVendite).toMatch(/<<<dalla stanza [0-9a-f]+/);
		expect(toVendite).toContain("[Ricercatore] ciao da ricerca");
		expect(toVendite).toContain("[Persona] e la scadenza?");
		expect(toVendite.trim().endsWith("@vendite che ne pensi?")).toBe(true);
		const { entries } = (await rooms.open(PERSON, room.id)) ?? { entries: [] };
		expect(entries.map((e) => [e.from, e.instanceId ?? null])).toEqual([
			["person", null],
			["agent", "ricerca"],
			["person", null],
			["agent", "ricerca"],
			["person", null],
			["agent", "vendite"],
		]);
	});

	it("an agente's answer calls another one, and a chain stops after the limit", async () => {
		// Each agente hands over to the next, forever.
		const next: Record<string, string> = { ricerca: "@vendite", vendite: "@contabile", conti: "@ricercatore" };
		const { rooms, got, seen } = setup((id) => `fatto, tocca a ${next[id]}`);
		const room = await rooms.create(PERSON, "", ["ricerca", "vendite", "conti"]);
		expect(room.title).toBe("Ricercatore, Assistente vendite, Contabile");
		await rooms.post(PERSON, room.id, "@ricercatore inizia tu");
		await waitFor(() => seen.some((e) => e.from === "note"));
		const agentTurns = seen.filter((e) => e.from === "agent").length;
		expect(agentTurns).toBe(1 + ROOM_LIMITS.chain);
		expect(got.vendite?.[0]).toContain("Ricercatore ti ha chiamato in causa");
		expect(got.vendite?.[0]).not.toContain("inizia tu\n\nRicercatore");
	});

	it("an agente the person can no longer write to gets nothing; another person cannot read the stanza", async () => {
		let open = true;
		const { rooms, got, seen } = setup((id) => `ok ${id}`, (id) => id !== "vendite" || open);
		const room = await rooms.create(PERSON, "Due", ["ricerca", "vendite"]);
		open = false;
		await rooms.post(PERSON, room.id, "@vendite ci sei?");
		await waitFor(() => seen.some((e) => e.from === "agent"));
		expect(got.vendite).toEqual([]);
		// The name calls no one present: the message goes to the agente still there.
		expect(seen.find((e) => e.from === "agent")?.instanceId).toBe("ricerca");
		expect(await rooms.open("p_000000000002", room.id)).toBeUndefined();
		await expect(rooms.post("p_000000000002", room.id, "ciao")).rejects.toThrow(/non trovata/);
		await expect(rooms.create(PERSON, "Una", ["ricerca"])).rejects.toThrow(/almeno due/);
	});
});
