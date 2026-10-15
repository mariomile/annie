import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Worker = {
	readonly child: ChildProcess;
	readonly lines: string[];
	/** Resolves with the first stdout line starting with `prefix`; rejects if the process exits first. */
	waitForLine(prefix: string): Promise<string>;
	/** Resolves with the exit code (or signal) once the process is gone. */
	readonly exited: Promise<number | NodeJS.Signals>;
	stderr(): string;
};

/** Run a TypeScript fixture under test/fixtures in a real child process. */
export function spawnFixture(fixture: string, args: readonly string[]): Worker {
	const child = spawn(process.execPath, ["--import", "tsx", "--no-warnings", join(import.meta.dirname, "fixtures", fixture), ...args], {
		cwd: join(import.meta.dirname, ".."),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	const waiters: { prefix: string; resolve: (line: string) => void }[] = [];
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	const exited = new Promise<number | NodeJS.Signals>((resolve) => child.once("exit", (code, signal) => resolve(code ?? (signal as NodeJS.Signals))));
	createInterface({ input: child.stdout! }).on("line", (line) => {
		lines.push(line);
		for (const waiter of waiters.filter((w) => line.startsWith(w.prefix))) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(line);
		}
	});
	const waitForLine = (prefix: string) =>
		new Promise<string>((resolve, reject) => {
			const found = lines.find((line) => line.startsWith(prefix));
			if (found !== undefined) return resolve(found);
			waiters.push({ prefix, resolve });
			void exited.then((how) => {
				// Let readline flush the last lines before giving up.
				setImmediate(() => {
					const late = lines.find((line) => line.startsWith(prefix));
					if (late !== undefined) resolve(late);
					else reject(new Error(`${fixture} exited (${how}) before "${prefix}"\n${stderr}`));
				});
			});
		});
	return { child, lines, waitForLine, exited, stderr: () => stderr };
}

export async function kill9(worker: Worker): Promise<void> {
	worker.child.kill("SIGKILL");
	await worker.exited;
}
