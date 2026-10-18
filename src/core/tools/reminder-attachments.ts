/**
 * The invoice files a payment reminder can carry (invoices op reminder with attach_invoice): each
 * invoice's own file in the workspace (the XML, else the signed .p7m) and a PDF beside it with the
 * same name, when there is one. Only files of the workspace, checked like any mail attachment.
 */
import type { Invoice } from "../invoices.ts";
import { AttachmentError, attachFiles, type MailAttachment } from "../mail-attachments.ts";
import { type Workspace, WorkspaceError } from "../workspace.ts";

/** «fatture/B-70.xml.p7m» → «fatture/B-70». */
function stemOf(path: string): string {
	return path.replace(/(\.xml)?\.p7m$/i, "").replace(/\.xml$/i, "");
}

/** The workspace paths of these invoices' files: one per invoice, and its PDF copy if found. */
export async function invoiceFiles(workspace: Workspace, invoices: readonly Invoice[]): Promise<string[]> {
	const out: string[] = [];
	for (const invoice of invoices) {
		out.push(invoice.paths.find((p) => /\.xml$/i.test(p)) ?? invoice.path);
		for (const stem of new Set(invoice.paths.map(stemOf))) {
			for (const pdf of [`${stem}.pdf`, `${stem}.PDF`]) {
				try {
					if ((await workspace.stat(pdf)) !== undefined) {
						out.push(pdf);
						break;
					}
				} catch (error) {
					if (!(error instanceof WorkspaceError)) throw error;
				}
			}
		}
	}
	return [...new Set(out)];
}

/** The attachments of one letter, or why it cannot carry them (too many, too large, a file not allowed). */
export async function letterAttachments(workspace: Workspace, invoices: readonly Invoice[]): Promise<MailAttachment[] | { problem: string }> {
	try {
		return await attachFiles(workspace, await invoiceFiles(workspace, invoices));
	} catch (error) {
		if (error instanceof AttachmentError) return { problem: `${error.message}; manda una fattura alla volta con number, o senza attach_invoice` };
		throw error;
	}
}
