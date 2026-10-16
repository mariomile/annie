import { createHmac } from "node:crypto";
import { sameSecret } from "../web/compare.ts";
import { DUPLICATE_NOTICE, splitText } from "./telegram.ts";
import { type ActionButton, type ChannelAdapter, ChannelRefused, type InboundAction, type InboundMessage, type OutboundFile, type OutboundMessage } from "./types.ts";

/**
 * WhatsApp through Meta's Cloud API: a business phone number, messages pushed to a webhook
 * (there is no polling), replies with plain fetch. Every chat is one person and the business,
 * so every thread is private. WhatsApp allows free-form replies only within 24 hours of the
 * person's last message: outside that window Meta refuses, and the refusal says so.
 */
export type WhatsAppCredentials = {
	/** A system user's access token with whatsapp_business_messaging. */
	readonly accessToken: string;
	/** The id of the business phone number (not the number itself). */
	readonly phoneNumberId: string;
	/** The Meta app's secret: Meta signs each webhook delivery with it. */
	readonly appSecret: string;
	/** What the webhook answers Meta's verification with; ours, random. */
	readonly verifyToken: string;
};

export type WhatsAppAdapterOptions = WhatsAppCredentials & {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly fetch?: typeof fetch;
	/** Graph API base with version; tests point it to a fake. */
	readonly apiBase?: string;
	readonly log?: (message: string) => void;
	/** May this person's files be downloaded? Files of strangers should not. */
	readonly mayDownload?: (userId: string) => Promise<boolean>;
};

export const WHATSAPP_GRAPH = "https://graph.facebook.com/v26.0";
/** WhatsApp's limit for one text message. */
const MAX_TEXT = 4096;
/** Reply buttons: at most three, titles up to 20 characters, ids up to 256. */
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
const MAX_BUTTON_ID = 256;
const MAX_CAPTION = 1024;
const MAX_INTERACTIVE_BODY = 1024;
/** Largest file Annie downloads from a chat. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;
/** Meta's error code for a free-form message outside the 24-hour window. */
const OUTSIDE_WINDOW = 131047;

type WhatsAppMessage = {
	from: string;
	id: string;
	type: string;
	text?: { body?: string };
	interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
	document?: { id?: string; filename?: string; mime_type?: string; caption?: string };
};
export type WhatsAppWebhook = { object?: string; entry?: { changes?: { field?: string; value?: { metadata?: { phone_number_id?: string }; messages?: WhatsAppMessage[] } }[] }[] };

export class WhatsAppAdapter implements ChannelAdapter {
	readonly name = "whatsapp";
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private actionHandler: ((action: InboundAction) => Promise<void>) | undefined;
	private readonly fetch: typeof fetch;
	private readonly apiBase: string;

	constructor(private readonly options: WhatsAppAdapterOptions) {
		this.fetch = options.fetch ?? fetch;
		this.apiBase = options.apiBase ?? WHATSAPP_GRAPH;
	}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	onAction(handler: (action: InboundAction) => Promise<void>): void {
		this.actionHandler = handler;
	}

	/** Messages arrive on the webhook; there is nothing to start or stop. */
	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	/** The business number as Meta shows it: checks token and phone number id together. */
	async me(): Promise<{ number: string | undefined; name: string | undefined }> {
		const found = await this.call<{ display_phone_number?: string; verified_name?: string }>("GET", `/${this.options.phoneNumberId}?fields=display_phone_number,verified_name`);
		return { number: found.display_phone_number, name: found.verified_name };
	}

	/** Meta's verification of the webhook: the challenge back, only with our token. */
	verify(query: URLSearchParams): string | undefined {
		if (query.get("hub.mode") !== "subscribe") return undefined;
		return sameSecret(query.get("hub.verify_token") ?? "", this.options.verifyToken) ? (query.get("hub.challenge") ?? undefined) : undefined;
	}

	/** Whether Meta signed this delivery: `sha256=` and the HMAC of the raw body with the app secret. */
	signed(rawBody: Buffer, header: string | undefined): boolean {
		const given = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
		if (given === undefined) return false;
		return sameSecret(given, createHmac("sha256", this.options.appSecret).update(rawBody).digest("hex"));
	}

	/** One webhook delivery: every message in it, in order. Throws if one fails, so Meta delivers again (the core dedupes by id). */
	async handleWebhook(payload: WhatsAppWebhook): Promise<void> {
		for (const entry of payload.entry ?? []) {
			for (const change of entry.changes ?? []) {
				// Deliveries for another number of the same app are not ours.
				if (change.field !== "messages" || change.value?.metadata?.phone_number_id !== this.options.phoneNumberId) continue;
				for (const message of change.value.messages ?? []) await this.dispatch(message);
			}
		}
	}

	async send(message: OutboundMessage): Promise<void> {
		const text = message.possibleDuplicate === true ? `${DUPLICATE_NOTICE}\n\n${message.text}` : message.text;
		const buttons = message.buttons ?? [];
		// A message with buttons holds at most 1024 characters: the text before goes as plain messages.
		const tail = buttons.length === 0 ? 0 : Math.min(text.length, MAX_INTERACTIVE_BODY);
		const head = text.slice(0, text.length - tail);
		const to = { messaging_product: "whatsapp", recipient_type: "individual", to: message.threadId };
		if (head !== "" || buttons.length === 0) {
			for (const chunk of splitText(head, MAX_TEXT)) await this.call("POST", `/${this.options.phoneNumberId}/messages`, { ...to, type: "text", text: { body: chunk, preview_url: false } });
		}
		if (buttons.length > 0) await this.call("POST", `/${this.options.phoneNumberId}/messages`, { ...to, type: "interactive", interactive: replyButtons(text.slice(text.length - tail) || "…", buttons) });
	}

