import { parentPort, workerData } from "node:worker_threads";
import { DocumentError, documentText } from "./documents.ts";
import { PdfError, pdfPageImage } from "./pdf-text.ts";

/**
 * Runs one extraction for document-reader.ts, away from the event loop that serves everyone:
 * a document's text, or with `page` the picture on that page of a PDF (ADR 0028).
 */
const { name, data, page } = workerData as { name: string; data: Uint8Array; page?: number };
try {
	if (page !== undefined) {
		const image = pdfPageImage(Buffer.from(data), page);
		parentPort?.postMessage({ image });
	} else parentPort?.postMessage({ document: documentText(name, data) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof DocumentError || error instanceof PdfError ? error.message : "il file è rovinato" });
}
