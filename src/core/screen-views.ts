/**
 * What the agente last saw on its screen (ADR 0067), per conversation: the console shows it next
 * to the chat, so the person follows the work live. Only screenshots the agente took itself, in
 * that conversation: watching never starts a screen, nor shows what it did for someone else.
 * Kept in memory, the latest few hundred and at most SCREEN_VIEWS_BYTES: after a restart the panel
 * waits for the next action.
 */
export type ScreenView = {
	readonly png: Uint8Array;
	/** Grows with each picture, so the console fetches a picture only when it changed. */
	readonly version: number;
	readonly at: string;
	/** What it just did («Clic in 120, 300.»), or undefined after a plain look. */
	readonly action?: string;
};

export const SCREEN_VIEWS_LIMIT = 300;
export const SCREEN_VIEWS_BYTES = 200 * 1024 * 1024;

export class ScreenViews {
	private readonly views = new Map<string, ScreenView>();
	/** From the clock: a tab open across a restart does not take a new picture for the one it has. */
	private version = Date.now();
	private bytes = 0;
	/** When each agente's pictures were last forgotten: one asked for before then arrives too late. */
	private readonly forgotten = new Map<string, number>();

	private key(agent: string, channel: string, threadId: string): string {
		return `${agent}\n${channel}\n${threadId}`;
	}

	/** `askedAt`: when the picture was asked for; one asked for before a reset or a deletion is dropped. */
	set(agent: string, thread: { readonly channel: string; readonly threadId: string }, png: Uint8Array, action?: string, askedAt = Date.now(), now = new Date()): void {
		if (askedAt <= (this.forgotten.get(agent) ?? -Infinity)) return;
		const key = this.key(agent, thread.channel, thread.threadId);
		this.drop(key);
		this.version += 1;
		this.views.set(key, { png, version: this.version, at: now.toISOString(), ...(action === undefined ? {} : { action }) });
		this.bytes += png.length;
		while (this.views.size > SCREEN_VIEWS_LIMIT || (this.bytes > SCREEN_VIEWS_BYTES && this.views.size > 1)) this.drop(this.views.keys().next().value as string);
	}

	get(agent: string, channel: string, threadId: string): ScreenView | undefined {
		return this.views.get(this.key(agent, channel, threadId));
	}

	/** An agente deleted, or its screen reset: what it showed goes. */
	forget(agent: string): void {
		this.forgotten.set(agent, Date.now());
		for (const key of [...this.views.keys()]) if (key.startsWith(`${agent}\n`)) this.drop(key);
	}

	private drop(key: string): void {
		const view = this.views.get(key);
		if (view === undefined) return;
		this.bytes -= view.png.length;
		this.views.delete(key);
	}
}
