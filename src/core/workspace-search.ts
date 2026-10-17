import { DOCUMENT_READER_LIMITS } from "./document-reader.ts";
import type { DocumentTexts, ReadOptions } from "./document-texts.ts";
import { DocumentError, type DocumentKind, documentHasWords, documentKind, documentLabel, documentSectionAt, documentSectionLines, looksLikeDocument, oldFormatAdvice } from "./documents.ts";
import { type FileMatch, matchFile, type Passage, type QueryTerm, rankMatches } from "./file-search.ts";
import { pool } from "./pool.ts";
import type { Workspace, WorkspaceFile } from "./workspace.ts";

/** How far one search goes (ADR 0035): a big workspace answers within a minute, never holds the turn. */
export type SearchLimits = {
	/** Files looked at, newest first. */
	readonly files: number;
	/** Bytes read from disk. */
	readonly bytes: number;
	/** Characters of text searched: a document's text can be much longer than its file. */
	readonly chars: number;
	/** Time spent reading and parsing, after which the files left are not searched. */
	readonly budgetMs: number;
	/** Files in the answer. */
	readonly results: number;
	/** Passages shown per file. */
	readonly passages: number;
};

export const SEARCH_LIMITS: SearchLimits = { files: 5000, bytes: 300 * 1024 * 1024, chars: 60_000_000, budgetMs: 60_000, results: 10, passages: 3 };

/** Sounds, pictures, videos and archives: no words to search, not worth reading. */
const NO_WORDS = /\.(?:mp3|m4a|mp4|m4v|mov|avi|mkv|wav|ogg|oga|opus|flac|webm|amr|aac|wma|jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|ico|zip|gz|tgz|7z|rar|exe|dll|so|bin|iso|dmg|woff2?|ttf|otf|sqlite|db)$/i;

/**
 * Files read one at a time: the document workers are shared by the whole server, and a search
 * must leave one free for someone else's file_read. A search waits a few seconds for a worker,
 * not the usual 45, and never past its own time.
 */
const PARALLEL = 1;
const WORKER_WAIT_MS = 3000;

export type FoundPassage = Passage & { /** The page, sheet or slide of a document; the minute of a transcript. */ readonly section?: string };

export type Found = Omit<FileMatch, "passages"> & { readonly label?: string; readonly passages: readonly FoundPassage[] };

export type SearchOutcome = {
	/** Files in the workspace, or in the folder searched. */
	readonly files: number;
	/** Files whose words were searched. */
	readonly searched: number;
	/** Every matching file, best first. */
	readonly found: readonly Found[];
	/** Documents whose text could not be read, with the reason. */
	readonly unread: readonly { readonly path: string; readonly why: string }[];
	/** Documents with no words in them (scans), newest first: their pages can be looked at. */
	readonly noText: readonly string[];
	/** Files left out by the limits (too many, too big together, out of time): searched by name only. */
	readonly leftOut: number;
};

type Read = { readonly kind: "text"; readonly text: string; readonly document?: DocumentKind } | { readonly kind: "unread"; readonly why: string } | { readonly kind: "notext" } | { readonly kind: "none" };

/**
 * The query's terms looked for in the workspace (or a folder of it): the text of text files and of
 * documents, and every file's name. Newest files first, so when the limits stop the search what
 * was left out is the oldest.
 */
