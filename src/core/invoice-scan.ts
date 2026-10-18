/**
 * Finding the electronic invoices of a workspace for the scadenzario (invoices.ts): the files are
 * taken the way file_search takes them (newest first, within its limits), told apart by their
 * first 256 KB on this thread, and read in the document worker. What each file says is kept while
 * it stays the same (path, size, modification time), so asking again reads nothing new.
 */
import { FATTURA_SNIFF_BYTES, type Fattura, type FatturaDocument, isFatturaXml } from "./fattura-pa.ts";
import { DOCUMENT_READER_LIMITS, isTimeout, isTransient, readFattura } from "./document-reader.ts";
import { DocumentError } from "./documents.ts";
import { isSignedEnvelope, signedContentStart } from "./p7m.ts";
import { newestFirst, SEARCH_LIMITS, type SearchLimits, WORKER_WAIT_MS } from "./workspace-search.ts";
import type { Workspace, WorkspaceFile } from "./workspace.ts";

export type ScanLimits = Pick<SearchLimits, "files" | "bytes" | "budgetMs">;

export const SCAN_LIMITS = {
	/** Files whose reading is remembered, at least: the scan's own file limit when larger. */
	entries: 2000,
	/** Documents and instalments remembered, all files together: what bounds the memory. */
	weight: 500_000,
	/** Instalments kept per document: FatturaPA allows more, the tool's instalment goes to 100. */
	instalments: 100,
	/** How much of a file tells whether it is an invoice: the root element, or a signed envelope's start. */
	detectBytes: 256 * 1024,
	/** A file whose reading ran out of time is not tried again for this long. */
	backoffMs: 10 * 60_000,
} as const;

/** Names an invoice may have: .xml, signed .xml.p7m, or a bare .p7m that is not a signed PDF, Office file, text or picture. */
const CANDIDATE = /\.(?:xml|p7m)$/i;
const OTHER_SIGNED = /\.(?:pdf|docx|xlsx|pptx|odt|ods|odp|txt|csv|jpe?g|png|tiff?)(?:\.p7m)+$/i;

function maybeInvoice(path: string): boolean {
	return CANDIDATE.test(path) && !OTHER_SIGNED.test(path);
}

export type FoundFattura = { readonly path: string; readonly modifiedAt: string; readonly fattura: Fattura };

export type ScanOutcome = {
	readonly invoices: readonly FoundFattura[];
	/** Files whose name may be an invoice's. */
	readonly candidates: number;
	/** Invoices that cannot be read, with the reason. */
	readonly unread: readonly { readonly path: string; readonly why: string }[];
	/** Invoices not read now (no worker free, out of time): they may read in a while. */
	readonly busy: number;
	/** Files left out by the limits: the oldest. */
	readonly leftOut: number;
	/** Files with more documents than are read (a lotto past 100), or documents with instalments left out. */
	readonly cut: readonly { readonly path: string; readonly documents: number; readonly read: number; readonly instalments: boolean }[];
};

export type ReadFattura = (name: string, data: Uint8Array, options: { readonly timeoutMs?: number; readonly waitMs?: number; readonly signal?: AbortSignal }) => Promise<Fattura>;

type Entry = { readonly kind: "fattura"; readonly fattura: Fattura; readonly cutInstalments: boolean } | { readonly kind: "other" } | { readonly kind: "unread"; readonly why: string };

type Kept = { readonly entry: Entry; readonly weight: number; scan: number };

/**
 * Every scan of the process reads one file at a time in one worker, in turn: the document workers
 * are shared by the whole server, and file_read and file_search must always find one free. The
 * turn's signal reaches the wait for the lane and the read itself.
 */
let lane: Promise<void> = Promise.resolve();

/**
 * `work` when the reads before it are done. A turn stopped while it waits leaves at once; its
 * place is given up only when the read before it is over, so two reads never overlap.
 */
async function inLane<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
	const before = lane;
	let release = () => {};
	lane = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		await untilAborted(before, signal);
		return await work();
	} finally {
		void before.then(release);
	}
}

