import type { Block, ListItem, Span } from "./markdown-blocks.ts";
import { plainText, xmlSafe } from "./markdown-blocks.ts";
import { writeZip } from "./zip.ts";

/** A picture to put in a document, already read and checked (see make-document.ts). */
export type Picture = { readonly path: string; readonly alt: string; readonly mime: "image/png" | "image/jpeg"; readonly data: Buffer; readonly width: number; readonly height: number };

export type DocxInput = { readonly title?: string; readonly blocks: readonly Block[]; readonly pictures: ReadonlyMap<string, Picture>; readonly now: Date };

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** A4 with 2 cm margins: the text is 17 cm wide (twentieths of a point). */
const TEXT_WIDTH = 9638;

/** A Word document (.docx) from Markdown blocks (ADR 0029). */
export function makeDocx(input: DocxInput): Buffer {
	const rels: string[] = [
		`<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>`,
		`<Relationship Id="rIdNumbering" Type="${R}/numbering" Target="numbering.xml"/>`,
		`<Relationship Id="rIdFooter" Type="${R}/footer" Target="footer1.xml"/>`,
	];
	const media: { name: string; data: Buffer }[] = [];
	const pictureIds = new Map<string, string>();
	let drawing = 0;
	const linkIds = new Map<string, string>();
	const linkId = (url: string): string => {
		let id = linkIds.get(url);
		if (id === undefined) {
			id = `rIdLink${linkIds.size + 1}`;
			linkIds.set(url, id);
			rels.push(`<Relationship Id="${id}" Type="${R}/hyperlink" Target="${xmlSafe(safeUrl(url))}" TargetMode="External"/>`);
		}
		return id;
	};
	// Numbered lists each start again from their own number: one <w:num> each.
	const numbered: number[] = [];
	const body: string[] = [];
	for (const block of input.blocks) {
		switch (block.type) {
			case "heading":
				body.push(paragraph(runs(block.spans, linkId), `<w:pStyle w:val="Heading${block.level}"/><w:keepNext/>`));
				break;
			case "paragraph":
				body.push(paragraph(runs(block.spans, linkId)));
				break;
			case "quote":
				body.push(paragraph(runs(block.spans, linkId), '<w:pStyle w:val="Quote"/>'));
				break;
			case "code":
				for (const line of block.text.split("\n")) body.push(paragraph(line === "" ? "" : run(line, ""), '<w:pStyle w:val="Code"/>'));
				break;
			case "rule":
				body.push(paragraph("", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A6A6A6"/></w:pBdr>'));
				break;
			case "pagebreak":
				body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
				break;
			case "list": {
				numbered.push(block.ordered ? block.start : 1);
				const num = numbered.length + 1; // 1 is the bullets
				for (const item of block.items) body.push(listItem(item, item.ordered ? num : 1, runs(item.spans, linkId)));
				break;
			}
			case "table":
				body.push(table(block, linkId), "<w:p/>");
				break;
			case "image": {
				const picture = input.pictures.get(block.path);
				if (picture === undefined) break;
				let id = pictureIds.get(block.path);
				if (id === undefined) {
					id = `rIdPicture${pictureIds.size + 1}`;
					pictureIds.set(block.path, id);
					const name = `image${pictureIds.size}.${picture.mime === "image/png" ? "png" : "jpeg"}`;
					media.push({ name, data: picture.data });
					rels.push(`<Relationship Id="${id}" Type="${R}/image" Target="media/${name}"/>`);
				}
				drawing++;
				const box = pictureBox(picture, block.alt, block.widthCm, TEXT_WIDTH / 20, 9000 / 20);
				body.push(paragraph(pictureRun(box, block.alt, id, drawing), box.left ? "" : '<w:jc w:val="center"/>'));
				break;
			}
		}
	}
	const section =
		'<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/>' +
		'<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
	const document = `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}"><w:body>${body.join("")}${section}</w:body></w:document>`;
	const types =
		`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		'<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
		'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
		'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
		'<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
		'<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
		"</Types>";
	return writeZip([
		{ name: "[Content_Types].xml", data: types },
		{
			name: "_rels/.rels",
			data: `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
		},
		{ name: "docProps/core.xml", data: coreProperties(input.title, input.now) },
		{ name: "word/document.xml", data: document },
		{ name: "word/_rels/document.xml.rels", data: `${XML}<Relationships xmlns="${REL}">${rels.join("")}</Relationships>` },
		{ name: "word/styles.xml", data: STYLES },
		{ name: "word/numbering.xml", data: numbering(numbered) },
		{ name: "word/footer1.xml", data: FOOTER },
		...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
	]);
}