export async function searchWorkspace(input: {
	readonly workspace: Workspace;
	readonly texts: DocumentTexts;
	readonly terms: readonly QueryTerm[];
	readonly folder: string;
	readonly limits: SearchLimits;
	readonly signal: AbortSignal;
	readonly progress?: (text: string) => void;
}): Promise<SearchOutcome> {
	const { workspace, texts, terms, limits, signal } = input;
	const files = newestFirst(await workspace.list(input.folder));
	const considered = files.slice(0, limits.files);
	if (considered.length >= 50) input.progress?.(`Cerco in ${considered.length} file…`);
	const started = performance.now();
	const left = () => limits.budgetMs - (performance.now() - started);
	let bytes = 0;
	let chars = 0;
	let leftOut = files.length - considered.length;
	let searched = 0;
	let looked = 0;
	const unread: { path: string; why: string }[] = [];
	const noText: WorkspaceFile[] = [];
	const results = await pool(considered, PARALLEL, async (file): Promise<Found | undefined> => {
		signal.throwIfAborted();
		const wordless = NO_WORDS.test(file.path);
		looked++;
		if (!wordless && (bytes + file.size > limits.bytes || chars > limits.chars || left() <= 0)) {
			leftOut++;
			return matchRead(file, { text: "" }, terms, limits.passages);
		}
		if (!wordless) bytes += file.size;
		const read = wordless ? ({ kind: "none" } as const) : await readText(workspace, texts, file, { waitMs: WORKER_WAIT_MS, timeoutMs: Math.max(1000, Math.min(DOCUMENT_READER_LIMITS.timeoutMs, left())) });
		if (read.kind === "text") chars += read.text.length;
		if (read.kind === "unread") unread.push({ path: file.path, why: read.why });
		if (read.kind === "notext") noText.push(file);
		if (read.kind === "text") searched++;
		return matchRead(file, read.kind === "text" ? read : { text: "" }, terms, limits.passages);
	});
	return {
		files: files.length,
		searched,
		found: rankMatches(
			results.filter((r): r is Found => r !== undefined),
			looked,
		),
		unread: unread.sort((a, b) => a.path.localeCompare(b.path)),
		noText: newestFirst(noText).map((f) => f.path),
		leftOut,
	};
}

function newestFirst(files: readonly WorkspaceFile[]): WorkspaceFile[] {
	return [...files].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
}

/**
 * How a file answers the query, with a document's kind and where each passage is: the page, sheet
 * or slide of a document, the minute of a transcript (its passages start with «[04:10]»).
 */
function matchRead(file: WorkspaceFile, read: { readonly text: string; readonly document?: DocumentKind }, terms: readonly QueryTerm[], passages: number): Found | undefined {
	const { text, document } = read;
	const walls = document === undefined ? stampedLines(text) : documentSectionLines(text);
	const match = matchFile({ path: file.path, modifiedAt: file.modifiedAt, text, walls }, terms, passages);
	if (match === undefined) return undefined;
	const where = (at: number) => (document === undefined ? minuteAt(text, at) : documentSectionAt(text, at));
	return {
		...match,
		...(document === undefined ? {} : { label: documentLabel(document) }),
		passages: match.passages.map((p) => {
			const section = where(p.hit);
			return section === undefined ? p : { ...p, section };
		}),
	};
}

/** Where a transcript's passages start: a passage shown stays within the one its words are in. */
function stampedLines(text: string): { start: number; end: number }[] {
	return [...text.matchAll(STAMP)].map((m) => ({ start: m.index, end: m.index }));
}

/** «[04:10]» at the start of a line: how a transcript (ADR 0033) stamps its passages. */
const STAMP = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/gm;

/** «minuto 04:10»: the stamp of the transcript passage that holds `at`, if the text has stamps. */
function minuteAt(text: string, at: number): string | undefined {
	const lineStart = text.lastIndexOf("\n", at - 1) + 1;
	const stamp = new RegExp(STAMP.source).exec(text.slice(lineStart, lineStart + 12));
	return stamp === null ? undefined : `minuto ${stamp[1]}`;
}

/** A file's words: its text, a document's extracted text, or why there are none to search. */
async function readText(workspace: Workspace, texts: DocumentTexts, file: WorkspaceFile, options: ReadOptions): Promise<Read> {
	let data: Buffer;
	try {
		data = await workspace.read(file.path);
	} catch {
		return { kind: "none" }; // removed or replaced while the search ran
	}
	const document = documentKind(file.path, data);
	if (document !== undefined || looksLikeDocument(file.path)) {
		try {
			const doc = await texts.text(file.path, data, options);
			if (!documentHasWords(doc.text)) return { kind: "notext" };
			return { kind: "text", text: doc.text, document: doc.kind };
		} catch (error) {
			if (!(error instanceof DocumentError)) throw error;
			return { kind: "unread", why: error.message };
		}
	}
	if (oldFormatAdvice(file.path, data) !== undefined) return { kind: "unread", why: "è in un formato vecchio che non so leggere" };
	if (data.includes(0)) return { kind: "none" };
	return { kind: "text", text: data.toString("utf8") };
}
