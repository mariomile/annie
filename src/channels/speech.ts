/**
 * Annie's replies as voice notes (ADR 0020), through any service that speaks OpenAI's speech API
 * (`POST <base>/audio/speech`, JSON `model`, `input`, `voice`, `response_format`): OpenAI's TTS, or
 * a model of one's own behind the same API. The operator chooses the service; the owner allows it
 * instance by instance (connector "speech" in the egress policy). Only the reply's text leaves the
 * server, for that service and nowhere else.
 */

/** The egress name of spoken replies: an instance sends its replies' text out only with it in its connectors. */
export const SPEECH_CONNECTOR = "speech";

export type SpeakerConfig = {
	/** The API base, e.g. https://api.openai.com/v1. */
	readonly url: string;
	readonly apiKey: string;
	readonly model: string;
	readonly voice: string;
	/** Longest reply read aloud, in characters of what is spoken; longer ones stay text only. */
	readonly maxChars: number;
};

/** Text to a voice note: OGG with Opus inside, what Telegram and WhatsApp play as a voice message. */
export type Speak = ((text: string) => Promise<Uint8Array>) & { readonly maxChars?: number };

/** Not read aloud: too long, or nothing left to say once links and markup are gone. */
export class SpeechRefused extends Error {
	override readonly name = "SpeechRefused";
}

/** Longest audio accepted from the service: about ten minutes of Opus. */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export function speaker(config: SpeakerConfig, fetchImpl: typeof fetch = fetch): Speak {
	const speak = async (text: string): Promise<Uint8Array> => {
		const input = speakable(text);
		if (input === "") throw new SpeechRefused("nothing to say aloud");
		if (input.length > config.maxChars) throw new SpeechRefused(`reply of ${input.length} characters, over the ${config.maxChars} limit`);
		const response = await fetchImpl(`${config.url.replace(/\/+$/, "")}/audio/speech`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ model: config.model, input, voice: config.voice, response_format: "opus" }),
			signal: AbortSignal.timeout(45_000),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { message?: unknown; error?: { message?: unknown } | string };
			// The service's words, never the request: the key stays out of logs.
			const detail = typeof body.error === "string" ? body.error : String(body.error?.message ?? body.message ?? "");
			throw new Error(`speech: ${response.status} ${detail.replaceAll(config.apiKey, "[chiave]").slice(0, 200)}`.trim());
		}
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > MAX_AUDIO_BYTES) throw new Error("speech: audio too large");
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.length === 0 || data.length > MAX_AUDIO_BYTES) throw new Error("speech: no usable audio in the answer");
		// OGG files start with "OggS": anything else would not play as a voice note.
		if (!(data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53)) throw new Error("speech: the answer is not OGG audio");
		return data;
	};
	return Object.assign(speak, { maxChars: config.maxChars });
}

/**
 * What is read aloud: the reply without markup, links said as "link", code blocks left out
 * (they are for reading). The text reply still goes out in full, next to the voice note.
 */
export function speakable(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, "$1")
		.replace(/\bhttps?:\/\/\S+/g, "link")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/\|/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

/** The thread's last message from the person was a voice note: the reply goes back as one too. */
export class VoiceThreads {
	private readonly last = new Map<string, number>();

	constructor(
		/** How long a voice note asks for a spoken reply: a reply much later is not an answer to it. */
		private readonly windowMs = 30 * 60_000,
		private readonly now: () => number = Date.now,
	) {}

	/** Record what kind of message the person last sent here. */
	heard(threadId: string, voice: boolean): void {
		if (voice) this.last.set(threadId, this.now());
		else this.last.delete(threadId);
		// Bounded: the oldest threads go first.
		if (this.last.size > 1000) this.last.delete(this.last.keys().next().value as string);
	}

	wantsVoice(threadId: string): boolean {
		const at = this.last.get(threadId);
		return at !== undefined && this.now() - at <= this.windowMs;
	}
}
