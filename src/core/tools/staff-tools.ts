/**
 * The tool `staff`: il personale of a small business (not Annie's users: HR data only). The
 * people with their usual week and what they are entitled to; their absences (ferie, permesso,
 * malattia, altro: added, changed, cancelled only on the person's own word, an overlap refused and
 * said); the shifts of a week from the usual week less absences and closures, with the hours
 * nobody covers; who works on a day; ferie and permessi left (an estimate: the consulente del
 * lavoro has the official figure); the month for the consulente (CSV, PDF or Word in personale/,
 * never sent). An absence of a person who is a resource of the appointments blocks it there; the
 * appointments it falls on are listed. Health data: of a malattia only the dates and the
 * certificate's protocol, never a diagnosis. Another agente gets counts only, never kinds; the
 * audit the op and a count. Names, reasons and protocols: in the fence.
 */
import type { AppointmentSettings } from "../appointments.ts";
import { localNow, type Span } from "../appointment-slots.ts";
import type { AppointmentStore } from "../appointment-store.ts";
import { makeDocumentFile } from "../document-reader.ts";
import { DocumentError } from "../documents.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { addDays, weekdayOf } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import { PeriodError, readPeriod } from "../periods.ts";
import { type Absence, type AbsenceKind, absenceId, decimalWords, HALVES, type Half, hoursWords, isActive, KIND_WORDS, KINDS, overlaps, type Person, personId, spanOf, STAFF_LIMITS, StaffError, type StaffSettings } from "../staff.ts";
import { type Balance, balancesOf } from "../staff-balances.ts";
import { absenceDays, coverageGaps, dayOf, monthRows, type StaffDay } from "../staff-shifts.ts";
import { STAFF_BROKEN, type StaffBook, type StaffStore } from "../staff-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { absenceNamed, dayHours, decimalSaid, isAnswer, minutesOfHours, personSaid, protocolSaid, rangeSaid, staffDay, staffTime, weekOfPerson } from "./staff-input.ts";
import { absenceRow, absenceWords, dayWords, fencedStaff, monthCsv, monthMarkdown, monthRow, personDayRow, personRow, plainDay, shiftsCsv, shiftsMarkdown, spansWords } from "./staff-render.ts";

export const STAFF_OPS = ["person", "absence", "change", "cancel", "extra", "shift", "who", "shifts", "balance", "absences", "summary", "export", "settings"] as const;
export type StaffOp = (typeof STAFF_OPS)[number];

/** What was done, for the audit: the op and how many, never names, kinds or days. */
export type StaffEvent = { readonly type: "staff.used"; readonly op: StaffOp | "brief"; readonly count: number };

export type StaffToolsOptions = {
	readonly workspace: Workspace;
	readonly store: StaffStore;
	/** The appointments: the business's hours and closures, and those an absence falls on. */
	readonly appointments?: Pick<AppointmentStore, "read">;
	/** The business's time zone (Europe/Rome). */
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: StaffEvent) => Promise<void>;
	/** Tests: the clock and the document maker. */
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

const DESCRIPTION = [
	"Il personale di una piccola attività: le persone che ci lavorano (non gli utenti di Annie), il loro orario di solito, ferie, permessi, malattia, i turni, il riepilogo per la consulente del lavoro. Not the appointments with clients (appointments), not the agents of the board, not the people who use Annie.",
	"What the person says → op: «Giulia è in ferie dal 3 al 14 agosto» → absence with person, kind ferie, from, to (half mattina/pomeriggio for half a day); «Marco domani ha un permesso dalle 15» → absence kind permesso, from, start (end when said); «Marco è in malattia da oggi» → absence kind malattia, from (to only when said; protocol only the certificate's number: never a diagnosis, never ask for one); lutto, congedo, 104 → kind altro with reason. «sposta le ferie di Giulia» → change; «annulla il permesso di Marco» → cancel (with on, the day). «Marco ieri ha fatto 2 ore in più» → extra with person, date, hours. «sabato Giulia fa 9-13» → shift with person, date, hours («riposo» for a day off). These only on the person's own word.",
	"«chi lavora sabato?» → who with date; «fammi i turni della prossima settimana» → shifts with date (a day of that week); «quante ferie le restano a Giulia?» → balance with person (an estimate: say so); «chi è in ferie ad agosto?» → absences with period; «mandami il riepilogo ore di ottobre per la consulente del lavoro» → summary with month, then export what summary (CSV and PDF in personale/): never sent; offer google_mail_send with the file (it asks its approval). Turni as a file → export what shifts.",
	"person: «Giulia Verdi, commessa, 40 ore, lun-ven 9-13 e 14-18, 26 giorni di ferie e 72 ore di permessi; le restano 12 giorni di ferie» → person with name, role, weekly_hours, week (one line), ferie_days, rol_hours, ferie_left, rol_left (as_of: the day of that balance); resource: her name in the appointments, so her absences block it. settings: monthly true when ferie and permessi accrue month by month. summary of the brief: who with compact true.",
	"Never say a reference (PE-…, AS-…) to the person: name the person.",
].join(" ");

const AGENT_NOTE = "A un altro agente do solo i conteggi: chi e perché no.";
const BRIEF_NOTHING = "Personale: niente da segnalare.";
const BRIEF_BROKEN = "Personale: il file non si legge, guarda il runbook.";
const HEALTH = "La diagnosi non la salvo: basta il numero di protocollo del certificato.";
const ESTIMATE = "È una stima: la consulente del lavoro ha il dato ufficiale.";

type Answer = { text: string; count: number };
type Now = { readonly day: string; readonly minutes: number };

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));

