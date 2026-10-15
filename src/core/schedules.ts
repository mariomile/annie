import { randomBytes } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import { assertTimeZone, nextRun, parseCron } from "./cron.ts";

/** A task programmato: an instruction the instance runs by itself, delivered to a thread. */
export type Schedule = {
	readonly id: string;
	readonly instruction: string;
	readonly channel: string;
	readonly threadId: string;
	readonly when: { readonly at: string } | { readonly cron: string; readonly timeZone: string };
	/** Next time it fires; null once a one-off has run. */
	readonly nextRunAt: string | null;
	readonly lastRunAt?: string;
	readonly createdBy: { readonly kind: "person"; readonly channel: string; readonly userId: string } | { readonly kind: "instance" };
	readonly createdAt: string;
};

export type NewSchedule = {
	readonly instruction: string;
	readonly channel: string;
	readonly threadId: string;
	readonly when: Schedule["when"];
	readonly createdBy: Schedule["createdBy"];
};

/** Limits that keep a runaway instance from flooding itself. */
export const SCHEDULE_LIMITS = { maxPerInstance: 50, minIntervalMinutes: 5, maxInstructionChars: 2000 } as const;

export class ScheduleError extends Error {
	override readonly name = "ScheduleError";
}

/** The schedules of one instance: one JSON file each, written atomically. */
export class ScheduleStore {
	constructor(private readonly dir: string) {}

	async create(input: NewSchedule, now = new Date()): Promise<Schedule> {
		if (input.instruction.trim() === "") throw new ScheduleError("Empty instruction");
		if (input.instruction.length > SCHEDULE_LIMITS.maxInstructionChars) throw new ScheduleError(`Instruction over ${SCHEDULE_LIMITS.maxInstructionChars} characters`);
		if ((await this.list()).length >= SCHEDULE_LIMITS.maxPerInstance) throw new ScheduleError(`At most ${SCHEDULE_LIMITS.maxPerInstance} schedules per instance`);
		const nextRunAt = firstRun(input.when, now);
		const schedule: Schedule = { ...input, id: randomBytes(6).toString("hex"), nextRunAt, createdAt: now.toISOString() };
		await this.save(schedule);
		return schedule;
	}

	async get(id: string): Promise<Schedule | undefined> {
		try {
			return JSON.parse(await readFile(this.file(id), "utf8")) as Schedule;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async list(): Promise<Schedule[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const all = await Promise.all(names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => this.get(n.slice(0, -5))));
		return all.filter((s): s is Schedule => s !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async remove(id: string): Promise<boolean> {
		if (!/^[0-9a-f]{12}$/.test(id)) return false;
		try {
			await unlink(this.file(id));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/** Due at `now`: nextRunAt reached. */
	async due(now: Date): Promise<Schedule[]> {
		return (await this.list()).filter((s) => s.nextRunAt !== null && Date.parse(s.nextRunAt) <= now.getTime());
	}

	/**
	 * Record that the run planned for `ranFor` happened. A one-off ends; a recurring one moves
	 * to its first run after `now`, so a long downtime gives one catch-up run, not many.
	 */
	async advance(schedule: Schedule, ranFor: string, now: Date): Promise<Schedule> {
		const next = "at" in schedule.when ? null : nextRun(parseCron(schedule.when.cron), now, schedule.when.timeZone).toISOString();
		const updated: Schedule = { ...schedule, nextRunAt: next, lastRunAt: ranFor };
		await this.save(updated);
		return updated;
	}

	private save(schedule: Schedule): Promise<void> {
		return writeFileAtomic(this.file(schedule.id), `${JSON.stringify(schedule, null, 2)}\n`);
	}

	private file(id: string): string {
		return join(this.dir, `${id}.json`);
	}
}

function firstRun(when: Schedule["when"], now: Date): string {
	if ("at" in when) {
		const at = Date.parse(when.at);
		if (Number.isNaN(at)) throw new ScheduleError(`Not a date: ${when.at}`);
		if (at < now.getTime() - 60_000) throw new ScheduleError(`In the past: ${when.at}`);
		return new Date(at).toISOString();
	}
	try {
		assertTimeZone(when.timeZone);
	} catch {
		throw new ScheduleError(`Unknown time zone: ${when.timeZone}`);
	}
	let cron;
	try {
		cron = parseCron(when.cron);
	} catch (error) {
		throw new ScheduleError(error instanceof Error ? error.message : String(error));
	}
	const first = nextRun(cron, now, when.timeZone);
	const second = nextRun(cron, first, when.timeZone);
	if (second.getTime() - first.getTime() < SCHEDULE_LIMITS.minIntervalMinutes * 60_000) {
		throw new ScheduleError(`Runs more often than every ${SCHEDULE_LIMITS.minIntervalMinutes} minutes`);
	}
	return first.toISOString();
}
