import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cardView, type GoogleAction, googleActionTitle } from "../src/core/google-actions.ts";
import { ATTACHMENT_CHANGED, ATTACHMENT_LIMITS, AttachmentError, attachFiles, attachmentName, attachmentsLine, readAttachments } from "../src/core/mail-attachments.ts";
import { mimeMessage } from "../src/core/mail-mime.ts";
import { Workspace } from "../src/core/workspace.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "annie-attach-"));
	dirs.push(dir);
	return dir;
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) % 256))]);
const XML = Buffer.from('<?xml version="1.0"?><p:FatturaElettronica>àè</p:FatturaElettronica>', "utf8");

/** A workspace with these files (path → bytes). */
function workspaceWith(files: Record<string, Buffer | string>) {
	const dir = temp();
	const root = join(dir, "workspace");
	for (const [path, data] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), data);
	}
	return { dir, root, workspace: new Workspace(root) };
}

type Part = { headers: Record<string, string>; body: string };

/** Header lines unfolded, by lower-case name. */
function headersOf(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
		const colon = line.indexOf(":");
		out[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
	}
	return out;
}

/** A raw message read back: its headers and, for multipart, its parts. */
function parse(raw: string): { headers: Record<string, string>; parts: Part[]; boundary: string } {
	const cut = raw.indexOf("\r\n\r\n");
	const headers = headersOf(raw.slice(0, cut));
	const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1] ?? "";
	const body = raw.slice(cut + 4);
	expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
	const chunks = body.split(`--${boundary}`);
	// Nothing before the first boundary, the closing "--" after the last.
	expect(chunks[0]).toBe("");
	expect(chunks.at(-1)).toBe("--\r\n");
	const parts = chunks.slice(1, -1).map((c) => {
		const inner = c.replace(/^\r\n/, "").replace(/\r\n$/, "");
		const at = inner.indexOf("\r\n\r\n");
		return { headers: headersOf(inner.slice(0, at)), body: inner.slice(at + 4) };
	});
	return { headers, parts, boundary };
}

/** The file name a mail program reads: RFC 2231 filename* (with continuations) first, else filename. */
function fileName(disposition: string): string {
	const pieces = [...disposition.matchAll(/filename\*(\d+)?\*?=([^;]+)/g)].sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0)).map((m) => (m[2] as string).trim());
	if (pieces.length > 0) return decodeURIComponent(pieces.join("").replace(/^UTF-8''/, ""));
	return /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
}

const MAIL = { to: ["rossi@cliente.it"], cc: [], subject: "Preventivo n. 2026-012: Beta Ristorazione Srl", body: "Gentile Rossi,\nin allegato il preventivo.\nCordiali saluti" };

