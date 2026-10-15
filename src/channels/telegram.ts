import type { ChannelAdapter, InboundMessage, OutboundMessage } from "./types.ts";

export type TelegramAdapterOptions = {
	readonly token: string;
	/** The instance this bot belongs to. */
	readonly tenantId: string;
	readonly instanceId: string;
	/** Injected for tests; defaults to the global fetch. */
	readonly fetch?: typeof fetch;
	readonly apiBase?: string;
	/** Long-polling timeout in seconds. */
	readonly pollTimeoutSec?: number;
	/** Wait after a failed poll before the next one. */
	readonly retryDelayMs?: number;
	readonly log?: (message: string) => void;
};

/** Telegram's limit for one message's text. */
export const TELEGRAM_MAX_TEXT = 4096;

/** First line of a reply resent after a crash: sendMessage has no idempotency key. */
export const DUPLICATE_NOTICE = "Possibile doppione: mi sono riavviata mentre ti inviavo questa risposta. Se l'hai già ricevuta, ignora questa.";

type TelegramUpdate = {
	update_id: number;
	message?: {
		message_id: number;
		chat: { id: number };
		from?: { id: number };
		text?: string;
	};
};

type TelegramResponse<T> = { ok: true; result: T } | { ok: false; description?: string; error_code?: number };

/** Telegram Bot API over long polling (getUpdates), with plain fetch. Text messages only. */
export class TelegramAdapter implements ChannelAdapter {
	readonly name = "telegram";
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private abort: AbortController | undefined;
	private loop: Promise<void> | undefined;
	private offset: number | undefined;
	private readonly fetch: typeof fetch;
	private readonly apiBase: string;

	constructor(private readonly options: TelegramAdapterOptions) {
		this.fetch = options.fetch ?? fetch;
		this.apiBase = options.apiBase ?? "https://api.telegram.org";
	}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (this.loop !== undefined) return;
		this.abort = new AbortController();
		this.loop = this.poll(this.abort.signal);
	}

	async stop(): Promise<void> {
		this.abort?.abort();
		await this.loop;
		this.loop = undefined;
	}

	async send(message: OutboundMessage): Promise<void> {
		const text = message.possibleDuplicate === true ? `${DUPLICATE_NOTICE}\n\n${message.text}` : message.text;
		for (const chunk of splitText(text)) {
			await this.call("sendMessage", { chat_id: message.threadId, text: chunk });
		}
	}

	/** One getUpdates round; exposed for tests. Returns the number of updates handled. */
	async pollOnce(signal?: AbortSignal): Promise<number> {
		const updates = await this.call<TelegramUpdate[]>(
			"getUpdates",
			{
				timeout: this.options.pollTimeoutSec ?? 30,
				allowed_updates: ["message"],
				...(this.offset === undefined ? {} : { offset: this.offset }),
			},
			signal,
		);
		for (const update of updates) {
			// Confirmed on the next getUpdates. A redelivery after a crash carries the same
			// message ID, which the core turns into an idempotent request.
			this.offset = update.update_id + 1;
			const message = update.message;
			if (message?.text === undefined || this.handler === undefined) continue;
			await this.handler({
				tenantId: this.options.tenantId,
				instanceId: this.options.instanceId,
				channel: this.name,
				threadId: String(message.chat.id),
				userId: String(message.from?.id ?? message.chat.id),
				text: message.text,
				messageId: `${message.chat.id}:${message.message_id}`,
			});
		}
		return updates.length;
	}

	private async poll(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.pollOnce(signal);
			} catch (error) {
				if (signal.aborted) return;
				this.options.log?.(`telegram: poll failed: ${error instanceof Error ? error.message : String(error)}`);
				await delay(this.options.retryDelayMs ?? 1000, signal);
			}
		}
	}

	private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const response = await this.fetch(`${this.apiBase}/bot${this.options.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});
		const payload = (await response.json()) as TelegramResponse<T>;
		// Never include the URL in errors: it contains the bot token.
		if (!payload.ok) throw new Error(`Telegram ${method} failed: ${payload.error_code ?? response.status} ${payload.description ?? ""}`.trim());
		return payload.result;
	}
}

export function splitText(text: string, max = TELEGRAM_MAX_TEXT): string[] {
	if (text.length === 0) return ["(risposta vuota)"];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
	return chunks;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
