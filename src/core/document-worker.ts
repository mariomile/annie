import { parentPort, workerData } from "node:worker_threads";
import { ChartError, type ChartSpec, drawChart } from "./charts.ts";
import { DocumentError, documentText } from "./documents.ts";
import { MakeError, type MakeInput, makeDocument } from "./make-document.ts";
import { PdfError, pdfPageImage } from "./pdf-text.ts";
import { type TableQuery, TableError, queryTable } from "./tables.ts";

/**
 * Runs one extraction for document-reader.ts, away from the event loop that serves everyone:
 * a document's text, with `page` the picture on that page of a PDF (ADR 0028), or with `make`
 * a Word, Excel or PDF file to write (ADR 0029), with `chart` a chart to draw (ADR 0030),
 * with `table` a question to a table (ADR 0031).
 */
const { name, data, page, make, chart, table } = workerData as { name: string; data: Uint8Array; page?: number; make?: MakeInput; chart?: ChartSpec; table?: TableQuery };
try {
	if (table !== undefined) parentPort?.postMessage({ table: queryTable(name, data, table) });
	else if (chart !== undefined) parentPort?.postMessage({ made: drawChart(chart) });
	else if (make !== undefined) parentPort?.postMessage({ made: makeDocument(make) });
	else if (page !== undefined) {
		const image = pdfPageImage(Buffer.from(data), page);
		parentPort?.postMessage({ image });
	} else parentPort?.postMessage({ document: documentText(name, data) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof DocumentError || error instanceof PdfError || error instanceof MakeError || error instanceof ChartError || error instanceof TableError ? error.message : table !== undefined ? "non sono riuscita ad analizzarla" : chart !== undefined ? "non sono riuscita a disegnarlo" : make !== undefined ? "non sono riuscita a crearlo" : "il file è rovinato" });
}
