import { inflateRawSync } from "node:zlib";

/**
 * Just enough of ZIP to read Office and OpenDocument files (ADR 0026): the central directory,
 * stored and deflated entries. No ZIP64, no encryption. Every limit is checked before the work,
 * so a crafted file (a "zip bomb") costs at most `maxEntryBytes` of memory per entry read.
 */
export class ZipError extends Error {
	override readonly name = "ZipError";
}

export const ZIP_LIMITS = { maxEntries: 10_000, maxEntryBytes: 30 * 1024 * 1024, maxTotalBytes: 80 * 1024 * 1024 } as const;

type Entry = { readonly method: number; readonly compressedSize: number; readonly size: number; readonly offset: number; readonly flags: number };

export class Zip {
	private readonly entries = new Map<string, Entry>();
	private read = 0;
	private readonly data: Buffer;

	constructor(data: Buffer) {
		this.data = data;
		const end = findEndOfDirectory(data);
		const count = data.readUInt16LE(end + 10);
		const size = data.readUInt32LE(end + 12);
		let at = data.readUInt32LE(end + 16);
		if (count > ZIP_LIMITS.maxEntries) throw new ZipError(`troppi file nell'archivio (${count})`);
		if (at + size > data.length) throw new ZipError("archivio troncato");
		for (let i = 0; i < count; i++) {
			if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw new ZipError("indice dell'archivio rovinato");
			const flags = data.readUInt16LE(at + 8);
			const method = data.readUInt16LE(at + 10);
			const compressedSize = data.readUInt32LE(at + 20);
			const entrySize = data.readUInt32LE(at + 24);
			const nameLength = data.readUInt16LE(at + 28);
			const extraLength = data.readUInt16LE(at + 30);
			const commentLength = data.readUInt16LE(at + 32);
			const offset = data.readUInt32LE(at + 42);
			const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
			if (compressedSize === 0xffffffff || entrySize === 0xffffffff || offset === 0xffffffff) throw new ZipError("archivio ZIP64: non supportato");
			this.entries.set(name, { method, compressedSize, size: entrySize, offset, flags });
			at += 46 + nameLength + extraLength + commentLength;
		}
	}

	names(): string[] {
		return [...this.entries.keys()];
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	/** The entry's bytes, or undefined if there is none by that name. */
	file(name: string): Buffer | undefined {
		const entry = this.entries.get(name);
		if (entry === undefined) return undefined;
		if ((entry.flags & 1) !== 0) throw new ZipError("archivio protetto da password");
		if (entry.size > ZIP_LIMITS.maxEntryBytes) throw new ZipError(`${name} è troppo grande da aprire`);
		if (this.read + entry.size > ZIP_LIMITS.maxTotalBytes) throw new ZipError("l'archivio è troppo grande da aprire");
		const at = entry.offset;
		if (at + 30 > this.data.length || this.data.readUInt32LE(at) !== 0x04034b50) throw new ZipError("archivio rovinato");
		const start = at + 30 + this.data.readUInt16LE(at + 26) + this.data.readUInt16LE(at + 28);
		const raw = this.data.subarray(start, start + entry.compressedSize);
		if (raw.length !== entry.compressedSize) throw new ZipError("archivio troncato");
		let out: Buffer;
		if (entry.method === 0) out = Buffer.from(raw);
		else if (entry.method === 8) {
			try {
				// The size in the index is a claim: the inflater stops at the limit whatever it says.
				out = inflateRawSync(raw, { maxOutputLength: Math.min(ZIP_LIMITS.maxEntryBytes, Math.max(entry.size, 1)) });
			} catch {
				throw new ZipError(`${name} non si decomprime`);
			}
		} else throw new ZipError(`compressione ${entry.method} non supportata`);
		this.read += out.length;
		return out;
	}

	text(name: string): string | undefined {
		return this.file(name)?.toString("utf8");
	}
}

function findEndOfDirectory(data: Buffer): number {
	if (data.length < 22) throw new ZipError("non è un archivio ZIP");
	const from = Math.max(0, data.length - 22 - 65_535);
	for (let at = data.length - 22; at >= from; at--) if (data.readUInt32LE(at) === 0x06054b50) return at;
	throw new ZipError("non è un archivio ZIP");
}
