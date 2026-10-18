/**
 * Sends that hold attachments in memory (some tens of MB each: the files and their base64): one
 * at a time per tenant, and at most a few in the whole process, so approvals that come together
 * cannot exhaust it, and one tenant's large send never holds up another's.
 */
export class AttachmentSlots {
	private readonly tenants = new Map<string, Promise<void>>();
	private running = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private readonly max = 2) {}

	/** `work` once this tenant's earlier runs are over and the process has a slot free. */
	async run<T>(tenant: string, work: () => Promise<T>): Promise<T> {
		const previous = this.tenants.get(tenant) ?? Promise.resolve();
		let done = () => {};
		const tail = previous.then(() => new Promise<void>((resolve) => (done = resolve)));
		this.tenants.set(tenant, tail);
		await previous;
		await this.take();
		try {
			return await work();
		} finally {
			this.give();
			done();
			if (this.tenants.get(tenant) === tail) this.tenants.delete(tenant);
		}
	}

	private async take(): Promise<void> {
		if (this.running < this.max) {
			this.running++;
			return;
		}
		// Woken by give(), which hands its slot over: `running` stays the same.
		await new Promise<void>((resolve) => this.waiting.push(resolve));
	}

	private give(): void {
		const next = this.waiting.shift();
		if (next === undefined) this.running--;
		else next();
	}
}

/** The process's slots for sends with attachments. */
export const attachmentSlots = new AttachmentSlots(2);
