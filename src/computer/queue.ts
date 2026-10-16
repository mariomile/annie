/** One operation at a time per computer: no start, stop or sweep under a running command. */
export class PerKey {
	private readonly locks = new Map<string, Promise<unknown>>();

	/** Runs `work` after every operation already queued for `key`. */
	run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const result = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
		const tail = result.catch(() => {});
		this.locks.set(key, tail);
		void tail.then(() => {
			if (this.locks.get(key) === tail) this.locks.delete(key);
		});
		return result;
	}

	/** Something is queued or running for `key`. */
	has(key: string): boolean {
		return this.locks.has(key);
	}
}

/** At most `max` commands at once on this server; the others wait their turn. */
export class Slots {
	private readonly queue: (() => void)[] = [];
	private busy = 0;

	constructor(private readonly max: number) {}

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.busy >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
		else this.busy += 1;
		try {
			return await work();
		} finally {
			const next = this.queue.shift();
			if (next === undefined) this.busy -= 1;
			else next();
		}
	}
}