	/** Upload, then send as a document. */
	async sendFile(file: OutboundFile): Promise<void> {
		const form = new FormData();
		form.set("messaging_product", "whatsapp");
		form.set("file", new Blob([Uint8Array.from(file.data)], { type: "application/octet-stream" }), file.name);
		form.set("type", "application/octet-stream");
		const uploaded = await this.call<{ id?: string }>("POST", `/${this.options.phoneNumberId}/media`, form);
		if (uploaded.id === undefined) throw new Error("WhatsApp media upload returned no id");
		const caption = [file.possibleDuplicate === true ? DUPLICATE_NOTICE : undefined, file.caption].filter(Boolean).join("\n\n");
		await this.call("POST", `/${this.options.phoneNumberId}/messages`, {
			messaging_product: "whatsapp",
			recipient_type: "individual",
			to: file.threadId,
			type: "document",
			document: { id: uploaded.id, filename: file.name, ...(caption === "" ? {} : { caption: caption.slice(0, MAX_CAPTION) }) },
		});
	}

	private async dispatch(message: WhatsAppMessage): Promise<void> {
		if (message.type === "interactive" && message.interactive?.type === "button_reply") {
			const data = message.interactive.button_reply?.id;
			if (this.actionHandler === undefined || data === undefined) return;
			return this.actionHandler({ tenantId: this.options.tenantId, instanceId: this.options.instanceId, channel: this.name, threadId: message.from, userId: message.from, data, actionId: message.id });
		}
		if (this.handler === undefined) return;
		const text = message.type === "text" ? (message.text?.body ?? "") : message.type === "document" ? (message.document?.caption ?? "") : undefined;
		// Voice notes, images, stickers, locations: not understood yet, so not passed on as empty messages.
		if (text === undefined) return;
		const attachments = message.type === "document" && message.document?.id !== undefined && ((await this.options.mayDownload?.(message.from)) ?? true) ? [await this.download(message.document.id, message.document.filename)] : [];
		await this.handler({
			tenantId: this.options.tenantId,
			instanceId: this.options.instanceId,
			channel: this.name,
			threadId: message.from,
			userId: message.from,
			text,
			privateThread: true,
			messageId: message.id,
			...(attachments.length === 0 ? {} : { attachments }),
		});
	}

	/** The media's address from the Graph API, then the file itself, with the token. */
	private async download(mediaId: string, filename: string | undefined): Promise<{ name: string; data: Uint8Array }> {
		const media = await this.call<{ url?: string; file_size?: number }>("GET", `/${encodeURIComponent(mediaId)}`);
		if (media.url === undefined) throw new ChannelRefused("WhatsApp media without url");
		// The token goes only to Meta's own hosts, whatever address the answer holds.
		const host = new URL(media.url).hostname;
		if (!(host === new URL(this.apiBase).hostname || /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net)$/.test(host))) throw new ChannelRefused(`WhatsApp media on an unexpected host: ${host}`);
		if ((media.file_size ?? 0) > MAX_DOWNLOAD) throw new ChannelRefused(`WhatsApp file too large to download: ${media.file_size} bytes`);
		const response = await this.fetch(media.url, { headers: { authorization: `Bearer ${this.options.accessToken}` }, signal: AbortSignal.timeout(60_000) });
		if (!response.ok) throw new Error(`WhatsApp media download failed: ${response.status}`);
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			size += (chunk as Uint8Array).length;
			if (size > MAX_DOWNLOAD) {
				await response.body?.cancel().catch(() => {});
				throw new ChannelRefused(`WhatsApp file too large to download: over ${MAX_DOWNLOAD} bytes`);
			}
			chunks.push(chunk as Uint8Array);
		}
		return { name: filename ?? `documento-${mediaId}`, data: new Uint8Array(Buffer.concat(chunks)) };
	}

	private async call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown> | FormData): Promise<T> {
		const multipart = body instanceof FormData;
		const response = await this.fetch(`${this.apiBase}${path}`, {
			method,
			headers: { authorization: `Bearer ${this.options.accessToken}`, ...(body === undefined || multipart ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
			signal: AbortSignal.timeout(30_000),
		});
		const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
		if (!response.ok || payload.error !== undefined) {
			const code = payload.error?.code ?? response.status;
			// Meta's words, never the request: the token stays out of logs.
			const detail = String(payload.error?.message ?? "").slice(0, 200);
			if (code === OUTSIDE_WINDOW) throw new ChannelRefused("WhatsApp: fuori dalla finestra di 24 ore, la persona deve scrivere prima ad Annie");
			// Rate limits and Meta's own outages are a "not now"; the rest is a no.
			throw new ChannelRefused(`WhatsApp ${method} ${path.split("?")[0]}: ${code} ${detail}`.trim(), code === 4 || code === 80007 || code === 130429 || code === 131048 || response.status === 429 || response.status >= 500);
		}
		return payload;
	}
}

function replyButtons(body: string, buttons: readonly ActionButton[]) {
	if (buttons.length > MAX_BUTTONS) throw new Error(`WhatsApp allows at most ${MAX_BUTTONS} reply buttons`);
	for (const button of buttons) if (button.data.length > MAX_BUTTON_ID) throw new Error(`WhatsApp button "${button.label}": id over ${MAX_BUTTON_ID} characters`);
	return {
		type: "button",
		body: { text: body },
		action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.data, title: b.label.slice(0, MAX_BUTTON_TITLE) } })) },
	};
}
