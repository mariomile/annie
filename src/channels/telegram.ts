import { audioName, type Transcribe, tooLong, voiceText } from "./voice.ts";
import { DUPLICATE_NOTICE, splitText as splitPieces } from "./text.ts";
import { type ActionButton, type ChannelAdapter, ChannelRefused, type InboundAction, type InboundMessage, type OutboundFile, type OutboundMessage } from "./types.ts";

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
	/** May this user's files be downloaded? Default: yes. Files of strangers should not. */
	readonly mayDownload?: (userId: string) => Promise<boolean>;
	/**
	 * Receive updates by webhook instead of long polling: Telegram pushes each update to
	 * `url`, with `secretToken` in a header. A process that can sleep (a cell) needs this.
	 */
	readonly webhook?: { readonly url: string; readonly secretToken: string };
	/** Voice messages to text; without it Annie is told transcription is off. */
	readonly transcribe?: Transcribe;
};

/** Telegram's limit for one message's text. */
export const TELEGRAM_MAX_TEXT = 4096;

/** A handler that fails this many times on the same update gives it up. */
const MAX_UPDATE_FAILURES = 3;

/** Largest file a bot can download. */
const TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024;

/** Telegram's limit for a document caption. */
const TELEGRAM_MAX_CAPTION = 1024;

/** Telegram's limit for a button's callback_data, in bytes. */
export const TELEGRAM_MAX_CALLBACK_DATA = 64;

/** First line of a reply resent after a crash: sendMessage has no idempotency key. */
export { DUPLICATE_NOTICE };

export type TelegramUpdate = {
	update_id: number;
	message?: {
		message_id: number;
		chat: { id: number; type?: string };
		from?: { id: number };
		text?: string;
		caption?: string;
		document?: { file_id: string; file_name?: string; file_size?: number };
		voice?: TelegramSound;
		audio?: TelegramSound;
	};
	callback_query?: {
		id: string;
		from: { id: number };
		message?: { message_id: number; chat: { id: number } };
		data?: string;
	};
};

/** A voice note or an audio file, as Telegram describes it. */
type TelegramSound = { file_id: string; duration?: number; mime_type?: string; file_size?: number; file_name?: string };

type TelegramResponse<T> = { ok: true; result: T } | { ok: false; description?: string; error_code?: number };

