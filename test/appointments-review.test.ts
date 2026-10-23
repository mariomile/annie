/** Week 74 review: the fixes to the appointments and their invoices. Synthetic data only. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Appointment } from "../src/core/appointments.ts";
import { timeOnDay, timeSaid } from "../src/core/tools/appointment-input.ts";
import { hoursWords, mobileOf } from "../src/core/tools/appointment-render.ts";
import { hourlyLine, hoursOfMinutes } from "../src/core/tools/sales-appointments.ts";
import { type SalesInvoice, validInvoice } from "../src/core/sales-invoices.ts";
import { agent, checkIn, cleanup, EMDASH, fresh, inside, MARK, outside, type S, SETTINGS, setup } from "./appointment-fixtures.ts";

afterEach(cleanup);

const rossi = { op: "book", client: "Maria Rossi", services: ["taglio", "piega"], date: "giovedì", time: "15" };
const all = (s: S) => s.store.read().appointments;
const one = (s: S, id = "AP-0001") => all(s).find((a) => a.id === id) as Appointment;
const forceCheckIn = (answer: string) => /fissalo lo stesso e il controllo ([0-9a-f]{16})/.exec(answer)?.[1] as string;

async function doneOn(s: S, client: string, services: string[], date: string, time: string): Promise<void> {
	const saved = s.clock.now;
	s.clock.now = new Date(`${date}T05:00:00Z`);
	const booked = await s.run({ op: "book", client, services, date, time });
	if (!booked.includes("Fatto")) throw new Error(booked);
	s.clock.now = new Date(`${date}T17:30:00Z`);
	const done = await s.run({ op: "done", appointment: all(s).at(-1)?.id as string });
	if (!done.includes("Fatto")) throw new Error(done);
	s.clock.now = saved;
}

describe("M1: a name only close to the client asks «intendi questo appuntamento?» before any change", () => {
	it("cancel, move and done by «la signora Rossi»: asked with the appointment in the fence, bound by the check", async () => {
		const s = setup();
		await s.run(rossi);
		const asked = await s.run({ op: "cancel", client: "la signora Rossi" });
		expect(outside(asked)).toContain("Intendi questo appuntamento?");
		expect(inside(asked)).toContain("Maria Rossi");
		expect(outside(asked)).not.toContain("Rossi");
		expect(one(s).status).toBe("booked");
		expect(await s.run({ op: "cancel", client: "la signora Rossi", confirm: true, check: "0123456789abcdef" })).toContain("il controllo non torna");
		expect(one(s).status).toBe("booked");
		const moveAsked = await s.run({ op: "move", client: "la signora Rossi", date: "venerdì" });
		expect(outside(moveAsked)).toContain("Intendi questo appuntamento?");
		expect(one(s).day).toBe("2026-10-22");
		// The check of the cancel does not move it.
		expect(await s.run({ op: "move", client: "la signora Rossi", date: "venerdì", confirm: true, check: checkIn(asked) })).toContain("il controllo non torna");
		const ok = await s.run({ op: "cancel", client: "la signora Rossi", confirm: true, check: checkIn(asked) });
		expect(outside(ok)).toContain("Fatto: ho segnato come disdetto");
		expect(one(s).status).toBe("cancelled");
	});
});

describe("M2: morning or afternoon", () => {
	it("a bare hour goes to the afternoon only when the morning is closed and the afternoon open; «07:30» is 7:30; both or neither asked", () => {
		const day = "2026-10-22";
		const on = (raw: string, settings = SETTINGS) => {
			const t = timeSaid(raw);
			if ("answer" in t) return t.answer;
			const r = timeOnDay(t, settings, day);
			return "answer" in r ? r.answer : r;
		};
		expect(on("3")).toEqual({ minutes: 15 * 60, note: "Ho messo alle 15 (le 3 del pomeriggio)." });
		expect(on("alle 3 e mezza")).toMatchObject({ minutes: 15 * 60 + 30 });
		expect(on("3 e un quarto")).toMatchObject({ minutes: 15 * 60 + 15 });
		expect(on("15 e 30")).toEqual({ minutes: 15 * 60 + 30 });
		expect(on("mezzogiorno")).toEqual({ minutes: 12 * 60 });
		expect(on("10")).toEqual({ minutes: 10 * 60 });
		expect(on("07:30")).toEqual({ minutes: 7 * 60 + 30 });
		expect(on("3:30")).toEqual({ minutes: 3 * 60 + 30 });
		// 1:00 is closed and 13:00 is the break: asked, never guessed.
		expect(on("1")).toContain("del mattino o del pomeriggio? Chiedilo a chi ti scrive");
		// Open 8-22: 8 and 20 both fit.
		const long = { ...SETTINGS, week: { ...SETTINGS.week, "4": [{ from: "08:00", to: "22:00" }] } };
		expect(on("8", long)).toContain("Le 8 del mattino o del pomeriggio?");
		expect(on("ventitré")).toContain("Errore");
	});

	it("«07:30» is booked as 7:30 and refused as closed, not moved to the evening; the ask books nothing", async () => {
		const s = setup();
		const early = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "giovedì", time: "07:30" });
		expect(outside(early)).toContain("A quell'ora sei chiuso (giovedì 22 sei aperto 9-13 e 14-19): non ho fissato niente.");
		expect(outside(early)).toContain("giovedì 22 alle 9");
		expect(outside(early)).not.toContain("19:30");
		expect(all(s)).toEqual([]);
		const asked = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "giovedì", time: "1" });
		expect(asked).toContain("L'una del mattino o del pomeriggio?");
		expect(asked).not.toMatch(/^Errore/);
		expect(all(s)).toEqual([]);
		const half = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "giovedì", time: "alle 3 e mezza" });
		expect(outside(half)).toContain("dalle 15:30 alle 16");
	});
});

describe("M3: done and no_show by reference only once begun", () => {
	it("an appointment named by its reference that has not begun is refused", async () => {
		const s = setup();
		await s.run(rossi);
		const early = await s.run({ op: "done", appointment: "AP-0001" });
		expect(early).toContain("Questo appuntamento non si può: è già segnato o disdetto, oppure non è ancora cominciato.");
		expect(await s.run({ op: "no_show", appointment: "AP-0001" })).toContain("non è ancora cominciato");
		expect(one(s).status).toBe("booked");
		s.clock.now = new Date("2026-10-22T13:30:00Z");
		expect(await s.run({ op: "done", appointment: "AP-0001" })).toContain("Fatto");
		expect(await s.run({ op: "no_show", appointment: "AP-0001" })).toContain("è già segnato");
	});
});

describe("M4: a replayed call gives its own answer", () => {
	it("book and move again with the same call: the appointment it made, never a clash with itself", async () => {
		const s = setup();
		const c = fresh("book-once");
		const first = await s.run(rossi, c);
		// Another booking takes the next slot meanwhile; the replay still answers as booked.
		await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "16" });
		const again = await s.run(rossi, c);
		expect(outside(again)).toContain("Fatto: ho fissato l'appuntamento giovedì 22 ottobre dalle 15 alle 16.");
		expect(outside(again)).toBe(outside(first));
		expect(all(s)).toHaveLength(2);
		const m = fresh("move-once");
		const moved = await s.run({ op: "move", client: "Maria Rossi", date: "venerdì" }, m);
		expect(moved).toContain("Fatto: ho spostato");
		const replay = await s.run({ op: "move", client: "Maria Rossi", date: "venerdì" }, m);
		expect(outside(replay)).toContain("Fatto: ho spostato l'appuntamento da giovedì 22 ottobre alle 15 a venerdì 23 ottobre alle 15");
		expect(one(s).moved?.call).toBe("move-once");
		const k = fresh("cancel-once");
		await s.run({ op: "cancel", client: "Maria Rossi" }, k);
		expect(await s.run({ op: "cancel", client: "Maria Rossi" }, k)).toContain("Fatto: ho segnato come disdetto");
	});
});

describe("M5, UX13: the invoice of appointments to the wrong customer, credited, redone to the right one", () => {
	it("bill_to only for the appointments a credit note gave back; the right customer on the draft; the release says the next step", async () => {
		const s = setup();
		await doneOn(s, "Bianchi", ["taglio"], "2026-10-02", "10");
		const draft = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, recipient_code: "ZZZ0001" });
		expect(outside(draft)).toContain("Il cliente ha già pagato questi appuntamenti, con lo scontrino? Se sì, la fattura va fatta come differita o citando gli scontrini: chiedi al commercialista prima di emetterla.");
		await s.sell({ op: "issue", draft: "BZ-0001", confirm: true });
		expect(await s.sell({ op: "draft", customer: "Bianchi", appointments: true, bill_to: "Studio Verdi Prova Srl" })).toContain("a un altro cliente intesto solo gli appuntamenti di una fattura corretta con una nota di credito per cliente sbagliato");
		expect(await s.sell({ op: "draft", customer: "Bianchi", lines: [{ description: "Taglio", quantity: "1", price: "25" }], bill_to: "Studio Verdi Prova Srl" })).toContain("Errore: un altro cliente a cui intestare la fattura si dice solo");
		const credit = await s.sell({ op: "credit_note", invoice: "1", wrong_customer: true });
		expect(outside(credit)).toContain("si rifà la fattura degli stessi appuntamenti intestata al cliente giusto: chiedi a chi ti scrive a chi va fatta.");
		const nc = s.sales.read().invoices.find((i) => i.related !== undefined) as SalesInvoice;
		const released = await s.sell({ op: "issue", draft: nc.id, confirm: true });
		expect(outside(released)).toContain("Gli appuntamenti della fattura n. 1 tornano da fatturare. Ora si rifà la fattura degli stessi appuntamenti intestata al cliente giusto: dimmi a chi va fatta e la preparo.");
		const close = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, bill_to: "Rossi" });
		expect(outside(close)).toContain("Intendi uno di questi clienti?");
		expect(inside(close)).toContain("Maria Rossi");
		const redo = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, bill_to: "Studio Verdi Prova Srl", vat_number: "IT00000040014", recipient_code: "ZZZ0002", address: "Via Neri 3, 20121 Milano MI" });
		expect(outside(redo)).toContain("La intesto al cliente giusto");
		const inv = s.sales.read().invoices.at(-1) as SalesInvoice;
		expect(inv.buyer).toMatchObject({ name: "Studio Verdi Prova Srl", vat: "IT00000040014" });
		expect(inv.appointments?.map((a) => a.id)).toEqual(["AP-0001"]);
		expect(inv.type).toBe("TD01");
		expect(redo).not.toMatch(EMDASH);
	});
});

describe("L1: dictated lines that an appointment fatto already is", () => {
	it("asked, nothing drafted; with appointments false the lines are apart", async () => {
		const s = setup();
		await doneOn(s, "Bianchi", ["taglio"], "2026-10-02", "10");
		const asked = await s.sell({ op: "draft", customer: "Bianchi", lines: [{ description: "Taglio", quantity: "1", price: "25" }], vat: 22, recipient_code: "ZZZ0001" });
		expect(asked).toContain("Attenzione: questo cliente ha un appuntamento fatto e non ancora fatturato con un servizio come le voci dettate. Non ho fatto la bozza");
		expect(s.sales.read().invoices).toEqual([]);
		// Another client's appointment, or other work: no question.
		expect(await s.sell({ op: "draft", customer: "Bianchi", lines: [{ description: "Consulenza", quantity: "1", price: "25" }], vat: 22, recipient_code: "ZZZ0001" })).toContain("Bozza pronta");
		const apart = await s.sell({ op: "draft", customer: "Bianchi", lines: [{ description: "Taglio", quantity: "1", price: "25" }], vat: 22, appointments: false, recipient_code: "ZZZ0001" });
		expect(apart).toContain("Bozza pronta");
		expect((s.sales.read().invoices.at(-1) as SalesInvoice).appointments).toBeUndefined();
	});
});

describe("L2, L3, L6, L7", () => {
	it("export only on the person's word", async () => {
		const s = setup();
		await s.run(rossi);
		expect(await s.run({ op: "export" }, fresh(undefined, "notice"))).not.toContain("appuntamenti/");
		expect(await s.run({ op: "export" }, fresh(undefined, "scheduled"))).not.toContain("appuntamenti/");
		expect(inside(await s.run({ op: "export" }))).toContain("appuntamenti/");
	});

	it("settings are rebuilt under the lock: a change saved meanwhile is kept", async () => {
		const s = setup();
		const original = s.store.update.bind(s.store);
		let raced = false;
		s.store.update = ((callId: string, fn: Parameters<typeof original>[1]) => {
			if (!raced && callId === "settings-race") {
				raced = true;
				original("other", (st) => ({ ...st, settings: { ...(st.settings ?? SETTINGS), resources: ["Giulia"] } }));
			}
			return original(callId, fn);
		}) as typeof original;
		expect(await s.run({ op: "settings", business: "Salone Anna" }, fresh("settings-race"))).toContain("Fatto, ho salvato.");
		expect(s.store.read().settings).toMatchObject({ business: "Salone Anna", resources: ["Giulia"] });
	});

	it("a day more than a year ahead is refused", async () => {
		const s = setup();
		expect(await s.run({ ...rossi, date: "22/10/2028" })).toContain("quel giorno è più di un anno avanti");
		expect(await s.run({ op: "agenda", date: "22/10/2028" })).toContain("più di un anno avanti");
		expect(await s.run({ op: "free_slots", date: "22/10/2028" })).toContain("più di un anno avanti");
		expect(all(s)).toEqual([]);
	});

	it("a file that does not read: one quiet line in the brief, the full error elsewhere", async () => {
		const s = setup();
		writeFileSync(join(s.dir, "appointments.json"), "{ non è json");
		expect(await s.run({ op: "agenda", compact: true })).toBe("Appuntamenti: il file non si legge, guarda il runbook.");
		expect(await s.run({ op: "agenda" })).not.toBe("Appuntamenti: il file non si legge, guarda il runbook.");
	});
});

describe("L4, L-a: a voce priced by the hour bills the minutes, to the cent", () => {
	it("the line total is minutes × hourly / 60 to the cent: 100 minutes at 60 euro an hour is exactly 100,00", async () => {
		expect(hourlyLine(90, "40")).toEqual({ quantity: "1.5", unit: "ore", price: "40", how: "ore" });
		expect(hourlyLine(100, "60")).toEqual({ quantity: "100", unit: "minuti", price: "1", how: "minuti" });
		expect(hourlyLine(100, "50")).toEqual({ quantity: "1", unit: "a corpo", price: "83.33", how: "corpo" });
		expect(hourlyLine(20, "45.5")).toEqual({ quantity: "1", unit: "a corpo", price: "15.17", how: "corpo" });
		expect(hoursOfMinutes(100)).toEqual({ quantity: "1.67", exact: false });
		const items = [{ id: "LS-0001", name: "Taglio", unit: "ora", price: "60", vat: 22 as const, ...MARK }];
		const settings = { ...SETTINGS, services: [{ name: "Taglio", item: "LS-0001", minutes: 50 }] };
		const s = setup({ items, settings });
		await doneOn(s, "Bianchi", ["taglio"], "2026-10-02", "10");
		await doneOn(s, "Bianchi", ["taglio"], "2026-10-09", "10");
		const text = await s.sell({ op: "draft", customer: "Bianchi", appointments: true, recipient_code: "ZZZ0001" });
		expect(outside(text)).toContain("Le voci a ore le conto dai minuti degli appuntamenti, con il totale esatto al centesimo");
		expect(inside(text)).toContain("• Taglio: 100 minuti (circa 1,67 ore) a 60 € l'ora: al minuto, 1 € l'uno");
		const inv = s.sales.read().invoices[0] as SalesInvoice;
		expect(inv.lines[0]).toMatchObject({ quantity: "100", price: "1", item: "LS-0001" });
		expect(inside(text)).toContain("= 100,00 €");
		expect(inside(text)).not.toContain("100,20");
		expect(validInvoice(inv)).toBe(true);
		// 50 euro an hour, 100 minutes: 83,33 once (1,67 hours would be 83,50).
		const r = setup({ items: [{ ...items[0], price: "50" }] as never, settings });
		await doneOn(r, "Bianchi", ["taglio"], "2026-10-02", "10");
		await doneOn(r, "Bianchi", ["taglio"], "2026-10-09", "10");
		const fifty = await r.sell({ op: "draft", customer: "Bianchi", appointments: true, recipient_code: "ZZZ0001" });
		expect(inside(fifty)).toContain("83,33 €");
		expect(inside(fifty)).not.toContain("83,50");
		expect((r.sales.read().invoices[0] as SalesInvoice).lines[0]).toMatchObject({ quantity: "1", price: "83.33", unit: "a corpo" });
		// 90 minutes: exact hours.
		const h = setup({ items, settings: { ...SETTINGS, services: [{ name: "Taglio", item: "LS-0001", minutes: 45 }] } });
		await doneOn(h, "Bianchi", ["taglio"], "2026-10-02", "10");
		await doneOn(h, "Bianchi", ["taglio"], "2026-10-09", "10");
		await h.sell({ op: "draft", customer: "Bianchi", appointments: true, recipient_code: "ZZZ0001" });
		expect((h.sales.read().invoices[0] as SalesInvoice).lines[0]).toMatchObject({ quantity: "1.5", price: "60" });
	});
});

describe("L-b: the confirmation message is one client's", () => {
	it("without a client it is refused, not every appointment to come", async () => {
		const s = setup();
		await s.run(rossi);
		await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "venerdì", time: "10" });
		expect(await s.run({ op: "reminders", confirmation: true })).toBe("Errore: il messaggio di conferma è per un cliente: dimmi per quale.");
		const one_ = await s.run({ op: "reminders", confirmation: true, client: "Luca Neri" });
		expect(inside(one_)).toContain("Luca Neri");
		expect(inside(one_)).not.toContain("Maria Rossi");
	});
});

describe("UX: the refusals", () => {
	it("UX1: the start fits, the end runs into the break: said, with the nearest times", async () => {
		const s = setup();
		const text = await s.run({ op: "book", client: "Bianchi", services: ["colore"], date: "venerdì", time: "12:30" });
		expect(outside(text)).toContain("Alle 12:30 c'è posto solo fino alle 13: l'appuntamento dura un'ora e mezza e finirebbe alle 14, nella pausa. Non ho fissato niente.");
		expect(outside(text)).toContain("Orari liberi vicini: venerdì 23 alle 11, alle 11:15 o alle 11:30. Quale preferisci?");
		expect(all(s)).toEqual([]);
	});

	it("UX2: «fissalo lo stesso» books over a clash or out of hours, only on the person's word, never in the past", async () => {
		const s = setup();
		await s.run(rossi);
		const over = { op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "15:30", force: true };
		expect(await s.run(over, fresh(undefined, "notice"))).toContain("Non fisso l'appuntamento sovrapposto o fuori orario");
		expect(await s.run(over, agent())).toContain("a un altro agente do solo quanti sono");
		expect(all(s)).toHaveLength(1);
		// L-c: force only after the clash was shown, with the refusal's check.
		const blind = await s.run(over);
		expect(blind).toContain("Errore: lo fisso lo stesso solo dopo aver mostrato perché non si può");
		expect(all(s)).toHaveLength(1);
		const { force: _f, ...plain } = over;
		const refused = await s.run(plain);
		const check = forceCheckIn(refused);
		expect(check).toMatch(/^[0-9a-f]{16}$/);
		expect(await s.run({ ...over, force_check: "0123456789abcdef" })).toContain("Errore: lo fisso lo stesso solo dopo");
		// The check of another time does not force this one.
		expect(await s.run({ ...over, time: "15:15", force_check: check })).toContain("Errore: lo fisso lo stesso solo dopo");
		const ok = await s.run({ ...over, force_check: check });
		expect(outside(ok)).toContain("Fatto: ho fissato l'appuntamento giovedì 22 ottobre dalle 15:30 alle 16.");
		expect(outside(ok)).toContain("L'ho fissato lo stesso, come mi hai detto");
		const lateArgs = { op: "book", client: "Luca Neri", services: ["taglio"], date: "giovedì", time: "19" };
		const lateCheck = forceCheckIn(await s.run(lateArgs));
		const late = await s.run({ ...lateArgs, force: true, force_check: lateCheck });
		expect(late).toContain("Fatto");
		expect(all(s)).toHaveLength(3);
		expect(await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "oggi", time: "9", force: true })).toBe("Quell'ora è già passata: dimmi un altro giorno o un'altra ora.");
		const outsideHours = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "giovedì", time: "20:30" });
		expect(outside(outsideHours)).toContain("Se vuoi fissarlo lo stesso, dimmi «fissalo lo stesso».");
	});

	it("UX3: a weekday that is today with the time gone is next week, said", async () => {
		const s = setup();
		// Monday 19 October, 10:00.
		const text = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "lunedì", time: "9" });
		expect(outside(text)).toContain("Fatto: ho fissato l'appuntamento lunedì 26 ottobre dalle 9 alle 9:30.");
		expect(outside(text)).toContain("Lunedì l'ho inteso come lunedì prossimo, 26 ottobre: oggi alle 9 è già passato.");
		const later = await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "lunedì", time: "11" });
		expect(outside(later)).toContain("oggi, lunedì 19 ottobre dalle 11 alle 11:30");
	});
});

describe("UX: reading the agenda", () => {
	it("UX5: with resources, each one's gaps in the fence; a gap shorter than the shortest service dropped", async () => {
		const s = setup({ settings: { ...SETTINGS, resources: ["Marco", "Giulia"] } });
		await s.run({ ...rossi, date: "domani", time: "10" });
		await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "domani", time: "9:15", resource: "Giulia" });
		const text = await s.run({ op: "agenda", date: "domani" });
		expect(outside(text)).toContain("Libero per risorsa, nel riquadro.");
		expect(outside(text)).not.toContain("Giulia");
		expect(inside(text)).toContain("Libero: Marco 9-10, 11-13, 14-19; Giulia 9:45-13, 14-19");
		const plain = setup();
		await plain.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "domani", time: "9:15" });
		const solo = await plain.run({ op: "agenda", date: "domani" });
		// 9:00-9:15 is shorter than the shortest service (30 minutes): not a gap.
		expect(outside(solo)).toContain("Libero: 9:45-13, 14-19.");
	});

	it("UX9: free windows clipped to the real hours; UX17: compact hours", async () => {
		const s = setup();
		const evening = await s.run({ op: "free_slots", date: "giovedì", window: "sera", minutes: 30 });
		expect(evening).toContain("dalle 18 alle 19");
		expect(evening).not.toContain("alle 22");
		expect(hoursWords(SETTINGS)).toBe("lun-ven 9-13 e 14-19; sab 9-13; chiuso domenica");
		expect(hoursWords({ ...MARK, week: { "2": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }], "3": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }], "4": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }], "5": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }], "6": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }] } })).toBe("mar-sab 9-13 e 14-19; chiuso domenica e lunedì");
	});

	it("UX10: the no-shows counted, the last one dated; from the third, the reminder offered and the warning at booking", async () => {
		const s = setup();
		const days = ["2026-10-01", "2026-10-03", "2026-10-08"];
		let last = "";
		for (const day of days) {
			s.clock.now = new Date(`${day}T05:00:00Z`);
			await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "oggi", time: "10" });
			s.clock.now = new Date(`${day}T09:00:00Z`);
			last = await s.run({ op: "no_show", client: "Bianchi" });
		}
		expect(outside(last)).toContain("È la terza volta che non si presenta (l'ultima il 3 ottobre).");
		expect(outside(last)).toContain("Se vuoi, quando lo rifissi te lo ricordo.");
		s.clock.now = new Date("2026-10-19T08:00:00Z");
		const booked = await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "giovedì", time: "10" });
		expect(outside(booked)).toContain("Attenzione: questo cliente non si è presentato 3 volte (l'ultima il 8 ottobre).");
	});

	it("UX16: yesterday's still to mark, in the brief", async () => {
		const s = setup();
		s.clock.now = new Date("2026-10-19T05:00:00Z");
		await s.run({ op: "book", client: "Bianchi", services: ["taglio"], date: "oggi", time: "9" });
		await s.run({ op: "book", client: "Luca Neri", services: ["taglio"], date: "oggi", time: "10" });
		s.clock.now = new Date("2026-10-20T05:00:00Z");
		expect(outside(await s.run({ op: "agenda", compact: true }))).toContain("Ieri 2 appuntamenti sono ancora da segnare: dimmi «tutti fatti», oppure chi non è venuto.");
	});
});

describe("UX: the messages to the clients", () => {
	it("UX6: Italian mobiles to 39…, landlines and others skipped", () => {
		expect(mobileOf("+39 333 0000001")).toBe("393330000001");
		expect(mobileOf("333 000 0001")).toBe("393330000001");
		expect(mobileOf("0039 333-0000001")).toBe("393330000001");
		expect(mobileOf("02 0000002")).toBeUndefined();
		expect(mobileOf("+44 20 0000 0000")).toBeUndefined();
	});

	it("UX7, UX14: after booking, the confirmation for the client; Calendar only when it is there", async () => {
		const s = setup();
		const booked = await s.run(rossi);
		expect(outside(booked)).toContain("Vuoi mandare al cliente un messaggio di conferma?");
		expect(booked).not.toContain("google_calendar_create");
		expect(inside(booked)).not.toContain("Per il calendario");
		const text = await s.run({ op: "reminders", client: "Maria Rossi", confirmation: true });
		expect(inside(text)).toContain("le confermiamo");
		expect(inside(text)).toContain("giovedì 22 ottobre alle 15, per taglio e piega");
		expect(inside(text)).toContain("https://wa.me/393330000001?text=");
		expect(outside(text)).not.toContain("wa.me");
	});
});

describe("UX11: routing", () => {
	it("the instructions and the description say the reminders are the clients', the agenda with the calendar, the settings phrases, the hours example", () => {
		const s = setup();
		expect(s.tool.description).toContain("«fammi i promemoria per domani», «fammi il messaggio di promemoria per gli appuntamenti di domani» are the messages to the clients");
		expect(s.tool.description).toContain("if the person also has Google Calendar, add their own events (google_calendar_events)");
		expect(s.tool.description).toContain("«il taglio dura 30 minuti, il colore un'ora e mezza» → services");
		expect(s.tool.description).toContain("«siamo aperti mar-sab 9-13 e 14:30-19, chiusi domenica e lunedì»");
		expect(s.tool.description).toContain("«fissalo lo stesso»");
	});
});
