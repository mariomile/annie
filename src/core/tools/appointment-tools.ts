/**
 * The tool `appointments`: gli appuntamenti of a service business (parrucchiere, estetista,
 * studio, officina, consulente). Booked when the business is open, inside its hours, not over
 * another appointment of the same resource: on a clash the nearest free times are proposed and
 * nothing is booked; a client or a service only close to what was said, or a service whose
 * duration is not known (30 minutes taken), is proposed with a check first. Moved, disdetto, non
 * presentato and fatto only on the person's own word; nothing is deleted. The free times, the day
 * or the week, a client's history, the reminder texts for tomorrow (never sent by Annie), the
 * settings (hours, closures, resources, how long each service lasts), the CSV. The brief's line
 * once a day. Billing is sales_invoices' (sales-appointments.ts). Another agente gets counts
 * only; the audit only the op and a count. Clients, services, notes, contacts: in the fence.
 */
import { createHash } from "node:crypto";
import { type Appointment, APPOINTMENT_LIMITS, AppointmentError, type AppointmentSettings, appointmentId, type BookedService, DEFAULT_MINUTES, endOf, minutesOf, timeOf } from "../appointments.ts";
import { fits, type FitInput, freeSlots, gapsOf, localNow, nearestFree, openOn } from "../appointment-slots.ts";
import { APPOINTMENTS_BROKEN, type AppointmentBook, type AppointmentStore } from "../appointment-store.ts";
import type { ClientStore } from "../client-store.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { addDays, daysBetween } from "../italian-calendar.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import type { PriceListStore } from "../price-list-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { appointmentNamed, clientSaid, daySaid, isAnswer, minutesSaid, resourceSaid, servicesSaid, timeSaid, windowSaid } from "./appointment-input.ts";
import { appointmentRow, appointmentsCsv, closedWords, dayWords, fencedAppointments, reminderText, servicesWords, spanWords, whenWords } from "./appointment-render.ts";
import { settingsSaid, settingsWords } from "./appointment-settings.ts";

export const APPOINTMENT_OPS = ["book", "move", "cancel", "no_show", "done", "free_slots", "agenda", "history", "reminders", "settings", "export"] as const;
export type AppointmentOp = (typeof APPOINTMENT_OPS)[number];

/** What was done, for the audit: the op and how many, never clients, services or times. */
export type AppointmentEvent = { readonly type: "appointments.used"; readonly op: AppointmentOp | "brief"; readonly count: number };

export type AppointmentToolsOptions = {
	readonly workspace: Workspace;
	readonly store: AppointmentStore;
	readonly clients?: Pick<ClientStore, "read">;
	readonly priceList?: Pick<PriceListStore, "read">;
	/** The business's time zone (Europe/Rome): today, and the hour already gone. */
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: AppointmentEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Gli appuntamenti dei clienti di un'attività di servizi (parrucchiere, estetista, studio, officina, consulente): chi viene, per cosa, quando, con quale risorsa (una persona, una poltrona, un ponte). Not the fiscal deadlines (fiscal_agenda), not the board's scadenze, not Annie's own reminders (schedule_create), not the person's Google calendar (google_calendar_events).",
	"What the person says → op: «fissa la signora Rossi giovedì alle 15 per taglio e piega» → book with client, services [as said], date, time (resource, notes, minutes when said). When Annie is not sure of the client, of a service, or does not know how long a service lasts, book shows the proposal with a check: show it, and only after the person's yes repeat with confirm true and that check. On a clash or when closed, book books nothing and gives the nearest free times: offer those. After a booking, offer google_calendar_create with the start and end in the fence (it asks its own yes); never sync by yourself.",
	"«sposta Rossi a venerdì stessa ora» → move with client and date (time only when said: otherwise the same); «Rossi ha disdetto» → cancel; «Rossi non si è presentata» → no_show; «Rossi è fatta», «segna fatti tutti quelli di oggi» → done (all true with date); these only on the person's own word. «quando ho un'ora libera giovedì pomeriggio?» → free_slots with date, window, minutes (or services); «cosa ho domani?», «la settimana» → agenda with date (week true); «com'è andata con Rossi?», «cosa fa di solito Bianchi?» → history with client.",
	"«fammi il messaggio di promemoria per gli appuntamenti di domani» → reminders (date default tomorrow): the texts and the contacts from the cards are in the fence; Annie never sends them: offer google_mail_send as a draft (or sent after the person's yes) for who has an email; the others the person copies. «fattura gli appuntamenti fatti da Bianchi questo mese» is sales_invoices (draft with customer, appointments true, period), not this tool. «siamo aperti mar-sab 9-13 e 14:30-19», «chiusi dal 10 al 20 agosto», «il taglio dura 30 minuti», «le poltrone sono Marco e Giulia» → settings. «fammi il file degli appuntamenti» → export, then file_send. summary of the brief: agenda with compact true.",
	"Never say an appointment's reference (AP-…) to the person: name it by its client and time. Times are as said: «alle 3» is read as 15:00 and said.",
].join(" ");

const AGENT_REFUSAL = "Gli appuntamenti dicono clienti, servizi e orari: a un altro agente do solo quanti sono. Li fissa e li cambia chi ti scrive, nella sua conversazione.";
const BRIEF_NOTHING = "Appuntamenti: niente da segnalare.";
const READ_OPS: readonly AppointmentOp[] = ["agenda", "free_slots", "history", "reminders"];

