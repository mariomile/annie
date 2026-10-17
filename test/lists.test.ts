import { describe, expect, it } from "vitest";
import { LIST_LIMITS, ListError, ListStore, listKey, listName, ordered, resolveItems } from "../src/core/lists.ts";
import { createListTools } from "../src/core/tools/list-tools.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const from = (userId: string, threadId: string, text: string, messageId: string, privateThread = true) => ({ tenantId: "acme", instanceId: "ops", channel: "test", threadId, userId, text, messageId, privateThread });

async function withLists() {
	const events: unknown[] = [];
	const { runtime, replies } = await runtimeWithInstance({
		allowedUsers: { test: ["anna", "luca"] },
		toolsFor: (rt) => createListTools({ store: rt.lists("acme", "ops"), whoIs: (thread) => rt.participant("acme", "ops", thread), record: async (e) => void events.push(e) }),
	});
	let sent = 0;
	const say = async (user: string, thread: string, text: string, privateThread = true) => {
		sent++;
		await runtime.submit(from(user, thread, text, String(sent), privateThread));
		await waitFor(() => replies.length === sent);
		return String((replies.at(-1) as { text?: string }).text);
	};
	return { runtime, say, events };
}

describe("liste in chat (faux model)", () => {
	it("adds to a list, shows it numbered, ticks by words and number, puts back, removes", async () => {
		const { runtime, say, events } = await withLists();
		expect(await say("anna", "a", '/tool list_add {"list":"la lista della spesa","items":["latte","pane","uova","Latte"]}')).toBe("Fatto. Creata la lista «spesa». Aggiunto: latte, pane, uova. Restano 3 voci da fare.");
		expect(await say("anna", "a", '/tool list_add {"list":"Spesa","items":["latte di soia","pane"]}')).toBe("Fatto. Lista «spesa»: Aggiunto: latte di soia. Già in lista: pane. Restano 4 voci da fare.");
		expect(await say("anna", "a", '/tool list_check {"list":"spesa","items":["latte"]}')).toBe("Fatto. Lista «spesa»: Spuntato: latte. Restano 3 voci da fare.");
		expect(await say("anna", "a", '/tool list_check {"list":"spesa","items":["soia","1"]}')).toBe("Fatto. Lista «spesa»: Spuntato: latte di soia, pane. Resta una voce da fare.");
		expect(await say("anna", "a", '/tool list_show {"list":"spesa"}')).toBe("Fatto. Lista «spesa», una voce da fare, 3 fatte:\n1. uova\n2. pane (fatto)\n3. latte di soia (fatto)\n4. latte (fatto)");
		expect(await say("anna", "a", '/tool list_check {"list":"spesa","items":["pane"],"undo":true}')).toBe("Fatto. Lista «spesa»: Rimesso da fare: pane. Restano 2 voci da fare.");
		expect(await say("anna", "a", '/tool list_add {"list":"spesa","items":["latte"]}')).toContain("Rimesso da fare: latte. Restano 3 voci da fare.");
		expect(await say("anna", "a", '/tool list_remove {"list":"spesa","done":true}')).toBe("Fatto. Lista «spesa»: Tolta una voce fatta. Restano 3 voci da fare.");
		expect(await say("anna", "a", '/tool list_remove {"list":"spesa","items":["uova"]}')).toBe("Fatto. Lista «spesa»: Tolto: uova. Restano 2 voci da fare.");
		expect(await say("anna", "a", '/tool list_remove {"list":"spesa","whole":true}')).toBe("Fatto. Cancellata la lista «spesa».");
		expect(await say("anna", "a", "/tool list_show {}")).toBe("Fatto. Non ci sono ancora liste.");
		expect(events.map((e) => (e as { action: string }).action)).toEqual(["added", "added", "checked", "checked", "unchecked", "added", "cleared", "removed", "deleted"]);
		expect(JSON.stringify(events)).not.toContain("latte");
		await runtime.close();
	});

	it("does not guess when words fit more than one item, and says what it cannot find", async () => {
		const { runtime, say } = await withLists();
		await say("anna", "a", '/tool list_add {"list":"spesa","items":["latte intero","latte di soia"]}');
		expect(await say("anna", "a", '/tool list_check {"list":"spesa","items":["latte"]}')).toBe("Fatto. Errore: non ho cambiato niente, perché «latte» può essere «latte intero» o «latte di soia». Chiedi quale, o usa il numero di list_show.");
		expect(await say("anna", "a", '/tool list_check {"list":"spesa","items":["burro","latte intero"]}')).toBe("Fatto. Lista «spesa»: Spuntato: latte intero. Non trovo: «burro». Resta una voce da fare.");
		expect(await say("anna", "a", '/tool list_check {"list":"regali","items":["1"]}')).toBe("Fatto. Errore: non c'è una lista «regali»; ci sono: spesa.");
		expect(await say("anna", "a", '/tool list_remove {"list":"spesa"}')).toContain("Errore: indica le voci da togliere");
		await runtime.close();
	});

	it("a person's lists are theirs; a shared list everyone sees; a group sees only the shared ones", async () => {
		const { runtime, say } = await withLists();
		await say("anna", "a", '/tool list_add {"list":"regali","items":["libro per Luca"]}');
		await say("anna", "a", '/tool list_add {"list":"spesa di casa","items":["caffè"],"shared":true}');
		expect(await say("luca", "l", "/tool list_show {}")).toBe("Fatto. Liste:\n- «spesa di casa» (condivisa): una voce da fare");
		expect(await say("luca", "l", '/tool list_check {"list":"regali","items":["libro"]}')).toContain("Errore: non c'è una lista «regali»");
		expect(await say("luca", "l", '/tool list_add {"list":"spesa di casa","items":["zucchero"]}')).toBe("Fatto. Lista «spesa di casa» (condivisa): Aggiunto: zucchero. Restano 2 voci da fare.");
		expect(await say("anna", "g", "/tool list_show {}", false)).toBe("Fatto. Liste:\n- «spesa di casa» (condivisa): 2 voci da fare");
		expect(await say("anna", "g", '/tool list_add {"list":"gita","items":["panini"]}', false)).toBe("Fatto. Creata la lista «gita» (condivisa). Aggiunto: panini. Resta una voce da fare.");
		expect(await say("anna", "a", "/tool list_show {}")).toBe("Fatto. Liste:\n- «regali»: una voce da fare\n- «spesa di casa» (condivisa): 2 voci da fare\n- «gita» (condivisa): una voce da fare");
		await runtime.close();
	});
});