export function createStaffTools(options: StaffToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const make = options.make ?? ((input: MakeInput) => makeDocumentFile(input));
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: StaffEvent["op"], count: number) => {
		await ctx.step(`audit-${op}`, async () => {
			await options.record?.({ type: "staff.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const hours = (): AppointmentSettings | undefined => {
		const b = options.appointments?.read();
		return b === undefined || b.broken ? undefined : b.settings;
	};
	const data = (b: StaffBook): StaffDay => {
		const settings = hours();
		return { people: b.people, absences: b.absences, shifts: b.shifts, ...(settings === undefined ? {} : { settings }) };
	};
	const offOn = (b: StaffBook, day: string) => dayOf(data(b), day).people.filter((p) => p.off !== undefined);

	/** Another agente: counts only, no names, no kinds. */
	function agentCounts(b: StaffBook, at: Now): string {
		return `Personale: oggi ${n1(offOn(b, at.day).length, "un assente", "# assenti")}, domani ${n1(offOn(b, addDays(at.day, 1)).length, "un assente", "# assenti")}. ${AGENT_NOTE}`;
	}

	/** «Intendi questa persona?»: a name only close to one, asked; nothing written. */
	const closeAsk = (p: Person) => ["Intendi questa persona? Non si chiama esattamente come è stata detta:", fencedStaff(p.name), "Se chi ti scrive dice di sì, ripeti con il nome scritto come qui."].join("\n");

	async function person(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const said = typeof args.person === "string" ? args.person : undefined;
		if (said === undefined) return { text: "Errore: dimmi il nome della persona.", count: 0 };
		const found = b.people.length === 0 ? undefined : personSaid(said, b.people);
		const current = found === undefined || isAnswer(found) ? undefined : found.person;
		if (found !== undefined && !isAnswer(found) && found.close === true) return { text: closeAsk(found.person), count: 0 };
		const fields: Record<string, unknown> = {};
		if (args.role !== undefined) {
			const r = cleanText(args.role, STAFF_LIMITS.role, "il ruolo");
			if (isProblem(r)) return { text: `Errore: ${r.problem}.`, count: 0 };
			fields.role = r;
		}
		const decimals: [string, string, number, string][] = [
			["weekly_hours", "weeklyHours", STAFF_LIMITS.weeklyHours, "le ore a settimana"],
			["ferie_days", "ferieDays", STAFF_LIMITS.ferieDays, "i giorni di ferie l'anno"],
			["rol_hours", "rolHours", STAFF_LIMITS.rolHours, "le ore di permesso l'anno"],
		];
		for (const [arg, key, max, what] of decimals) {
			const v = decimalSaid(args[arg], max, what);
			if (isAnswer(v)) return { text: v.answer, count: 0 };
			if (v !== undefined) fields[key] = v;
		}
		if (args.week !== undefined) {
			const w = weekOfPerson(args.week, current?.week);
			if (isAnswer(w)) return { text: w.answer, count: 0 };
			fields.week = w;
		}
		if (args.ferie_left !== undefined || args.rol_left !== undefined) {
			const ferie = decimalSaid(args.ferie_left, STAFF_LIMITS.ferieDays * 3, "le ferie che restano");
			if (isAnswer(ferie)) return { text: ferie.answer, count: 0 };
			const rol = decimalSaid(args.rol_left, STAFF_LIMITS.rolHours * 3, "le ore di permesso che restano");
			if (isAnswer(rol)) return { text: rol.answer, count: 0 };
			const day = args.as_of === undefined ? at.day : staffDay(args.as_of, at.day);
			if (isAnswer(day)) return { text: day.answer, count: 0 };
			fields.opening = { day, ...(ferie === undefined ? {} : { ferie }), ...(rol === undefined ? {} : { rol }) };
		}
		if (args.resource !== undefined) {
			const r = cleanText(args.resource, STAFF_LIMITS.resource, "la risorsa");
			if (isProblem(r) || r === undefined) return { text: `Errore: ${isProblem(r) ? r.problem : "la risorsa è vuota"}.`, count: 0 };
			const known = hours()?.resources ?? [];
			const match = known.find((k) => k.toLowerCase() === r.toLowerCase());
			if (match === undefined) return { text: ["Errore: negli appuntamenti non c'è una risorsa con questo nome: aggiungila prima lì, nelle impostazioni degli appuntamenti.", fencedStaff(r)].join("\n"), count: 0 };
			if (b.people.some((p) => p.id !== current?.id && p.resource?.toLowerCase() === match.toLowerCase())) return { text: ["Errore: questa risorsa degli appuntamenti è già di un'altra persona.", fencedStaff(match)].join("\n"), count: 0 };
			fields.resource = match;
		}
		if (Object.keys(fields).length === 0) {
			if (current !== undefined) return { text: ["La scheda è nel riquadro.", fencedStaff(personRow(current))].join("\n"), count: 0 };
		}
		const refused = requirePersonFor(ctx, "cambio i dati del personale");
		if (refused !== undefined) return { text: refused, count: 0 };
		const name = cleanText(said, STAFF_LIMITS.name, "il nome");
		if (current === undefined && (isProblem(name) || name === undefined || name.split(/\s+/).length < 2)) return { text: "Errore: per una persona nuova dimmi nome e cognome.", count: 0 };
		const by = marker(ctx);
		let id = current?.id ?? "";
		await ctx.step("person", async () => {
			store.update(ctx.callId, (state) => {
				if (current !== undefined) return { ...state, people: state.people.map((p) => (p.id === current.id ? ({ ...p, ...fields, ...by } as Person) : p)) };
				if (state.people.length >= STAFF_LIMITS.people) throw new StaffError("il personale è troppo per aggiungere altre persone");
				id = personId(state.nextPerson);
				const made = { id, name: name as string, ...fields, ...by } as Person;
				return { ...state, nextPerson: state.nextPerson + 1, people: [...state.people, made] };
			});
			return true;
		});
		const saved = store.read().people.find((p) => (current === undefined ? p.name === name : p.id === current.id));
		const notes = [
			...(saved?.week === undefined ? ["Dimmi anche il suo orario di lavoro di solito (come «lun-ven 9-13 e 14-18»): serve per i turni e per contare le ferie."] : []),
			...(saved?.ferieDays === undefined && saved?.opening?.ferie === undefined ? ["Se vuoi tenere il conto delle ferie e dei permessi, dimmi quanti giorni e quante ore le spettano l'anno, o quante gliene restano oggi."] : []),
		];
		return { text: [current === undefined ? "Fatto: ho aggiunto la persona al personale, come nel riquadro." : "Fatto: ho aggiornato la scheda, come nel riquadro.", fencedStaff(saved === undefined ? "" : personRow(saved)), ...notes].join("\n"), count: 1 };
	}

	/** The absence as said, checked: kind, days, times, protocol, reason. Notes for the answer (the health one). */
	function absenceSaid(args: Record<string, unknown>, p: Person, at: Now, base?: Absence): { absence: Omit<Absence, "id" | "callId" | "by" | "at">; notes: string[] } | string {
		const kind = (args.kind ?? base?.kind) as AbsenceKind;
		if (!KINDS.includes(kind)) return "Errore: l'assenza è ferie, permesso, malattia o altro (lutto, congedo, 104).";
		const notes: string[] = [];
		const out: Record<string, unknown> = { person: p.id, kind };
		const changedDays = args.from !== undefined || args.to !== undefined;
		if (kind === "permesso") {
			const day = staffDay(args.from ?? base?.from ?? "oggi", at.day);
			if (isAnswer(day)) return day.answer;
			const start = args.start !== undefined ? staffTime(args.start) : base?.start;
			if (start === undefined) return "Errore: dimmi da che ora è il permesso.";
			if (isAnswer(start)) return start.answer;
			const end = args.end !== undefined ? staffTime(args.end) : base?.end;
			if (end !== undefined && isAnswer(end)) return end.answer;
			if (end !== undefined && end <= start) return "Errore: il permesso finisce prima di cominciare: dimmi le ore di nuovo.";
			if (end === undefined && (p.week?.[String(weekdayOf(day))] ?? []).length === 0) return "Errore: quel giorno non ha un orario di solito: dimmi fino a che ora è il permesso.";
			Object.assign(out, { from: day, to: day, start, ...(end === undefined ? {} : { end }) });
		} else {
			const r = changedDays || base === undefined ? rangeSaid(args.from ?? base?.from, args.to ?? (kind === "malattia" ? undefined : (base?.to ?? args.from ?? base?.from)), at.day, kind === "malattia") : { from: base.from, ...(base.to === undefined ? {} : { to: base.to }) };
			if (isAnswer(r)) return r.answer;
			Object.assign(out, { from: r.from, ...(r.to === undefined ? {} : { to: r.to }) });
			const half = args.half ?? (changedDays ? undefined : base?.half);
			if (half !== undefined) {
				if (kind !== "ferie" || !HALVES.includes(half as Half) || r.to !== r.from) return "Errore: la mezza giornata è di ferie, di un giorno solo: mattina o pomeriggio.";
				out.half = half;
			}
		}
		if (kind === "malattia") {
			// Health data: the certificate's protocol only.
			const prot = args.protocol !== undefined ? protocolSaid(args.protocol) : base?.protocol;
			if (prot === "bad") notes.push(`Il numero di protocollo non l'ho salvato: sono solo cifre e lettere. ${HEALTH}`);
			else if (prot !== undefined) out.protocol = prot;
			if (args.reason !== undefined || args.notes !== undefined) notes.push(HEALTH);
		} else if (kind === "altro") {
			const reason = args.reason !== undefined ? cleanText(args.reason, STAFF_LIMITS.reason, "il motivo") : base?.reason;
			if (isProblem(reason)) return `Errore: ${reason.problem}.`;
			if (reason !== undefined) out.reason = reason;
		} else if (args.reason !== undefined || args.notes !== undefined) notes.push("Il motivo lo tengo solo per le altre assenze (lutto, congedo, 104): per ferie e permessi non serve.");
		if (args.protocol !== undefined && kind !== "malattia") notes.push("Il numero di protocollo vale solo per la malattia: non l'ho salvato.");
		return { absence: out as Omit<Absence, "id" | "callId" | "by" | "at">, notes };
	}

	/** The appointments of the person's resource the absence falls on: listed, with the offer to move them. */
	function appointmentsHit(p: Person, a: Pick<Absence, "from" | "to" | "half" | "start" | "end">, today: string): string[] {
		if (p.resource === undefined || options.appointments === undefined) return [];
		const ab = options.appointments.read();
		if (ab.broken) return ["Attenzione: gli appuntamenti non si leggono, quindi non so se l'assenza ne tocca qualcuno."];
		const span = spanOf(a);
		const last = a.to ?? addDays(today, 60);
		const hit = ab.appointments.filter((x) => x.status === "booked" && x.resource?.toLowerCase() === p.resource?.toLowerCase() && x.day >= a.from && x.day <= last && x.day >= today).filter((x) => {
			const s = Number(x.start.slice(0, 2)) * 60 + Number(x.start.slice(3, 5));
			return x.day !== a.from && x.day !== a.to ? span.from === 0 && span.to === 24 * 60 : s < span.to && span.from < s + x.minutes;
		});
		if (hit.length === 0) return [];
		return [`Attenzione: in quei giorni ${n1(hit.length, "c'è un appuntamento", "ci sono # appuntamenti")} con questa persona (nel riquadro). Vuoi che ${hit.length === 1 ? "lo sposti" : "li sposti"}? Dimmi a quando, o con chi, uno per uno.`, fencedStaff(hit.slice(0, STAFF_LIMITS.shown).map((x) => `${italianDate(x.day)} ${x.start} ${x.client.name} (rif. ${x.id})`).join("\n"))];
	}

	function leftWords(p: Person, b: StaffBook, at: Now, kind: AbsenceKind): string[] {
		if (kind !== "ferie" && kind !== "permesso") return [];
		const bal = balancesOf(p, b.absences, b.shifts, at.day, b.settings?.monthly === true, hours());
		const x = kind === "ferie" ? bal.ferie : bal.permessi;
		if (x.left === undefined) return [];
		return [`Con questa, ${kind === "ferie" ? `le ferie che restano sono circa ${decimalWords(x.left)} giorni` : `i permessi che restano sono circa ${hoursWords(x.left)} ore`}. ${ESTIMATE}`];
	}

	async function absence(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const mine = b.absences.find((a) => a.callId === ctx.callId);
		if (mine !== undefined) return { text: `Fatto: ho segnato ${absenceWords(mine)}.`, count: 1 };
		const refused = requirePersonFor(ctx, "segno l'assenza");
		if (refused !== undefined) return { text: refused, count: 0 };
		const whoP = personSaid(args.person, b.people);
		if (isAnswer(whoP)) return { text: whoP.answer, count: 0 };
		if (whoP.close === true) return { text: closeAsk(whoP.person), count: 0 };
		const p = whoP.person;
		const said = absenceSaid(args, p, at);
		if (typeof said === "string") return { text: said, count: 0 };
		const clash = b.absences.find((x) => isActive(x) && x.person === p.id && overlaps(x, said.absence));
		if (clash !== undefined) return { text: [`Non l'ho segnata: si sovrappone a un'assenza già segnata (${absenceWords(clash)}). Se è cambiata, cambia quella.`, fencedStaff(absenceRow(clash, p))].join("\n"), count: 0 };
		const by = marker(ctx);
		await ctx.step("absence", async () => {
			store.update(ctx.callId, (state) => {
				if (state.absences.length >= STAFF_LIMITS.absences) throw new StaffError("le assenze sono troppe per salvarne altre");
				const again = state.absences.find((x) => isActive(x) && x.person === p.id && overlaps(x, said.absence));
				if (again !== undefined) throw new StaffError("intanto è stata segnata un'altra assenza negli stessi giorni: non l'ho segnata");
				const made = { id: absenceId(state.nextAbsence), ...said.absence, callId: ctx.callId, ...by } as Absence;
				return { ...state, nextAbsence: state.nextAbsence + 1, absences: [...state.absences, made] };
			});
			return true;
		});
		const after = store.read();
		const saved = after.absences.find((x) => x.callId === ctx.callId) as Absence;
		const days = said.absence.kind === "ferie" ? [`Conto ${decimalWords(absenceDays(p, saved, saved.from, saved.to ?? saved.from, at.day))} giorni di ferie: i festivi e i suoi giorni di riposo non contano.`] : [];
		return {
			text: [`Fatto: ho segnato ${absenceWords(saved)} per la persona nel riquadro.`, fencedStaff(absenceRow(saved, p)), ...said.notes, ...days, ...leftWords(p, after, at, saved.kind), ...appointmentsHit(p, saved, at.day)].join("\n"),
			count: 1,
		};
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now, cancel: boolean): Promise<Answer> {
		const done = b.absences.find((a) => (cancel ? a.cancelled?.call : a.changed?.call) === ctx.callId);
		if (done !== undefined) return { text: cancel ? `Fatto: ho annullato ${absenceWords(done)}.` : `Fatto: ora è ${absenceWords(done)}.`, count: 1 };
		const refused = requirePersonFor(ctx, cancel ? "annullo l'assenza" : "cambio l'assenza");
		if (refused !== undefined) return { text: refused, count: 0 };
		const named = absenceNamed(args, b.absences, b.people, at.day);
		if (isAnswer(named)) return { text: named.answer, count: 0 };
		if (named.close === true) return { text: closeAsk(named.person), count: 0 };
		const a = named.absence;
		const by = marker(ctx);
		if (cancel) {
			await ctx.step("cancel", async () => {
				store.update(ctx.callId, (state) => ({ ...state, absences: state.absences.map((x) => (x.id === a.id && isActive(x) ? { ...x, cancelled: { ...by, call: ctx.callId } } : x)) }));
				return true;
			});
			return { text: [`Fatto: ho annullato ${absenceWords(a)} della persona nel riquadro. Resta nello storico come annullata.`, fencedStaff(named.person.name)].join("\n"), count: 1 };
		}
		const said = absenceSaid(args, named.person, at, a);
		if (typeof said === "string") return { text: said, count: 0 };
		const clash = b.absences.find((x) => x.id !== a.id && isActive(x) && x.person === a.person && overlaps(x, said.absence));
		if (clash !== undefined) return { text: [`Non l'ho cambiata: si sovrapporrebbe a un'altra assenza già segnata (${absenceWords(clash)}).`, fencedStaff(absenceRow(clash, named.person))].join("\n"), count: 0 };
		await ctx.step("change", async () => {
			store.update(ctx.callId, (state) => {
				const again = state.absences.find((x) => x.id !== a.id && isActive(x) && x.person === a.person && overlaps(x, said.absence));
				if (again !== undefined) throw new StaffError("intanto è stata segnata un'altra assenza negli stessi giorni: non l'ho cambiata");
				return { ...state, absences: state.absences.map((x) => (x.id === a.id ? ({ id: x.id, ...said.absence, callId: x.callId, by: x.by, at: x.at, changed: { ...by, call: ctx.callId } } as Absence) : x)) };
			});
			return true;
		});
		const saved = store.read().absences.find((x) => x.id === a.id) as Absence;
		return { text: [`Fatto: ora è ${absenceWords(saved)}, per la persona nel riquadro.`, fencedStaff(absenceRow(saved, named.person)), ...said.notes, ...appointmentsHit(named.person, saved, at.day)].join("\n"), count: 1 };
	}

	async function extra(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const refused = requirePersonFor(ctx, "segno le ore in più");
		if (refused !== undefined) return { text: refused, count: 0 };
		const whoP = personSaid(args.person, b.people);
		if (isAnswer(whoP)) return { text: whoP.answer, count: 0 };
		if (whoP.close === true) return { text: closeAsk(whoP.person), count: 0 };
		const day = staffDay(args.date ?? "oggi", at.day);
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		if (day > at.day) return { text: "Errore: le ore in più si segnano quando sono fatte: dimmi un giorno passato o oggi.", count: 0 };
		const minutes = minutesOfHours(args.hours);
		if (isAnswer(minutes)) return { text: minutes.answer, count: 0 };
		if (minutes > STAFF_LIMITS.extraMinutes) return { text: "Errore: sono troppe ore in più per un giorno solo.", count: 0 };
		const by = marker(ctx);
		await ctx.step("extra", async () => {
			store.update(ctx.callId, (state) => {
				if (state.extras.length >= STAFF_LIMITS.extras) throw new StaffError("le ore in più segnate sono troppe per salvarne altre");
				return { ...state, extras: [...state.extras, { person: whoP.person.id, day, minutes, callId: ctx.callId, ...by }] };
			});
			return true;
		});
		return { text: [`Fatto: ho segnato ${hoursWords(minutes)} ${minutes === 60 ? "ora" : "ore"} in più ${dayWords(day, at.day)} per la persona nel riquadro. Vanno nel riepilogo del mese per la consulente.`, fencedStaff(whoP.person.name)].join("\n"), count: 1 };
	}

	async function shift(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const refused = requirePersonFor(ctx, "cambio i turni");
		if (refused !== undefined) return { text: refused, count: 0 };
		const whoP = personSaid(args.person, b.people);
		if (isAnswer(whoP)) return { text: whoP.answer, count: 0 };
		if (whoP.close === true) return { text: closeAsk(whoP.person), count: 0 };
		const day = staffDay(args.date, at.day);
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		const h = dayHours(args.hours);
		if (isAnswer(h)) return { text: h.answer, count: 0 };
		const by = marker(ctx);
		await ctx.step("shift", async () => {
			store.update(ctx.callId, (state) => {
				const rest = state.shifts.filter((s) => !(s.person === whoP.person.id && s.day === day));
				if (rest.length >= STAFF_LIMITS.shifts) throw new StaffError("i turni cambiati sono troppi per salvarne altri");
				return { ...state, shifts: [...rest, { person: whoP.person.id, day, hours: h, ...by }] };
			});
			return true;
		});
		const spans = h.map((o) => ({ from: Number(o.from.slice(0, 2)) * 60 + Number(o.from.slice(3)), to: o.to === "24:00" ? 1440 : Number(o.to.slice(0, 2)) * 60 + Number(o.to.slice(3)) }));
		return { text: [`Fatto: ${dayWords(day, at.day)} la persona nel riquadro ${h.length === 0 ? "è di riposo" : `lavora ${spansWords(spans)}`}, al posto dell'orario di solito.`, fencedStaff(whoP.person.name)].join("\n"), count: 1 };
	}

	function gapWords(gaps: readonly Span[]): string {
		return gaps.length === 0 ? "" : `; scoperto ${spansWords(gaps)}`;
	}

	function whoOn(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		const day = staffDay(args.date ?? "oggi", at.day);
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		const d = dayOf(data(b), day);
		const when = capital(dayWords(day, at.day));
		if (d.closed) return { text: `${when} sei chiuso${d.holiday === undefined ? "" : ` (${d.holiday})`}: non lavora nessuno, salvo turni detti a parte.`, count: 0 };
		const on = d.people.filter((p) => p.hours.length > 0);
		const off = d.people.filter((p) => p.off !== undefined);
		const gaps = coverageGaps(data(b), day);
		const head = `${when} ${on.length === 0 ? "non lavora nessuno" : `${n1(on.length, "lavora una persona", "lavorano # persone")}`}${off.length === 0 ? "" : `, ${n1(off.length, "una è assente", "# sono assenti")}`}${gapWords(gaps)}. Chi e quando è nel riquadro.`;
		return { text: [head, fencedStaff(d.people.filter((p) => p.hours.length > 0 || p.off !== undefined).map(personDayRow).join("\n") || "nessuno")].join("\n"), count: on.length };
	}

	function weekDays(args: Record<string, unknown>, at: Now): string[] | string {
		const day = args.date === undefined ? addDays(mondayOf(at.day), 7) : staffDay(args.date, at.day);
		if (isAnswer(day)) return day.answer;
		const monday = mondayOf(day);
		return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
	}

	function shifts(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		if (b.people.length === 0) return { text: "Non ho ancora nessuno del personale: dimmi chi lavora con te, con il suo orario di solito.", count: 0 };
		const days = weekDays(args, at);
		if (typeof days === "string") return { text: days, count: 0 };
		const lines: string[] = [];
		const rows: string[] = [];
		let gapsAll = 0;
		for (const day of days) {
			const d = dayOf(data(b), day);
			const gaps = coverageGaps(data(b), day);
			gapsAll += gaps.length;
			const on = d.people.filter((p) => p.hours.length > 0).length;
			const off = d.people.filter((p) => p.off !== undefined).length;
			lines.push(`• ${capital(plainDay(day, at.day))}: ${d.closed ? "chiuso" : `${n1(on, "una persona al lavoro", "# persone al lavoro")}${off === 0 ? "" : `, ${n1(off, "un'assenza", "# assenze")}`}${gapWords(gaps)}`}`);
			if (!d.closed) rows.push(`${capital(plainDay(day, at.day))}: ${d.people.map(personDayRow).join("; ")}`);
		}
		const hoursNote = hours()?.week === undefined ? ["Non conosco gli orari di apertura (sono nelle impostazioni degli appuntamenti), quindi non vedo le ore scoperte."] : gapsAll > 0 ? ["Nelle ore scoperte il negozio è aperto e non c'è nessuno: vuoi cambiare un turno?"] : [];
		return { text: [`I turni dal ${italianDate(days[0] as string)} al ${italianDate(days[6] as string)}, dall'orario di solito meno le assenze e le chiusure:`, ...lines, "Chi e quando è nel riquadro.", fencedStaff(rows.join("\n")), ...hoursNote, "Se vuoi il file (PDF, Word o CSV), lo preparo in personale/."].join("\n"), count: days.length };
	}

	function balanceLine(p: Person, b: StaffBook, at: Now): string {
		const bal = balancesOf(p, b.absences, b.shifts, at.day, b.settings?.monthly === true, hours());
		const part = (x: Balance, unit: (n: number) => string, what: string, yearly: string | undefined) =>
			x.left === undefined ? `${what}: ${unit(x.taken)} prese${x.planned > 0 ? `, ${unit(x.planned)} in programma` : ""} (quante gliene spettano non lo so)` : `${what}: ne restano circa ${unit(x.left)} (${bal.fromOpening ? "dal saldo che mi hai detto" : `${yearly ?? "?"} l'anno${bal.monthly ? ", maturate fin qui" : ""}`}; ${unit(x.taken)} prese, ${unit(x.planned)} in programma)`;
		return `${p.name}: ${part(bal.ferie, (n) => `${decimalWords(n)} giorni`, "ferie", p.ferieDays === undefined ? undefined : `${decimalWords(Math.round(Number(p.ferieDays) * 100))} giorni`)}; ${part(bal.permessi, (n) => `${hoursWords(n)} ore`, "permessi", p.rolHours === undefined ? undefined : `${decimalWords(Math.round(Number(p.rolHours) * 100))} ore`)}`;
	}

	function balance(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		let list = b.people;
		if (args.person !== undefined) {
			const w = personSaid(args.person, b.people);
			if (isAnswer(w)) return { text: w.answer, count: 0 };
			if (w.close === true) return { text: closeAsk(w.person), count: 0 };
			list = [w.person];
		}
		if (list.length === 0) return { text: "Non ho ancora nessuno del personale.", count: 0 };
		const how = b.settings?.monthly === true ? "maturazione mese per mese" : "saldo annuo, senza maturazione mensile";
		return { text: [`Ferie e permessi del ${at.day.slice(0, 4)}, nel riquadro (${how}; senza i residui degli anni prima, se non me li hai detti). ${ESTIMATE}`, fencedStaff(list.map((p) => balanceLine(p, b, at)).join("\n"))].join("\n"), count: list.length };
	}

	function absences(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		let from = at.day;
		let to = addDays(at.day, 366);
		let label = "da oggi in poi";
		if (args.period !== undefined) {
			try {
				const p = readPeriod(String(args.period), at.day, { ahead: true });
				from = p.from;
				to = p.to;
				label = p.label;
			} catch (error) {
				if (error instanceof PeriodError) return { text: `Errore: ${error.message}.`, count: 0 };
				throw error;
			}
		}
		let list = b.absences.filter((a) => isActive(a) && a.from <= to && (a.to ?? "9999-12-31") >= from);
		if (args.person !== undefined) {
			const w = personSaid(args.person, b.people);
			if (isAnswer(w)) return { text: w.answer, count: 0 };
			list = list.filter((a) => a.person === w.person.id);
		}
		if (args.kind !== undefined && KINDS.includes(args.kind as AbsenceKind)) list = list.filter((a) => a.kind === args.kind);
		if (list.length === 0) return { text: `Nessuna assenza segnata, ${label}.`, count: 0 };
		list = [...list].sort((a, b2) => a.from.localeCompare(b2.from));
		return { text: [`${n1(list.length, "Un'assenza", "# assenze")}, ${label}: chi e quando nel riquadro.`, fencedStaff(list.slice(0, STAFF_LIMITS.shown).map((a) => absenceRow(a, b.people.find((p) => p.id === a.person))).join("\n"))].join("\n"), count: list.length };
	}

	function monthOf(args: Record<string, unknown>, at: Now): { from: string; label: string } | string {
		try {
			const p = readPeriod(String(args.month ?? "mese scorso"), at.day);
			if (p.kind !== "month") return "Errore: il riepilogo è di un mese: dimmi quale, come «ottobre».";
			return { from: p.from, label: p.label };
		} catch (error) {
			if (error instanceof PeriodError) return `Errore: ${error.message}.`;
			throw error;
		}
	}

	function summary(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		if (b.people.length === 0) return { text: "Non ho ancora nessuno del personale.", count: 0 };
		const m = monthOf(args, at);
		if (typeof m === "string") return { text: m, count: 0 };
		const rows = monthRows(data(b), b.extras, m.from, at.day);
		return {
			text: [`Il riepilogo di ${m.label} per la consulente del lavoro, persona per persona, nel riquadro: giorni e ore dai turni meno le assenze, ferie, permessi, malattia (in giorni di calendario) e le ore in più che mi hai detto. ${ESTIMATE}`, fencedStaff(rows.map(monthRow).join("\n")), "Se vuoi, preparo il file (CSV e PDF, o Word) in personale/; poi, se me lo chiedi, la mail alla consulente con google_mail_send, che parte solo dopo la tua approvazione."].join("\n"),
			count: rows.length,
		};
	}

	async function exportFile(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const what = args.what ?? "shifts";
		if (what !== "shifts" && what !== "summary") return { text: "Errore: il file è dei turni o del riepilogo del mese.", count: 0 };
		const format = args.format ?? (what === "summary" ? "pdf" : "pdf");
		if (format !== "pdf" && format !== "docx" && format !== "csv") return { text: "Errore: il file è PDF, Word o CSV.", count: 0 };
		const refused = requirePersonFor(ctx, "preparo il file del personale");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (b.people.length === 0) return { text: "Non ho ancora nessuno del personale.", count: 0 };
		const business = hours()?.business;
		const files: { stem: string; ext: string; body: () => Promise<Uint8Array | string> }[] = [];
		if (what === "shifts") {
			const days = weekDays(args, at);
			if (typeof days === "string") return { text: days, count: 0 };
			const week = days.map((day) => ({ day, ...dayOf(data(b), day), gaps: coverageGaps(data(b), day) }));
			const stem = `personale/turni-dal-${days[0]}`;
			if (format === "csv") files.push({ stem, ext: ".csv", body: async () => shiftsCsv(week) });
			else files.push({ stem, ext: `.${format}`, body: async () => (await make({ format, text: shiftsMarkdown(week, business, at.day), name: "Turni", pictures: [], now: now().getTime() })).data });
		} else {
			const m = monthOf(args, at);
			if (typeof m === "string") return { text: m, count: 0 };
			const rows = monthRows(data(b), b.extras, m.from, at.day);
			const stem = `personale/riepilogo-${m.from.slice(0, 7)}`;
			files.push({ stem, ext: ".csv", body: async () => monthCsv(rows) });
			if (format !== "csv") files.push({ stem, ext: `.${format}`, body: async () => (await make({ format, text: monthMarkdown(rows, m.label, business), name: "Riepilogo del personale", pictures: [], now: now().getTime() })).data });
		}
		try {
			const written: string[] = [];
			for (const [i, f] of files.entries()) {
				const path = await ctx.step(`path-${i}`, async () => freePath(workspace, f.stem, f.ext));
				written.push(await ctx.step(`write-${i}`, async () => (await workspace.write(path, await f.body())).path));
			}
			const mail = what === "summary" ? " Per mandarlo alla consulente del lavoro posso preparare la mail con google_mail_send, con il file in allegato: parte solo dopo la tua approvazione." : "";
			return { text: [`Ecco ${what === "summary" ? "il riepilogo del mese" : "i turni della settimana"}: ${written.length === 1 ? "il file è" : "i file sono"} nel riquadro. Non l'ho mandato a nessuno; se vuoi te lo mando qui con file_send.${mail}`, fencedStaff(written.join("\n"))].join("\n"), count: written.length };
		} catch (error) {
			if (error instanceof WorkspaceError || error instanceof DocumentError) return { text: `Errore: non sono riuscita a fare il file (${error.message}).`, count: 0 };
			throw error;
		}
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook): Promise<Answer> {
		const words = (s: StaffSettings | undefined) => `Ferie e permessi: ${s?.monthly === true ? "maturano mese per mese" : "saldo annuo, senza maturazione mensile"}.`;
		if (args.monthly === undefined) return { text: words(b.settings), count: 0 };
		if (typeof args.monthly !== "boolean") return { text: "Errore: la maturazione mensile è sì o no.", count: 0 };
		const refused = requirePersonFor(ctx, "cambio le impostazioni del personale");
		if (refused !== undefined) return { text: refused, count: 0 };
		const by = marker(ctx);
		await ctx.step("settings", async () => {
			store.update(ctx.callId, (state) => ({ ...state, settings: { ...(args.monthly === true ? { monthly: true as const } : {}), ...by } }));
			return true;
		});
		return { text: `Fatto, ho salvato. ${words(store.read().settings)}`, count: 1 };
	}

	/** The brief's line, once a day: who is off today and tomorrow, absences starting this week, tomorrow's gaps. */
	async function brief(ctx: ToolContext, b: StaffBook, at: Now): Promise<string> {
		if (b.people.length === 0) return BRIEF_NOTHING;
		const said = await ctx.step("brief-claim", async () => store.claim(ctx.callId, at.day, ["day"]));
		if (!said.includes("day")) return BRIEF_NOTHING;
		const tomorrow = addDays(at.day, 1);
		const today = offOn(b, at.day);
		const next = offOn(b, tomorrow);
		const sunday = addDays(mondayOf(at.day), 6);
		const starting = b.absences.filter((a) => isActive(a) && a.from > tomorrow && a.from <= sunday);
		const gaps = coverageGaps(data(b), tomorrow);
		if (today.length + next.length + starting.length + gaps.length === 0) return BRIEF_NOTHING;
		const rows = [
			...today.map((p) => `Oggi: ${personDayRow(p)}`),
			...next.map((p) => `Domani: ${personDayRow(p)}`),
			...starting.map((a) => `In settimana: ${absenceRow(a, b.people.find((p) => p.id === a.person))}`),
		];
		const parts = [`oggi ${n1(today.length, "un assente", "# assenti")}`, `domani ${n1(next.length, "un assente", "# assenti")}`, ...(starting.length === 0 ? [] : [`${n1(starting.length, "un'assenza comincia", "# assenze cominciano")} più avanti in settimana`])];
		await audit(ctx, "brief", rows.length);
		return [`Personale: ${parts.join(", ")}${gaps.length === 0 ? "" : `; domani scoperto ${spansWords(gaps)}`}.`, ...(rows.length === 0 ? [] : [fencedStaff(rows.join("\n"))])].join("\n");
	}

	async function run(op: StaffOp, args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		switch (op) {
			case "person":
				return person(args, ctx, b, at);
			case "absence":
				return absence(args, ctx, b, at);
			case "change":
				return change(args, ctx, b, at, false);
			case "cancel":
				return change(args, ctx, b, at, true);
			case "extra":
				return extra(args, ctx, b, at);
			case "shift":
				return shift(args, ctx, b, at);
			case "who":
				return whoOn(args, b, at);
			case "shifts":
				return shifts(args, b, at);
			case "balance":
				return balance(args, b, at);
			case "absences":
				return absences(args, b, at);
			case "summary":
				return summary(args, b, at);
			case "export":
				return exportFile(args, ctx, b, at);
			case "settings":
				return settings(args, ctx, b);
		}
	}

	return [
		{
			name: "staff",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...STAFF_OPS] },
					person: text(STAFF_LIMITS.name, "the person as said (a name, a first name), or PE-0001; person: the full name of a new one"),
					kind: { type: "string", enum: [...KINDS], description: "absence: ferie, permesso, malattia, altro (lutto, congedo, 104); absences: only this kind" },
					from: text(40, "absence, change: the first day («domani», «3 agosto», «da oggi»); permesso: its day"),
					to: text(40, "absence, change: the last day (a malattia only when said)"),
					half: { type: "string", enum: [...HALVES], description: "absence: ferie of half a day" },
					start: text(20, "absence permesso: from what time («15»)"),
					end: text(20, "absence permesso: to what time (default the end of the shift)"),
					protocol: text(60, "absence malattia: the INPS certificate's protocol number only, when said; never a diagnosis"),
					reason: text(STAFF_LIMITS.reason, "absence altro: why (lutto, congedo, 104)"),
					absence: text(10, "change, cancel: the reference AS-0001 (never said to the person)"),
					on: text(40, "change, cancel: a day of the absence"),
					date: text(40, "who: the day (default today); shifts, export: a day of the week (default next week); shift: the day; extra: the day (default today)"),
					hours: { type: ["string", "number"], description: "extra: how many hours («2», «1,5», «45 minuti»); shift: the day's hours («9-13 e 15-19», «riposo»)" },
					period: text(40, "absences: «agosto», «questo mese»; default from today on"),
					month: text(40, "summary, export summary: the month («ottobre»; default last month)"),
					what: { type: "string", enum: ["shifts", "summary"], description: "export: the week of shifts, or the month's summary" },
					format: { type: "string", enum: ["pdf", "docx", "csv"], description: "export: the file (summary: the CSV always, plus PDF or Word)" },
					role: text(STAFF_LIMITS.role, "person: the role («commessa»)"),
					weekly_hours: { type: ["string", "number"], description: "person: contract hours a week" },
					week: text(200, "person: the usual hours in one line («lun-ven 9-13 e 14-18; sab 9-13»)"),
					ferie_days: { type: ["string", "number"], description: "person: ferie days a year" },
					rol_hours: { type: ["string", "number"], description: "person: permessi/ROL hours a year" },
					ferie_left: { type: ["string", "number"], description: "person: ferie days left, as the owner says" },
					rol_left: { type: ["string", "number"], description: "person: permessi hours left, as the owner says" },
					as_of: text(40, "person: the day of that balance (default today)"),
					resource: text(STAFF_LIMITS.resource, "person: the resource of the appointments this person is"),
					monthly: { type: "boolean", description: "settings: ferie and permessi accrue month by month" },
					compact: { type: "boolean", description: "who: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!STAFF_OPS.includes(args.op as StaffOp)) return "Errore: non conosco questa operazione sul personale.";
				const op = args.op as StaffOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				const at = localNow(timeZone, now());
				try {
					const b = store.read();
					if (b.broken) return op === "who" && args.compact === true ? BRIEF_BROKEN : `Errore: ${STAFF_BROKEN}.`;
					// Staff data: another agente gets counts only, never names or kinds.
					if (isAgentTurn(ctx)) return agentCounts(b, at);
					if (op === "who" && args.compact === true) return await brief(ctx, b, at);
					const answer = await run(op, args, ctx, b, at);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof StaffError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}
