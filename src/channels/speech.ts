import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../core/atomic-file.ts";

/**
 * Annie's replies as voice notes (ADR 0020), through any service that speaks OpenAI's speech API
 * (`POST <base>/audio/speech`, JSON `model`, `input`, `voice`, `response_format`): OpenAI's TTS, or
 * a model of one's own behind the same API. The operator chooses the service; the owner allows it
 * instance by instance (connector "speech" in the egress policy). Only the text of a reply to a
 * person's voice note leaves the server, for that service and nowhere else.
 */

/** The egress name of spoken replies: an instance sends replies' text out only with it in its connectors. */
export const SPEECH_CONNECTOR = "speech";

export type SpeakerConfig = {
	/** The API base, e.g. https://api.openai.com/v1. */
	readonly url: string;
	readonly apiKey: string;
	readonly model: string;
	readonly voice: string;
	/** Longest part of a reply read aloud, in characters of what is spoken; the rest stays text. */
	readonly maxChars: number;
	/** How to speak, for services that take it (OpenAI's gpt-4o-mini-tts): tone, pace, accent. */
	readonly style?: string;
	/** Voice notes made per day for the whole server; then replies go as text. */
	readonly maxPerDay: number;
};

/** Text to a voice note: OGG with Opus inside, what Telegram and WhatsApp play as a voice message. */
export type Speak = (text: string) => Promise<Uint8Array>;

/** Not read aloud: nothing left to say once links and code are gone. */
export class SpeechRefused extends Error {
	override readonly name = "SpeechRefused";
}

/** Longest audio accepted from the service: about ten minutes of Opus. */
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** What the person is told when only part of a long reply was read aloud. */
export const REST_WRITTEN = "Il resto te l'ho scritto.";

export function speaker(config: SpeakerConfig, fetchImpl: typeof fetch = fetch): Speak {
	return async (text: string): Promise<Uint8Array> => {
		const input = spokenPart(speakable(text), config.maxChars);
		if (input === "") throw new SpeechRefused("nothing to say aloud");
		const response = await fetchImpl(`${config.url.replace(/\/+$/, "")}/audio/speech`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ model: config.model, input, voice: config.voice, response_format: "opus", ...(config.style === undefined ? {} : { instructions: config.style }) }),
			// The text waits for the voice note: past this, it goes alone.
			signal: AbortSignal.timeout(20_000),
		});
		// Only the status: some services repeat the text they were given in their errors.
		if (!response.ok) throw new Error(`speech: the service answered ${response.status}`);
		const data = await readCapped(response, MAX_AUDIO_BYTES);
		if (!isOggOpus(data)) throw new Error("speech: the answer is not OGG Opus audio");
		return data;
	};
}

/** The body, refused past `max` bytes whatever the headers say. */
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
	if (Number(response.headers.get("content-length") ?? "0") > max) throw new Error("speech: audio too large");
	const reader = response.body?.getReader();
	if (reader === undefined) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			throw new Error("speech: audio too large");
		}
		chunks.push(value);
	}
	const data = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		data.set(chunk, at);
		at += chunk.length;
	}
	return data;
}

/** An OGG page whose first packet is Opus's header: what Telegram and WhatsApp play as a voice note. */
export function isOggOpus(data: Uint8Array): boolean {
	const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
	return data.length > 36 && ascii(0, 4) === "OggS" && ascii(28, 36) === "OpusHead";
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
		.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
		.replace(/\|/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

/** Up to `max` characters, cut at the end of a sentence, saying the rest was written. */
export function spokenPart(said: string, max: number): string {
	if (said.length <= max) return said;
	const room = said.slice(0, Math.max(0, max - REST_WRITTEN.length - 1));
	const end = Math.max(room.lastIndexOf(". "), room.lastIndexOf("! "), room.lastIndexOf("? "), room.lastIndexOf("\n"));
	const head = (end > room.length / 3 ? room.slice(0, end + 1) : room.slice(0, room.lastIndexOf(" ") > 0 ? room.lastIndexOf(" ") : room.length)).trim();
	return head === "" ? "" : `${head} ${REST_WRITTEN}`;
}

/** How a person wants Annie's replies: as a voice note when they send one (the default), always, or never. */
export type VoiceMode = "auto" | "always" | "never";
export const VOICE_MODES: readonly VoiceMode[] = ["auto", "always", "never"];

/** Each person's choice, per instance, by `channel:threadId` of their private chat. Kept in one small file. */
export class VoicePreferences {
	private cache: Record<string, VoiceMode> | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly file: string) {}

	async get(key: string): Promise<VoiceMode> {
		return (await this.all())[key] ?? "auto";
	}

	set(key: string, mode: VoiceMode): Promise<void> {
		const next = this.queue.then(async () => {
			const all = { ...(await this.all()) };
			if (mode === "auto") delete all[key];
			else all[key] = mode;
			await writeFileAtomic(this.file, `${JSON.stringify(all)}\n`);
			this.cache = all;
		});
		this.queue = next.catch(() => {});
		return next;
	}

	private async all(): Promise<Record<string, VoiceMode>> {
		if (this.cache !== undefined) return this.cache;
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
			this.cache = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, VoiceMode] => VOICE_MODES.includes(e[1] as VoiceMode)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.cache = {};
		}
		return this.cache;
	}
}

/**
 * The gateway's view of an instance's voice: whether this person's message gets a spoken reply,
 * and the voice note itself. `speak` resolves undefined when the instance stopped speaking since.
 */
export type InstanceVoice = {
	/** A spoken reply for a message from this private chat: `voice` says the person sent a voice note. */
	wanted(key: string, voice: boolean): Promise<boolean>;
	speak(text: string): Promise<Uint8Array | undefined>;
	/** Characters read aloud at most, for the note to the model. */
	readonly maxChars: number;
};

/** Told to the model with a message whose reply will be read aloud. */
export function spokenNote(maxChars: number): string {
	return `[La tua risposta arriverà come messaggio vocale, seguito dal testo. Scrivi come parleresti: frasi brevi, niente tabelle, elenchi lunghi o link nel corpo; ne leggo al più ${maxChars} caratteri.]`;
}
