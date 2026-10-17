import { Worker } from "node:worker_threads";
import { DocumentError, type DocumentText } from "./documents.ts";

/**
 * Reads a document in a worker thread (ADR 0026), so a file made to be slow or huge costs at
 * most `timeoutMs` and `memoryMb` of one worker, never the event loop that serves every tenant.
 * At most `MAX_WORKERS` at once in the process; the others wait their turn.
 */
export const DOCUMENT_READER_LIMITS = { timeoutMs: 20_000, memoryMb: 512, maxWorkers: 2, waitMs: 45_000 } as const;

const AGAIN = "non sono riuscita a leggerlo ora, riprova tra poco";

let running = 0;
const waiting: (() => void)[] = [];

/**
 * `waitMs`: how long to wait for a free worker before giving up with "riprova tra poco", so
 * documents from the web cannot keep a person's file waiting without end.
 */
export async function readDocumentText(name: string, data: Uint8Array, options: { timeoutMs?: number; waitMs?: number } = {}): Promise<DocumentText> {
	if (running >= DOCUMENT_READER_LIMITS.maxWorkers) await turn(options.waitMs ?? DOCUMENT_READER_LIMITS.waitMs);
	running++;
	try {
		return await inWorker(name, data, options.timeoutMs ?? DOCUMENT_READER_LIMITS.timeoutMs);
	} finally {
		running--;
		waiting.shift()?.();
	}
}

function turn(waitMs: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const go = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			const at = waiting.indexOf(go);
			if (at >= 0) waiting.splice(at, 1);
			reject(new DocumentError(AGAIN));
		}, waitMs);
		waiting.push(go);
	});
}

function inWorker(name: string, data: Uint8Array, timeoutMs: number): Promise<DocumentText> {
	// From source (tsx, the tests) the worker is TypeScript that Node runs by stripping the types, so
	// its files use only erasable syntax; built, it is JavaScript.
	const source = import.meta.url.endsWith(".ts");
	const worker = new Worker(new URL(source ? "./document-worker.ts" : "./document-worker.js", import.meta.url), {
		workerData: { name, data },
		execArgv: [],
		resourceLimits: { maxOldGenerationSizeMb: DOCUMENT_READER_LIMITS.memoryMb, maxYoungGenerationSizeMb: 64 },
		stdout: true,
		stderr: true,
	});
	// Whatever the worker prints (Node's warnings) is drained, never shown.
	worker.stdout.resume();
	worker.stderr.resume();
	return new Promise<DocumentText>((resolve, reject) => {
		let settled = false;
		const settle = (outcome: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			outcome();
		};
		const timer = setTimeout(() => settle(() => reject(new DocumentError("il documento è troppo complesso da leggere"))), timeoutMs);
		worker.on("message", (message: { document?: DocumentText; error?: string }) =>
			settle(() => (message.document !== undefined ? resolve(message.document) : reject(new DocumentError(message.error ?? "il file è rovinato")))),
		);
		// A worker that fails is our problem, not the file's: the person can try again.
		worker.on("error", (error: Error & { code?: string }) =>
			settle(() => reject(new DocumentError(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "il documento è troppo grande da leggere" : AGAIN))),
		);
		worker.on("exit", () => settle(() => reject(new DocumentError(AGAIN))));
	});
}
