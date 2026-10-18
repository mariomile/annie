/**
 * Which files a mail may carry (mail-attachments.ts): documents an office sends, each checked to
 * be what its extension says. Nothing that runs: no executables, scripts, web pages, archives,
 * Office files with macros.
 */

/** Extensions allowed, and their content type. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	doc: "application/msword",
	xls: "application/vnd.ms-excel",
	ppt: "application/vnd.ms-powerpoint",
	rtf: "application/rtf",
	csv: "text/csv",
	txt: "text/plain",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	xml: "application/xml",
	p7m: "application/pkcs7-mime",
};

/** What the person can attach, said when a file is refused. */
export const ATTACHMENT_KINDS = "PDF, Word, Excel, PowerPoint, OpenDocument (odt, ods), RTF, CSV, testo, immagini PNG e JPG, fatture XML e p7m";

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from("PK\x03\x04", "latin1");
const BOM = /^﻿/;

/** The names in a zip's central directory, or undefined when it does not read as a zip. Minimal: no zip64, no encryption. */
export function zipNames(data: Buffer): string[] | undefined {
	// The end of central directory record: 22 bytes, then a comment of up to 65535.
	const from = Math.max(0, data.length - 22 - 0xffff);
	let end = -1;
	for (let i = data.length - 22; i >= from; i--) {
		if (data.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) return undefined;
	const count = data.readUInt16LE(end + 10);
	const size = data.readUInt32LE(end + 12);
	let at = data.readUInt32LE(end + 16);
	if (at + size > end || count === 0xffff) return undefined;
	const names: string[] = [];
	for (let n = 0; n < count; n++) {
		if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) return undefined;
		const nameLength = data.readUInt16LE(at + 28);
		const extraLength = data.readUInt16LE(at + 30);
		const commentLength = data.readUInt16LE(at + 32);
		if (at + 46 + nameLength > end) return undefined;
		names.push(data.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
		at += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

/** Text that is not markup a mail program could render: no NUL, no leading HTML or script. */
function plainText(data: Buffer): boolean {
	if (data.includes(0)) return false;
	const start = data.subarray(0, 1024).toString("utf8").replace(BOM, "").trimStart().toLowerCase();
	return !start.startsWith("<html") && !start.startsWith("<!doctype html") && !start.startsWith("<script");
}

/** An XML document: a declaration or a root element, and no HTML or script in its first 64 KB. */
function xmlText(data: Buffer): boolean {
	if (data.includes(0)) return false;
	const head = data.subarray(0, 64 * 1024).toString("utf8").replace(BOM, "");
	const start = head.trimStart();
	if (!start.startsWith("<?xml") && !/^<[A-Za-z_]/.test(start)) return false;
	return !/<(html|script)\b/i.test(head);
}

/** An Office Open XML or OpenDocument package, without a VBA project. */
function officeZip(data: Buffer, kind: "ooxml" | "odf"): boolean {
	if (!data.subarray(0, 4).equals(ZIP)) return false;
	const names = zipNames(data);
	if (names === undefined) return false;
	if (names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) return false;
	return kind === "ooxml" ? names.includes("[Content_Types].xml") : names.includes("mimetype");
}

/** Whether `data` is what extension `ext` says (lower case, one of ATTACHMENT_TYPES). */
export function contentMatches(ext: string, data: Buffer): boolean {
	switch (ext) {
		case "pdf":
			return data.subarray(0, 5).toString("latin1") === "%PDF-";
		case "docx":
		case "xlsx":
		case "pptx":
			return officeZip(data, "ooxml");
		case "odt":
		case "ods":
			return officeZip(data, "odf");
		case "doc":
		case "xls":
		case "ppt":
			return data.subarray(0, 8).equals(OLE);
		case "rtf":
			return data.subarray(0, 5).toString("latin1") === "{\\rtf";
		case "png":
			return data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		case "jpg":
		case "jpeg":
			return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
		case "p7m":
			return data[0] === 0x30;
		case "xml":
			return xmlText(data);
		case "csv":
		case "txt":
			return plainText(data);
		default:
			return false;
	}
}

/** Why an extension is refused, in Italian: a hint where there is one. */
export function refusedType(ext: string, name: string): string {
	if (ext === "") return `non allego «${name}»: il file non ha estensione. Posso allegare ${ATTACHMENT_KINDS}`;
	if (ext === "heic" || ext === "heif") return `non allego «${name}»: le foto HEIC molti non le aprono, converti la foto in JPG`;
	return `non allego «${name}»: i file .${ext} non si mandano. Posso allegare ${ATTACHMENT_KINDS}`;
}
