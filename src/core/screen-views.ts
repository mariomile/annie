/**
 * What the agente last saw on its screen (ADR 0067), per conversation: the console shows it next
 * to the chat, so the person follows the work live. Only screenshots the agente took itself, in
 * that conversation: watching never starts a screen, nor shows what it did for someone else.
 * Kept in memory, the latest few hundred: after a restart the panel waits for the next action.
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

export class ScreenViews {
	private readonly views = new Map<string, ScreenView>();
	private version = 0;

	private key(agent: string, channel: string, threadId: string): string {
		return `${agent}\n${channel}\n${threadId}`;
	}

	set(agent: string, thread: { readonly channel: string; readonly threadId: string }, png: Uint8Array, action?: string, now = new Date()): void {
		const key = this.key(agent, thread.channel, thread.threadId);
		this.views.delete(key);
		this.version += 1;
		this.views.set(key, { png, version: this.version, at: now.toISOString(), ...(action === undefined ? {} : { action }) });
		if (this.views.size > SCREEN_VIEWS_LIMIT) this.views.delete(this.views.keys().next().value as string);
	}

	get(agent: string, channel: string, threadId: string): ScreenView | undefined {
		return this.views.get(this.key(agent, channel, threadId));
	}

	/** An agente deleted, or its screen reset: what it showed goes. */
	forget(agent: string): void {
		for (const key of [...this.views.keys()]) if (key.startsWith(`${agent}\n`)) this.views.delete(key);
	}
}
