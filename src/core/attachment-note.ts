import { documentKind, documentLabel } from "./documents.ts";
import { imageType } from "./images.ts";
import { recordingLabel } from "./recordings.ts";

/**
 * The line that tells the model a file arrived with a message, and what to do with it: a
 * document says file_read gives its text (ADR 0026), a recording gives its length so the
 * model knows audio_transcribe gives its words (ADR 0033). One wording for every channel:
 * the gateway puts it in Telegram and WhatsApp messages, the console in the web chat.
 */
export function attachmentNote(path: string, data: Uint8Array): string {
	if (imageType(data) !== undefined) return `[Immagine nel workspace: ${path}]`;
	const kind = documentKind(path, data);
	if (kind !== undefined) return `[Documento ${documentLabel(kind)} nel workspace: ${path}. Leggilo con file_read]`;
	const recording = recordingLabel(data);
	if (recording !== undefined) return `[Registrazione ${recording} nel workspace: ${path}]`;
	return `[File caricato nel workspace: ${path}]`;
}