/** A link's address as a valid URI (a broken percent escape would make strict readers refuse the file). */
export function safeUrl(url: string): string {
	try {
		return new URL(url).href;
	} catch {
		return encodeURI(url.replace(/%(?![0-9a-f]{2})/gi, "%25"));
	}
}

/** Title and author, shared with the Excel files. */
export function coreProperties(title: string | undefined, now: Date): string {
	const when = now.toISOString().replace(/\.\d{3}Z$/, "Z");
	return (
		`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
		(title === undefined || title === "" ? "" : `<dc:title>${xmlSafe(title)}</dc:title>`) +
		`<dc:creator>Annie</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified></cp:coreProperties>`
	);
}

function paragraph(content: string, properties = ""): string {
	return `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}${content}</w:p>`;
}

function run(text: string, properties: string): string {
	// A line break inside a paragraph (an address) is a <w:br/>; a tab a <w:tab/>.
	const pieces = text.split("\n").map((line) =>
		line
			.split("\t")
			.map((part) => (part === "" ? "" : `<w:t xml:space="preserve">${xmlSafe(part)}</w:t>`))
			.join("<w:tab/>"),
	);
	return `<w:r>${properties === "" ? "" : `<w:rPr>${properties}</w:rPr>`}${pieces.join("<w:br/>")}</w:r>`;
}

function runs(spans: readonly Span[], linkId: (url: string) => string, extra = ""): string {
	return spans
		.map((span) => {
			const properties =
				(span.link !== undefined ? '<w:rStyle w:val="Hyperlink"/>' : "") +
				(span.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : "") +
				(span.bold ? "<w:b/>" : "") +
				(span.italic ? "<w:i/>" : "") +
				extra;
			const content = run(span.text, properties);
			return span.link === undefined ? content : `<w:hyperlink r:id="${linkId(span.link)}" w:history="1">${content}</w:hyperlink>`;
		})
		.join("");
}

function listItem(item: ListItem, num: number, content: string): string {
	return paragraph(content, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${num}"/></w:numPr>`);
}

function table(block: Extract<Block, { type: "table" }>, linkId: (url: string) => string): string {
	const columns = block.header.length;
	const widths = tableWidths(block, TEXT_WIDTH);
	const numeric = Array.from({ length: columns }, (_, i) => numericColumn(block.rows.map((r) => plainText(r[i] ?? []))));
	const cell = (spans: readonly Span[], i: number, header: boolean): string => {
		const align = block.align[i] ?? (numeric[i] ? "right" : undefined);
		const jc = align === undefined || align === "left" ? "" : `<w:jc w:val="${align === "center" ? "center" : "right"}"/>`;
		const shade = header ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : "";
		return `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${shade}</w:tcPr>${paragraph(runs(spans, linkId, header ? "<w:b/>" : ""), `<w:spacing w:before="40" w:after="40"/>${jc}`)}</w:tc>`;
	};
	const border = (side: string): string => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
	return (
		`<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
		`<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
		'<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="85" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
		`<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
		`<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.header.map((c, i) => cell(c, i, true)).join("")}</w:tr>` +
		block.rows.map((row) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${row.map((c, i) => cell(c, i, false)).join("")}</w:tr>`).join("") +
		"</w:tbl>"
	);
}

/**
 * Column widths in twentieths of a point, filling `total`: each column at least as wide as its
 * longest word, the room left shared by how much longer its text is. From the number of
 * characters, at about 5.3 points each in 11-point Calibri.
 */
