/**
 * A store kept as one JSON file of an instance (quotes.json, expenses.json): read without ever
 * throwing, changed under the shared file lock (locked-json.ts), and copied to `<file>.bak` after
 * every change written. A file that does not read, does not have the book's shape or is past its
 * size cap is broken: it is never written over, so a hand-made change is never lost.
 */
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { updateJsonFile } from "./locked-json.ts";

export type BookFile<T> = {
	readonly file: string;
	readonly empty: T;
	readonly maxBytes: number;
	/** The book when the JSON has its shape; undefined otherwise. */
	readonly valid: (raw: unknown) => T | undefined;
	/** The errors to throw: the file does not read; the change would make it too large. */
	readonly broken: () => Error;
	readonly full: () => Error;
};

/** The book; `empty` when there is no file; undefined when it is broken. Never throws. */
export function readBook<T>(f: BookFile<T>): T | undefined {
	let text: string;
	try {
		if (statSync(f.file).size > f.maxBytes) return undefined;
		text = readFileSync(f.file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? f.empty : undefined;
	}
	try {
		return f.valid(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/** `change` under the lock: the same book back writes nothing; a new one is written, then copied to `.bak`. */
export function updateBook<T>(f: BookFile<T>, change: (book: T) => T): void {
	if (readBook(f) === undefined) throw f.broken();
	let changed = false;
	try {
		updateJsonFile<unknown>(f.file, f.empty, (raw) => {
			const book = f.valid(raw);
			if (book === undefined) throw f.broken();
			const next = change(book);
			changed = next !== book;
			if (changed && Buffer.byteLength(JSON.stringify(next, null, 2)) >= f.maxBytes) throw f.full();
			return changed ? next : raw;
		});
	} catch (error) {
		// Changed into something unreadable meanwhile.
		if (error instanceof SyntaxError) throw f.broken();
		throw error;
	}
	if (changed && existsSync(f.file)) copyFileSync(f.file, `${f.file}.bak`);
}
