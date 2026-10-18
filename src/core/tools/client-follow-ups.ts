/**
 * The ricontatti of the clients: fixed, moved, dropped, done, and the contacts had. A ricontatto
 * reminds the person on its day through the tasks programmati (schedule-tools.ts ReminderSeam):
 * one reminder per ricontatto, keyed by the call and the ricontatto's id, made before the write
 * that links it and taken back when that write fails. A reminder replaced or no longer needed is
 * recorded before the write and taken away on every run of the call, so a crash leaves none behind.
 */
import type { Client } from "../client-sums.ts";
import { openFollowUps } from "../client-sums.ts";
import { CLIENTS_BROKEN, type ClientState, type ClientStore } from "../client-store.ts";
import { CLIENT_LIMITS, type ClientCard, ClientError, type ContactEntry, cardKeys, FOLLOW_UP_HOUR, FOLLOW_UP_ID, FOLLOW_UP_MAX_DAYS, type FollowUp, followUpId } from "../clients.ts";
import type { ToolContext } from "../engine.ts";
import { addDays } from "../italian-calendar.ts";
import { capitalized, monthName, withNearDate } from "../italian-format.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import { withOptional, clash } from "./client-input.ts";
import { fenced, nearDay } from "./client-render.ts";
import { readFutureDay, workingDayFrom } from "./day-input.ts";
import { line, textOf } from "./field-input.ts";
import { isProblem, type Problem } from "./quote-input.ts";
import { type Cancelled, type Reminder, type ReminderSeam, reminderKey } from "./schedule-tools.ts";

/** What the audit records (client-tools.ts ClientEvent). */
export type FollowUpOp = "follow_up" | "postpone" | "cancel_follow_up" | "done";

/** The client a write is for (client-tools.ts target): its client in the registers, the name to write, what to say. */
export type Chosen = { readonly client?: Client; readonly name: string; readonly notes: readonly string[]; readonly inside: readonly string[] };

/** What the ricontatti need from the clients tool. */
export type ClientEnv = {
	readonly store: ClientStore;
	readonly reminders?: ReminderSeam;
	readonly marker: (ctx: ToolContext) => Marker;
	readonly audit: (ctx: ToolContext, op: FollowUpOp, count: number) => Promise<void>;
	readonly cards: () => readonly ClientCard[];
	readonly clients: (ctx: ToolContext) => Promise<readonly Client[]>;
	readonly target: (clients: readonly Client[], name: string, mode: "create" | "ask" | "exact") => Chosen | string;
	readonly newCard: (state: ClientState, name: string, client: Client | undefined, ctx: ToolContext) => ClientCard;
	readonly cardNamed: (name: string, client: Client | undefined) => ClientCard | undefined;
};

/** A reminder made, or why there is none. */
type Reminded = Reminder | { readonly problem: string };

/** A reminder to take away: its task and the key it was made with. */
type Old = { readonly id: string; readonly call: string } | null;

/** A ricontatto's number moved under the call (another call took it): the reminder made for it is taken back and the write tried again. */
class Moved extends Error {}

const NO_SEAM = "i promemoria programmati non ci sono su questa istanza";

/** The task's instruction: only the ricontatto's id, never a name or a note (those are read, fenced, when it runs). */
export function reminderInstruction(id: string): string {
	return `Promemoria dei clienti: c'è un ricontatto da fare. Leggilo con lo strumento clients, operazione show e cliente ${id}, e fai come dice la risposta.`;
}

/** The ricontatto's id a call names (follow_up), checked; undefined when not given. */
export function followUpSaid(args: Record<string, unknown>): string | undefined | Problem {
	if (args.follow_up === undefined) return undefined;
	const id = typeof args.follow_up === "string" ? args.follow_up.trim().toUpperCase() : "";
	return FOLLOW_UP_ID.test(id) ? id : { problem: "un ricontatto si indica con il suo numero, come FU-0001" };
}

function clientSaid(args: Record<string, unknown>): string | undefined {
	return typeof args.client === "string" && args.client.trim() !== "" ? args.client.trim().slice(0, CLIENT_LIMITS.name) : undefined;
}