/** `promise`, or the signal's reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

/**
 * The invoices of one workspace. A file that is not an invoice is remembered too; a failure that
 * may not happen again is not, but a file that ran out of time waits SCAN_LIMITS.backoffMs before
 * it is tried again. Two scans asked at once share one.
 */
export class InvoiceScanner {
	private readonly workspace: Workspace;
	private readonly limits: ScanLimits;
	private readonly read: ReadFattura;
	private readonly maxEntries: number;
	private readonly now: () => number;
	private readonly maxWeight: number;
	private readonly entries = new Map<string, Kept>();
	private readonly backoff = new Map<string, number>();
	private weight = 0;
	private scans = 0;
	private running: Promise<ScanOutcome> | undefined;

	/** `maxWeight`, for tests: the memory bound, SCAN_LIMITS.weight otherwise. */
	constructor(workspace: Workspace, options: { readonly limits?: ScanLimits; readonly read?: ReadFattura; readonly now?: () => number; readonly maxWeight?: number } = {}) {
		this.workspace = workspace;
		this.limits = options.limits ?? SEARCH_LIMITS;
		this.read = options.read ?? readFattura;
		this.maxEntries = Math.max(SCAN_LIMITS.entries, this.limits.files);
		this.now = options.now ?? Date.now;
		this.maxWeight = options.maxWeight ?? SCAN_LIMITS.weight;
	}

	async scan(signal: AbortSignal, progress?: (text: string) => void): Promise<ScanOutcome> {
		while (this.running !== undefined) {
			const other = this.running;
			try {
				return await untilAborted(other, signal);
			} catch (error) {
				// This turn was stopped; or the other one was: then this one scans, unless a third already does.
				if (signal.aborted) throw error;
				if (this.running === other) this.running = undefined;
			}
		}
		const running = this.run(signal, progress);
		this.running = running;
		try {
			return await running;
		} finally {
			if (this.running === running) this.running = undefined;
		}
	}

	private async run(signal: AbortSignal, progress?: (text: string) => void): Promise<ScanOutcome> {
		const scan = ++this.scans;
		const files = newestFirst((await this.workspace.list()).filter((f) => maybeInvoice(f.path)));
		const considered = files.slice(0, this.limits.files);
		const fresh = considered.filter((f) => !this.entries.has(keyOf(f))).length;
		if (fresh >= 20) progress?.(`Leggo ${fresh} file di fatture…`);
		const started = performance.now();
		const left = () => this.limits.budgetMs - (performance.now() - started);
		let bytes = 0;
		let busy = 0;
		let leftOut = files.length - considered.length;
		const invoices: FoundFattura[] = [];
		const unread: { path: string; why: string }[] = [];
		const cut: { path: string; documents: number; read: number; instalments: boolean }[] = [];
		for (const file of considered) {
			signal.throwIfAborted();
			const key = keyOf(file);
			let kept = this.entries.get(key);
			if (kept === undefined) {
				if ((this.backoff.get(key) ?? 0) > this.now()) {
					busy++;
					continue;
				}
				// Past the time, the bytes, or the memory the cache may take (once what this scan does not use is gone): left for the next call.
				if (this.weight >= this.maxWeight) this.evict(scan);
				if (bytes + Math.min(file.size, SCAN_LIMITS.detectBytes) > this.limits.bytes || left() <= 0 || this.weight >= this.maxWeight) {
					leftOut++;
					continue;
				}
				const read = await this.readFile(file, key, left, signal);
				bytes += read.bytes;
				if (read.entry === undefined) {
					busy++;
					continue;
				}
				kept = this.keep(key, read.entry);
				// Between files the event loop serves everyone else.
				await new Promise((resolve) => setImmediate(resolve));
			} else {
				this.entries.delete(key);
				this.entries.set(key, kept);
			}
			kept.scan = scan;
			const { entry } = kept;
			if (entry.kind === "unread") unread.push({ path: file.path, why: entry.why });
			if (entry.kind !== "fattura") continue;
			invoices.push({ path: file.path, modifiedAt: file.modifiedAt, fattura: entry.fattura });
			if (entry.fattura.count > entry.fattura.documents.length || entry.cutInstalments) cut.push({ path: file.path, documents: entry.fattura.count, read: entry.fattura.documents.length, instalments: entry.cutInstalments });
		}
		this.evict(scan);
		return { invoices, candidates: files.length, unread, busy, leftOut, cut };
	}

