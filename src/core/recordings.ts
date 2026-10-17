import { AudioError, type AudioInfo, audioInfo, audioLabel } from "./audio.ts";

/**
 * Long recordings as text with the time of each passage (ADR 0033): a meeting, a call, a lesson,
 * a video. The recording is cut into pieces (audio.ts), each piece goes to the transcription
 * service the operator chose, and the passages come back stamped with where they are in the
 * whole recording, so the person can find a moment by its time.
 */

/** «MP3, 52:10»: what a recording is and how long, for the note that tells the model it arrived; undefined when it is not one. */
export function recordingLabel(data: Uint8Array): string | undefined {
	let info: AudioInfo;
	try {
		info = audioInfo(data);
	} catch (error) {
		if (error instanceof AudioError) return undefined;
		throw error;
	}
	return info.seconds === undefined ? audioLabel(info) : `${audioLabel(info)}, ${clock(info.seconds)}`;
}

/** A passage as the service heard it: seconds from the start of the piece it was in. */
export type TranscriptSegment = { readonly start: number; readonly end: number; readonly text: string; readonly speaker?: string };

export type PieceTranscript = { readonly text: string; readonly segments: readonly TranscriptSegment[] };

/** One piece of a recording to text. The core's port: the adapter speaks to the service. */
export type TranscribePiece = (piece: { readonly data: Uint8Array; readonly name: string; readonly mimeType: string }, options: { readonly speakers: boolean; readonly signal: AbortSignal }) => Promise<PieceTranscript>;

/** The owner has not allowed the transcription service for this instance. */
export class TranscriptionNotAllowed extends Error {
	override readonly name = "TranscriptionNotAllowed";
}

/** The service answered with an error, or did not answer: `status` when it answered, `retryable` when trying again may work. */
export class TranscriptionFailed extends Error {
	override readonly name = "TranscriptionFailed";
	constructor(
		message: string,
		readonly retryable: boolean,
		readonly status?: number,
	) {
		super(message);
	}
}

/** What the service can do beyond plain text, known from its configuration. */
export type TranscriptionAbilities = {
	/** Passages come back with their times. */
	readonly timestamps: boolean;
	/** Passages come back with who said them. */
	readonly speakers: boolean;
};

export const RECORDING_LIMITS = {
	/** Longest piece sent: ten minutes, within what the services take in one request. */
	pieceSeconds: 600,
	/** Largest piece sent, under the 25 MB OpenAI's API accepts with room for the request around it. */
	pieceBytes: 20 * 1024 * 1024,
	/** Characters of the transcript shown with the answer; the rest is in the file. */
	shownChars: 12_000,
} as const;

/** «04:05», «1:02:03». */
export function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	const two = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** A passage of the transcript: when it starts in the recording, who speaks (when known), what is said. */
export type Passage = { readonly at: number; readonly speaker?: string; readonly text: string };

/** Longest passage, in characters and seconds, before a new one starts with its own time. */
const PASSAGE_CHARS = 600;
const PASSAGE_SECONDS = 60;

/**
 * The pieces' transcripts as passages stamped with their time in the whole recording: the
 * service's short segments joined while the same voice speaks, up to about a minute each, never
 * across pieces. A piece without segments is one passage at its start. Voices are kept apart by
 * piece: the service numbers them again in each request, so its «speaker_1» of one piece is not
 * the «speaker_1» of the next.
 */
export function passages(pieces: readonly { readonly start: number; readonly transcript: PieceTranscript }[]): Passage[] {
	const out: { at: number; speaker?: string; text: string; piece: number }[] = [];
	pieces.forEach((piece, index) => {
		const segments = piece.transcript.segments.filter((s) => s.text.trim() !== "");
		if (segments.length === 0) {
			const text = clean(piece.transcript.text);
			if (text !== "") out.push({ at: piece.start, text, piece: index });
			return;
		}
		for (const segment of segments) {
			const at = piece.start + Math.max(0, segment.start);
			const text = clean(segment.text);
			const speaker = segment.speaker === undefined ? undefined : `${index}:${segment.speaker}`;
			const open = out.at(-1);
			if (open !== undefined && open.piece === index && open.speaker === speaker && open.text.length + text.length < PASSAGE_CHARS && at - open.at < PASSAGE_SECONDS) open.text = `${open.text} ${text}`;
			else out.push({ at, ...(speaker === undefined ? {} : { speaker }), text, piece: index });
		}
	});
	return out.map(({ at, speaker, text }) => ({ at, ...(speaker === undefined ? {} : { speaker }), text }));
}

/** The voices as the person reads them: «Voce 1», «Voce 2», in the order they first speak. */
export function speakerNames(list: readonly Passage[]): Passage[] {
	const names = new Map<string, string>();
	return list.map((p) => {
		if (p.speaker === undefined) return p;
		let name = names.get(p.speaker);
		if (name === undefined) names.set(p.speaker, (name = `Voce ${names.size + 1}`));
		return { ...p, speaker: name };
	});
}

/**
 * The name a person gave the file: without the folder and the message prefix files from a chat
 * get in uploads/ («7_1-riunione.m4a» from Telegram, «wamid_…-riunione.m4a» from WhatsApp).
 */
export function recordingName(path: string): string {
	const name = path.split("/").at(-1) ?? path;
	return path.startsWith("uploads/") ? name.replace(/^(?:-?\d+_\d+|wamid_\w+?)-(?=.)/, "") : name;
}

export type TranscriptInput = {
	readonly source: string;
	readonly label: string;
	/** Undefined when the file does not say how long it is. */
	readonly seconds: number | undefined;
	readonly pieces: number;
	readonly date: string;
	readonly passages: readonly Passage[];
	readonly timestamps: boolean;
};

/** The transcript file: a heading, what was transcribed, then one stamped passage per paragraph. */
export function transcriptMarkdown(input: TranscriptInput): string {
	const length = input.seconds === undefined ? "durata non indicata dal file" : clock(input.seconds);
	const head = [`# Trascrizione di ${recordingName(input.source)}`, "", `- Registrazione: ${input.source} (${input.label}, ${length})`, `- Trascritta il ${input.date}`];
	head.push(input.timestamps ? "- I tempi sono minuti e secondi dall'inizio della registrazione" : "- I tempi indicano l'inizio di ogni pezzo in cui è stata divisa la registrazione: il servizio di trascrizione non dà quelli delle frasi");
	if (input.pieces > 1 && input.passages.some((p) => p.speaker !== undefined)) head.push("- Le voci sono distinte dentro ogni pezzo: la stessa persona può avere un numero diverso nel pezzo dopo");
	const body = input.passages.map((p) => `[${clock(p.at)}] ${p.speaker === undefined ? "" : `**${p.speaker}:** `}${p.text}`);
	return `${[...head, "", ...(body.length === 0 ? ["(nessuna parola riconoscibile)"] : body)].join("\n")}\n`;
}

/** A transcript's text on one line: services put in line breaks and runs of spaces. */
function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
