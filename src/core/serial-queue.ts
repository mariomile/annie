/** Work under one key runs one at a time, in order; work under different keys does not wait. */
export class SerialQueue {
	private readonly chains = new Map<string, Promise<unknown>>();

	run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const run = (this.chains.get(key) ?? Promise.resolve()).then(work);
		const tail = run.catch(() => undefined);
		this.chains.set(key, tail);
		void tail.then(() => {
			if (this.chains.get(key) === tail) this.chains.delete(key);
		});
		return run;
	}

	/** Settles when the work queued so far has finished, however it ended. */
	async idle(): Promise<void> {
		await Promise.allSettled(this.chains.values());
	}
}
