import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { staffCallReads, validAbsence } from "../src/core/staff.ts";
import { agent, cleanup, EMDASH, fresh, inside, outside, type S, setup } from "./staff-fixtures.ts";

afterEach(cleanup);

const all = (s: S) => s.store.read().absences;
// Monday 7 to Friday 11 December 2026: the 8th is the Immacolata.
const giulia = { op: "absence", person: "Giulia", kind: "ferie", from: "7 dicembre", to: "11 dicembre" };
const ESTIMATE = "(stima: il dato ufficiale ce l'ha la consulente)";

describe("absences", () => {
	it("ferie: saved, the working days counted (the holiday named), what is left an estimate; names only in the fence; audit op and count", async () => {
		const s = setup();
		const text = await s.run(giulia);
		expect(outside(text)).toContain("Segnato: ferie da lunedì 7 a venerdì 11 dicembre, per la persona nel riquadro.");
		expect(outside(text)).toContain(`Sono 4 giorni di ferie (lun-ven; Immacolata Concezione non conta); restano circa 22 giorni ${ESTIMATE}.`);
		expect(outside(text)).toContain("Se il vostro contratto conta anche il sabato, dimmelo.");
		expect(outside(text)).not.toContain("Giulia");
		expect(outside(text)).not.toContain("AS-0001");
		expect(inside(text)).toContain("Giulia Verdi: ferie da lunedì 7 a venerdì 11 dicembre");
		expect(all(s)).toHaveLength(1);
		expect(validAbsence(all(s)[0])).toBe(true);
		expect(s.events).toEqual([{ type: "staff.used", op: "absence", count: 1 }]);
		expect(text).not.toMatch(EMDASH);
		// The same call again saves nothing twice.
		const c = fresh("same");
		await s.run({ ...giulia, from: "1 dicembre", to: "2 dicembre" }, c);
		await s.run({ ...giulia, from: "1 dicembre", to: "2 dicembre" }, c);
		expect(all(s)).toHaveLength(2);
	});

	it("an overlap is refused and said; only the person's word writes; another agente gets counts and no kinds", async () => {
		const s = setup();
		await s.run(giulia);
		const clash = await s.run({ ...giulia, from: "10 dicembre", to: "18 dicembre" });
		expect(outside(clash)).toContain("Non l'ho segnata: si sovrappone a un'assenza già segnata (ferie da lunedì 7 a venerdì 11 dicembre).");
		expect(await s.run({ ...giulia, from: "1 dicembre" }, fresh(undefined, "notice"))).toContain("Non segno l'assenza");
		expect(await s.run({ ...giulia, from: "1 dicembre" }, fresh(undefined, "scheduled"))).toContain("Non segno l'assenza");
		await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "domani" });
		const counted = await s.run({ op: "who" }, agent());
		expect(counted).toBe("Personale: oggi nessuno assente, domani un assente. A un altro agente do solo i conteggi: chi e perché no.");
		expect(await s.run({ ...giulia, from: "1 dicembre" }, agent())).not.toContain("Segnato");
		expect(await s.run({ op: "absences" }, agent())).not.toMatch(/malattia|ferie|Marco|Giulia/);
		expect(all(s)).toHaveLength(2);
	});

	it("«Marco domani ha un permesso dalle 15»: the rest of his shift, 4 hours; the half day; «altro» with its reason from the list, in the fence", async () => {
		const s = setup();
		const text = await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		expect(outside(text)).toContain("Segnato: permesso martedì 20 ottobre dalle 15 a fine turno, per la persona nel riquadro.");
		expect(outside(text)).toContain(`Sono 4 ore di permesso; restano circa 68 ore di permessi ${ESTIMATE}.`);
		const half = await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "giovedì", half: "pomeriggio" });
		expect(outside(half)).toContain("mezza giornata (pomeriggio)");
		expect(outside(half)).toContain("Sono 0,5 giorni di ferie");
		const lutto = await s.run({ op: "absence", person: "Giulia", kind: "altro", from: "2 novembre", to: "4 novembre", reason: "lutto in famiglia" });
		expect(inside(lutto)).toContain("motivo: lutto)");
		expect(outside(lutto)).not.toContain("lutto");
		expect(outside(lutto)).toContain("Segnato: assenza da lunedì 2 a mercoledì 4 novembre");
	});

	it("«Marco è in malattia da oggi»: open-ended; a diagnosis is never saved, said plainly; only the protocol, digits", async () => {
		const s = setup();
		const text = await s.run({ op: "absence", person: "Marco", kind: "malattia", from: "oggi", reason: "influenza con febbre", protocol: "influenza" });
		expect(outside(text)).toContain("Il motivo non lo scrivo da nessuna parte, è un dato sanitario: mi basta il numero di protocollo del certificato, quando ce l'hai, che serve alla consulente.");
		expect(outside(text)).toContain("Questo non sembra un numero di protocollo (sono solo cifre): non l'ho salvato. Quando hai il certificato, dimmi il numero.");
		expect(outside(text)).toContain("Segnato: malattia da lunedì 19 ottobre, fine non detta");
		const saved = all(s)[0];
		expect(saved).not.toHaveProperty("reason");
		expect(saved).not.toHaveProperty("protocol");
		expect(JSON.stringify(s.store.read())).not.toContain("influenza");
		const change = await s.run({ op: "change", person: "Marco", to: "venerdì", protocol: "123 456 789" });
		expect(outside(change)).toContain("malattia da lunedì 19 a venerdì 23 ottobre");
		expect(outside(change)).not.toContain("dato sanitario");
		expect(inside(change)).toContain("protocollo 123456789");
		expect(outside(change)).not.toContain("123456789");
		expect(all(s)[0]?.protocol).toBe("123456789");
	});

	it("change and cancel: kept in the history, the time free again", async () => {
		const s = setup();
		await s.run(giulia);
		const moved = await s.run({ op: "change", person: "Giulia", from: "14 dicembre", to: "18 dicembre" });
		expect(outside(moved)).toContain("Fatto: ora è ferie da lunedì 14 a venerdì 18 dicembre");
		expect(await s.run({ op: "cancel", person: "Giulia", on: "15 dicembre" }, fresh(undefined, "notice"))).toContain("Non annullo l'assenza");
		const cancel = await s.run({ op: "cancel", person: "Giulia", on: "15 dicembre" });
		expect(outside(cancel)).toContain("Fatto: ho annullato ferie da lunedì 14 a venerdì 18 dicembre");
		expect(all(s)[0]?.cancelled).toBeDefined();
		expect(await s.run(giulia)).toContain("Segnato");
	});
});

