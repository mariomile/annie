/**
 * The computer of an instance (ADR 0013): a machine apart from the cell, with no network and
 * no secrets, where Annie runs commands on copies of workspace files. Providers: a container
 * per instance on the Docker host (src/computer/docker-computer.ts); micro-VMs later.
 */
export type ComputerRun = {
	/** null: killed (time out) or never known. */
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/** More output than was kept. */
	readonly truncated: boolean;
	readonly ms: number;
};

export type ComputerProvider = {
	/** Run `command` with sh in /work. Starts the computer if it is not running. */
	run(key: string, command: string, options: { readonly timeoutS: number }): Promise<ComputerRun>;
	/** Write files under /work (paths relative to it). */
	put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void>;
	/** A file under /work, at most `maxBytes`. */
	get(key: string, path: string, maxBytes: number): Promise<Uint8Array>;
	/** Remove the computer and everything in /work. */
	reset(key: string): Promise<void>;
	/** Stop every computer of this process (they keep their files). */
	close(): Promise<void>;
};

/** Something the person or Annie can fix (a missing file, a file too big): said as it is. */
export class ComputerError extends Error {
	override readonly name = "ComputerError";
}

export const COMPUTER_CONNECTOR = "computer";
export const COMPUTER_LIMITS = { maxFileBytes: 20 * 1024 * 1024, maxFiles: 20, maxTimeoutS: 300, maxOutputChars: 16_000 } as const;

/** The computer's name for an instance of a tenant. */
export function computerKey(tenant: string, instance: string): string {
	const key = `${tenant}-${instance}`.toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,100}$/.test(key)) throw new Error(`Invalid computer key ${key}`);
	return key;
}

/** A path under /work as given by the model: relative, no `..`, no odd characters. Normalized, or undefined. */
export function workPath(path: string): string | undefined {
	const parts = path.replace(/^\/?work\//, "").split("/").filter((p) => p !== "" && p !== ".");
	if (parts.length === 0 || parts.length > 16) return undefined;
	if (parts.some((p) => p === ".." || !/^[\p{L}\p{N}_ .,()+=@-]{1,120}$/u.test(p) || p.startsWith("-"))) return undefined;
	return parts.join("/");
}

/** A tar archive of regular files, with the folders they need, owned by uid/gid 1000. */
export function tarFiles(files: readonly { readonly path: string; readonly data: Uint8Array }[]): Buffer {
	const blocks: Buffer[] = [];
	const folders = new Set<string>();
	for (const file of files) {
		const parts = file.path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const folder = `${parts.slice(0, i).join("/")}/`;
			if (folders.has(folder)) continue;
			folders.add(folder);
			blocks.push(tarHeader(folder, 0, "5", 0o755));
		}
		blocks.push(tarHeader(file.path, file.data.length, "0", 0o644), Buffer.from(file.data), Buffer.alloc((512 - (file.data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

function tarHeader(path: string, size: number, type: "0" | "5", mode: number): Buffer {
	const header = Buffer.alloc(512);
	let name = path;
	let prefix = "";
	if (Buffer.byteLength(name) > 100) {
		const cut = path.lastIndexOf("/", path.length - 2);
		prefix = path.slice(0, cut);
		name = path.slice(cut + 1);
		if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new ComputerError(`percorso troppo lungo: ${path.slice(0, 60)}…`);
	}
	const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;
	header.write(name, 0, 100, "utf8");
	header.write(octal(mode, 8), 100, "ascii");
	header.write(octal(1000, 8), 108, "ascii");
	header.write(octal(1000, 8), 116, "ascii");
	header.write(octal(size, 12), 124, "ascii");
	header.write(octal(Math.floor(Date.now() / 1000), 12), 136, "ascii");
	header.write("        ", 148, "ascii");
	header.write(type, 156, "ascii");
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	header.write(prefix, 345, 155, "utf8");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return header;
}

/** The first regular file of a tar archive (Docker's archive of one path), or undefined. */
export function untarFirstFile(archive: Uint8Array): Uint8Array | undefined {
	const tar = Buffer.from(archive);
	for (let at = 0; at + 512 <= tar.length; ) {
		const header = tar.subarray(at, at + 512);
		if (header.every((b) => b === 0)) return undefined;
		const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
		const type = String.fromCharCode(header[156] ?? 48);
		const start = at + 512;
		// "0" (or NUL, old tars): a regular file. Others (folders, pax headers, links) are skipped.
		if (type === "0" || type === "\0") return tar.subarray(start, start + size);
		at = start + Math.ceil(size / 512) * 512;
	}
	return undefined;
}