type Answer = { text: string; count: number };
type Now = { readonly day: string; readonly minutes: number };

/** A booking as proposed: what the check is given on. */
type Proposed = { readonly client: Appointment["client"]; readonly services: readonly BookedService[]; readonly day: string; readonly start: string; readonly minutes: number; readonly resource?: string; readonly notes?: string };

const capital = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
const clientKey = (c: Appointment["client"]) => c.card ?? `n:${spellingKey(c.name)}`;
const byTime = (a: Appointment, b: Appointment) => a.day.localeCompare(b.day) || minutesOf(a.start) - minutesOf(b.start);
const started = (a: Appointment, now: Now) => a.day < now.day || (a.day === now.day && minutesOf(a.start) <= now.minutes);

/** The services with the duration said: one takes it all; with more, the last takes what the others leave. */
function withMinutes(services: readonly BookedService[], total: number): BookedService[] | string {
	if (services.length === 1) return [{ ...(services[0] as BookedService), minutes: total }];
	const before = services.slice(0, -1).reduce((n, s) => n + s.minutes, 0);
	if (total - before < 5) return "Errore: con più servizi, la durata detta è meno di quanto durano gli altri: dimmi la durata di tutto l'appuntamento, o fissali a parte.";
	return [...services.slice(0, -1), { ...(services.at(-1) as BookedService), minutes: total - before }];
}

/** «giovedì 22 ottobre alle 14:30, …»: the free times proposed; with resources, each with its own (in the fence). */
function proposalsText(list: readonly { day: string; start: number; resource?: string }[], today: string): string[] {
	if (list.length === 0) return ["Nei prossimi 14 giorni non trovo un orario libero così: dimmi un altro giorno."];
	if (list.every((p) => p.resource === undefined)) return [`Gli orari liberi più vicini: ${list.map((p) => whenWords(p.day, timeOf(p.start), today)).join("; ")}. Chiedi a chi ti scrive quale preferisce.`];
	return ["Gli orari liberi più vicini sono nel riquadro, ognuno con la sua risorsa. Chiedi a chi ti scrive quale preferisce.", fencedAppointments(list.map((p) => `• ${whenWords(p.day, timeOf(p.start), today)} (${p.resource ?? ""})`).join("\n"))];
}

/** Start times on the step, «alle 14:00, tra le 16:00 e le 18:00». */
function startsWords(starts: readonly number[], step: number): string {
	const runs: [number, number][] = [];
	for (const s of [...starts].sort((a, b) => a - b)) {
		const last = runs.at(-1);
		if (last !== undefined && s - last[1] === step) last[1] = s;
		else runs.push([s, s]);
	}
	return runs.map(([a, b]) => (a === b ? `alle ${timeOf(a)}` : `tra le ${timeOf(a)} e le ${timeOf(b)}`)).join(", ");
}

