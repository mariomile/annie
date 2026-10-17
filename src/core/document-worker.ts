import { parentPort, workerData } from "node:worker_threads";
import { DocumentError, documentText } from "./documents.ts";

/** Runs one extraction for document-reader.ts, away from the event loop that serves everyone. */
const { name, data } = workerData as { name: string; data: Uint8Array };
try {
	parentPort?.postMessage({ document: documentText(name, data) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof DocumentError ? error.message : "il file è rovinato" });
}
