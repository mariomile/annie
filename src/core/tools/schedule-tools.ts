import { AGENT_CHANNEL } from "../agent-messages.ts";
import { nextRun, parseCron } from "../cron.ts";
import type { AnnieTool, ToolContext } from "../engine.ts";
import { addDays, todayIn } from "../italian-calendar.ts";
import { ScheduleError, type ScheduleStore } from "../schedules.ts";

type ScheduleToolsOptions = { readonly store: ScheduleStore; readonly defaultTimeZone: string; readonly now?: () => Date };

/** A reminder another tool makes for the person: on `day` (ISO) at `hour` where the instance is, in the call's conversation. */
export type ReminderInput = { readonly day: string; readonly hour: number; readonly instruction: string };

/**
 * The tasks programmati for another tool (a client's ricontatto): the same store and limits as
 * schedule_create, the same refusals (no conversation, another agente, the phone). `remind` makes
 * a one-off task keyed by the calling tool's callId and `key`, so a call run again finds the one
 * it made instead of making another; `cancel` removes one (false when it is gone already).
 */
export type ReminderSeam = {
	readonly remind: (input: ReminderInput, key: string, ctx: ToolContext) => Promise<{ readonly id: string; readonly at: string } | { readonly problem: string }>;
	readonly cancel: (id: string) => Promise<boolean>;
};

/**
 * Tools to create, list and delete tasks programmati. A task created in a conversation
 * delivers its results to that same conversation.
 */
export function createScheduleTools(options: ScheduleToolsOptions): AnnieTool[] {
	return schedulesOf(options).tools;
}

/** The schedule tools, and the same schedules' reminders for another tool. */
export function schedulesOf(options: ScheduleToolsOptions): { readonly tools: AnnieTool[]; readonly reminders: ReminderSeam } {
	const { store } = options;
	const now = options.now ?? (() => new Date());
	const timeZone = options.defaultTimeZone;
	const reminders: ReminderSeam = {
		async remind(input, key, ctx) {
			const thread = ctx.thread;
			if (thread === undefined) return { problem: "un promemoria va creato in una conversazione" };
			if (thread.channel === AGENT_CHANNEL) return { problem: "in una richiesta di un altro agente non programmo promemoria" };
			if (thread.channel === "phone") return { problem: "al telefono non programmo promemoria, perché non chiamo per prima" };
			const callId = `${ctx.callId}:${key}`;
			const made = (await store.list()).find((s) => s.callId === callId);
			if (made !== undefined) return { id: made.id, at: made.nextRunAt ?? ("at" in made.when ? made.when.at : "") };
			const at = reminderTime(input, now(), timeZone);
			if (at === undefined) return { problem: "il giorno del promemoria è già passato" };
			try {
				const s = await store.create({ instruction: input.instruction, channel: thread.channel, threadId: thread.threadId, when: { at: at.toISOString() }, createdBy: { kind: "instance" }, callId }, now());
				return { id: s.id, at: s.nextRunAt ?? at.toISOString() };
			} catch (error) {
				if (error instanceof ScheduleError) return { problem: "non ho potuto programmare il promemoria: ci sono già troppi task programmati, o la data non va" };
				throw error;
			}
		},
		cancel: (id) => store.remove(id),
	};
	const tools: AnnieTool[] = [
		{
			name: "schedule_create",
			description:
				"Schedule an instruction for yourself to run later, once (at) or repeatedly (cron), with the result sent to this conversation. " +
				"Use it for reminders and recurring reports; to be told when a page or a price changes, use watch_create instead. cron has 5 fields in the given time zone, e.g. '30 8 * * 1-5' = weekdays at 8:30.",
			parameters: {
				type: "object",
				properties: {
					instruction: { type: "string", description: "What to do when it fires, written as a request to yourself", minLength: 1, maxLength: 2000 },
					at: { type: "string", description: "ISO 8601 date-time for a one-off run, with offset, e.g. 2026-10-20T09:00:00+02:00" },
					cron: { type: "string", description: "5-field cron for a recurring run" },
					timeZone: { type: "string", description: `IANA time zone for cron (default ${options.defaultTimeZone})` },
				},
				required: ["instruction"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (ctx.thread === undefined) return "Errore: un task programmato va creato in una conversazione.";
				const thread = ctx.thread;
				// Annie never calls first: a reminder set on a call would only be heard at the next one.
				// A colleague's question gets an answer, not a task: nobody in that conversation could receive it.
				if (thread.channel === "agente") return "Errore: in una richiesta di un altro agente non posso programmare task. Rispondi a quello che chiede; il task lo crea chi te l'ha chiesto, nella sua conversazione.";
				if (thread.channel === "phone") return "Errore: al telefono non posso programmare task, perché non chiamo per prima. Chiedi alla persona di farlo su Telegram, WhatsApp o nella console.";
				if ((args.at === undefined) === (args.cron === undefined)) return "Errore: indica at (una volta) oppure cron (ripetuto), non entrambi.";
				// Once per call, also when the call reruns after a crash.
				const result = await ctx.step("create", async () => {
					try {
						const s = await store.create(
							{
								instruction: String(args.instruction),
								channel: thread.channel,
								threadId: thread.threadId,
								when: args.at !== undefined ? { at: String(args.at) } : { cron: String(args.cron), timeZone: typeof args.timeZone === "string" ? args.timeZone : options.defaultTimeZone },
								createdBy: { kind: "instance" },
							},
							now(),
						);
						return `Creato il task ${s.id}: prossima esecuzione ${s.nextRunAt}.`;
					} catch (error) {
						if (error instanceof ScheduleError) return `Errore: ${error.message}`;
						throw error;
					}
				});
				return result;
			},
		},
		{
			name: "schedule_list",
			description: "List your tasks programmati with their next run.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			replaySafe: true,
			async execute() {
				const all = await store.list();
				if (all.length === 0) return "Nessun task programmato.";
				return all
					.map((s) => `${s.id}\t${"at" in s.when ? `una volta ${s.when.at}` : `cron ${s.when.cron} (${s.when.timeZone})`}\tprossima: ${s.nextRunAt ?? "finito"}\t${s.instruction.slice(0, 120)}`)
					.join("\n");
			},
		},
		{
			name: "schedule_delete",
			description: "Delete a task programmato by its ID.",
			parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
			replaySafe: true,
			async execute(args) {
				return (await store.remove(String(args.id))) ? `Eliminato il task ${String(args.id)}.` : `Nessun task con ID ${String(args.id)}.`;
			},
		},
	];
	return { tools, reminders };
}

/** The instant of `hour` on `day` where the instance is; for today past that hour, in two minutes; undefined for a day gone. */
function reminderTime(input: ReminderInput, now: Date, timeZone: string): Date | undefined {
	const today = todayIn(timeZone, now);
	if (input.day < today) return undefined;
	const [, month, day] = input.day.split("-").map(Number);
	// From the day before (never before now), so a day next year is not taken for this year's.
	const from = new Date(Math.max(now.getTime(), Date.parse(`${addDays(input.day, -1)}T12:00:00Z`)));
	const next = nextRun(parseCron(`0 ${input.hour} ${day} ${month} *`), from, timeZone);
	if (todayIn(timeZone, next) === input.day) return next;
	return input.day === today ? new Date(now.getTime() + 2 * 60_000) : undefined;
}
