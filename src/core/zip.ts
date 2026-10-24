import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

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
		if (entry.size > ZIP_LIMITS.maxEntryBytes) throw new ZipError("una parte dell'archivio è troppo grande da aprire");
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
				throw new ZipError("una parte dell'archivio non si decomprime");
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

/**
 * A ZIP of the given files, for the Office files Owni writes (ADR 0029). Pictures, already
 * compressed, are stored as they are; the rest is deflated. A fixed date (1 January 1980), so the
 * same files always give the same bytes.
 */
export function writeZip(files: readonly { readonly name: string; readonly data: Buffer | string }[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const data = typeof file.data === "string" ? Buffer.from(file.data, "utf8") : file.data;
		const stored = /\.(png|jpe?g)$/i.test(file.name);
		const packed = stored ? data : deflateRawSync(data);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // names in UTF-8
		local.writeUInt16LE(stored ? 0 : 8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x21, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(stored ? 0 : 8, 10);
		entry.writeUInt16LE(0, 12);
		entry.writeUInt16LE(0x21, 14);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(offset, 42);
		parts.push(local, name, packed);
		central.push(entry, name);
		offset += local.length + name.length + packed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}
