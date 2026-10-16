import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace, WorkspaceError } from "../src/core/workspace.ts";
import { tempDataDir } from "./helpers.ts";

describe("workspace", () => {
	it("writes, reads, lists and deletes files under relative paths", async () => {
		const ws = new Workspace(join(tempDataDir(), "ws"));
		await ws.write("report/ottobre.md", "# Ottobre\n");
		await ws.write("dati.csv", Buffer.from("a,b\n1,2\n"));
		expect((await ws.read("report/ottobre.md")).toString("utf8")).toBe("# Ottobre\n");
		const list = await ws.list();
		expect(list.map((f) => [f.path, f.size])).toEqual([
			["dati.csv", 8],
			["report/ottobre.md", 10],
		]);
		expect(await ws.list("report")).toHaveLength(1);
		await ws.remove("dati.csv");
		expect((await ws.list()).map((f) => f.path)).toEqual(["report/ottobre.md"]);
	});

	it("never leaves its folder: no .., no absolute paths, no symlinks out", async () => {
		const dir = tempDataDir();
		const ws = new Workspace(join(dir, "ws"));
		for (const bad of ["../segreti.json", "/etc/passwd", "a/../../x", "", ".", "a\0b"]) {
			await expect(ws.write(bad, "x")).rejects.toThrow(WorkspaceError);
		}
		writeFileSync(join(dir, "secret.txt"), "no");
		mkdirSync(join(dir, "ws"), { recursive: true });
		symlinkSync(join(dir, "secret.txt"), join(dir, "ws", "link.txt"));
		await expect(ws.read("link.txt")).rejects.toThrow(WorkspaceError);
		expect((await ws.list()).map((f) => f.path)).toEqual([]);
	});

	it("enforces the size limits", async () => {
		const ws = new Workspace(join(tempDataDir(), "ws"), { maxFileBytes: 10, maxTotalBytes: 15 });
		await expect(ws.write("big.txt", "x".repeat(11))).rejects.toThrow("10 bytes");
		await ws.write("a.txt", "x".repeat(10));
		await expect(ws.write("b.txt", "x".repeat(6))).rejects.toThrow("15 bytes");
		// Replacing a file counts its new size, not both.
		await ws.write("a.txt", "y".repeat(10));
		await expect(ws.read("missing.txt")).rejects.toThrow("not found");
	});
});
