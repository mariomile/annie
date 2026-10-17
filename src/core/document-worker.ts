import { parentPort, workerData } from "node:worker_threads";
import { DocumentError, documentText } from "./documents.ts";
import { MakeError, type MakeInput, makeDocument } from "./make-document.ts";
import { PdfError, pdfPageImage } from "./pdf-text.ts";

/**
 * Runs one extraction for document-reader.ts, away from the event loop that serves everyone:
 * a document's text, with `page` the picture on that page of a PDF (ADR 0028), or with `make`
 * a Word, Excel or PDF file to write (ADR 0029).
 */
const { name, data, page, make } = workerData as { name: string; data: Uint8Array; page?: number; make?: MakeInput };
try {
	if (make !== undefined) parentPort?.postMessage({ made: makeDocument(make) });
	else if (page !== undefined) {
		const image = pdfPageImage(Buffer.from(data), page);
		parentPort?.postMessage({ image });
	} else parentPort?.postMessage({ document: documentText(name, data) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof DocumentError || error instanceof PdfError || error instanceof MakeError ? error.message : make !== undefined ? "non sono riuscita a crearlo" : "il file è rovinato" });
}
