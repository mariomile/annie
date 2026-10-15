import type { AnnieTool } from "../engine.ts";
import { ScheduleError, type ScheduleStore } from "../schedules.ts";

/**
 * Tools to create, list and delete tasks programmati. A task created in a conversation
 * delivers its results to that same conversation.
 */
export function createScheduleTools(options: { readonly store: ScheduleStore; readonly defaultTimeZone: string; readonly now?: () => Date }): AnnieTool[] {
	const { store } = options;
	const now = options.now ?? (() => new Date());
	return [
		{
			name: "schedule_create",
			description:
				"Schedule an instruction for yourself to run later, once (at) or repeatedly (cron), with the result sent to this conversation. " +
				"Use it for reminders, recurring reports and checks. cron has 5 fields in the given time zone, e.g. '30 8 * * 1-5' = weekdays at 8:30.",
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
}
