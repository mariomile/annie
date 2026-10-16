import { type ActionButton, type ChannelAdapter, ChannelRefused, type InboundAction, type InboundMessage, type OutboundMessage } from "./types.ts";

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

/** A handler that fails this many times on the same update gives it up. */
const MAX_UPDATE_FAILURES = 3;

/** Telegram's limit for a button's callback_data, in bytes. */
export const TELEGRAM_MAX_CALLBACK_DATA = 64;

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
	callback_query?: {
		id: string;
		from: { id: number };
		message?: { message_id: number; chat: { id: number } };
		data?: string;
	};
};

type TelegramResponse<T> = { ok: true; result: T } | { ok: false; description?: string; error_code?: number };

/** Telegram Bot API over long polling (getUpdates), with plain fetch. Text messages only. */
export class TelegramAdapter implements ChannelAdapter {
	readonly name = "telegram";
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private actionHandler: ((action: InboundAction) => Promise<void>) | undefined;
	private readonly failures = new Map<number, number>();
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

	onAction(handler: (action: InboundAction) => Promise<void>): void {
		this.actionHandler = handler;
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
		const markup = message.buttons === undefined || message.buttons.length === 0 ? undefined : inlineKeyboard(message.buttons);
		const chunks = splitText(text);
		for (const [i, chunk] of chunks.entries()) {
			const last = i === chunks.length - 1;
			await this.call("sendMessage", { chat_id: message.threadId, text: chunk, ...(last && markup !== undefined ? { reply_markup: markup } : {}) });
		}
	}

	/** One getUpdates round; exposed for tests. Returns the number of updates handled. */
	async pollOnce(signal?: AbortSignal): Promise<number> {
		const updates = await this.call<TelegramUpdate[]>(
			"getUpdates",
			{
				timeout: this.options.pollTimeoutSec ?? 30,
				// Taps are requested only when someone handles them: otherwise they would be dropped.
				allowed_updates: this.actionHandler === undefined ? ["message"] : ["message", "callback_query"],
				...(this.offset === undefined ? {} : { offset: this.offset }),
			},
			signal,
		);
		for (const update of updates) {
			// Confirmed on the next getUpdates. A redelivery after a crash carries the same
			// message ID, which the core turns into an idempotent request.
			this.offset = update.update_id + 1;
			try {
				await this.dispatch(update);
			} catch (error) {
				const failures = (this.failures.get(update.update_id) ?? 0) + 1;
				if (failures >= MAX_UPDATE_FAILURES) {
					this.failures.delete(update.update_id);
					this.options.log?.(`telegram: update ${update.update_id} dropped after ${failures} failed attempts: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				// Not confirmed: Telegram delivers this update again on the next poll.
				this.failures.set(update.update_id, failures);
				this.offset = update.update_id;
				throw error;
			}
			this.failures.delete(update.update_id);
		}
		return updates.length;
	}

	private async dispatch(update: TelegramUpdate): Promise<void> {
		if (update.callback_query !== undefined) return this.handleTap(update.callback_query);
		const message = update.message;
		if (message?.text === undefined || this.handler === undefined) return;
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

	private async handleTap(tap: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
		// Answer first, so the button stops spinning even if the handler takes a while. A tap
		// redelivered after a crash is often too old to answer: log it and handle it anyway.
		await this.call("answerCallbackQuery", { callback_query_id: tap.id }).catch((error: unknown) => {
			this.options.log?.(`telegram: answerCallbackQuery failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (this.actionHandler === undefined || tap.data === undefined || tap.message === undefined) return;
		await this.actionHandler({
			tenantId: this.options.tenantId,
			instanceId: this.options.instanceId,
			channel: this.name,
			threadId: String(tap.message.chat.id),
			userId: String(tap.from.id),
			data: tap.data,
			actionId: tap.id,
		});
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
		if (!payload.ok) throw new ChannelRefused(`Telegram ${method} failed: ${payload.error_code ?? response.status} ${payload.description ?? ""}`.trim());
		return payload.result;
	}
}

export function splitText(text: string, max = TELEGRAM_MAX_TEXT): string[] {
	if (text.length === 0) return ["(risposta vuota)"];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
	return chunks;
}

function inlineKeyboard(buttons: readonly ActionButton[]): { inline_keyboard: { text: string; callback_data: string }[][] } {
	for (const button of buttons) {
		if (Buffer.byteLength(button.data, "utf8") > TELEGRAM_MAX_CALLBACK_DATA) {
			throw new Error(`Telegram button "${button.label}": callback data over ${TELEGRAM_MAX_CALLBACK_DATA} bytes`);
		}
	}
	return { inline_keyboard: [buttons.map((button) => ({ text: button.label, callback_data: button.data }))] };
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