	/**
	 * What the file is, and the bytes read to tell; no entry when it went away meanwhile or could
	 * not be read now. A file that ran out of its whole time waits before it is tried again; one
	 * cut short by the scan's budget does not.
	 */
	private async readFile(file: WorkspaceFile, key: string, left: () => number, signal: AbortSignal): Promise<{ entry?: Entry; bytes: number }> {
		let start: Buffer;
		try {
			start = await this.workspace.readStart(file.path, SCAN_LIMITS.detectBytes);
		} catch {
			return { bytes: 0 };
		}
		if (!looksLikeFattura(start)) return { entry: { kind: "other" }, bytes: start.length };
		let data: Buffer;
		try {
			data = start.length < file.size ? await this.workspace.read(file.path) : start;
		} catch {
			return { bytes: start.length };
		}
		const bytes = data.length;
		const timeoutMs = Math.max(1000, Math.min(DOCUMENT_READER_LIMITS.timeoutMs, left()));
		try {
			const fattura = await inLane(() => this.read(file.path, data, { waitMs: WORKER_WAIT_MS, timeoutMs, signal }), signal);
			return { entry: trimmed(fattura), bytes };
		} catch (error) {
			if (!(error instanceof DocumentError)) throw error;
			if (isTimeout(error) && timeoutMs >= DOCUMENT_READER_LIMITS.timeoutMs) this.backoff.set(key, this.now() + SCAN_LIMITS.backoffMs);
			if (isTransient(error)) return { bytes };
			return { entry: { kind: "unread", why: error.message }, bytes };
		}
	}

	private keep(key: string, entry: Entry): Kept {
		const kept: Kept = { entry, weight: weightOf(entry), scan: 0 };
		this.entries.set(key, kept);
		this.weight += kept.weight;
		this.backoff.delete(key);
		return kept;
	}

	/** The least recently used go, past the limits; never one this scan used, so a big workspace does not read itself over and over. */
	private evict(scan: number): void {
		for (const [key, kept] of this.entries) {
			if (this.entries.size <= this.maxEntries && this.weight <= this.maxWeight) break;
			if (kept.scan === scan) continue;
			this.entries.delete(key);
			this.weight -= kept.weight;
		}
		const now = this.now();
		for (const [key, until] of this.backoff) if (until <= now) this.backoff.delete(key);
	}
}

function keyOf(file: WorkspaceFile): string {
	return `${file.path}\u0000${file.size}\u0000${file.modifiedAt}`;
}

/** An invoice by its start: FatturaPA's root element, or a signed envelope whose content starts with it. No ZIP is opened here. */
function looksLikeFattura(start: Uint8Array): boolean {
	if (!isSignedEnvelope(start)) return isFatturaXml(start);
	const content = signedContentStart(start, FATTURA_SNIFF_BYTES);
	return content !== undefined && isFatturaXml(content);
}

/** At most SCAN_LIMITS.instalments instalments per document: the memory a cached file takes stays bounded. */
function trimmed(fattura: Fattura): Entry {
	let cutInstalments = false;
	const documents = fattura.documents.map((doc): FatturaDocument => {
		if (doc.instalments.length <= SCAN_LIMITS.instalments) return doc;
		cutInstalments = true;
		return { ...doc, instalments: doc.instalments.slice(0, SCAN_LIMITS.instalments) };
	});
	return { kind: "fattura", fattura: cutInstalments ? { ...fattura, documents } : fattura, cutInstalments };
}

function weightOf(entry: Entry): number {
	return entry.kind === "fattura" ? 1 + entry.fattura.documents.reduce((n, d) => n + 1 + d.instalments.length + (d.vatRows?.length ?? 0), 0) : 1;
}