describe("mail attachments: MIME", () => {
	it("multipart/mixed: the text first, then each file in base64 lines of 76 that decode to the same bytes; non-ASCII names in RFC 2231", async () => {
		const name = "Preventivo città è più lungo del solito per vedere le continuazioni ünïcode.pdf";
		const { workspace } = workspaceWith({ [`preventivi/${name}`]: PDF, "fatture/B-70.xml": XML });
		const list = await attachFiles(workspace, [`preventivi/${name}`, "fatture/B-70.xml"]);
		expect(list.map((a) => [a.name, a.size, a.contentType])).toEqual([
			[name, PDF.length, "application/pdf"],
			["B-70.xml", XML.length, "application/xml"],
		]);
		const raw = mimeMessage(MAIL, await readAttachments(workspace, list));
		expect(raw).toMatch(/^[\x00-\x7f]*$/);
		const { headers, parts, boundary } = parse(raw);
		expect(headers.to).toBe("rossi@cliente.it");
		expect(headers.subject).toBe(MAIL.subject);
		expect(headers["mime-version"]).toBe("1.0");
		expect(headers["content-type"]).toBe(`multipart/mixed; boundary="${boundary}"`);
		expect(boundary).toMatch(/^=_annie_[0-9a-f]{36}$/);
		expect(parts).toHaveLength(3);
		const [text, pdf, xml] = parts as [Part, Part, Part];
		expect(text.headers["content-type"]).toBe("text/plain; charset=UTF-8");
		expect(Buffer.from(text.body, "base64").toString("utf8")).toBe(MAIL.body);
		for (const [part, bytes] of [
			[pdf, PDF],
			[xml, XML],
		] as const) {
			expect(part.headers["content-transfer-encoding"]).toBe("base64");
			expect(part.body.split("\r\n").every((l) => l.length <= 76)).toBe(true);
			expect(part.body.split("\r\n").slice(0, -1).every((l) => l.length === 76)).toBe(true);
			expect(Buffer.from(part.body, "base64").equals(bytes)).toBe(true);
		}
		expect(pdf.headers["content-type"]).toMatch(/^application\/pdf; name="=\?UTF-8\?B\?/);
		expect(pdf.headers["content-disposition"]).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*0\*=UTF-8''/);
		expect(fileName(pdf.headers["content-disposition"] as string)).toBe(name);
		expect(fileName(xml.headers["content-disposition"] as string)).toBe("B-70.xml");
		expect(xml.headers["content-disposition"]).toBe('attachment; filename="B-70.xml"');
		// Every header line stays short; the boundary is in no part.
		const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
		expect(head.split("\r\n").every((l) => l.length <= 78)).toBe(true);
		for (const p of parts) expect(`${Object.values(p.headers).join("")}${p.body}`).not.toContain(boundary);
		const partHeads = raw.split(`--${boundary}`).map((c) => c.slice(0, c.indexOf("\r\n\r\n")));
		expect(partHeads.every((h) => h.split("\r\n").every((l) => l.length <= 78))).toBe(true);
	});

	it("without attachments the mail stays plain text, as before", () => {
		const raw = mimeMessage(MAIL);
		expect(raw).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
		expect(raw).not.toContain("multipart");
		expect(Buffer.from(raw.split("\r\n\r\n")[1] as string, "base64").toString("utf8")).toBe(MAIL.body);
	});

	it("a file name cannot add headers: line breaks, quotes and backslashes are taken out, and MIME refuses them anyway", async () => {
		expect(attachmentName('dir/evil"\r\nBcc: spia@evil.com\r\n.pdf')).toBe("evilBcc: spia@evil.com.pdf");
		expect(attachmentName("a/.pdf")).toBe("allegato.pdf");
		expect(attachmentName(`${"x".repeat(300)}.pdf`)).toHaveLength(ATTACHMENT_LIMITS.maxName);
		const { workspace } = workspaceWith({ 'evil"\nBcc: spia@evil.com.pdf': PDF });
		const [file] = await attachFiles(workspace, ['evil"\nBcc: spia@evil.com.pdf']);
		expect(file?.name).toBe("evilBcc: spia@evil.com.pdf");
		const raw = mimeMessage(MAIL, await readAttachments(workspace, file === undefined ? [] : [file]));
		const { headers, parts } = parse(raw);
		expect(headers.bcc).toBeUndefined();
		expect(raw).not.toMatch(/\r\nBcc:/i);
		expect(fileName(parts[1]?.headers["content-disposition"] as string)).toBe("evilBcc: spia@evil.com.pdf");
		expect(() => mimeMessage(MAIL, [{ name: 'a"\r\nBcc: x@y.it', contentType: "application/pdf", data: PDF }])).toThrow(/allegato/);
		expect(() => mimeMessage(MAIL, [{ name: "a.pdf", contentType: "text/html\r\nBcc: x@y.it", data: PDF }])).toThrow(/allegato/);
	});
});