/** The ricontatti's ops and the card write the other ops share. */
export function followUpOps(env: ClientEnv) {
	const { store } = env;

	/**
	 * Under the lock, once per call: the card of `chosen` (by its id, or by the name it was made
	 * with; a new one when it has none) changed by `change`. With `plan`, a new ricontatto too, its
	 * reminder linked in the same write: the reminder is made first, keyed by the number the
	 * ricontatto will take, that number and the reminder recorded before the write; a write that fails
	 * (or finds that number taken, also on a call run again after a crash) takes it back. `fresh`:
	 * false on a call run again, which writes nothing.
	 */
	async function writeCard(
		ctx: ToolContext,
		chosen: { client?: Client; name: string },
		change: (card: ClientCard, fu: FollowUp | undefined) => ClientCard | string,
		plan?: { readonly date: string; readonly text?: string },
	): Promise<{ readonly fresh: boolean; readonly created: boolean; readonly reminded?: Reminded }> {
		for (let attempt = 0; ; attempt++) {
			const book = store.read();
			if (book.broken) throw new ClientError(CLIENTS_BROKEN);
			if (book.calls.includes(ctx.callId)) return { fresh: false, created: false };
			// The number this attempt plans for, recorded before its reminder is made: a call run again
			// after a crash comes back to it, finds that reminder and, the number taken since, takes it away.
			const number = plan === undefined ? book.nextFollowUp : await ctx.step(`follow-up-number-${attempt}`, async () => book.nextFollowUp);
			let reminded: Reminded | undefined;
			let recorded: { readonly number: number; readonly id?: string; readonly call?: string } | undefined;
			if (plan !== undefined) {
				const made: Reminded = env.reminders === undefined ? { problem: NO_SEAM } : await env.reminders.remind({ day: plan.date, hour: FOLLOW_UP_HOUR, instruction: reminderInstruction(followUpId(number)) }, reminderKey(followUpId(number)), ctx);
				reminded = made;
				recorded = await ctx.step(`follow-up-reminder-${attempt}`, async () => ({ number, ...("id" in made ? { id: made.id, call: made.call } : {}) }));
			}
			let created = false;
			try {
				const fresh = store.update(ctx.callId, (state) => {
					if (plan !== undefined && state.nextFollowUp !== number) throw new Moved();
					let card = (chosen.client?.card === undefined ? undefined : state.cards.find((c) => c.id === chosen.client?.card?.id)) ?? state.cards.find((c) => cardKeys(c).includes(spellingKey(chosen.name)));
					let next = state;
					if (card === undefined) {
						if (state.cards.length >= CLIENT_LIMITS.cards) throw new ClientError(`ci sono già ${CLIENT_LIMITS.cards} schede di clienti, il massimo`);
						card = env.newCard(state, chosen.name, chosen.client, ctx);
						// A partita IVA another card has already: the name is not linked to it.
						if (card.vat !== undefined && state.cards.some((c) => c.vat === card?.vat)) card = withOptional(card, "vat", null);
						next = { ...state, nextCard: state.nextCard + 1, cards: [...state.cards, card] };
						created = true;
					}
					const fu: FollowUp | undefined =
						plan === undefined
							? undefined
							: {
									id: followUpId(number),
									date: plan.date,
									...(plan.text === undefined ? {} : { text: plan.text }),
									callId: ctx.callId,
									...(reminded !== undefined && "id" in reminded ? { scheduleId: reminded.id, scheduleCall: reminded.call } : {}),
									...env.marker(ctx),
								};
					const made = change(card, fu);
					if (typeof made === "string") throw new ClientError(made);
					const problem = clash(made, next.cards);
					if (problem !== undefined) throw new ClientError(problem);
					return { ...next, ...(plan === undefined ? {} : { nextFollowUp: number + 1 }), cards: next.cards.map((c) => (c.id === made.id ? made : c)) };
				});
				return { fresh, created: fresh && created, ...(reminded === undefined ? {} : { reminded }) };
			} catch (error) {
				// No ricontatto saved: no reminder left behind, the one recorded for this number included.
				if (env.reminders !== undefined) {
					if (reminded !== undefined && "id" in reminded) await env.reminders.cancel(reminded.id, reminded.call);
					if (recorded?.id !== undefined && (reminded === undefined || !("id" in reminded) || reminded.id !== recorded.id)) await env.reminders.cancel(recorded.id, recorded.call ?? "");
				}
				if (error instanceof Moved && attempt < 3) continue;
				if (error instanceof Moved) throw new ClientError("le schede sono cambiate mentre salvavo: ripeti la richiesta");
				throw error;
			}
		}
	}

	/** The card with one more ricontatto: past the cap the oldest done ones go first, never an open one. */
	function withFollowUp(card: ClientCard, fu: FollowUp, by: Marker): ClientCard | string {
		let followUps = [...card.followUps, fu];
		while (followUps.length > CLIENT_LIMITS.followUps) {
			const old = followUps.findIndex((f) => f.done !== undefined);
			if (old < 0) return `la scheda ha già ${CLIENT_LIMITS.followUps} ricontatti aperti: segnane qualcuno come fatto`;
			followUps = followUps.filter((_, i) => i !== old);
		}
		return { ...card, followUps, edited: by };
	}

	/**
	 * The day of a ricontatto as said: from today on, at most two years ahead. A day counted from
	 * today that falls off work moves to the next working day; a day named is kept, with the next
	 * working day offered; a month is its first working day. `notes`: what to say about it.
	 */
	function plannedDay(value: unknown, day: string): { date: string; notes: string[] } | string {
		if (typeof value !== "string" || value.trim() === "") return "Errore: dimmi quando ricontattarlo, per esempio «tra due settimane» o «il 3 novembre».";
		const read = readFutureDay(value.slice(0, 60), day);
		if (read === undefined) return ["Errore: non capisco il giorno; dimmelo come «tra due settimane», «lunedì» o «3 novembre»:", fenced(value.slice(0, 60))].join("\n");
		if (read.date < day) return "Errore: quel giorno è già passato; dimmi un giorno da oggi in poi.";
		if (read.date > addDays(day, FOLLOW_UP_MAX_DAYS)) return "Errore: un ricontatto si fissa al più due anni avanti.";
		const notes: string[] = [];
		if (read.kind === "month") {
			const first = workingDayFrom(read.date).date;
			const already = read.nextYear === true ? `Siamo già a ${monthName(day)}: prendo quello del ${read.date.slice(0, 4)}; se intendevi questo mese, dimmi il giorno. ` : "";
			notes.push(`${already}Ho preso ${nearDay(first, day)}, il primo giorno lavorativo del mese.`);
			return { date: first, notes };
		}
		if (read.nextWeek === true) notes.push(`Ho preso ${nearDay(read.date, day)}, quello della settimana prossima, non domani.`);
		if (read.date === day) return { date: read.date, notes };
		const working = workingDayFrom(read.date);
		if (working.why === undefined) return { date: read.date, notes };
		const said = capitalized(withNearDate("il", read.date, day));
		if (read.kind === "relative") {
			notes.push(`${said} ${working.why}, lo sposto a ${nearDay(working.date, day)}.`);
			return { date: working.date, notes };
		}
		notes.push(`${said} ${working.why}: lo lascio, o preferisci ${nearDay(working.date, day)}? Se sì, lo sposto.`);
		return { date: read.date, notes };
	}

	/** What the person hears of a ricontatto's reminder: when it comes, or why it does not and where it shows instead. */
	async function reminderLine(fu: FollowUp, reminded: Reminded | undefined, day: string, ctx: ToolContext): Promise<string> {
		if (fu.scheduleId !== undefined) return `Te lo ricordo ${fu.date === day ? "tra poco" : `quel giorno alle ${FOLLOW_UP_HOUR}`} in questa conversazione.`;
		const why = reminded !== undefined && "problem" in reminded ? `Non posso ricordartelo con un messaggio (${reminded.problem}).` : "Per questo ricontatto non c'è un promemoria.";
		const brief = (await env.reminders?.briefActive(ctx).catch(() => false)) === true;
		return `${why} ${brief ? "Lo vedrai nel brief del mattino di quel giorno, e" : "Lo trovi"} nella scheda e tra i ricontatti da fare.`;
	}

	function cancelWords(result: Cancelled | undefined): string {
		if (result === "removed") return ", e ho tolto il suo promemoria";
		if (result === "not_ours") return "; il task programmato che aveva non è più il suo, e non l'ho toccato";
		return "";
	}

	/** The reminder a ricontatto has now, recorded once per call before the write that replaces or ends it. */
	function oldReminder(ctx: ToolContext, fu: FollowUp | undefined): Promise<Old> {
		return ctx.step("old-reminder", async () => (fu?.scheduleId === undefined ? null : { id: fu.scheduleId, call: fu.scheduleCall ?? "" }));
	}

	async function cancelOld(old: Old, keep?: string): Promise<Cancelled | undefined> {
		if (old === null || old.id === keep || env.reminders === undefined) return undefined;
		return env.reminders.cancel(old.id, old.call);
	}

	async function followUp(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const name = clientSaid(args);
		if (name === undefined) return "Errore: dimmi quale cliente ricontattare.";
		const planned = plannedDay(args.when, day);
		if (typeof planned === "string") return planned;
		const what = args.text === undefined || args.text === "" ? undefined : line(args.text, CLIENT_LIMITS.followUpChars, "cosa fare");
		if (isProblem(what)) return `Errore: ${what.problem}.`;
		const chosen = env.target(await env.clients(ctx), name, "ask");
		if (typeof chosen === "string") return chosen;
		const by = env.marker(ctx);
		const written = await writeCard(ctx, chosen, (card, fu) => withFollowUp(card, fu as FollowUp, by), { date: planned.date, ...(what === undefined ? {} : { text: what }) });
		const card = env.cardNamed(chosen.name, chosen.client);
		const fu = card?.followUps.find((f) => f.callId === ctx.callId);
		if (card === undefined || fu === undefined) return "Errore: il ricontatto non risulta salvato: ripeti la richiesta.";
		await env.audit(ctx, "follow_up", 1);
		const lines = [...planned.notes, `Ricontatto fissato per ${nearDay(fu.date, day)} (${fu.id}); ${written.created ? `ho creato la scheda ${card.id}` : `è nella scheda ${card.id}`}.`, ...chosen.notes];
		lines.push(await reminderLine(fu, written.reminded, day, ctx));
		lines.push(fenced([`Cliente: ${card.name}`, ...(fu.text === undefined ? [] : [`Da fare: ${fu.text}`]), ...chosen.inside].join("\n")));
		return lines.join("\n");
	}

	/** The card and the ricontatto a call names: the id said, else the client's next open one. */
	async function namedFollowUp(args: Record<string, unknown>, ctx: ToolContext): Promise<{ card: ClientCard; fu: FollowUp | undefined; wanted?: string } | string> {
		const fuSaid = followUpSaid(args);
		if (isProblem(fuSaid)) return `Errore: ${fuSaid.problem}.`;
		const name = clientSaid(args) ?? fuSaid;
		if (name === undefined) return "Errore: dimmi di quale cliente, o il numero del ricontatto.";
		const chosen = env.target(await env.clients(ctx), name, "exact");
		if (typeof chosen === "string") return chosen;
		const card = chosen.client?.card === undefined ? undefined : env.cards().find((c) => c.id === chosen.client?.card?.id);
		if (card === undefined) return "Questo cliente non ha ricontatti: non ha ancora una scheda.";
		const wanted = fuSaid ?? (FOLLOW_UP_ID.test(name.toUpperCase()) ? name.toUpperCase() : undefined);
		const fu = wanted !== undefined ? card.followUps.find((f) => f.id === wanted) : openFollowUps(card)[0];
		return { card, fu, ...(wanted === undefined ? {} : { wanted }) };
	}

	async function postpone(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const planned = plannedDay(args.when, day);
		if (typeof planned === "string") return planned;
		const named = await namedFollowUp(args, ctx);
		if (typeof named === "string") return named;
		const { card, fu } = named;
		if (fu === undefined) return named.wanted === undefined ? "Questo cliente non ha ricontatti aperti da spostare." : "Errore: questo cliente non ha un ricontatto con quel numero.";
		if (fu.done !== undefined) return `Il ricontatto ${fu.id} è già segnato come fatto: non lo sposto. Se c'è da risentirlo, fissane uno nuovo.`;
		const again = store.read().calls.includes(ctx.callId);
		const old = await oldReminder(ctx, fu);
		let reminded: Reminded | undefined;
		if (!again) {
			if (fu.date === planned.date) return `Il ricontatto ${fu.id} è già fissato per ${nearDay(fu.date, day)}.`;
			reminded = env.reminders === undefined ? { problem: NO_SEAM } : await env.reminders.remind({ day: planned.date, hour: FOLLOW_UP_HOUR, instruction: reminderInstruction(fu.id) }, reminderKey(fu.id), ctx);
			const link = reminded !== undefined && "id" in reminded ? { scheduleId: reminded.id, scheduleCall: reminded.call } : {};
			const by = env.marker(ctx);
			try {
				store.update(ctx.callId, (state) => ({
					...state,
					cards: state.cards.map((c) =>
						c.id !== card.id
							? c
							: {
									...c,
									followUps: c.followUps.map((f) => {
										if (f.id !== fu.id || f.done !== undefined) return f;
										const { scheduleId: _id, scheduleCall: _call, ...rest } = f;
										return { ...rest, date: planned.date, ...link };
									}),
									edited: by,
								},
					),
				}));
			} catch (error) {
				if (reminded !== undefined && "id" in reminded && env.reminders !== undefined) await env.reminders.cancel(reminded.id, reminded.call);
				throw error;
			}
		}
		const now = env
			.cards()
			.find((c) => c.id === card.id)
			?.followUps.find((f) => f.id === fu.id);
		if (now === undefined) return "Errore: il ricontatto non risulta salvato: ripeti la richiesta.";
		// The old reminder on every run, once the ricontatto has its new one.
		await cancelOld(old, now.scheduleId);
		await env.audit(ctx, "postpone", 1);
		const lines = [...planned.notes, `Ricontatto ${now.id} spostato a ${nearDay(now.date, day)}.`, await reminderLine(now, reminded, day, ctx)];
		lines.push(fenced([`Cliente: ${card.name}`, ...(now.text === undefined ? [] : [`Da fare: ${now.text}`])].join("\n")));
		return lines.join("\n");
	}

	async function cancelFollowUp(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		if (store.read().calls.includes(ctx.callId)) {
			// Run again after the write: the ricontatto is gone; its reminder as recorded is taken away.
			await cancelOld(await oldReminder(ctx, undefined));
			await env.audit(ctx, "cancel_follow_up", 1);
			return "Fatto, il ricontatto è tolto, senza segnarlo come fatto.";
		}
		const named = await namedFollowUp(args, ctx);
		if (typeof named === "string") return named;
		const { card, fu } = named;
		if (fu === undefined) return named.wanted === undefined ? "Questo cliente non ha ricontatti aperti da togliere." : "Errore: questo cliente non ha un ricontatto con quel numero.";
		if (fu.done !== undefined) return `Il ricontatto ${fu.id} è già segnato come fatto: resta nella storia del cliente.`;
		const old = await oldReminder(ctx, fu);
		const by = env.marker(ctx);
		// The ricontatto first, then its reminder: a reminder never outlives what it reminds.
		store.update(ctx.callId, (state) => ({ ...state, cards: state.cards.map((c) => (c.id !== card.id ? c : { ...c, followUps: c.followUps.filter((f) => f.id !== fu.id), edited: by })) }));
		const cancelled = await cancelOld(old);
		await env.audit(ctx, "cancel_follow_up", 1);
		return [`Fatto, ho tolto il ricontatto ${fu.id} di ${nearDay(fu.date, day)}, senza segnarlo come fatto${cancelWords(cancelled)}.`, fenced([`Cliente: ${card.name}`, ...(fu.text === undefined ? [] : [`Era da fare: ${fu.text}`])].join("\n"))].join("\n");
	}

	async function done(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const fuSaid = followUpSaid(args);
		if (isProblem(fuSaid)) return `Errore: ${fuSaid.problem}.`;
		const name = clientSaid(args) ?? fuSaid;
		if (name === undefined) return "Errore: dimmi quale cliente hai sentito.";
		let outcome: string | undefined;
		if (args.note !== undefined && args.note !== "") {
			const n = textOf(args.note, CLIENT_LIMITS.noteChars, "com'è andata");
			if (isProblem(n)) return `Errore: ${n.problem}.`;
			outcome = n;
		}
		const planned = args.when === undefined || args.when === "" ? undefined : plannedDay(args.when, day);
		if (typeof planned === "string") return planned;
		const wanted = fuSaid ?? (FOLLOW_UP_ID.test(name.toUpperCase()) ? name.toUpperCase() : undefined);
		const chosen = env.target(await env.clients(ctx), name, wanted !== undefined ? "exact" : "ask");
		if (typeof chosen === "string") return chosen;
		const before = chosen.client?.card === undefined ? undefined : env.cards().find((c) => c.id === chosen.client?.card?.id);
		// A call run again finds the ricontatto it marked; otherwise the one named, or the next open one.
		const mine = before?.followUps.find((f) => f.doneCall === ctx.callId);
		const fu = mine ?? (wanted !== undefined ? before?.followUps.find((f) => f.id === wanted) : openFollowUps(before)[0]);
		if (wanted !== undefined && fu === undefined) return "Errore: questo cliente non ha un ricontatto con quel numero.";
		if (fu?.done !== undefined && mine === undefined) return `Il ricontatto ${fu.id} era già segnato come fatto.`;
		const old = await oldReminder(ctx, fu);
		const by = env.marker(ctx);
		const written = await writeCard(
			ctx,
			chosen,
			(card, next) => {
				const entry: ContactEntry = { date: day, ...(outcome === undefined ? {} : { note: outcome }), ...(fu === undefined ? {} : { done: fu.id }), ...(next === undefined ? {} : { next: next.id }), ...by };
				let c: ClientCard = { ...card, followUps: card.followUps.map((f) => (f.id === fu?.id && f.done === undefined ? { ...f, done: by, doneCall: ctx.callId } : f)), log: [...(card.log ?? []), entry].slice(-CLIENT_LIMITS.log), edited: by };
				if (next !== undefined) {
					const withNext = withFollowUp(c, next, by);
					if (typeof withNext === "string") return withNext;
					c = withNext;
				}
				return c;
			},
			planned === undefined ? undefined : { date: planned.date },
		);
		// The reminder of the ricontatto done, on every run.
		const cancelled = await cancelOld(old);
		await env.audit(ctx, "done", 1);
		const card = env.cardNamed(chosen.name, chosen.client);
		if (card === undefined) return "Errore: il contatto non risulta salvato: ripeti la richiesta.";
		const lines = [fu === undefined ? `Fatto: ho segnato che l'hai sentito oggi, ${written.created ? `nella nuova scheda ${card.id}` : `nella scheda ${card.id}`}.` : `Fatto: ricontatto ${fu.id} di ${nearDay(fu.date, day)} segnato come fatto${cancelWords(cancelled)}.`, ...chosen.notes];
		const next = card.followUps.find((f) => f.callId === ctx.callId && f.done === undefined);
		if (planned !== undefined) lines.push(...planned.notes);
		if (next !== undefined) lines.push(`Prossimo ricontatto fissato per ${nearDay(next.date, day)} (${next.id}).`, await reminderLine(next, written.reminded, day, ctx));
		else {
			const other = openFollowUps(card).filter((f) => f.id !== fu?.id)[0];
			if (other !== undefined) lines.push(`Il prossimo è ${nearDay(other.date, day)} (${other.id}).`);
		}
		lines.push(fenced([`Cliente: ${card.name}`, ...(fu?.text === undefined ? [] : [`Era da fare: ${fu.text}`]), ...(outcome === undefined ? [] : [`Com'è andata: ${outcome}`])].join("\n")));
		return lines.join("\n");
	}

	return { writeCard, followUp, postpone, cancelFollowUp, done };
}