describe("ListStore", () => {
	it("calls a list the same however it is named", () => {
		expect(["Spesa", "la lista della spesa", "lista spesa", "Lista per la spesa", "  SPESA "].map(listKey)).toEqual(["spesa", "spesa", "spesa", "spesa", "spesa"]);
		expect(listKey("liste")).toBe("liste");
		expect(listKey("lista")).toBe("lista");
		expect(listName("La lista dei Regali")).toBe("Regali");
		expect(listKey("cose da fare")).toBe("cose da fare");
	});

	it("keeps the limits, and only the latest done items", () => {
		const store = new ListStore(tempDataDir());
		expect(() => store.add({ subject: "test:anna", name: " ", items: ["x"], shared: false })).toThrow(ListError);
		expect(() => store.add({ subject: "test:anna", name: "spesa", items: ["x".repeat(LIST_LIMITS.text + 1)], shared: false })).toThrow("caratteri");
		expect(() => store.add({ subject: "test:anna", name: "spesa", items: Array.from({ length: LIST_LIMITS.perCall + 1 }, (_, i) => `v${i}`), shared: false })).toThrow("alla volta");
		for (let n = 0; n < 4; n++) store.add({ subject: "test:anna", name: "spesa", items: Array.from({ length: 50 }, (_, i) => `voce ${n}-${i}`), shared: false });
		expect(() => store.add({ subject: "test:anna", name: "spesa", items: ["una di troppo"], shared: false })).toThrow("200 voci");
		store.update("test:anna", "spesa", (list) => ({ list: { ...list, items: list.items.map((i, k) => ({ ...i, done: true, doneAt: new Date(k * 1000).toISOString() })) }, result: undefined }));
		const list = store.find("test:anna", "spesa");
		expect(list?.items).toHaveLength(LIST_LIMITS.done);
		expect(list?.items[0]?.text).toBe("voce 3-0");
		for (let n = 1; n < LIST_LIMITS.lists; n++) store.add({ subject: "test:anna", name: `lista ${n}x`, items: ["x"], shared: false });
		expect(() => store.add({ subject: "test:anna", name: "ancora una", items: ["x"], shared: false })).toThrow("30 liste");
		expect(store.add({ subject: "test:luca", name: "ancora una", items: ["x"], shared: false }).created).toBe(true);
	});

	it("resolves items by number in the order shown, by the same words, or by the only item holding them", () => {
		const store = new ListStore(tempDataDir());
		store.add({ subject: undefined, name: "casa", items: ["Pagare la bolletta della luce", "chiamare l'idraulico", "comprare lampadine"], shared: true });
		const list = store.find(undefined, "casa");
		if (list === undefined) throw new Error("no list");
		expect(ordered(list).map((i) => i.text)[1]).toBe("chiamare l'idraulico");
		const r = resolveItems(list, ["2", "bolletta luce", "COMPRARE LAMPADINE", "9", "gas"]);
		expect(r.found.map((i) => i.text)).toEqual(["chiamare l'idraulico", "Pagare la bolletta della luce", "comprare lampadine"]);
		expect(r.unknown).toEqual(["9", "gas"]);
	});
});