describe("shifts and who works", () => {
	it("«chi lavora sabato?» and «fammi i turni della prossima settimana»: from the usual week less absences and closures, with the gaps", async () => {
		const s = setup();
		const sat = await s.run({ op: "who", date: "sabato" });
		expect(outside(sat)).toContain("Sabato 24 ottobre lavora una persona. Chi e quando è nel riquadro.");
		expect(inside(sat)).toContain("Marco Neri: 9-13 e 15-19");
		await s.run({ op: "absence", person: "Marco", kind: "ferie", from: "31/10/2026" });
		const week = await s.run({ op: "shifts" });
		expect(outside(week)).toContain("I turni dal 26/10/2026 al 01/11/2026");
		expect(outside(week)).toContain("• Lunedì 26 ottobre: una persona al lavoro; scoperto 18-19");
		expect(outside(week)).toContain("• Sabato 31 ottobre: 0 persone al lavoro, un'assenza; scoperto 9-13");
		expect(outside(week)).toContain("• Domenica 1 novembre: chiuso");
		// To the person in the chat the kind; never in the file.
		expect(inside(week)).toContain("Marco Neri: assente (ferie)");
		expect(await s.run({ op: "who", date: "08/12/2026" })).toContain("Martedì 8 dicembre è festa (Immacolata Concezione) e siete chiusi: non lavora nessuno.");
	});

	it("a shift said apart, and the extra hours, only on the person's word", async () => {
		const s = setup();
		expect(await s.run({ op: "shift", person: "Giulia", date: "sabato", hours: "9-13" }, fresh(undefined, "notice"))).toContain("Non cambio i turni");
		const shift = await s.run({ op: "shift", person: "Giulia", date: "sabato", hours: "9-13" });
		expect(outside(shift)).toContain("sabato 24 ottobre la persona nel riquadro lavora 9-13");
		expect(inside(await s.run({ op: "who", date: "sabato" }))).toContain("Giulia Verdi: 9-13");
		const extra = await s.run({ op: "extra", person: "Marco", date: "ieri", hours: "2 ore" });
		expect(outside(extra)).toContain("Fatto: ho segnato 2 ore in più ieri (domenica) per la persona nel riquadro. Vanno nel riepilogo del mese per la consulente, segnate come lavoro di domenica o festivo.");
		expect(await s.run({ op: "extra", person: "Marco", date: "domani", hours: 1 })).toContain("quando sono fatte");
	});
});

