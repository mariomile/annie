/**
 * The invoice files a payment reminder can carry (invoices op reminder with attach_invoice): each
 * invoice's own file in the workspace (the XML, else the signed .p7m) and its PDF copy when one is
 * found and reads as that invoice: beside the XML with the same name, or named with the invoice's
 * number in the same folder; in both cases its text holds the number and the customer's partita
 * IVA, the invoice's date or its total. Reading PDFs has a budget per call. Only files of the
 * workspace, checked like any mail attachment.
 */
import { readDocumentText } from "../document-reader.ts";
import type { Invoice } from "../invoices.ts";
import { ATTACHMENT_LIMITS, AttachmentError, attachFiles, attachmentName, type MailAttachment } from "../mail-attachments.ts";
import { type Workspace, WorkspaceError } from "../workspace.ts";

/** The text of a document, to tell whether a PDF is the invoice. */
export type ReadText = (name: string, data: Uint8Array) => Promise<string>;

const readPdfText: ReadText = async (name, data) => (await readDocumentText(name, data)).text;

/** PDFs looked at per invoice, at most. */
const MAX_CANDIDATES = 4;
/** Larger PDFs are not read to check them. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Shorter numbers («1», «12») match too many names: only the PDF beside the XML is looked at. */
const MIN_NAMED_NUMBER = 3;

/** What one call may spend reading PDFs: so many of them, until a moment. Shared by the letters of the call. */
export type PdfBudget = { reads: number; readonly until: number; spent?: boolean };

/** The budget of one call: 12 PDFs, 30 seconds. */
export function pdfBudget(now = Date.now(), reads = 12, ms = 30_000): PdfBudget {
	return { reads, until: now + ms };
}

/** «fatture/B-70.xml.p7m» → «fatture/B-70». */
function stemOf(path: string): string {
	return path.replace(/(\.xml)?\.p7m$/i, "").replace(/\.xml$/i, "");
}

function folderOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` holds `number` as a whole (not «B-700» for «B-70»), any case. */
function holdsNumber(text: string, number: string): boolean {
	const pattern = escaped(number.trim()).replace(/\s+/g, "\\s*");
	return pattern !== "" && new RegExp(`(^|[^0-9A-Za-z])${pattern}(?![0-9A-Za-z])`, "i").test(text);
}

/** Whether `text` holds these digits not inside a longer number («IT00000520031» holds «00000520031»). */
function holdsDigits(text: string, digits: string): boolean {
	return new RegExp(`(^|[^0-9])${escaped(digits)}(?![0-9])`).test(text);
}

/** «1220.50» as an Italian document writes it: «1.220,50» or «1220,50». */
function italianAmounts(total: string): string[] {
	const m = /^-?(\d+)(?:\.(\d{1,2}))?$/.exec(total.trim());
	if (m === null) return [];
	const units = m[1] as string;
	const cents = (m[2] ?? "").padEnd(2, "0");
	return [...new Set([`${units.replace(/\B(?=(\d{3})+$)/g, ".")},${cents}`, `${units},${cents}`])];
}

/** Besides its number, what ties a PDF's text to this invoice: the customer's partita IVA, the date, the total. */
function tiedToInvoice(text: string, invoice: Invoice): boolean {
	const vat = invoice.customer.vat?.code.trim();
	if (vat !== undefined && vat.length >= 5 && holdsDigits(text, vat)) return true;
	const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(invoice.doc.date ?? "");
	if (date !== null && (holdsDigits(text, `${date[3]}/${date[2]}/${date[1]}`) || holdsDigits(text, `${date[1]}-${date[2]}-${date[3]}`))) return true;
	return italianAmounts(invoice.doc.total ?? "").some((amount) => holdsDigits(text, amount));
}

const LATE = Symbol("late");

/** `work`, or LATE when it takes longer than `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<typeof LATE>((resolve) => {
		timer = setTimeout(() => resolve(LATE), Math.max(0, ms));
	});
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** The budget is spent: said once per call. */
function spend(budget: PdfBudget, notes: string[]): void {
	if (budget.spent !== true) notes.push("non ho controllato altri PDF: troppi da leggere in una volta, li ho lasciati fuori (sollecita un cliente alla volta per averli)");
	budget.spent = true;
	budget.reads = 0;
}