function tableWidths(block: Extract<Block, { type: "table" }>, total: number): number[] {
	const char = 106;
	const pad = 200;
	const all = [block.header, ...block.rows];
	const natural: number[] = [];
	const least: number[] = [];
	for (let c = 0; c < block.header.length; c++) {
		const texts = all.map((row) => plainText(row[c] ?? []));
		natural.push(Math.max(3, ...texts.flatMap((t) => t.split("\n").map((l) => l.length))) * char + pad);
		least.push(Math.min(total / 3, Math.max(2, ...texts.flatMap((t) => t.split(/[ \t\n]+/).map((w) => w.length))) * char + pad));
	}
	const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
	if (sum(natural) <= total) return natural.map((v) => Math.floor((v * total) / sum(natural)));
	const room = total - sum(least);
	if (room <= 0) return least.map((l) => Math.floor((l * total) / sum(least)));
	const extra = natural.map((v, i) => v - (least[i] as number));
	return least.map((l, i) => Math.floor(l + (room * (extra[i] as number)) / sum(extra)));
}

/** A column of amounts or counts (empty cells aside): right-aligned in a table. */
export function numericColumn(cells: readonly string[]): boolean {
	const filled = cells.filter((c) => c.trim() !== "");
	return filled.length > 0 && filled.every(looksNumeric);
}

/** An amount, a percentage, a count: right-aligned in a table. */
export function looksNumeric(text: string): boolean {
	const t = text.trim();
	return t !== "" && /^[-+]?\s*(€|\$|£|EUR)?\s*[-+]?\d[\d.,'  ]*\s*(%|€|\$|£|EUR)?$/.test(t);
}

/**
 * How big a picture goes on the page, in points: the width asked (`![logo|4cm]`); a logo small
 * and on the left (at most 4.5 by 2 cm); any other picture at 96 dots per inch, within the page.
 */
export function pictureBox(picture: Picture, alt: string, widthCm: number | undefined, maxWidth: number, maxHeight: number): { width: number; height: number; left: boolean } {
	const ratio = picture.height / picture.width;
	const logo = /\blogo\b/i.test(alt);
	let width = picture.width * 0.75;
	if (widthCm !== undefined) width = widthCm * 28.35;
	else if (logo) width = Math.min(width, 128, 57 / ratio);
	const scale = Math.min(1, maxWidth / width, maxHeight / (width * ratio));
	return { width: width * scale, height: width * ratio * scale, left: logo };
}

function pictureRun(box: { width: number; height: number }, alt: string, id: string, n: number): string {
	// Points to EMU (12700 a point).
	const cx = Math.max(1, Math.round(box.width * 12700));
	const cy = Math.max(1, Math.round(box.height * 12700));
	const description = xmlSafe(alt);
	return (
		`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Immagine ${n}" descr="${description}"/>` +
		`<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:nvPicPr><pic:cNvPr id="${n}" name="Immagine ${n}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr>` +
		`<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
	);
}

function numbering(starts: readonly number[]): string {
	const level = (ilvl: number, format: string, text: string, font = ""): string =>
		`<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
		`<w:pPr><w:ind w:left="${720 + ilvl * 360}" w:hanging="360"/></w:pPr>${font === "" ? "" : `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>`}</w:lvl>`;
	const bullets = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "bullet", "•")}${level(1, "bullet", "–")}${level(2, "bullet", "▪")}</w:abstractNum>`;
	const numbers = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "decimal", "%1.")}${level(1, "lowerLetter", "%2.")}${level(2, "lowerRoman", "%3.")}</w:abstractNum>`;
	const nums = [
		'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
		...starts.map(
			(start, i) =>
				`<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/>${[0, 1, 2].map((l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="${l === 0 ? start : 1}"/></w:lvlOverride>`).join("")}</w:num>`,
		),
	];
	return `${XML}<w:numbering xmlns:w="${W}">${bullets}${numbers}${nums.join("")}</w:numbering>`;
}

const STYLES =
	`${XML}<w:styles xmlns:w="${W}">` +
	'<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="it-IT"/></w:rPr></w:rPrDefault>' +
	'<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr></w:style>' +
	'<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
	"</w:styles>";

const FOOTER =
	`${XML}<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>` +
	'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
	"</w:p></w:ftr>";