describe("balances and the month", () => {
	it("«quante ferie le restano a Giulia?»: an estimate, the year's at once by default; the balance said wins", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "26/10/2026", to: "30/10/2026" });
		const text = await s.run({ op: "balance", person: "Giulia" });
		expect(outside(text)).toContain("una stima (saldo annuo, senza maturazione mensile");
		expect(outside(text)).toContain("Il dato ufficiale ce l'ha la consulente del lavoro.");
		expect(inside(text)).toContain("Giulia Verdi: ferie, ne restano circa 21 giorni su 26 (in programma 5); permessi (ROL ed ex festività insieme), ne restano circa 72 ore su 72");
		await s.run({ op: "person", person: "Giulia", ferie_left: "12,5", as_of: "oggi" });
		expect(inside(await s.run({ op: "balance", person: "Giulia" }))).toContain("ferie, ne restano circa 7,5 giorni su 12,5 dal saldo del 19/10/2026 (in programma 5)");
		await s.run({ op: "settings", monthly: true });
		expect(outside(await s.run({ op: "balance" }))).toContain("maturazione mese per mese");
	});

	it("«mandami il riepilogo ore di settembre per la consulente del lavoro»: per person; the files in personale/ (CSV formula-safe, PDF), never sent", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "15/09/2026", start: "15" });
		await s.run({ op: "absence", person: "Giulia", kind: "malattia", from: "22/09/2026", to: "23/09/2026" });
		await s.run({ op: "extra", person: "Marco", date: "16/09/2026", hours: "1,5" });
		await s.run({ op: "person", person: "Marco", role: '=HYPERLINK("x")' });
		const text = await s.run({ op: "summary", month: "settembre" });
		expect(outside(text)).toContain("Il riepilogo di settembre per la consulente è pronto, giorno per giorno: presenze dai turni previsti (non sono timbrature), ferie, permessi, malattie con il protocollo e le ore in più che mi hai detto.");
		expect(inside(text)).toContain("Giulia Verdi: Totali: 20 giorni lavorati, 160 ore; ferie 0 giorni; permessi 0 ore; malattia 2 giorni di calendario; ore in più 0.");
		expect(inside(text)).toContain("Marco Neri: Totali: 22 giorni lavorati, 172 ore; ferie 0 giorni; permessi 4 ore; malattia 0 giorni di calendario; ore in più 1,5.");
		expect(outside(text)).toContain("è solo per la consulente del lavoro");
		expect(outside(text)).toContain("google_mail_send");
		expect(await s.run({ op: "export", what: "summary", month: "settembre" }, fresh(undefined, "notice"))).toContain("Non preparo il file");
		const out = await s.run({ op: "export", what: "summary", month: "settembre" });
		expect(inside(out)).toContain("personale/riepilogo-2026-09.csv");
		expect(inside(out)).toContain("personale/riepilogo-2026-09.pdf");
		expect(outside(out)).toContain("Non l'ho mandato a nessuno");
		const csv = readFileSync(join(s.root, "personale/riepilogo-2026-09.csv"), "utf8");
		expect(csv).toContain("Marco Neri;15/09/2026;martedì;9-13 e 15-19;4;PE;0;");
		expect(csv).toContain("Marco Neri;16/09/2026;mercoledì;9-13 e 15-19;8;;1,5;");
		expect(csv).toContain("Marco Neri;Totale;;22 giorni;172;FE 0 g PE 4 h MA 0 g;1,5;");
		expect(csv).not.toContain(";=HYPERLINK");
		expect(s.made.at(-1)?.text).toContain("# Riepilogo del personale, settembre 2026");
		const shifts = await s.run({ op: "export", what: "shifts", format: "csv" });
		expect(inside(shifts)).toContain("personale/turni-dal-2026-10-26.csv");
	});
});

describe("the appointments link", () => {
	it("an absence blocks the person's resource; never forced; the appointments it falls on are listed with the offer to move them", async () => {
		const s = setup();
		await s.book({ op: "book", client: "Luca Bianchi", services: ["taglio"], date: "domani", time: "16", resource: "Marco" });
		const text = await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		expect(outside(text)).toContain("Attenzione: in quei giorni c'è un appuntamento con questa persona (nel riquadro). Vuoi che lo sposti?");
		expect(inside(text)).toContain("20/10/2026 16:00 Luca Bianchi");
		const refused = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "17", resource: "Marco" });
		expect(outside(refused)).toContain("Domani dalle 15 la risorsa nel riquadro non c'è: con questa risorsa non ho fissato niente.");
		expect(outside(refused)).toContain("Se invece ci sarà, annulla prima la sua assenza nel personale.");
		expect(refused).not.toContain("fissalo lo stesso");
		expect(refused).not.toContain("permesso");
		const forced = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "17", resource: "Marco", force: true, force_check: "0123456789abcdef" });
		expect(forced).not.toContain("Fatto");
		// Without a resource said, the one there takes it.
		const other = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "17" });
		expect(inside(other)).toContain("(Giulia)");
		const free = await s.book({ op: "free_slots", date: "domani", resource: "Marco", minutes: 30, window: "pomeriggio" });
		expect(free).not.toContain("dalle 15");
		expect(await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "11", resource: "Marco" })).toContain("Fatto");
	});
});

