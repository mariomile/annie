import { createHash } from "node:crypto";
import { type Workspace, WorkspaceError } from "./workspace.ts";

/**
 * Files of the workspace attached to a mail Annie asks to send (google-actions.ts). A request keeps
 * only each file's path, name, size and hash: the file is read again when the person approves,
 * and goes only if it is still exactly the one shown on the card. Contents never reach the model,
 * the request or the logs.
 */
export type MailAttachment = {
	readonly path: string;
	/** The name the recipient sees: the file's own, without what could break a header. */
	readonly name: string;
	readonly size: number;
	readonly sha256: string;
	readonly contentType: string;
};

/** A file read back at approval, as the message carries it. */
export type AttachmentData = { readonly name: string; readonly contentType: string; readonly data: Buffer };

export class AttachmentError extends Error {
	override readonly name = "AttachmentError";
}

/**
 * Gmail takes 25 MB per message, counted after base64 (4/3 and line breaks): 18 MiB of files
 * leaves room for the text and the headers.
 */
export const ATTACHMENT_LIMITS = { maxFiles: 5, maxTotalBytes: 18 * 1024 * 1024, maxName: 120 } as const;

/** Documents an office sends; nothing that runs (scripts, executables, macros, web pages) and no archives. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	csv: "text/csv",
	txt: "text/plain",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	xml: "application/xml",
	p7m: "application/pkcs7-mime",
};

/** How the files of a type begin: a file whose bytes say otherwise is not attached under that name. */
const MAGIC: Readonly<Record<string, readonly Buffer[]>> = {
	pdf: [Buffer.from("%PDF-")],
	docx: [Buffer.from("PK\x03\x04", "latin1")],
	xlsx: [Buffer.from("PK\x03\x04", "latin1")],
	pptx: [Buffer.from("PK\x03\x04", "latin1")],
	odt: [Buffer.from("PK\x03\x04", "latin1")],
	ods: [Buffer.from("PK\x03\x04", "latin1")],
	png: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
	jpg: [Buffer.from([0xff, 0xd8, 0xff])],
	jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
};

const KINDS = "PDF, Word (docx), Excel (xlsx), PowerPoint (pptx), OpenDocument (odt, ods), CSV, testo, immagini PNG e JPG, fatture XML e p7m";

/** The extension, lower case, of a name ("" when none). */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The name the recipient sees: the last part of the path, without control characters, quotes or backslashes, at most maxName characters (the extension kept). */
export function attachmentName(path: string): string {
	const last = path.split(/[\\/]+/).filter(Boolean).at(-1) ?? "allegato";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	let name = last.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\]/g, "").trim();
	if (name === "" || name.startsWith(".")) name = `allegato${name}`;
	const chars = [...name];
	if (chars.length > ATTACHMENT_LIMITS.maxName) {
		const ext = extensionOf(name);
		const keep = ATTACHMENT_LIMITS.maxName - (ext === "" ? 0 : ext.length + 1);
		name = chars.slice(0, keep).join("") + (ext === "" ? "" : `.${ext}`);
	}
	return name;
}

/** «84 KB», «1,2 MB». */
export function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} byte`;
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** The attachments in one line, for the card: «Allegati: Preventivo.pdf (84 KB), B-70.xml (3 KB)». */
export function attachmentsLine(list: readonly MailAttachment[]): string {
	if (list.length === 0) return "";
	return `${list.length === 1 ? "Allegato" : "Allegati"}: ${list.map((a) => `${a.name} (${sizeText(a.size)})`).join(", ")}`;
}

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Read through the workspace's own rules (no "..", no hidden names, no symlinks, nothing outside): its refusal said in Italian. */
async function guarded<T>(path: string, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof WorkspaceError) throw new AttachmentError(`non posso allegare «${attachmentName(path)}»: il percorso non è un file del workspace che si può mandare (niente cartelle sopra, file nascosti o collegamenti)`);
		throw error;
	}
}

/**
 * The files to attach, checked now: in the workspace, of an allowed type, within the limits.
 * Each one's size and hash are kept, so the approval sends exactly these bytes.
 */
export async function attachFiles(workspace: Workspace, paths: readonly string[]): Promise<MailAttachment[]> {
	const unique = [...new Set(paths.map((p) => String(p).trim().split(/[\\/]+/).filter((x) => x !== "" && x !== ".").join("/")))].filter((p) => p !== "");
	if (unique.length > ATTACHMENT_LIMITS.maxFiles) throw new AttachmentError(`al massimo ${ATTACHMENT_LIMITS.maxFiles} allegati per mail`);
	const out: MailAttachment[] = [];
	let total = 0;
	for (const path of unique) {
		const ext = extensionOf(attachmentName(path));
		const contentType = ATTACHMENT_TYPES[ext];
		if (contentType === undefined) throw new AttachmentError(`non allego «${attachmentName(path)}»: ${ext === "" ? "il file non ha estensione" : `i file .${ext} non si mandano`}. Posso allegare ${KINDS}`);
		const stat = await guarded(path, () => workspace.stat(path));
		if (stat === undefined) throw new AttachmentError(`non trovo «${attachmentName(path)}» nel workspace: controlla il percorso con file_list`);
		total += stat.size;
		if (total > ATTACHMENT_LIMITS.maxTotalBytes) throw new AttachmentError(`gli allegati superano ${sizeText(ATTACHMENT_LIMITS.maxTotalBytes)} in tutto, troppo per una mail: mandane meno, o mandali da qui con file_send`);
		const data = await guarded(path, () => workspace.read(path));
		if (data.length !== stat.size) throw new AttachmentError(`«${attachmentName(path)}» sta cambiando: riprova tra poco`);
		const magic = MAGIC[ext];
		if (magic !== undefined && !magic.some((m) => data.subarray(0, m.length).equals(m))) throw new AttachmentError(`«${attachmentName(path)}» non è davvero un file .${ext}: non lo allego`);
		out.push({ path: stat.path, name: attachmentName(path), size: data.length, sha256: sha256(data), contentType });
	}
	return out;
}

/** The message the person reads when a file is no longer the one on the card. */
export const ATTACHMENT_CHANGED = "il file è cambiato dopo la richiesta: chiedi di nuovo";

/** The files read again at approval: each must still be there with the same bytes, or nothing is sent. */
export async function readAttachments(workspace: Workspace, list: readonly MailAttachment[]): Promise<AttachmentData[]> {
	if (list.length > ATTACHMENT_LIMITS.maxFiles || list.reduce((n, a) => n + a.size, 0) > ATTACHMENT_LIMITS.maxTotalBytes) throw new AttachmentError("troppi allegati per una mail");
	const out: AttachmentData[] = [];
	for (const a of list) {
		let data: Buffer;
		try {
			const stat = await workspace.stat(a.path);
			if (stat === undefined || stat.size !== a.size) throw new AttachmentError(ATTACHMENT_CHANGED);
			data = await workspace.read(a.path);
		} catch (error) {
			if (error instanceof AttachmentError || error instanceof WorkspaceError) throw new AttachmentError(`${ATTACHMENT_CHANGED} (${a.name})`);
			throw error;
		}
		if (data.length !== a.size || sha256(data) !== a.sha256) throw new AttachmentError(`${ATTACHMENT_CHANGED} (${a.name})`);
		const type = ATTACHMENT_TYPES[extensionOf(a.name)];
		if (type === undefined || type !== a.contentType) throw new AttachmentError(`tipo di allegato non consentito (${a.name})`);
		out.push({ name: a.name, contentType: a.contentType, data });
	}
	return out;
}
