import { createHash } from "node:crypto";
import { extname } from "node:path";
import { isTransient, readDocumentText } from "./document-reader.ts";
import { DocumentError, type DocumentText } from "./documents.ts";

/** What an entry is counted as when it holds no text: a failure, a document without words. */
const ENTRY_CHARS = 1000;

export type ReadOptions = { readonly timeoutMs?: number; readonly waitMs?: number };

type Entry = DocumentText | DocumentError;

/**
 * Documents' text read once per content (ADR 0035): file_read reading a long one in pieces and
 * every search reuse it instead of parsing the file again in a worker. Keyed by the bytes' hash and
 * the extension (which tells ZIP formats apart), so a file replaced under the same name is read
 * anew. A document that cannot be read (a password, a damaged file) is remembered too, so a search
 * does not try it each time; a failure that may not happen again is not. Holds at most `maxChars`
 * of text, the least recently used goes; a document longer than half of it is not kept. Callers
 * asking for the same document at once share one read.
 */
export class DocumentTexts {
	private readonly entries = new Map<string, Entry>();
	private readonly pending = new Map<string, Promise<Entry>>();
	private chars = 0;

	constructor(
		private readonly maxChars = 4_000_000,
		private readonly read: (name: string, data: Uint8Array, options: ReadOptions) => Promise<DocumentText> = readDocumentText,
	) {}

	/** The document's text; throws DocumentError, with the reason in Italian, when it cannot be read. */
	async text(name: string, data: Uint8Array, options: ReadOptions = {}): Promise<DocumentText> {
		const key = `${extname(name).toLowerCase()}:${createHash("sha256").update(data).digest("hex")}`;
		const entry = this.entries.get(key) ?? (await this.load(key, name, data, options));
		if (this.entries.delete(key)) this.entries.set(key, entry); // most recently used last
		if (entry instanceof DocumentError) throw entry;
		return entry;
	}

	private load(key: string, name: string, data: Uint8Array, options: ReadOptions): Promise<Entry> {
		const running = this.pending.get(key);
		if (running !== undefined) return running;
		const reading = (async () => {
			let entry: Entry;
			try {
				entry = await this.read(name, data, options);
			} catch (error) {
				if (!(error instanceof DocumentError) || isTransient(error)) throw error;
				entry = error;
			}
			this.keep(key, entry);
			return entry;
		})().finally(() => this.pending.delete(key));
		this.pending.set(key, reading);
		return reading;
	}

	private keep(key: string, entry: Entry): void {
		if (size(entry) > this.maxChars / 2) return;
		const old = this.entries.get(key);
		if (old !== undefined) {
			this.entries.delete(key);
			this.chars -= size(old);
		}
		this.entries.set(key, entry);
		this.chars += size(entry);
		for (const [oldest, value] of this.entries) {
			if (this.chars <= this.maxChars) break;
			this.entries.delete(oldest);
			this.chars -= size(value);
		}
	}
}

function size(entry: Entry): number {
	return entry instanceof DocumentError ? ENTRY_CHARS : Math.max(ENTRY_CHARS, entry.text.length);
}
