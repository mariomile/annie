/**
 * Voice messages to text, through any service that speaks OpenAI's transcription API
 * (`POST <base>/audio/transcriptions`, multipart `file` and `model`): Mistral's Voxtral (servers
 * in the EU), OpenAI's Whisper, a model of one's own. The operator chooses the service; the owner
 * allows it instance by instance (connector "voice" in the egress policy). The audio leaves the
 * server for that service and nowhere else.
 */

/** The egress name of transcription: an instance sends audio out only with it in its connectors. */
export const VOICE_CONNECTOR = "voice";
export type TranscriberConfig = {
	/** The API base, e.g. https://api.mistral.ai/v1. */
	readonly url: string;
	readonly apiKey: string;
	readonly model: string;
	/** Longest voice message transcribed, in seconds; longer ones are not sent. */
	readonly maxSeconds: number;
};

/** What a channel hands over: the audio as it came, and its length when the channel says it. */
export type VoiceClip = { readonly data: Uint8Array; readonly name: string; readonly mimeType: string; readonly seconds?: number };

/** Audio to text; `maxSeconds` lets a channel refuse a clip before downloading it. */
export type Transcribe = ((clip: VoiceClip) => Promise<string>) & { readonly maxSeconds?: number };

/** This clip will not be transcribed: too long. */
export class TranscriptionRefused extends Error {
	override readonly name = "TranscriptionRefused";
}

/** The owner has not allowed transcription for this instance. */
export class TranscriptionOff extends Error {
	override readonly name = "TranscriptionOff";
}

/** Too long to send, known before downloading when the channel tells the length. */
export function tooLong(seconds: number | undefined, maxSeconds: number): boolean {
	return seconds !== undefined && seconds > maxSeconds;
}

const EXTENSIONS: Record<string, string> = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/flac": "flac" };

/** A file name whose extension matches the audio's type: some services read the format from it. */
export function audioName(mimeType: string, given?: string): string {
	if (given !== undefined && /\.[a-z0-9]{2,5}$/i.test(given)) return given;
	return `vocale.${EXTENSIONS[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "ogg"}`;
}

export function transcriber(config: TranscriberConfig, fetchImpl: typeof fetch = fetch): Transcribe {
	const transcribe = async (clip: VoiceClip): Promise<string> => {
		if (tooLong(clip.seconds, config.maxSeconds)) throw new TranscriptionRefused(`voice message of ${clip.seconds} s, over the ${config.maxSeconds} s limit`);
		const form = new FormData();
		form.set("model", config.model);
		form.set("file", new Blob([Uint8Array.from(clip.data)], { type: clip.mimeType }), clip.name);
		const response = await fetchImpl(`${config.url.replace(/\/+$/, "")}/audio/transcriptions`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.apiKey}` },
			body: form,
			// Within what Telegram and Meta wait for a webhook to answer, more or less.
			signal: AbortSignal.timeout(45_000),
		});
		const body = (await response.json().catch(() => ({}))) as { text?: unknown; message?: unknown; error?: { message?: unknown } | string };
		// The service's words, never the request: the key stays out of logs. OpenAI nests them, Mistral does not.
		const detail = typeof body.error === "string" ? body.error : String(body.error?.message ?? body.message ?? "");
		if (!response.ok) throw new Error(`transcription: ${response.status} ${detail.replaceAll(config.apiKey, "[chiave]").slice(0, 200)}`.trim());
		if (typeof body.text !== "string") throw new Error("transcription: no text in the answer");
		return body.text.trim();
	};
	return Object.assign(transcribe, { maxSeconds: config.maxSeconds });
}

/** How a voice message reaches Annie: its words, marked as transcribed; or why there are none. */
export async function voiceText(clip: VoiceClip, transcribe: Transcribe | undefined, log?: (message: string) => void): Promise<string> {
	if (transcribe === undefined) return "[Messaggio vocale: su questo server la trascrizione non è attiva. Chiedi di scrivere il messaggio.]";
	try {
		const text = await transcribe(clip);
		return text === "" ? "[Messaggio vocale senza parole riconoscibili.]" : `[Messaggio vocale, trascritto] ${text}`;
	} catch (error) {
		if (error instanceof TranscriptionOff) return "[Messaggio vocale: la trascrizione non è attiva per questa istanza. Chiedi di scrivere il messaggio.]";
		log?.(`voice: not transcribed: ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof TranscriptionRefused ? "[Messaggio vocale troppo lungo da trascrivere. Chiedi di dividerlo o di scriverlo.]" : "[Messaggio vocale: la trascrizione non è riuscita. Chiedi di riprovare o di scriverlo.]";
	}
}