/** Telegram Bot API over long polling (getUpdates) or a webhook, with plain fetch. */
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
		const webhook = this.options.webhook;
		if (webhook !== undefined) {
			// Updates come to handleUpdate from now on. Telegram keeps them up to a day if we are down.
			await this.call("setWebhook", { url: webhook.url, secret_token: webhook.secretToken, allowed_updates: this.allowedUpdates() });
			this.loop = Promise.resolve();
			return;
		}
		// A webhook left from an earlier run makes getUpdates fail forever: polling removes it.
		await this.call("deleteWebhook", {}).catch((error: unknown) => this.options.log?.(`telegram: deleteWebhook failed: ${error instanceof Error ? error.message : String(error)}`));
		this.abort = new AbortController();
		this.loop = this.poll(this.abort.signal);
	}

	async stop(): Promise<void> {
		this.abort?.abort();
		await this.loop;
		this.loop = undefined;
	}

	/** The bot's own account: checks the token. */
	async me(): Promise<{ username: string | undefined }> {
		const me = await this.call<{ username?: string }>("getMe", {});
		return { username: me.username };
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

	/** sendDocument, multipart. Telegram bots can send files up to 50 MB. */
	async sendFile(file: OutboundFile): Promise<void> {
		const form = new FormData();
		form.set("chat_id", file.threadId);
		const caption = [file.possibleDuplicate === true ? DUPLICATE_NOTICE : undefined, file.caption].filter(Boolean).join("\n\n");
		if (caption !== "") form.set("caption", caption.slice(0, TELEGRAM_MAX_CAPTION));
		form.set("document", new Blob([Uint8Array.from(file.data)]), file.name);
		await this.call("sendDocument", form);
	}

	/** One getUpdates round; exposed for tests. Returns the number of updates handled. */
	async pollOnce(signal?: AbortSignal): Promise<number> {
		const updates = await this.call<TelegramUpdate[]>(
			"getUpdates",
			{
				timeout: this.options.pollTimeoutSec ?? 30,
				allowed_updates: this.allowedUpdates(),
				...(this.offset === undefined ? {} : { offset: this.offset }),
			},
			signal,
		);
		for (const update of updates) {
			// Confirmed on the next getUpdates. A redelivery after a crash carries the same
			// message ID, which the core turns into an idempotent request.
			this.offset = update.update_id + 1;
			try {
				await this.handleUpdate(update);
			} catch (error) {
				// Not confirmed: Telegram delivers this update again on the next poll.
				this.offset = update.update_id;
				throw error;
			}
		}
		return updates.length;
	}

	/**
	 * Handle one update, polled or pushed by the webhook. Throws while it fails, so Telegram
	 * delivers it again; after the third failure it is let go (logged), not retried forever.
	 */
	async handleUpdate(update: TelegramUpdate): Promise<void> {
		try {
			await this.dispatch(update);
		} catch (error) {
			const failures = (this.failures.get(update.update_id) ?? 0) + 1;
			if (failures >= MAX_UPDATE_FAILURES) {
				this.failures.delete(update.update_id);
				this.options.log?.(`telegram: update ${update.update_id} dropped after ${failures} failed attempts: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			this.failures.set(update.update_id, failures);
			throw error;
		}
		this.failures.delete(update.update_id);
	}

	// Taps are requested only when someone handles them: otherwise they would be dropped.
	private allowedUpdates(): string[] {
		return this.actionHandler === undefined ? ["message"] : ["message", "callback_query"];
	}

	private async dispatch(update: TelegramUpdate): Promise<void> {
		if (update.callback_query !== undefined) return this.handleTap(update.callback_query);
		const message = update.message;
		if (message === undefined || this.handler === undefined) return;
		const sound = message.voice ?? message.audio;
		if (message.text === undefined && message.document === undefined && sound === undefined) return;
		const userId = String(message.from?.id ?? message.chat.id);
		const mayDownload = (await this.options.mayDownload?.(userId)) ?? true;
		let text = message.text ?? message.caption ?? "";
		if (sound !== undefined) {
			// A stranger's voice is never downloaded, let alone sent to be transcribed.
			const words = mayDownload ? await this.voice(sound) : "[Messaggio vocale]";
			text = [words, text].filter(Boolean).join("\n\n");
		}
		const attachments = message.document === undefined || !mayDownload ? [] : [await this.download(message.document)];
		await this.handler({
			tenantId: this.options.tenantId,
			instanceId: this.options.instanceId,
			channel: this.name,
			threadId: String(message.chat.id),
			userId: String(message.from?.id ?? message.chat.id),
			text,
			privateThread: message.chat.type === "private",
			messageId: `${message.chat.id}:${message.message_id}`,
			...(attachments.length === 0 ? {} : { attachments }),
		});
	}

	/** The words of a voice or audio message; a note when there are none to give. */
	private async voice(sound: TelegramSound): Promise<string> {
		const transcribe = this.options.transcribe;
		// Too long is known from the update: nothing is downloaded for it.
		if (transcribe !== undefined && tooLong(sound.duration, transcribe.maxSeconds ?? Number.POSITIVE_INFINITY)) return "[Messaggio vocale troppo lungo da trascrivere. Chiedi di dividerlo o di scriverlo.]";
		const mimeType = sound.mime_type ?? "audio/ogg";
		let file: { name: string; data: Uint8Array };
		try {
			file = await this.download({ file_id: sound.file_id, file_name: audioName(mimeType, sound.file_name), ...(sound.file_size === undefined ? {} : { file_size: sound.file_size }) });
		} catch (error) {
			// Over the 20 MB a bot may download: said, not dropped.
			if (!(error instanceof ChannelRefused) || error.retryable) throw error;
			this.options.log?.(`telegram: voice not downloaded: ${error.message}`);
			return "[Messaggio vocale troppo grande o non disponibile.]";
		}
		return voiceText({ data: file.data, name: audioName(mimeType, file.name), mimeType, ...(sound.duration === undefined ? {} : { seconds: sound.duration }) }, transcribe, this.options.log);
	}

	/** getFile, then the file itself. Bots can download files up to 20 MB. */
	private async download(document: { file_id: string; file_name?: string; file_size?: number }): Promise<{ name: string; data: Uint8Array }> {
		if ((document.file_size ?? 0) > TELEGRAM_MAX_DOWNLOAD) throw new ChannelRefused(`Telegram file too large to download: ${document.file_size} bytes`);
		const file = await this.call<{ file_path?: string }>("getFile", { file_id: document.file_id });
		if (file.file_path === undefined) throw new ChannelRefused("Telegram getFile returned no file_path");
		const response = await this.fetch(`${this.apiBase}/file/bot${this.options.token}/${file.file_path}`);
		// Never include the URL in errors: it contains the bot token.
		if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
		// file_size can be missing: count while reading.
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			size += (chunk as Uint8Array).length;
			if (size > TELEGRAM_MAX_DOWNLOAD) {
				await response.body?.cancel().catch(() => {});
				throw new ChannelRefused(`Telegram file too large to download: over ${TELEGRAM_MAX_DOWNLOAD} bytes`);
			}
			chunks.push(chunk as Uint8Array);
		}
		return { name: document.file_name ?? file.file_path.split("/").at(-1) ?? "file", data: new Uint8Array(Buffer.concat(chunks)) };
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

	private async call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
		const multipart = body instanceof FormData;
		const response = await this.fetch(`${this.apiBase}/bot${this.options.token}/${method}`, {
			method: "POST",
			...(multipart ? {} : { headers: { "content-type": "application/json" } }),
			body: multipart ? body : JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});
		const payload = (await response.json()) as TelegramResponse<T>;
		// Never include the URL in errors: it contains the bot token.
		if (!payload.ok) {
			const code = payload.error_code ?? response.status;
			const message = `Telegram ${method} failed: ${code} ${payload.description ?? ""}`.trim();
			// Too many requests and Telegram's own errors are a "not now"; other 4xx are a no.
			throw new ChannelRefused(message, code === 429 || code >= 500);
		}
		return payload.result;
	}
}

export function splitText(text: string, max = TELEGRAM_MAX_TEXT): string[] {
	return splitPieces(text, max);
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
