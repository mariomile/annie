import { readFileSync } from "node:fs";
import { deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readDocumentText } from "../src/core/document-reader.ts";
import { DocumentError, documentKind, documentText } from "../src/core/documents.ts";
import { ZIP_LIMITS, Zip, ZipError } from "../src/core/zip.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/docs/${name}`, import.meta.url));

describe("reading the documents people send", () => {
	it("Word: paragraphs and a table, one row per line, with accents and the euro sign", () => {
		const doc = documentText("preventivo.docx", fixture("preventivo.docx"));
		expect(doc.kind).toBe("docx");
		expect(doc.text).toBe(
			"# Preventivo Rossi Srl\nFornitura di 120 sedie ergonomiche, consegna entro il 30 novembre.\nArticolo\tPrezzo\nSedia Comfort\t89,00 €\nPagamento a 30 giorni. Perché è così caro? Città, attività, più.",
		);
	});

	it("Excel: every sheet by name, numbers as saved (a formula's last value), dates as dates", () => {
		const doc = documentText("ordini.xlsx", fixture("ordini.xlsx"));
		expect(doc).toMatchObject({ kind: "xlsx", parts: 2 });
		expect(doc.text).toBe("## Foglio «Ordini» (4 righe, colonne A-C)\nCliente\tImporto\tData\nBianchi\t1250,5\t2026-10-01\nVerdi\t980\t2026-10-03\n\t2230,5\n\n## Foglio «Note» (1 riga, colonna A)\nConsegna urgente");
	});

	it("Excel: money, percentages, decimals, times as the format shows them; row numbers after gaps; hidden sheets said", () => {
		const doc = documentText("vendite.xlsx", fixture("vendite.xlsx"));
		expect(doc.text).toContain("## Foglio «Vendite» (6 righe, colonne A-N)\nReport vendite Q3 2026\n[riga 3]\nProdotto\tPrezzo\tSconto\tData\tTotale\n");
		expect(doc.text).toContain("Caffè\t12,50 €\t10%\t2026-07-01\t11,25 €");
		expect(doc.text).toContain("\t09:30\t2026-07-01 14:05\t");
		expect(doc.text).toContain("Biscotti\t1.234,57 €\t5%\t2026-07-03\t1.172,84 €");
		expect(doc.text).toContain("## Foglio «Sparso» (1000 righe, colonne A-B; le colonne dopo SG non sono lette)\nInizio\n[riga 500]\n\tMetà\n[riga 1000]\nFondo");
		expect(doc.text).toContain("## Foglio «Nascosto» (1 riga, colonna A; nascosto)");
	});

	it("Word: letterhead, footer, footnotes, lists, headings and links", () => {
		const doc = documentText("contratto.docx", fixture("contratto.docx"));
		expect(doc.text).toMatch(/^\[Intestazione\] Rossi Srl/);
		expect(doc.text).toContain("# Contratto di fornitura\n");
		expect(doc.text).toContain("- primo punto\n- secondo punto");
		expect(doc.text).toContain("condizioni generali (https://example.com/condizioni)");
		expect(doc.text).toMatch(/\[Piè di pagina\] P\.IVA 01234567890/);
	});

	it("PowerPoint: tables by rows, and the numbers of a chart", () => {
		const doc = documentText("obiettivi.pptx", fixture("obiettivi.pptx"));
		expect(doc.text).toContain("## Diapositiva 2\nNumeri\nTrimestre\tRicavi\tCosti\nQ1\t100\t80\nQ2\t120\t90");
		expect(doc.text).toContain("Vendite: Gen 10; Feb 20");
		expect(doc.text).toContain("Note: Ricordarsi di citare il budget");
	});

	it("OpenDocument: no styles in the text, columns in place, slides counted right, footnotes at the end", () => {
		const ods = documentText("vendite.ods", fixture("vendite.ods"));
		expect(ods.text).toMatch(/^## Foglio «Vendite»\nReport vendite Q3 2026\n\[riga 3\]\nProdotto\tPrezzo\tSconto\tData\tTotale\n/);
		expect(ods.text).toContain("Caffè\t12.50 €\t10%\t01/07/2026\t€ 11.25\t\t0.123456");
		expect(ods.text).toContain("[riga 500]\n\tMetà");
		expect(ods.text).toContain("## Foglio «Nascosto» (nascosto)");
		expect(ods.text).not.toContain("?xml");
		const odp = documentText("obiettivi.odp", fixture("obiettivi.odp"));
		expect(odp.parts).toBe(4);
		expect(odp.text).toContain("## Diapositiva 2\nNumeri\nTrimestre\tRicavi\tCosti\nQ1\t100\t80");
		expect(odp.text).toContain("- Obiettivo uno\n- Obiettivo due\n\nNote: Ricordarsi di citare il budget");
		const odt = documentText("relazione.odt", fixture("relazione.odt"));
		expect(odt.text).toMatch(/^# Relazione\nIl fatturato è cresciuto del 12%\[1\] rispetto al 2025\.\n- Punto A\n/);
		expect(odt.text).toMatch(/\[Note\]\n1\. Dati non revisionati, fonte interna\.$/);
	});

	it("PDFs protected only against copying open like the others; one that asks for a password says so", () => {
		for (const name of ["protetto-rc4-40.pdf", "protetto-rc4-128.pdf", "protetto-aes-128.pdf", "protetto-aes-256-r5.pdf", "protetto-aes-256.pdf"]) {
			expect(documentText(name, fixture(name)).text, name).toContain("Totale: 1.234,56 € (IVA inclusa)");
		}
		expect(() => documentText("con-password.pdf", fixture("con-password.pdf"))).toThrow(/protetto da una password/);
	});

	it("a scanned page is named, with what to do about it", () => {
		expect(documentText("scansione.pdf", fixture("scansione.pdf")).note).toBe("La pagina 1 non ha testo (forse una scansione o un'immagine): guardala con image_view (page 1).");
		expect(documentText("x.pdf", syntheticPdf({ content: "q Q" })).note).toBe("Il PDF non contiene testo: è probabilmente una scansione. Guarda le pagine con image_view (il percorso del PDF e page) e leggi tu cosa dicono.");
	});

	it("PowerPoint: slides in the order shown", () => {
		const doc = documentText("piano.pptx", fixture("piano.pptx"));
		expect(doc).toMatchObject({ kind: "pptx", parts: 2 });
		expect(doc.text).toBe("## Diapositiva 1\nPiano 2027\nTre nuovi negozi a Roma\n\n## Diapositiva 2\nBudget\n200.000 euro");
	});

	it("PDF from LibreOffice, reportlab and Chrome: pages, words, accents and €", () => {
		const fattura = documentText("fattura.pdf", fixture("fattura.pdf"));
		expect(fattura).toMatchObject({ kind: "pdf", parts: 2 });
		expect(fattura.text).toBe("--- Pagina 1 ---\nFattura n. 42 del 15/10/2026\nTotale: 1.234,56 € (IVA inclusa)\n\n--- Pagina 2 ---\nPagina due: condizioni di pagamento, bonifico a 30 giorni.");
		const preventivo = documentText("preventivo.pdf", fixture("preventivo.pdf"));
		expect(preventivo.parts).toBe(1);
		expect(preventivo.text).toContain("Sedia Comfort 89,00 €");
		expect(preventivo.text).toContain("Perché è così caro? Città, attività, più.");
		const verbale = documentText("verbale.pdf", fixture("verbale.pdf"));
		expect(verbale.parts).toBe(2);
		expect(verbale.text).toContain("Decisione: aprire il negozio di Torino a marzo.");
		expect(verbale.text).toContain("--- Pagina 2 ---\nSeconda pagina: budget di 45.000 €.");
		expect(documentText("piano.pdf", fixture("piano.pdf")).text).toContain("Tre nuovi negozi a Roma");
	});

	it("the kind comes from the bytes, not the name", () => {
		expect(documentKind("foto.jpg", fixture("fattura.pdf"))).toBe("pdf");
		expect(documentKind("x.pdf", fixture("ordini.xlsx"))).toBe("xlsx");
		expect(documentKind("note.pdf", Buffer.from("solo testo"))).toBeUndefined();
		expect(documentKind("a.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeUndefined();
		expect(() => documentText("note.txt", Buffer.from("ciao"))).toThrow(DocumentError);
	});

	it("a PDF with its pages in an object stream, escapes, hex strings and kerning", () => {
		const doc = documentText("x.pdf", syntheticPdf());
		expect(doc).toMatchObject({ kind: "pdf", parts: 1 });
		expect(doc.text).toBe("--- Pagina 1 ---\nCiao (mondo) è qui\nHi\nParola due");
	});

	it("an encrypted PDF says why it cannot be read", () => {
		expect(() => documentText("x.pdf", syntheticPdf({ encrypted: true }))).toThrow(/protetto da una password/);
	});

	it("a PDF with no text says it is probably a scan", () => {
		const doc = documentText("x.pdf", syntheticPdf({ content: "q 100 0 0 100 0 0 cm Q" }));
		expect(doc.text).toBe("");
		expect(doc.note).toMatch(/scansione/);
	});

	it("a zip bomb stops at the limit, whatever the archive claims", () => {
		const huge = deflateRawSync(Buffer.alloc(ZIP_LIMITS.maxEntryBytes + 1024));
		expect(() => new Zip(zipOf("a.xml", huge, ZIP_LIMITS.maxEntryBytes + 1024)).file("a.xml")).toThrow(/troppo grande/);
		// It lies about the size: the inflater stops at the size claimed.
		expect(() => new Zip(zipOf("a.xml", huge, 1000)).file("a.xml")).toThrow(ZipError);
		expect(new Zip(zipOf("a.xml", deflateRawSync(Buffer.from("ciao")), 4)).text("a.xml")).toBe("ciao");
	});

	it("broken and truncated files fail with a reason, never a crash", () => {
		let random = 7;
		const next = () => {
			random = (random * 1103515245 + 12345) % 2 ** 31;
			return random;
		};
		for (const name of ["fattura.pdf", "verbale.pdf", "preventivo.docx", "ordini.xlsx", "piano.pptx"]) {
			const data = fixture(name);
			const tries: Buffer[] = [];
			for (let i = 1; i <= 8; i++) tries.push(data.subarray(0, Math.floor((data.length * i) / 9)));
			for (let i = 0; i < 25; i++) {
				const copy = Buffer.from(data);
				for (let j = 0; j < 30; j++) copy[next() % copy.length] = next() % 256;
				tries.push(copy);
			}
			for (const bytes of tries) {
				try {
					documentText(name, bytes);
				} catch (error) {
					expect(error, `${name}: ${String(error)}`).toBeInstanceOf(DocumentError);
				}
			}
		}
	});
});

describe("documents made to be slow or huge", () => {
	const fast = (what: () => unknown, ms = 2000) => {
		const start = Date.now();
		try {
			what();
		} catch (error) {
			expect(error).toBeInstanceOf(DocumentError);
		}
		expect(Date.now() - start).toBeLessThan(ms);
	};

	it("a long run of spaces does not stall the text cleanup", () => {
		const xml = `<w:document><w:body><w:p><w:r><w:t xml:space="preserve">${" ".repeat(300_000)}x</w:t></w:r></w:p></w:body></w:document>`;
		fast(() => documentText("a.docx", zipOf("word/document.xml", deflateRawSync(Buffer.from(xml)), xml.length)));
		fast(() => documentText("x.pdf", syntheticPdf({ content: `BT /F1 12 Tf (${" ".repeat(300_000)}x) Tj ET` })));
	});

	it("thousands of stray delimiters do not overflow the stack", () => {
		fast(() => documentText("x.pdf", syntheticPdf({ content: `${")".repeat(100_000)} BT /F1 12 Tf (ok) Tj ET` })));
		expect(documentText("x.pdf", syntheticPdf({ content: `${"}".repeat(100_000)} BT /F1 12 Tf (ok) Tj ET` })).text).toContain("ok");
	});

	it("a decompression bomb reused by a thousand fonts is decoded once, and the limit holds", () => {
		const bomb = deflateSync(Buffer.alloc(19 * 1024 * 1024, 0x20));
		const fonts = Array.from({ length: 1000 }, (_, i) => `/F${i} 4 0 R`).join(" ");
		const content = Array.from({ length: 1000 }, (_, i) => `/F${i} 12 Tf (a) Tj`).join(" ");
		fast(() => documentText("x.pdf", syntheticPdf({ content: `BT ${content} ET`, fonts, toUnicode: bomb })), 5000);
	});

	it("an extraction that takes too long, or a file that is not a document, stops in the worker with a reason", async () => {
		await expect(readDocumentText("fattura.pdf", fixture("fattura.pdf"), { timeoutMs: 1 })).rejects.toThrow(/troppo complesso/);
		await expect(readDocumentText("x.pdf", Buffer.from("niente"))).rejects.toThrow(DocumentError);
		expect((await readDocumentText("fattura.pdf", fixture("fattura.pdf"))).text).toContain("Totale: 1.234,56 €");
	});

	it("a document waiting too long for a free reader is told to try again, and the queue goes on", async () => {
		const busy = [readDocumentText("fattura.pdf", fixture("fattura.pdf")), readDocumentText("fattura.pdf", fixture("fattura.pdf"))];
		await expect(readDocumentText("fattura.pdf", fixture("fattura.pdf"), { waitMs: 1 })).rejects.toThrow(/riprova tra poco/);
		await Promise.all(busy);
		expect((await readDocumentText("fattura.pdf", fixture("fattura.pdf"), { waitMs: 1 })).parts).toBe(2);
	});
});

/** A one-entry ZIP whose index claims `size` bytes. */
function zipOf(name: string, deflated: Buffer, size: number): Buffer {
	const nameBytes = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(deflated.length, 18);
	local.writeUInt32LE(size, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(deflated.length, 20);
	central.writeUInt32LE(size, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	central.writeUInt32LE(0, 42);
	const directoryAt = 30 + nameBytes.length + deflated.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(46 + nameBytes.length, 12);
	end.writeUInt32LE(directoryAt, 16);
	return Buffer.concat([local, nameBytes, deflated, central, nameBytes, end]);
}

/** A small PDF 1.5: page and font inside a compressed object stream, a cross-reference stream. */
function syntheticPdf(options: { encrypted?: boolean; content?: string; fonts?: string; toUnicode?: Buffer } = {}): Buffer {
	const content = options.content ?? "BT /F1 12 Tf 72 700 Td (Ciao \\(mondo\\) \\350 qui) Tj 0 -20 Td <4869> Tj 0 -20 Td [(Pa) 120 (rola) -300 (due)] TJ ET";
	const stream = deflateSync(Buffer.from(content, "latin1"));
	const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${options.fonts ?? "/F1 4 0 R"} >> >> /Contents 5 0 R >>`;
	const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding${options.toUnicode === undefined ? "" : " /ToUnicode 8 0 R"} >>`;
	const header = `3 0 4 ${page.length + 1} `;
	const objstm = deflateSync(Buffer.from(`${header}${page} ${font}`, "latin1"));
	const parts: Buffer[] = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
	parts.push(Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
	parts.push(Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));
	parts.push(Buffer.from(`5 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream\nendobj\n"));
	parts.push(Buffer.from(`6 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Length ${objstm.length} /Filter /FlateDecode >>\nstream\n`), objstm, Buffer.from("\nendstream\nendobj\n"));
	if (options.toUnicode !== undefined) parts.push(Buffer.from(`8 0 obj\n<< /Length ${options.toUnicode.length} /Filter /FlateDecode >>\nstream\n`), options.toUnicode, Buffer.from("\nendstream\nendobj\n"));
	const encrypt = options.encrypted === true ? " /Encrypt << /Filter /Standard /V 2 /R 3 >>" : "";
	parts.push(Buffer.from(`7 0 obj\n<< /Type /XRef /Size 8 /Root 1 0 R${encrypt} /W [1 2 1] /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n0\n%%EOF\n`));
	return Buffer.concat(parts);
}
