import { createHash } from "node:crypto";
import { isTransient, readDocumentText } from "./document-reader.ts";
import { DocumentError, type DocumentText } from "./documents.ts";

/** What an entry is counted as when it holds no text: a failure, a document without words. */
const ENTRY_CHARS = 1000;

/**
 * Documents' text read once per content (ADR 0035): file_read reading a long one in pieces and
 * every search reuse it instead of parsing the file again in a worker. Keyed by the bytes' hash,
 * so a file replaced under the same name is read anew. A document that cannot be read (a password,
 * a damaged file) is remembered too, so a search does not try it each time; a failure that says
 * nothing about the file is not. Holds at most `maxChars` of text, the least recently used goes.
 */
export class DocumentTexts {
	private readonly entries = new Map<string, DocumentText | DocumentError>();
	private chars = 0;

	constructor(
		private readonly maxChars = 8_000_000,
		private readonly read: (name: string, data: Uint8Array) => Promise<DocumentText> = readDocumentText,
	) {}

	/** The document's text; throws DocumentError, with the reason in Italian, when it cannot be read. */
	async text(name: string, data: Uint8Array): Promise<DocumentText> {
		const key = createHash("sha256").update(data).digest("hex");
		const known = this.entries.get(key);
		if (known !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, known);
			if (known instanceof DocumentError) throw known;
			return known;
		}
		let entry: DocumentText | DocumentError;
		try {
			entry = await this.read(name, data);
		} catch (error) {
			if (!(error instanceof DocumentError) || isTransient(error)) throw error;
			entry = error;
		}
		this.keep(key, entry);
		if (entry instanceof DocumentError) throw entry;
		return entry;
	}

	private keep(key: string, entry: DocumentText | DocumentError): void {
		this.entries.set(key, entry);
		this.chars += size(entry);
		for (const [oldest, value] of this.entries) {
			if (this.chars <= this.maxChars || this.entries.size === 1) break;
			this.entries.delete(oldest);
			this.chars -= size(value);
		}
	}
}

function size(entry: DocumentText | DocumentError): number {
	return entry instanceof DocumentError ? ENTRY_CHARS : Math.max(ENTRY_CHARS, entry.text.length);
}
