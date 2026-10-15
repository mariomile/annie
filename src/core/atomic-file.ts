import { mkdir, open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let counter = 0;

/**
 * Replace `file` with `data` atomically and durably: a reader sees the old content or the
 * new one, never a mix, and after this resolves the new content survives a crash (file and
 * directory entry are fsynced).
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
	const dir = dirname(file);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(file)}.${process.pid}.${counter++}.tmp`);
	const handle = await open(tmp, "w", 0o600);
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tmp, file);
	const dirHandle = await open(dir, "r");
	try {
		await dirHandle.sync();
	} finally {
		await dirHandle.close();
	}
}
