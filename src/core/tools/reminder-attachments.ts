/**
 * The invoice files a payment reminder can carry (invoices op reminder with attach_invoice): each
 * invoice's own file in the workspace (the XML, else the signed .p7m) and its PDF copy when one is
 * found and reads as that invoice: beside the XML with the same name, or named with the invoice's
 * number in the same folder, and in both cases with the number in its text. Only files of the
 * workspace, checked like any mail attachment.
 */
import { readDocumentText } from "../document-reader.ts";
import type { Invoice } from "../invoices.ts";
import { AttachmentError, attachFiles, attachmentName, type MailAttachment } from "../mail-attachments.ts";
import { type Workspace, WorkspaceError } from "../workspace.ts";

/** The text of a document, to tell whether a PDF is the invoice. */
export type ReadText = (name: string, data: Uint8Array) => Promise<string>;

export const readPdfText: ReadText = async (name, data) => (await readDocumentText(name, data)).text;

/** PDFs looked at per invoice, at most. */
const MAX_CANDIDATES = 4;
/** Larger PDFs are not read to check them. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** «fatture/B-70.xml.p7m» → «fatture/B-70». */
function stemOf(path: string): string {
	return path.replace(/(\.xml)?\.p7m$/i, "").replace(/\.xml$/i, "");
}

function folderOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

/** Whether `text` holds `number` as a whole (not «B-700» for «B-70»), any case. */
export function holdsNumber(text: string, number: string): boolean {
	const escaped = number.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
	return escaped !== "" && new RegExp(`(^|[^0-9A-Za-z])${escaped}(?![0-9A-Za-z])`, "i").test(text);
}

/** Files of the letter and notes for the person: the PDFs not taken and why, an invoice with only its XML. */
export type InvoiceFiles = { readonly paths: readonly string[]; readonly notes: readonly string[] };

/** The PDF that is this invoice, if one is found; notes on those looked at but not taken. */
async function courtesyPdf(workspace: Workspace, invoice: Invoice, number: string | undefined, readText: ReadText, notes: string[]): Promise<string | undefined> {
	if (number === undefined) return undefined;
	const beside = invoice.paths.flatMap((p) => [`${stemOf(p)}.pdf`, `${stemOf(p)}.PDF`]);
	let named: string[] = [];
	try {
		named = (await workspace.list(folderOf(invoice.path))).filter((f) => /\.pdf$/i.test(f.path) && holdsNumber(attachmentName(f.path).replace(/\.pdf$/i, ""), number)).map((f) => f.path);
	} catch (error) {
		if (!(error instanceof WorkspaceError)) throw error;
	}
	for (const path of [...new Set([...beside, ...named])].slice(0, MAX_CANDIDATES)) {
		let data: Buffer;
		try {
			data = (await workspace.readExact(path, MAX_PDF_BYTES)).data;
		} catch (error) {
			if (error instanceof WorkspaceError) continue;
			throw error;
		}
		let text: string;
		try {
			text = await readText(attachmentName(path), data);
		} catch {
			notes.push(`non sono riuscita a leggere ${attachmentName(path)} per controllare che sia la fattura ${number}: non l'ho allegato`);
			continue;
		}
		if (holdsNumber(text, number)) return path;
		if (beside.includes(path)) notes.push(`${attachmentName(path)} non riporta il numero ${number}: non l'ho allegato`);
	}
	return undefined;
}

/** The workspace paths of these invoices' files: one per invoice, and its PDF copy when verified. */
export async function invoiceFiles(workspace: Workspace, invoices: readonly Invoice[], readText: ReadText = readPdfText): Promise<InvoiceFiles> {
	const paths: string[] = [];
	const notes: string[] = [];
	for (const invoice of invoices) {
		paths.push(invoice.paths.find((p) => /\.xml$/i.test(p)) ?? invoice.path);
		const number = invoice.doc.number;
		const pdf = await courtesyPdf(workspace, invoice, number, readText, notes);
		if (pdf !== undefined) paths.push(pdf);
		else notes.push(`per ${number ?? "la fattura senza numero"} ho solo il file XML della fattura elettronica, che il cliente non legge facilmente: se hai il PDF di cortesia, mettilo nel workspace`);
	}
	return { paths: [...new Set(paths)], notes };
}

/** The attachments of one letter, with notes, or why it cannot carry them (too many, too large, a file not allowed). */
export async function letterAttachments(workspace: Workspace, invoices: readonly Invoice[], readText: ReadText = readPdfText): Promise<{ attachments: MailAttachment[]; notes: readonly string[] } | { problem: string }> {
	try {
		const found = await invoiceFiles(workspace, invoices, readText);
		return { attachments: await attachFiles(workspace, found.paths), notes: found.notes };
	} catch (error) {
		if (error instanceof AttachmentError) return { problem: `${error.message}; manda una fattura alla volta con number, o senza attach_invoice` };
		throw error;
	}
}
