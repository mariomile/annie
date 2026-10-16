/**
 * Voice messages to text, through any service that speaks OpenAI's transcription API
 * (`POST <base>/audio/transcriptions`, multipart `file` and `model`): Mistral's Voxtral (servers
 * in the EU), OpenAI's Whisper, a model of one's own. The operator chooses it, like the model:
 * the audio leaves the server for that service and nowhere else.
 */
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

export type Transcribe = (clip: VoiceClip) => Promise<string>;

/** Largest audio sent: the limit of the common services (25 MB). */
const MAX_BYTES = 25 * 1024 * 1024;

export class TranscriptionRefused extends Error {
	override readonly name = "TranscriptionRefused";
}

export function transcriber(config: TranscriberConfig, fetchImpl: typeof fetch = fetch): Transcribe {
	return async (clip) => {
		if (clip.seconds !== undefined && clip.seconds > config.maxSeconds) throw new TranscriptionRefused(`voice message of ${clip.seconds} s, over the ${config.maxSeconds} s limit`);
		if (clip.data.length > MAX_BYTES) throw new TranscriptionRefused(`voice message of ${clip.data.length} bytes, over ${MAX_BYTES}`);
		const form = new FormData();
		form.set("model", config.model);
		form.set("file", new Blob([Uint8Array.from(clip.data)], { type: clip.mimeType }), clip.name);
		const response = await fetchImpl(`${config.url.replace(/\/+$/, "")}/audio/transcriptions`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.apiKey}` },
			body: form,
			signal: AbortSignal.timeout(120_000),
		});
		const body = (await response.json().catch(() => ({}))) as { text?: unknown; error?: { message?: unknown } | string };
		// The service's words, never the request: the key stays out of logs.
		const detail = typeof body.error === "string" ? body.error : String(body.error?.message ?? "");
		if (!response.ok) throw new Error(`transcription: ${response.status} ${detail.slice(0, 200)}`.trim());
		if (typeof body.text !== "string") throw new Error("transcription: no text in the answer");
		return body.text.trim();
	};
}

/** How a voice message reaches Annie: its words, marked as transcribed; or why there are none. */
export async function voiceText(clip: VoiceClip, transcribe: Transcribe | undefined, log?: (message: string) => void): Promise<string> {
	if (transcribe === undefined) return "[Messaggio vocale: su questo server la trascrizione non è attiva. Chiedi di scrivere il messaggio.]";
	try {
		const text = await transcribe(clip);
		return text === "" ? "[Messaggio vocale senza parole riconoscibili.]" : `[Messaggio vocale, trascritto] ${text}`;
	} catch (error) {
		log?.(`voice: not transcribed: ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof TranscriptionRefused ? "[Messaggio vocale troppo lungo da trascrivere. Chiedi di dividerlo o di scriverlo.]" : "[Messaggio vocale: la trascrizione non è riuscita. Chiedi di riprovare o di scriverlo.]";
	}
}