export function createAppointmentTools(options: AppointmentToolsOptions): AnnieTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "annie" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: AppointmentEvent["op"], count: number) => {
		await ctx.step(`audit-${op}`, async () => {
			await options.record?.({ type: "appointments.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const cards = () => {
		const b = options.clients?.read();
		return b === undefined || b.broken ? [] : b.cards;
	};
	const voci = () => {
		const b = options.priceList?.read();
		return b === undefined || b.broken ? [] : b.items;
	};

	const checkOf = (p: Proposed) => createHash("sha256").update(JSON.stringify([p.client, p.services, p.day, p.start, p.minutes, p.resource ?? "", p.notes ?? ""])).digest("hex").slice(0, 16);

	/** Why it does not fit, and the nearest free times: nothing is booked. */
	function refusal(fit: Exclude<ReturnType<typeof fits>, { ok: true }>, input: FitInput, today: string): string {
		if (fit.why === "past") return "Errore: quell'ora è già passata: dimmi un altro giorno o un'altra ora.";
		const head =
			fit.why === "closed"
				? `${capital(closedWords(fit.open ?? openOn(input.settings, input.day), input.day))}: non ho fissato niente.`
				: fit.why === "outside"
					? `A quell'ora sei chiuso (${dayWords(input.day, today)} sei aperto ${(fit.open?.spans ?? []).map(spanWords).join(" e ")}): non ho fissato niente.`
					: `A quell'ora c'è già un appuntamento${(input.settings?.resources ?? []).length > 0 ? " per ogni risorsa che può farlo" : ""}: non ho fissato niente.`;
		return [head, ...proposalsText(nearestFree(input), today)].join("\n");
	}

	function bookedAnswer(a: Appointment, today: string, notes: readonly string[]): string {
		return [
			`Fatto: ho fissato l'appuntamento ${dayWords(a.day, today)} dalle ${a.start} alle ${endOf(a)}. Chi e per cosa è nel riquadro.`,
			fencedAppointments([appointmentRow(a), `Per il calendario: inizio ${a.day}T${a.start}, fine ${a.day}T${endOf(a)} (${timeZone})`].join("\n")),
			...notes,
			"Se chi ti scrive lo vuole anche nel suo calendario Google, posso aggiungerlo con google_calendar_create (inizio e fine del riquadro): lo chiede lui.",
		].join("\n");
	}

	async function book(args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const today = at.day;
		const settings = b.settings;
		const client = clientSaid(args.client, cards(), b.appointments);
		if (isAnswer(client)) return { text: client.answer, count: 0 };
		const sv = servicesSaid(args.services, settings, voci());
		if (isAnswer(sv)) return { text: sv.answer, count: 0 };
		const said = minutesSaid(args.minutes);
		if (isAnswer(said)) return { text: said.answer, count: 0 };
		let services: readonly BookedService[] = sv.services;
		let assumed = sv.assumed;
		if (said !== undefined) {
			const w = withMinutes(services, said);
			if (typeof w === "string") return { text: w, count: 0 };
			services = w;
			assumed = [];
		}
		const minutes = services.reduce((n, s) => n + s.minutes, 0);
		if (args.date === undefined) return { text: "Errore: dimmi il giorno dell'appuntamento. Per vedere quando è libero, chiedimi gli orari liberi.", count: 0 };
		if (args.time === undefined) return { text: "Errore: dimmi a che ora. Per vedere quando è libero, chiedimi gli orari liberi.", count: 0 };
		const day = daySaid(args.date, today);
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		const time = timeSaid(args.time);
		if (isAnswer(time)) return { text: time.answer, count: 0 };
		const resource = resourceSaid(args.resource, settings);
		if (isAnswer(resource)) return { text: resource.answer, count: 0 };
		const notes = cleanText(args.notes, APPOINTMENT_LIMITS.notes, "le note", true);
		if (isProblem(notes)) return { text: `Errore: ${notes.problem}.`, count: 0 };
		if (time.minutes + minutes > 24 * 60) return { text: "Errore: l'appuntamento finirebbe dopo mezzanotte: dimmi un'ora prima.", count: 0 };
		const input: FitInput = { settings, appointments: b.appointments, day, start: time.minutes, minutes, ...(resource === undefined ? {} : { resource }), ...(sv.needs === undefined ? {} : { needs: sv.needs }), now: at };
		const fit = fits(input);
		if (!fit.ok) return { text: [refusal(fit, input, today), ...(time.note === undefined ? [] : [time.note])].join("\n"), count: 0 };
		const p: Proposed = { client: client.client, services, day, start: timeOf(time.minutes), minutes, ...(fit.resource === undefined ? {} : { resource: fit.resource }), ...(notes === undefined ? {} : { notes }) };
		const why: string[] = [];
		if (client.close === true) why.push("il cliente l'ho preso dalla scheda con il nome più vicino a come è stato detto");
		if (sv.guess.length > 0) why.push(n1(sv.guess.length, "un servizio l'ho preso dalla voce del listino più vicina a come è stato detto", "# servizi li ho presi dalle voci del listino più vicine a come sono stati detti"));
		if (assumed.length > 0) why.push(`non so quanto ${n1(assumed.length, "dura un servizio: ho contato", "durano # servizi: ho contato")} ${DEFAULT_MINUTES} minuti (si può dire la durata, e la salvo per le prossime volte)`);
		const extra = [...(time.note === undefined ? [] : [time.note]), ...(settings?.week === undefined ? ["Non so ancora gli orari di apertura: non ho potuto controllare che tu sia aperto. Dimmeli e li salvo."] : [])];
		if (why.length > 0 && args.confirm !== true) {
			const preview: Appointment = { id: "AP-0000", status: "booked", ...p, callId: "x", by: "x", at: "x" };
			return {
				text: [`Fisserei questo appuntamento, ${dayWords(day, today)} dalle ${p.start} alle ${endOf(p)}, come nel riquadro. Controlla con chi ti scrive: ${why.join("; ")}.`, fencedAppointments(appointmentRow(preview).replace(/ \(rif\. AP-0000\)$/, "")), ...extra, `Va bene così? Se chi ti scrive dice di sì, ripeti con la conferma e il controllo ${checkOf(p)}.`].join("\n"),
				count: 0,
			};
		}
		const refused = requirePersonFor(ctx, "fisso l'appuntamento");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (why.length > 0) {
			const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
			if (check === undefined || !/^[0-9a-f]{16}$/.test(check)) return { text: "Errore: per fissare l'appuntamento serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.", count: 0 };
			if (checkOf(p) !== check) return { text: "Errore: la proposta è cambiata da quando l'hai mostrata: non ho fissato niente. Chiedi di nuovo la proposta.", count: 0 };
		}
		const by = marker(ctx);
		const id = await ctx.step("book", async () => {
			store.update(ctx.callId, (state) => {
				if (state.appointments.length >= APPOINTMENT_LIMITS.appointments) throw new AppointmentError("gli appuntamenti sono troppi per salvarne altri");
				// Under the lock: another booking in between takes the time first.
				const again = fits({ ...input, appointments: state.appointments, ...(p.resource === undefined ? {} : { resource: p.resource }) });
				if (!again.ok) throw new AppointmentError("intanto quell'ora è stata presa da un altro appuntamento: non ho fissato niente. Chiedimi di nuovo gli orari liberi");
				const made: Appointment = { id: appointmentId(state.nextAppointment), status: "booked", ...p, callId: ctx.callId, ...by };
				return { ...state, nextAppointment: state.nextAppointment + 1, appointments: [...state.appointments, made] };
			});
			return store.read().appointments.find((a) => a.callId === ctx.callId)?.id ?? "";
		});
		const made = store.read().appointments.find((a) => a.id === id);
		if (made === undefined) return { text: "Errore: l'appuntamento non risulta salvato.", count: 0 };
		const notes_ = [...(client.fresh === true ? ["Il cliente non è tra le schede né tra gli appuntamenti: l'ho scritto come detto. Se vuoi, gli faccio la scheda con telefono ed email, per i promemoria."] : []), ...extra];
		return { text: bookedAnswer(made, today, notes_), count: 1 };
	}

	async function move(args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const refused = requirePersonFor(ctx, "sposto l'appuntamento");
		if (refused !== undefined) return { text: refused, count: 0 };
		const a = appointmentNamed(args, b.appointments, cards(), at.day, (x) => x.status === "booked");
		if (isAnswer(a)) return { text: a.answer, count: 0 };
		if (args.date === undefined && args.time === undefined && args.resource === undefined) return { text: "Errore: dimmi il giorno o l'ora nuovi.", count: 0 };
		const day = args.date === undefined ? a.day : daySaid(args.date, at.day);
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		const time = args.time === undefined ? { minutes: minutesOf(a.start) } : timeSaid(args.time);
		if (isAnswer(time)) return { text: time.answer, count: 0 };
		const resource = args.resource === undefined ? a.resource : resourceSaid(args.resource, b.settings);
		if (isAnswer(resource)) return { text: resource.answer, count: 0 };
		if (day === a.day && timeOf(time.minutes) === a.start && resource === a.resource) return { text: `L'appuntamento è già ${whenWords(a.day, a.start, at.day)}: non ho cambiato niente.`, count: 0 };
		if (time.minutes + a.minutes > 24 * 60) return { text: "Errore: l'appuntamento finirebbe dopo mezzanotte: dimmi un'ora prima.", count: 0 };
		const input: FitInput = { settings: b.settings, appointments: b.appointments, day, start: time.minutes, minutes: a.minutes, ...(resource === undefined ? {} : { resource }), except: a.id, now: at };
		const fit = fits(input);
		if (!fit.ok) return { text: [refusal(fit, input, at.day).replace("non ho fissato niente", "non l'ho spostato"), ...("note" in time && time.note !== undefined ? [time.note] : [])].join("\n"), count: 0 };
		const by = marker(ctx);
		await ctx.step("move", async () => {
			store.update(ctx.callId, (state) => {
				const now_ = state.appointments.find((x) => x.id === a.id);
				if (now_ === undefined || now_.status !== "booked") throw new AppointmentError("intanto quell'appuntamento è stato chiuso o disdetto: non l'ho spostato");
				const again = fits({ ...input, appointments: state.appointments, ...(fit.resource === undefined ? {} : { resource: fit.resource }) });
				if (!again.ok) throw new AppointmentError("intanto quell'ora è stata presa da un altro appuntamento: non l'ho spostato");
				const { resource: _r, ...rest } = now_;
				const moved: Appointment = { ...rest, day, start: timeOf(time.minutes), ...(fit.resource === undefined ? {} : { resource: fit.resource }), moved: { ...by, from: `${now_.day} ${now_.start}` } };
				return { ...state, appointments: state.appointments.map((x) => (x.id === a.id ? moved : x)) };
			});
			return true;
		});
		const after = store.read().appointments.find((x) => x.id === a.id) as Appointment;
		return {
			text: [
				`Fatto: ho spostato l'appuntamento da ${whenWords(a.day, a.start, at.day)} a ${whenWords(after.day, after.start, at.day)} (fino alle ${endOf(after)}). Chi e per cosa è nel riquadro.`,
				fencedAppointments(appointmentRow(after)),
				...("note" in time && time.note !== undefined ? [time.note] : []),
				"Se era anche nel calendario Google, va spostato anche lì.",
			].join("\n"),
			count: 1,
		};
	}

	/** Disdetto, non presentato, fatto: the person's word, the record kept. */
	async function close(op: "cancel" | "no_show" | "done", args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const status = op === "cancel" ? "cancelled" : op;
		const refused = requirePersonFor(ctx, op === "cancel" ? "segno l'appuntamento come disdetto" : op === "no_show" ? "segno che il cliente non si è presentato" : "segno l'appuntamento come fatto");
		if (refused !== undefined) return { text: refused, count: 0 };
		let targets: Appointment[];
		if (op === "done" && args.all === true) {
			const day = daySaid(args.date ?? "oggi", at.day);
			if (isAnswer(day)) return { text: day.answer, count: 0 };
			if (day > at.day) return { text: "Errore: si segnano come fatti solo gli appuntamenti già cominciati.", count: 0 };
			targets = b.appointments.filter((a) => a.day === day && a.status === "booked" && started(a, at));
			if (targets.length === 0) return { text: `Nessun appuntamento ancora «fissato» ${day === at.day ? "di oggi già cominciato" : `del ${dayWords(day, at.day)}`}: non ho segnato niente.`, count: 0 };
		} else {
			const a = appointmentNamed(args, b.appointments, cards(), at.day, (x) => x.status === "booked" && (op === "cancel" || started(x, at)), op !== "cancel");
			if (isAnswer(a)) return { text: op === "cancel" ? a.answer : `${a.answer}\nSi segna come fatto, o non presentato, solo un appuntamento ancora «fissato» e già cominciato.`, count: 0 };
			targets = [a];
		}
		const ids = targets.map((t) => t.id);
		const by = marker(ctx);
		await ctx.step(op, async () => {
			store.update(ctx.callId, (state) => {
				const gone = ids.filter((id) => state.appointments.find((x) => x.id === id)?.status !== "booked");
				if (gone.length > 0) throw new AppointmentError("intanto l'appuntamento è stato già segnato o disdetto: non ho cambiato niente");
				return { ...state, appointments: state.appointments.map((x) => (ids.includes(x.id) ? { ...x, status, closed: by } : x)) };
			});
			return true;
		});
		const after = store.read().appointments.filter((x) => ids.includes(x.id)).sort(byTime);
		const first = after[0] as Appointment;
		if (after.length > 1) return { text: [`Fatto: ho segnato come fatti ${after.length} appuntamenti ${dayWords(first.day, at.day)}. Sono nel riquadro.`, fencedAppointments(after.map((a) => appointmentRow(a)).join("\n"))].join("\n"), count: after.length };
		const when = whenWords(first.day, first.start, at.day);
		const head =
			op === "cancel"
				? `Fatto: ho segnato come disdetto l'appuntamento di ${when}. Resta nello storico del cliente, e quell'ora è di nuovo libera.`
				: op === "no_show"
					? `Fatto: ho segnato che il cliente non si è presentato all'appuntamento di ${when}. Resta nello storico: con questo, ${n1(b.appointments.filter((a) => clientKey(a.client) === clientKey(first.client) && a.status === "no_show").length + 1, "è la prima volta", "sono # volte")}.`
					: `Fatto: ho segnato come fatto l'appuntamento di ${when}.`;
		return { text: [head, fencedAppointments(appointmentRow(first)), ...(op === "cancel" ? ["Se era anche nel calendario Google, va tolto anche lì."] : [])].join("\n"), count: 1 };
	}

	/** The days from `date` (today) to `to_date`, at most 14. */
	function daysSaid(args: Record<string, unknown>, today: string, first: string, week: boolean): string[] | string {
		const from = daySaid(args.date ?? first, today);
		if (isAnswer(from)) return from.answer;
		const to = args.to_date !== undefined ? daySaid(args.to_date, from) : week ? addDays(from, 6) : from;
		if (isAnswer(to)) return to.answer;
		if (to < from) return "Errore: l'ultimo giorno viene prima del primo.";
		if (daysBetween(from, to) >= APPOINTMENT_LIMITS.ahead) return `Errore: guardo al più ${APPOINTMENT_LIMITS.ahead} giorni alla volta.`;
		const out: string[] = [];
		for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
		return out;
	}

	function freeTimes(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const settings = b.settings;
		if (settings?.week === undefined) return { text: "Non so ancora gli orari di apertura, quindi non so dire quando sei libero: dimmeli (per esempio «lun-ven 9-13 e 14:30-19») e li salvo.", count: 0 };
		const days = daysSaid(args, at.day, "oggi", args.week === true);
		if (typeof days === "string") return { text: days, count: 0 };
		const window = windowSaid(args.window);
		if (isAnswer(window)) return { text: window.answer, count: 0 };
		let minutes = minutesSaid(args.minutes);
		if (isAnswer(minutes)) return { text: minutes.answer, count: 0 };
		let needs: readonly string[] | undefined;
		const notes: string[] = [];
		if (minutes === undefined && args.services !== undefined) {
			const sv = servicesSaid(args.services, settings, voci());
			if (isAnswer(sv)) return { text: sv.answer, count: 0 };
			minutes = sv.services.reduce((n, s) => n + s.minutes, 0);
			needs = sv.needs;
			if (sv.assumed.length > 0) notes.push(`Non so quanto ${n1(sv.assumed.length, "dura un servizio: ho contato", "durano # servizi: ho contato")} ${DEFAULT_MINUTES} minuti.`);
		}
		if (minutes === undefined) {
			minutes = DEFAULT_MINUTES;
			notes.push(`Non mi hai detto quanto deve durare: ho cercato ${DEFAULT_MINUTES} minuti.`);
		}
		const resource = resourceSaid(args.resource, settings);
		if (isAnswer(resource)) return { text: resource.answer, count: 0 };
		const step = settings.slot ?? 15;
		const plain: string[] = [];
		const byResource: string[] = [];
		let found = 0;
		for (const day of days) {
			if (day < at.day) continue;
			const open = openOn(settings, day);
			if (open.spans.length === 0) {
				if (days.length === 1) plain.push(`${capital(closedWords(open, day))}.`);
				continue;
			}
			const slots = freeSlots({ settings, appointments: b.appointments, day, minutes, ...(resource === undefined ? {} : { resource }), ...(needs === undefined ? {} : { needs }), now: at, ...(window === undefined ? {} : { from: window.from, to: window.to }) });
			if (slots.length === 0) continue;
			found += 1;
			const lanes = [...new Set(slots.map((s) => s.resource))];
			if (lanes.length === 1 && lanes[0] === undefined) plain.push(`• ${dayWords(day, at.day)}: ${startsWords(slots.map((s) => s.start), step)}`);
			else for (const lane of lanes) byResource.push(`• ${dayWords(day, at.day)}, ${lane ?? ""}: ${startsWords(slots.filter((s) => s.resource === lane).map((s) => s.start), step)}`);
		}
		const head = found === 0 ? `Nessun orario libero per ${minutes} minuti in ${days.length === 1 ? "quel giorno" : "quei giorni"}${window === undefined ? "" : " in quella parte del giorno"}.` : `Si può cominciare un appuntamento di ${minutes} minuti in questi orari:`;
		return { text: [head, ...plain, ...(byResource.length === 0 ? [] : ["Per risorsa, nel riquadro:", fencedAppointments(byResource.join("\n"))]), ...notes].join("\n"), count: 0 };
	}

	function agenda(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const days = daysSaid(args, at.day, "oggi", args.week === true);
		if (typeof days === "string") return { text: days, count: 0 };
		const out: string[] = [];
		const rows: string[] = [];
		let count = 0;
		for (const day of days) {
			const list = b.appointments.filter((a) => a.day === day && (a.status === "booked" || a.status === "done")).sort(byTime);
			const cancelled = b.appointments.filter((a) => a.day === day && (a.status === "cancelled" || a.status === "no_show")).length;
			const open = openOn(b.settings, day);
			count += list.length;
			const closed = open.known && open.spans.length === 0 ? ` (${closedWords(open, day)})` : "";
			out.push(`• ${capital(dayWords(day, at.day))}: ${list.length === 0 ? "nessun appuntamento" : n1(list.length, "un appuntamento", "# appuntamenti")}${list.length > 0 ? `, dalle ${(list[0] as Appointment).start} alle ${endOf(list.at(-1) as Appointment)}` : ""}${cancelled > 0 ? `; ${n1(cancelled, "uno disdetto o non presentato", "# disdetti o non presentati")}` : ""}${closed}`);
			if (days.length === 1 && open.known && open.spans.length > 0) {
				const gaps = gapsOf(b.settings, b.appointments, day).filter((g) => day > at.day || g.to > at.minutes);
				if (gaps.length > 0) out.push(`  Libero: ${gaps.map(spanWords).join(", ")}.`);
			}
			if (list.length > 0) rows.push(...(days.length > 1 ? [capital(dayWords(day, at.day))] : []), ...list.map((a) => appointmentRow(a)));
		}
		return { text: [...out, ...(rows.length === 0 ? [] : ["Chi e per cosa è nel riquadro.", fencedAppointments(rows.join("\n"))])].join("\n"), count };
	}

	async function brief(ctx: ToolContext, b: AppointmentBook, at: Now): Promise<string> {
		const today = b.appointments.filter((a) => a.day === at.day && a.status === "booked").sort(byTime);
		const yesterday = addDays(at.day, -1);
		const open = b.appointments.filter((a) => a.day === yesterday && a.status === "booked");
		const wanted = [...(today.length > 0 ? [`today:${at.day}`] : []), ...(open.length > 0 ? [`open:${yesterday}`] : [])];
		const said = wanted.length === 0 ? [] : await ctx.step("claim", async () => store.claim(ctx.callId, at.day, wanted));
		if (said.length === 0) return BRIEF_NOTHING;
		await audit(ctx, "brief", said.length);
		const out: string[] = [];
		if (said.includes(`today:${at.day}`)) {
			const first = today[0] as Appointment;
			const gaps = gapsOf(b.settings, b.appointments, at.day);
			out.push(`Appuntamenti di oggi: ${today.length}, il primo alle ${first.start} (chi e per cosa nel riquadro).${b.settings?.week !== undefined && gaps.length > 0 ? ` Libero: ${gaps.map(spanWords).join(", ")}.` : ""}`, fencedAppointments(appointmentRow(first)));
		}
		if (said.includes(`open:${yesterday}`)) out.push(`Di ieri ${n1(open.length, "un appuntamento è", "# appuntamenti sono")} ancora «fissato»: segna com'è andata (fatto, disdetto o non presentato).`);
		return out.join("\n");
	}

	function history(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const c = clientSaid(args.client, cards(), b.appointments);
		if (isAnswer(c)) return { text: c.answer, count: 0 };
		if (c.close === true) return { text: ["Intendi questo cliente? Non si chiama esattamente così:", fencedAppointments(c.client.name), "Chiedi a chi ti scrive se è lui, e ripeti con il nome scritto come qui."].join("\n"), count: 0 };
		const mine = b.appointments.filter((a) => clientKey(a.client) === clientKey(c.client)).sort(byTime);
		if (mine.length === 0) return { text: ["Non trovo appuntamenti per questo cliente.", fencedAppointments(c.client.name)].join("\n"), count: 0 };
		const done = mine.filter((a) => a.status === "done");
		const noShow = mine.filter((a) => a.status === "no_show").length;
		const cancelled = mine.filter((a) => a.status === "cancelled").length;
		const next = mine.filter((a) => a.status === "booked" && !started(a, at));
		const usual = new Map<string, number>();
		for (const a of done) usual.set(servicesWords(a), (usual.get(servicesWords(a)) ?? 0) + 1);
		const top = [...usual.entries()].sort((x, y) => y[1] - x[1])[0];
		const lines = [
			`Cliente: ${mine.at(-1)?.client.name ?? c.client.name}`,
			...(top !== undefined && done.length >= 2 ? [`Di solito fa: ${top[0]} (${top[1]} volte su ${done.length})`] : []),
			"Ultime visite:",
			...(done.length === 0 ? ["nessuna"] : done.slice(-5).reverse().map((a) => appointmentRow(a, true))),
			...(next.length === 0 ? [] : ["Prossimi:", ...next.slice(0, 5).map((a) => appointmentRow(a, true))]),
			...(noShow + cancelled === 0 ? [] : ["Disdetti e non presentati:", ...mine.filter((a) => a.status === "no_show" || a.status === "cancelled").slice(-5).reverse().map((a) => appointmentRow(a, true))]),
		];
		const head = `${n1(done.length, "Una visita fatta", "# visite fatte")}, ${n1(noShow, "un «non presentato»", "# «non presentato»")}, ${n1(cancelled, "una disdetta", "# disdette")}${next.length === 0 ? ", nessun appuntamento in programma" : `; il prossimo è ${whenWords((next[0] as Appointment).day, (next[0] as Appointment).start, at.day)}`}.${top !== undefined && done.length >= 2 ? " Cosa fa di solito è nel riquadro." : ""}`;
		return { text: [head, fencedAppointments(lines.join("\n"))].join("\n"), count: 0 };
	}

	function reminders(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const day = daySaid(args.date ?? "domani", at.day);
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		if (day < at.day) return { text: "Errore: i promemoria si fanno per oggi o per i prossimi giorni.", count: 0 };
		const list = b.appointments.filter((a) => a.day === day && a.status === "booked" && !started(a, at)).sort(byTime);
		if (list.length === 0) return { text: `Per ${dayWords(day, at.day)} non ci sono appuntamenti fissati: nessun promemoria da preparare.`, count: 0 };
		const groups = new Map<string, Appointment[]>();
		for (const a of list) groups.set(clientKey(a.client), [...(groups.get(clientKey(a.client)) ?? []), a]);
		const all = cards();
		let withMail = 0;
		let withPhone = 0;
		const blocks: string[] = [];
		for (const g of groups.values()) {
			const first = g[0] as Appointment;
			const card = first.client.card === undefined ? undefined : all.find((x) => x.id === first.client.card);
			const email = card?.contacts.find((x) => x.email !== undefined)?.email;
			const phone = card?.contacts.find((x) => x.phone !== undefined)?.phone;
			if (email !== undefined) withMail += 1;
			if (phone !== undefined) withPhone += 1;
			const contact = [email === undefined ? undefined : `email ${email}`, phone === undefined ? undefined : `telefono ${phone}`].filter((x) => x !== undefined).join(", ");
			blocks.push([`Per: ${first.client.name}${contact === "" ? " (nessun contatto nella scheda)" : ` (${contact})`}`, reminderText(first.client.name, g, at.day, b.settings?.business)].join("\n"));
		}
		const n = groups.size;
		return {
			text: [
				`Ho preparato ${n1(n, "il messaggio", "i # messaggi")} di promemoria per gli appuntamenti di ${dayWords(day, at.day)}, uno per cliente, come nel riquadro. Non li mando da sola.`,
				fencedAppointments(blocks.join("\n\n")),
				`${withMail === 0 ? "Nessuno ha l'email nella scheda." : `${n1(withMail, "Un cliente ha", "# clienti hanno")} l'email nella scheda: posso prepararne la bozza con google_mail_send, o mandarla dopo il sì di chi ti scrive.`} ${withPhone === 0 ? "" : `${n1(withPhone, "Uno ha", "# hanno")} il telefono: chi ti scrive può copiare il testo su WhatsApp o in un SMS.`}`.trim(),
				...(b.settings?.business === undefined ? ["Se mi dici il nome dell'attività, lo metto nei messaggi."] : []),
			].join("\n"),
			count: n,
		};
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const by = marker(ctx);
		const next = settingsSaid(args, b.settings, voci(), at.day, by);
		if (next === undefined) return { text: settingsWords(b.settings, at.day), count: 0 };
		if (isAnswer(next)) return { text: next.answer, count: 0 };
		const refused = requirePersonFor(ctx, "cambio gli orari e le impostazioni degli appuntamenti");
		if (refused !== undefined) return { text: refused, count: 0 };
		await ctx.step("settings", async () => {
			store.update(ctx.callId, (state) => ({ ...state, settings: next as AppointmentSettings }));
			return true;
		});
		const saved = store.read().settings;
		// The appointments booked where now it is closed: said, never moved by Annie.
		const clash = b.appointments.filter((a) => a.status === "booked" && a.day >= at.day && !fitsOpen(saved, a));
		return {
			text: [
				"Fatto, ho salvato.",
				settingsWords(saved, at.day),
				...(clash.length === 0 ? [] : [`Attenzione: ${n1(clash.length, "un appuntamento fissato cade", "# appuntamenti fissati cadono")} quando ora sei chiuso (nel riquadro): ${clash.length === 1 ? "va spostato o disdetto" : "vanno spostati o disdetti"}, chiedilo a chi ti scrive.`, fencedAppointments(clash.map((a) => appointmentRow(a, true)).join("\n"))]),
			].join("\n"),
			count: 1,
		};
	}

	async function exportCsv(ctx: ToolContext, b: AppointmentBook, day: string): Promise<Answer> {
		const all = b.appointments;
		if (all.length === 0) return { text: "Non c'è ancora nessun appuntamento da mettere nel file.", count: 0 };
		const path = await ctx.step("path", async () => freePath(workspace, `appuntamenti/appuntamenti-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, appointmentsCsv(all))).path);
		return { text: [`Salvato il file degli appuntamenti: ${n1(all.length, "un appuntamento", "# appuntamenti")}, uno per riga, con lo stato (separatore «;», si apre con Excel). Il percorso è nel riquadro; mandalo con file_send se chi ti scrive lo vuole.`, fencedAppointments(written)].join("\n"), count: all.length };
	}

	function agentCounts(b: AppointmentBook, at: Now): string {
		const on = (day: string) => b.appointments.filter((a) => a.day === day && a.status === "booked").length;
		return `Appuntamenti: oggi ${on(at.day)}, domani ${on(addDays(at.day, 1))}. A un altro agente do solo i conteggi: clienti e servizi no.`;
	}

	async function run(op: AppointmentOp, args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		switch (op) {
			case "book":
				return book(args, ctx, b, at);
			case "move":
				return move(args, ctx, b, at);
			case "cancel":
			case "no_show":
			case "done":
				return close(op, args, ctx, b, at);
			case "free_slots":
				return freeTimes(args, b, at);
			case "agenda":
				return agenda(args, b, at);
			case "history":
				return history(args, b, at);
			case "reminders":
				return reminders(args, b, at);
			case "settings":
				return settings(args, ctx, b, at);
			case "export":
				return exportCsv(ctx, b, at.day);
		}
	}

	const durationSchema = {
		type: "object",
		properties: { name: text(APPOINTMENT_LIMITS.service, "the service, as said (a voce of the listino when there is one)"), minutes: { type: ["integer", "string"], description: "how long it lasts: 30, «1h30»" }, needs: { type: "array", maxItems: APPOINTMENT_LIMITS.resources, items: text(APPOINTMENT_LIMITS.resource, "a resource"), description: "the resources that may do it" } },
		required: ["name", "minutes"],
		additionalProperties: false,
	};

	return [
		{
			name: "appointments",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...APPOINTMENT_OPS] },
					client: text(APPOINTMENT_LIMITS.name, "book, history: the client as said («la signora Rossi»), or card id CL-0001; move, cancel, no_show, done: whose appointment"),
					services: { type: "array", maxItems: 50, items: { anyOf: [text(APPOINTMENT_LIMITS.service, "book, free_slots: a service as said («taglio»)"), durationSchema] }, description: "book, free_slots: the services as said, each a string; settings: how long each service lasts, each {name, minutes, needs}" },
					date: text(40, "book: the day («giovedì», «domani», 22/10); move: the new day; agenda, free_slots: the first day (default today); reminders: default tomorrow; done with all: the day"),
					time: text(10, "book: the time («15», «15:30»); move: the new time (default the same)"),
					minutes: { type: ["integer", "string"], description: "book: the duration when said (default the services'); free_slots: how long («un'ora», 45)" },
					resource: text(APPOINTMENT_LIMITS.resource, "book, move, free_slots: the resource as said («Marco», «poltrona 2»)"),
					notes: text(APPOINTMENT_LIMITS.notes, "book: notes as said"),
					appointment: text(10, "move, cancel, no_show, done: the reference AP-0001 (never said to the person)"),
					from_date: text(40, "move, cancel, no_show, done: the day of the appointment, when the client has more than one"),
					to_date: text(40, "agenda, free_slots: the last day (at most 14 days)"),
					week: { type: "boolean", description: "agenda, free_slots: seven days from date" },
					window: text(20, "free_slots: mattina, pomeriggio, sera"),
					all: { type: "boolean", description: "done: every appointment of the day already begun" },
					confirm: { type: "boolean", description: "book: true only after the person's yes to the proposal" },
					check: text(20, "book with confirm: the check given with the proposal"),
					compact: { type: "boolean", description: "agenda: the brief's line only" },
					business: text(APPOINTMENT_LIMITS.business, "settings: the business's name, for the reminders"),
					hours: {
						type: "array",
						maxItems: 7,
						items: { type: "object", properties: { days: text(40, "«lun-ven», «sabato»"), open: text(60, "«9-13, 14:30-19» or «chiuso»") }, required: ["days", "open"], additionalProperties: false },
						description: "settings: the opening hours by weekday, with breaks",
					},
					closure_from: text(40, "settings: a closure's first day (ferie)"),
					closure_to: text(40, "settings: a closure's last day"),
					closure_note: text(120, "settings: why («ferie»)"),
					closure_remove: text(40, "settings: a day of the closure to take off"),
					holidays_open: { type: "boolean", description: "settings: open on the national holidays (default closed)" },
					slot: { type: "integer", enum: [5, 10, 15, 20, 30, 60], description: "settings: appointments start every so many minutes (default 15)" },
					resources: { type: "array", maxItems: APPOINTMENT_LIMITS.resources, items: text(APPOINTMENT_LIMITS.resource, "a resource"), description: "settings: every resource (people, chairs, lifts), the whole list" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!APPOINTMENT_OPS.includes(args.op as AppointmentOp)) return "Errore: non conosco questa operazione sugli appuntamenti.";
				const op = args.op as AppointmentOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				// Appointments name clients, services and times: another agente gets counts only.
				if (isAgentTurn(ctx) && !READ_OPS.includes(op)) return AGENT_REFUSAL;
				const at = localNow(timeZone, now());
				try {
					const b = store.read();
					if (b.broken) return `Errore: ${APPOINTMENTS_BROKEN}.`;
					if (isAgentTurn(ctx)) return agentCounts(b, at);
					if (op === "agenda" && args.compact === true) return await brief(ctx, b, at);
					const answer = await run(op, args, ctx, b, at);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof AppointmentError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}

/** Whether a booked appointment still falls in the openings. */
function fitsOpen(settings: AppointmentSettings | undefined, a: Appointment): boolean {
	const start = minutesOf(a.start);
	return openOn(settings, a.day).spans.some((s) => s.from <= start && start + a.minutes <= s.to);
}
