import { UserNotAllowed } from "./errors.ts";
import { schedulePerson, type ScheduleStore } from "./schedules.ts";

export type SchedulerTarget = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly store: ScheduleStore;
	/** Admit the run into the instance (AnnieRuntime.submitScheduled). */
	readonly submit: (request: { channel: string; threadId: string; text: string; messageId: string; scheduleId: string; onBehalfOf: { channel: string; userId: string } | undefined }) => Promise<unknown>;
};

/**
 * Fires due schedules. Each run is admitted with a message ID derived from the schedule and
 * the planned time, so a crash between admitting a run and recording it fires it again
 * with the same ID, and the core admits it once.
 */
export class Scheduler {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly targets: () => Promise<readonly SchedulerTarget[]>,
		private readonly log: (message: string) => void = console.error,
	) {}

	/** One pass over every instance. Returns the runs admitted. */
	async tick(now = new Date()): Promise<number> {
		let fired = 0;
		for (const target of await this.targets()) {
			for (const schedule of await target.store.due(now)) {
				const plannedFor = schedule.nextRunAt as string;
				try {
					await target.submit({
						channel: schedule.channel,
						threadId: schedule.threadId,
						text: `[Task programmato ${schedule.id}] ${schedule.instruction}`,
						messageId: `schedule:${schedule.id}:${plannedFor}`,
						scheduleId: schedule.id,
						onBehalfOf: schedulePerson(schedule),
					});
					await target.store.advance(schedule, plannedFor, now);
					fired++;
				} catch (error) {
					if (error instanceof UserNotAllowed) {
						// Its person lost access: it must not keep sending them anything.
						await target.store.disable(schedule, "the person it acts for is no longer allowed").catch(() => {});
						this.log(`scheduler: ${target.tenantId}/${target.instanceId} schedule ${schedule.id} disabled: its person is no longer allowed`);
						continue;
					}
					// Left due: tried again on the next tick.
					this.log(`scheduler: ${target.tenantId}/${target.instanceId} schedule ${schedule.id} not fired: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		return fired;
	}

	start(intervalMs = 30_000): void {
		const loop = () => {
			this.running = this.tick().catch((error: unknown) => this.log(`scheduler: ${error instanceof Error ? error.message : String(error)}`));
			void this.running.then(() => {
				if (this.timer !== undefined) this.timer = setTimeout(loop, intervalMs);
			});
		};
		this.timer = setTimeout(loop, 0);
	}

	async stop(): Promise<void> {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		await this.running;
	}
}
