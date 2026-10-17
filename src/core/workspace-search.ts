import { isTransient } from "./document-reader.ts";
import type { DocumentTexts } from "./document-texts.ts";
import { DocumentError, type DocumentKind, documentKind, documentLabel, documentSectionAt, documentSectionLines, looksLikeDocument, oldFormatAdvice } from "./documents.ts";
import { type FileMatch, matchFile, type Passage, rankMatches } from "./file-search.ts";
import { pool } from "./pool.ts";
import type { Workspace, WorkspaceFile } from "./workspace.ts";

/** How far one search goes (ADR 0035): a big workspace answers within a minute, never holds the turn. */
export type SearchLimits = {
	/** Files looked at, newest first. */
	readonly files: number;
	/** Bytes read from disk. */
	readonly bytes: number;
	/** Time spent reading and parsing, after which the files left are not searched. */
	readonly budgetMs: number;
	/** Files in the answer. */
	readonly results: number;
	/** Passages shown per file. */
	readonly passages: number;
};

export const SEARCH_LIMITS: SearchLimits = { files: 5000, bytes: 300 * 1024 * 1024, budgetMs: 60_000, results: 10, passages: 3 };

/** Sounds, pictures, videos and archives: no words to search, not worth reading. */
const NO_WORDS = /\.(?:mp3|m4a|mp4|m4v|mov|avi|mkv|wav|ogg|oga|opus|flac|webm|amr|aac|wma|jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|ico|zip|gz|tgz|7z|rar|exe|dll|so|bin|iso|dmg|woff2?|ttf|otf|sqlite|db)$/i;

/** Documents read in parallel: as many as the document workers. */
const PARALLEL = 2;

export type FoundPassage = Passage & { /** The page, sheet or slide, for a document. */ readonly section?: string };

export type Found = Omit<FileMatch, "passages"> & { readonly label?: string; readonly passages: readonly FoundPassage[] };

export type SearchOutcome = {
	/** Files whose words were searched. */
	readonly searched: number;
	/** Every matching file, best first. */
	readonly found: readonly Found[];
	/** Documents whose text could not be read, with the reason. */
	readonly unread: readonly { readonly path: string; readonly why: string }[];
	/** Files left out by the limits: too many, too big together, or out of time. */
	readonly leftOut: number;
};

type Read = { readonly kind: "text"; readonly text: string; readonly document?: DocumentKind } | { readonly kind: "unread"; readonly why: string } | { readonly kind: "none" };

/**
 * The query's terms looked for in the workspace (or a folder of it): the text of text files and of
 * documents, and every file's name. Newest files first, so when the limits stop the search what
 * was left out is the oldest.
 */
export async function searchWorkspace(input: {
	readonly workspace: Workspace;
	readonly texts: DocumentTexts;
	readonly terms: readonly string[];
	readonly folder: string;
	readonly limits: SearchLimits;
	readonly signal: AbortSignal;
	readonly progress?: (text: string) => void;
}): Promise<SearchOutcome> {
	const { workspace, texts, terms, limits, signal } = input;
	const files = (await workspace.list(input.folder)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
	const considered = files.slice(0, limits.files);
	if (considered.length >= 50) input.progress?.(`Cerco in ${considered.length} file…`);
	const started = performance.now();
	let bytes = 0;
	let leftOut = files.length - considered.length;
	let searched = 0;
	const unread: { path: string; why: string }[] = [];
	const results = await pool(considered, PARALLEL, async (file): Promise<Found | undefined> => {
		signal.throwIfAborted();
		const wordless = NO_WORDS.test(file.path);
		if (!wordless && (bytes + file.size > limits.bytes || performance.now() - started > limits.budgetMs)) {
			leftOut++;
			return undefined;
		}
		if (!wordless) bytes += file.size;
		const read = wordless ? ({ kind: "none" } as const) : await readText(workspace, texts, file);
		if (read.kind === "unread") unread.push({ path: file.path, why: read.why });
		if (read.kind === "text") searched++;
		return matchRead(file, read.kind === "text" ? read : { text: "" }, terms, limits.passages);
	});
	return { searched, found: rankMatches(results.filter((r): r is Found => r !== undefined)), unread: unread.sort((a, b) => a.path.localeCompare(b.path)), leftOut };
}

/** How a file answers the query, with a document's kind and the page, sheet or slide of each passage. */
function matchRead(file: WorkspaceFile, read: { readonly text: string; readonly document?: DocumentKind }, terms: readonly string[], passages: number): Found | undefined {
	const { text, document } = read;
	const match = matchFile({ path: file.path, modifiedAt: file.modifiedAt, text, ...(document === undefined ? {} : { walls: documentSectionLines(text) }) }, terms, passages);
	if (match === undefined || document === undefined) return match;
	return {
		...match,
		label: documentLabel(document),
		passages: match.passages.map((p) => {
			const section = documentSectionAt(text, p.hit);
			return section === undefined ? p : { ...p, section };
		}),
	};
}

/** A file's words: its text, a document's extracted text, or why there are none to search. */
async function readText(workspace: Workspace, texts: DocumentTexts, file: WorkspaceFile): Promise<Read> {
	let data: Buffer;
	try {
		data = await workspace.read(file.path);
	} catch {
		return { kind: "none" }; // removed or replaced while the search ran
	}
	const document = documentKind(file.path, data);
	if (document !== undefined || looksLikeDocument(file.path)) {
		try {
			const doc = await texts.text(file.path, data);
			return { kind: "text", text: doc.text, document: doc.kind };
		} catch (error) {
			if (!(error instanceof DocumentError)) throw error;
			return { kind: "unread", why: isTransient(error) ? "non sono riuscita a leggerlo ora" : error.message };
		}
	}
	if (oldFormatAdvice(file.path, data) !== undefined) return { kind: "unread", why: "è in un formato vecchio che non so leggere" };
	if (data.includes(0)) return { kind: "none" };
	return { kind: "text", text: data.toString("utf8") };
}