describe("mail attachments: what may be attached", () => {
	it("documents only: executables, scripts, web pages, archives and files without extension are refused; a file must be what its extension says", async () => {
		const { workspace } = workspaceWith({ "a.exe": "MZ", "b.js": "alert(1)", "c.sh": "rm", "d.bat": "x", "e.html": "<b>", "f.zip": "PK\x03\x04", g: "x", "h.docm": "PK", "fake.pdf": "<html>", "ok.csv": "a;b", "ok.txt": "ciao", "ok.p7m": "0\x82" });
		for (const path of ["a.exe", "b.js", "c.sh", "d.bat", "e.html", "f.zip", "g", "h.docm"]) await expect(attachFiles(workspace, [path])).rejects.toThrow(/non allego/);
		await expect(attachFiles(workspace, ["fake.pdf"])).rejects.toThrow(/non è davvero un file \.pdf/);
		expect((await attachFiles(workspace, ["ok.csv", "ok.txt", "ok.p7m"])).map((a) => a.contentType)).toEqual(["text/csv", "text/plain", "application/pkcs7-mime"]);
	});

	it("limits: at most 5 files and 18 MB in all, said before anything is asked", async () => {
		const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, "x"]));
		const { workspace } = workspaceWith({ ...files, "big1.pdf": Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(10 * 1024 * 1024)]), "big2.pdf": Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(9 * 1024 * 1024)]) });
		await expect(attachFiles(workspace, Object.keys(files))).rejects.toThrow("al massimo 5 allegati per mail");
		expect(await attachFiles(workspace, Object.keys(files).slice(0, 5))).toHaveLength(5);
		// The same file twice counts once.
		expect(await attachFiles(workspace, ["f0.txt", "./f0.txt", "f0.txt"])).toHaveLength(1);
		await expect(attachFiles(workspace, ["big1.pdf", "big2.pdf"])).rejects.toThrow(/superano 18,0 MB in tutto/);
		expect(await attachFiles(workspace, ["big1.pdf"])).toHaveLength(1);
	});

	it("only files of the workspace: no going up, no hidden names, no symlinks to files or folders outside", async () => {
		const { dir, root, workspace } = workspaceWith({ "ok.pdf": PDF });
		writeFileSync(join(dir, "secret.pdf"), PDF);
		mkdirSync(join(dir, "outside"));
		writeFileSync(join(dir, "outside", "x.pdf"), PDF);
		symlinkSync(join(dir, "secret.pdf"), join(root, "link.pdf"));
		symlinkSync(join(dir, "outside"), join(root, "linked"));
		mkdirSync(join(root, ".config"));
		writeFileSync(join(root, ".config", "x.pdf"), PDF);
		for (const path of ["../secret.pdf", "a/../../secret.pdf", "/etc/passwd.txt", "link.pdf", "linked/x.pdf", ".config/x.pdf", ".env.txt"]) {
			const refused = await attachFiles(workspace, [path]).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(refused, path).toBeInstanceOf(AttachmentError);
		}
		await expect(attachFiles(workspace, ["manca.pdf"])).rejects.toThrow(/non trovo «manca.pdf»/);
		expect(await attachFiles(workspace, ["ok.pdf"])).toHaveLength(1);
	});

	it("at approval the file is read again: changed, swapped for a symlink or gone, nothing is sent", async () => {
		const { root, dir, workspace } = workspaceWith({ "p.pdf": PDF, "q.pdf": PDF });
		const list = await attachFiles(workspace, ["p.pdf"]);
		expect((await readAttachments(workspace, list))[0]?.data.equals(PDF)).toBe(true);
		// Same size, other bytes.
		const other = Buffer.from(PDF);
		other[100] = (other[100] ?? 0) ^ 0xff;
		writeFileSync(join(root, "p.pdf"), other);
		await expect(readAttachments(workspace, list)).rejects.toThrow(`${ATTACHMENT_CHANGED} (p.pdf)`);
		writeFileSync(join(root, "p.pdf"), Buffer.concat([PDF, Buffer.from("x")]));
		await expect(readAttachments(workspace, list)).rejects.toThrow(ATTACHMENT_CHANGED);
		unlinkSync(join(root, "p.pdf"));
		await expect(readAttachments(workspace, list)).rejects.toThrow(ATTACHMENT_CHANGED);
		writeFileSync(join(dir, "same.pdf"), PDF);
		symlinkSync(join(dir, "same.pdf"), join(root, "p.pdf"));
		await expect(readAttachments(workspace, list)).rejects.toThrow(ATTACHMENT_CHANGED);
		// A request edited to point elsewhere is read through the workspace's rules too.
		const q = await attachFiles(workspace, ["q.pdf"]);
		await expect(readAttachments(workspace, q.map((a) => ({ ...a, path: "../same.pdf" })))).rejects.toThrow(ATTACHMENT_CHANGED);
		await expect(readAttachments(workspace, q.map((a) => ({ ...a, name: "q.exe" })))).rejects.toThrow(/non consentito/);
	});

	it("the card shows names and sizes in the reason line; Annie's title counts them", async () => {
		const { workspace } = workspaceWith({ "preventivi/Preventivo-2026-012.pdf": PDF, "f/B-70.xml": XML });
		const attachments = await attachFiles(workspace, ["preventivi/Preventivo-2026-012.pdf", "f/B-70.xml"]);
		expect(attachmentsLine(attachments)).toBe("Allegati: Preventivo-2026-012.pdf (3 KB), B-70.xml (70 byte)");
		const action = { id: "x", kind: "mail.send", personId: "p", account: "a@b.it", reason: "Invio del preventivo", mail: { ...MAIL, attachments }, status: "pending", proposedAt: "2026-10-18T08:00:00Z" } as GoogleAction;
		expect(cardView(action).reason).toBe("Invio del preventivo · Allegati: Preventivo-2026-012.pdf (3 KB), B-70.xml (70 byte)");
		expect(cardView({ ...action, mail: MAIL }).reason).toBe("Invio del preventivo");
		expect(googleActionTitle(action)).toBe("Inviare una mail a rossi@cliente.it, con 2 allegati");
		// The request keeps no content: only path, name, size, hash and type.
		expect(Object.keys(attachments[0] ?? {}).sort()).toEqual(["contentType", "name", "path", "sha256", "size"]);
		expect(JSON.stringify(action)).not.toContain(PDF.subarray(0, 40).toString("base64"));
	});
});