describe("the brief, the file, routing", () => {
	it("once a day: who is off today and tomorrow, absences starting this week, tomorrow's gaps; never why", async () => {
		const s = setup();
		await s.run({ op: "absence", person: "Marco", kind: "permesso", from: "domani", start: "15" });
		await s.run({ op: "absence", person: "Giulia", kind: "ferie", from: "giovedì", to: "venerdì" });
		const text = await s.run({ op: "who", compact: true });
		expect(outside(text)).toBe("Personale: domani un assente; un'assenza comincia più avanti in settimana; domani scoperto 18-19.\n");
		expect(inside(text)).toContain("Domani: Marco Neri: 9-13 (assente il resto)");
		expect(inside(text)).toContain("In settimana: Giulia Verdi: assenza da giovedì 22 a venerdì 23 ottobre");
		expect(text).not.toMatch(/ferie|permesso|0 assenti/);
		expect(await s.run({ op: "who", compact: true })).toBe("Personale: niente da segnalare.");
		expect(BRIEF_INSTRUCTION).toContain("staff (who)");
		expect(staffCallReads({ op: "who", compact: true })).toBe(true);
		expect(staffCallReads({ op: "absence" })).toBe(false);
		expect(staffCallReads({ op: "export" })).toBe(false);
		const [gated] = readOnlyInBriefs([s.tool], async () => true);
		expect(await gated?.execute(giulia, fresh())).toContain("nella chat del brief del mattino Owni legge soltanto");
	});

	it("a file that does not read: one quiet line in the brief, never written over; a booking says so", async () => {
		const s = setup();
		writeFileSync(join(s.dir, "staff.json"), "{ non è json");
		expect(await s.run({ op: "who", compact: true })).toBe("Personale: il file non si legge, guarda il runbook.");
		expect(await s.run(giulia)).toContain("staff.json.bak");
		expect(readFileSync(join(s.dir, "staff.json"), "utf8")).toBe("{ non è json");
		// The appointments go on without the absences, and say it.
		expect(s.store.blocksOn("2026-10-20")).toEqual([]);
		const booked = await s.book({ op: "book", client: "Anna Rossi", services: ["taglio"], date: "domani", time: "11", resource: "Marco" });
		expect(outside(booked)).toContain("Attenzione: il file del personale non si legge, quindi non so se chi fa l'appuntamento è assente o di riposo.");
	});

	it("a new person; a resource only one of the appointments'; first names", async () => {
		const s = setup();
		const text = await s.run({ op: "person", person: "Sara Gialli", role: "apprendista", weekly_hours: "30", week: "lun-ven 9-15", ferie_days: 26 });
		expect(outside(text)).toContain("Fatto: ho aggiunto la persona nel riquadro al personale, 30 ore a settimana.");
		expect(inside(text)).toContain("Sara Gialli: apprendista; 30 ore a settimana; lun-ven 9-15; ferie 26 giorni l'anno");
		expect(await s.run({ op: "person", person: "Sara", resource: "Poltrona 9" })).toContain("negli appuntamenti non c'è una risorsa");
		expect(await s.run({ op: "person", person: "Sara", resource: "Marco" })).toContain("è già di un'altra persona");
		expect(await s.run({ op: "absence", person: "Paolo", kind: "ferie", from: "domani" })).toContain("non trovo questa persona");
	});

	it("routing: the instructions and the description keep staff apart from appointments, agents and Owni's users", () => {
		const s = setup();
		// Kept short: the instructions only route, the examples live in the description.
		expect(s.tool.description).toContain("protocol only the certificate's number: never a diagnosis, never ask for one");
		expect(s.tool.description).toContain("«assumo Luca");
		expect(s.tool.description).toContain("«chiudo per ferie dal 10 al 20 agosto» is the business closing: appointments settings, not staff.");
		expect(s.tool.description).toContain("«sabato Giulia fa 9-13»");
		expect(s.tool.description).toContain("«Giulia è in ferie dal 3 al 14 agosto»");
		expect(s.tool.description).toContain("«malattia del figlio» (reason congedo malattia figlio)");
		expect(s.tool.description).toContain("not the people who use Owni");
	});
});