/** The PDF that is this invoice, if one is found; notes on those looked at but not taken. Stops at the first that matches. */
async function courtesyPdf(workspace: Workspace, invoice: Invoice, readText: ReadText, budget: PdfBudget, notes: string[]): Promise<string | undefined> {
	const number = invoice.doc.number?.trim();
	if (number === undefined || number === "") return undefined;
	const beside = invoice.paths.flatMap((p) => [`${stemOf(p)}.pdf`, `${stemOf(p)}.PDF`]);
	let named: string[] = [];
	if (number.replace(/\s+/g, "").length >= MIN_NAMED_NUMBER) {
		try {
			named = (await workspace.list(folderOf(invoice.path))).filter((f) => /\.pdf$/i.test(f.path) && holdsNumber(attachmentName(f.path).replace(/\.pdf$/i, ""), number)).map((f) => f.path);
		} catch (error) {
			if (!(error instanceof WorkspaceError)) throw error;
		}
	}
	let looked = 0;
	for (const path of new Set([...beside, ...named])) {
		if (looked >= MAX_CANDIDATES) break;
		const there = await workspace.stat(path).catch((error: unknown) => {
			if (error instanceof WorkspaceError) return undefined;
			throw error;
		});
		if (there === undefined) continue;
		looked++;
		if (budget.reads <= 0 || Date.now() >= budget.until) {
			spend(budget, notes);
			return undefined;
		}
		let data: Buffer;
		try {
			data = (await workspace.readExact(path, MAX_PDF_BYTES)).data;
		} catch (error) {
			if (error instanceof WorkspaceError) continue;
			throw error;
		}
		budget.reads--;
		const name = attachmentName(path);
		let text: string | typeof LATE;
		try {
			text = await within(readText(name, data), budget.until - Date.now());
		} catch {
			notes.push(`non sono riuscita a leggere ${name} per controllare che sia la fattura ${number}: non l'ho allegato`);
			continue;
		}
		if (text === LATE) {
			notes.push(`${name} ci mette troppo a leggersi: non l'ho allegato`);
			spend(budget, notes);
			return undefined;
		}
		const ownNumber = holdsNumber(text, number);
		if (ownNumber && tiedToInvoice(text, invoice)) return path;
		if (!beside.includes(path)) continue;
		notes.push(ownNumber ? `${name} riporta il numero ${number} ma non la partita IVA del cliente, la data o l'importo della fattura: non l'ho allegato` : `${name} non riporta il numero ${number}: non l'ho allegato`);
	}
	return undefined;
}

/** Files of the letter and notes for the person: the PDFs not taken and why, an invoice with only its XML. */
type InvoiceFiles = { readonly paths: readonly string[]; readonly notes: readonly string[] };

/** The XML (or .p7m) of each invoice. */
function ownFile(invoice: Invoice): string {
	return invoice.paths.find((p) => /\.xml$/i.test(p)) ?? invoice.path;
}

/**
 * The workspace paths of these invoices' files: one per invoice, and its PDF copy when verified.
 * More invoices than a mail carries: refused before anything is read. PDFs only while there is room.
 */
async function invoiceFiles(workspace: Workspace, invoices: readonly Invoice[], readText: ReadText, budget: PdfBudget): Promise<InvoiceFiles> {
	if (invoices.length > ATTACHMENT_LIMITS.maxFiles) throw new AttachmentError(`al massimo ${ATTACHMENT_LIMITS.maxFiles} allegati per mail`);
	const paths: string[] = [];
	const notes: string[] = [];
	let room = ATTACHMENT_LIMITS.maxFiles - new Set(invoices.map(ownFile)).size;
	for (const invoice of invoices) {
		paths.push(ownFile(invoice));
		const number = invoice.doc.number ?? "la fattura senza numero";
		if (room <= 0) {
			notes.push(`per ${number} allego solo il file XML: al massimo ${ATTACHMENT_LIMITS.maxFiles} allegati per mail`);
			continue;
		}
		const pdf = await courtesyPdf(workspace, invoice, readText, budget, notes);
		if (pdf === undefined) notes.push(`per ${number} ho solo il file XML della fattura elettronica, che il cliente non legge facilmente: se hai il PDF di cortesia, mettilo nel workspace`);
		else if (!paths.includes(pdf)) {
			paths.push(pdf);
			room--;
		}
	}
	return { paths: [...new Set(paths)], notes };
}

/** The attachments of one letter, with notes, or why it cannot carry them (too many, too large, a file not allowed). */
export async function letterAttachments(workspace: Workspace, invoices: readonly Invoice[], budget: PdfBudget, readText: ReadText = readPdfText): Promise<{ attachments: MailAttachment[]; notes: readonly string[] } | { problem: string }> {
	try {
		const found = await invoiceFiles(workspace, invoices, readText, budget);
		return { attachments: await attachFiles(workspace, found.paths), notes: found.notes };
	} catch (error) {
		if (error instanceof AttachmentError) return { problem: `${error.message}; manda una fattura alla volta con number, o senza attach_invoice` };
		throw error;
	}
}

/**
 * The files to send by hand when Annie cannot send mail: each invoice's XML, and the PDF beside it
 * with the same name when there is one, labelled «da controllare»: found by name only, not read.
 */
export async function filesToForward(workspace: Workspace, invoices: readonly Invoice[]): Promise<string[]> {
	const out: string[] = [];
	for (const invoice of invoices) {
		out.push(ownFile(invoice));
		for (const pdf of [`${stemOf(ownFile(invoice))}.pdf`, `${stemOf(ownFile(invoice))}.PDF`]) {
			const found = await workspace.stat(pdf).catch((error: unknown) => {
				if (error instanceof WorkspaceError) return undefined;
				throw error;
			});
			if (found !== undefined) {
				out.push(`${found.path} (da controllare)`);
				break;
			}
		}
	}
	return [...new Set(out)];
}
