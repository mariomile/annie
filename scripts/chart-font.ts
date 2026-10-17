/**
 * Generates src/core/chart-font.ts: the outlines of DejaVu Sans and DejaVu Sans Bold for the
 * characters a chart writes (Latin-1, Latin Extended-A and a few punctuation marks), so charts
 * draw text without a font on the server (ADR 0030).
 *
 *   tsx scripts/chart-font.ts /usr/share/fonts/truetype/dejavu > src/core/chart-font.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UNITS = 1000;
const EXTRA = [0x218, 0x219, 0x21a, 0x21b, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac, 0x2212, 0x2248, 0x2264, 0x2265];
const CODES = [...range(0x20, 0x7e), ...range(0xa0, 0x17f), ...EXTRA];

function range(a: number, b: number): number[] {
	return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

type Point = { x: number; y: number; on: boolean };

function font(file: string) {
	const data = readFileSync(file);
	const tables = new Map<string, number>();
	const count = data.readUInt16BE(4);
	for (let i = 0; i < count; i++) tables.set(data.toString("latin1", 12 + i * 16, 16 + i * 16), data.readUInt32BE(20 + i * 16));
	const at = (tag: string) => tables.get(tag) as number;
	const unitsPerEm = data.readUInt16BE(at("head") + 18);
	const longLoca = data.readInt16BE(at("head") + 50) === 1;
	const glyphs = data.readUInt16BE(at("maxp") + 4);
	const metrics = data.readUInt16BE(at("hhea") + 34);
	const ascent = data.readInt16BE(at("hhea") + 4);
	const descent = data.readInt16BE(at("hhea") + 6);
	const loca = (g: number) => (longLoca ? data.readUInt32BE(at("loca") + g * 4) : data.readUInt16BE(at("loca") + g * 2) * 2);
	const advance = (g: number) => data.readUInt16BE(at("hmtx") + Math.min(g, metrics - 1) * 4);
	// cmap: the format 4 subtable for Unicode BMP.
	const cmap = at("cmap");
	let sub = -1;
	for (let i = 0; i < data.readUInt16BE(cmap + 2); i++) {
		const offset = cmap + data.readUInt32BE(cmap + 8 + i * 8);
		if (data.readUInt16BE(offset) === 4) sub = offset;
	}
	const segments = data.readUInt16BE(sub + 6) / 2;
	const glyphOf = (code: number): number => {
		for (let i = 0; i < segments; i++) {
			const end = data.readUInt16BE(sub + 14 + i * 2);
			if (code > end) continue;
			const start = data.readUInt16BE(sub + 16 + segments * 2 + i * 2);
			if (code < start) return 0;
			const delta = data.readInt16BE(sub + 16 + segments * 4 + i * 2);
			const rangeAt = sub + 16 + segments * 6 + i * 2;
			const offset = data.readUInt16BE(rangeAt);
			if (offset === 0) return (code + delta) & 0xffff;
			const g = data.readUInt16BE(rangeAt + offset + (code - start) * 2);
			return g === 0 ? 0 : (g + delta) & 0xffff;
		}
		return 0;
	};
	const contours = (g: number): Point[][] => {
		if (g >= glyphs) return [];
		const start = at("glyf") + loca(g);
		if (loca(g + 1) === loca(g)) return [];
		const n = data.readInt16BE(start);
		if (n < 0) {
			const out: Point[][] = [];
			let p = start + 10;
			for (;;) {
				const flags = data.readUInt16BE(p);
				const child = data.readUInt16BE(p + 2);
				p += 4;
				let dx: number;
				let dy: number;
				if (flags & 1) {
					dx = data.readInt16BE(p);
					dy = data.readInt16BE(p + 2);
					p += 4;
				} else {
					dx = data.readInt8(p);
					dy = data.readInt8(p + 1);
					p += 2;
				}
				if (!(flags & 2)) throw new Error("point-matched composites are not supported");
				let a = 1, b = 0, c = 0, d = 1;
				if (flags & 8) { a = d = data.readInt16BE(p) / 16384; p += 2; }
				else if (flags & 0x40) { a = data.readInt16BE(p) / 16384; d = data.readInt16BE(p + 2) / 16384; p += 4; }
				else if (flags & 0x80) { a = data.readInt16BE(p) / 16384; b = data.readInt16BE(p + 2) / 16384; c = data.readInt16BE(p + 4) / 16384; d = data.readInt16BE(p + 6) / 16384; p += 8; }
				for (const contour of contours(child)) out.push(contour.map((q) => ({ x: q.x * a + q.y * c + dx, y: q.x * b + q.y * d + dy, on: q.on })));
				if (!(flags & 0x20)) break;
			}
			return out;
		}
		const ends: number[] = [];
		for (let i = 0; i < n; i++) ends.push(data.readUInt16BE(start + 10 + i * 2));
		const total = (ends.at(-1) ?? -1) + 1;
		let p = start + 10 + n * 2;
		p += 2 + data.readUInt16BE(p);
		const flags: number[] = [];
		while (flags.length < total) {
			const f = data[p++] as number;
			flags.push(f);
			if (f & 8) for (let r = data[p++] as number; r > 0; r--) flags.push(f);
		}
		const coords = (short: number, same: number): number[] => {
			const out: number[] = [];
			let v = 0;
			for (const f of flags) {
				if (f & short) v += f & same ? (data[p++] as number) : -(data[p++] as number);
				else if (!(f & same)) { v += data.readInt16BE(p); p += 2; }
				out.push(v);
			}
			return out;
		};
		const xs = coords(2, 16);
		const ys = coords(4, 32);
		const out: Point[][] = [];
		let from = 0;
		for (const end of ends) {
			out.push(range(from, end).map((i) => ({ x: xs[i] as number, y: ys[i] as number, on: ((flags[i] as number) & 1) === 1 })));
			from = end + 1;
		}
		return out;
	};
	return { unitsPerEm, ascent, descent, glyphOf, advance, contours };
}

/** A contour as M/L/Q commands in 1000 units per em, y up; implied on-curve points made explicit. */
function path(contours: Point[][], scale: number): string {
	const r = (v: number) => Math.round(v * scale);
	const parts: string[] = [];
	for (const raw of contours) {
		if (raw.length === 0) continue;
		const pts: Point[] = [];
		for (let i = 0; i < raw.length; i++) {
			const a = raw[i] as Point;
			const b = raw[(i + 1) % raw.length] as Point;
			pts.push(a);
			if (!a.on && !b.on) pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
		}
		const first = pts.findIndex((q) => q.on);
		const ordered = [...pts.slice(first), ...pts.slice(0, first)];
		const start = ordered[0] as Point;
		parts.push(`M${r(start.x)} ${r(start.y)}`);
		for (let i = 1; i <= ordered.length; i++) {
			const q = ordered[i % ordered.length] as Point;
			if (q.on) parts.push(`L${r(q.x)} ${r(q.y)}`);
			else {
				const to = ordered[(i + 1) % ordered.length] as Point;
				parts.push(`Q${r(q.x)} ${r(q.y)} ${r(to.x)} ${r(to.y)}`);
				i++;
			}
		}
	}
	// "L" after the first point can be left out; the parser reads pairs as lines.
	return parts.join("").replace(/L/g, " ");
}

const dir = process.argv[2] ?? "/usr/share/fonts/truetype/dejavu";
const faces = { regular: font(join(dir, "DejaVuSans.ttf")), bold: font(join(dir, "DejaVuSans-Bold.ttf")) };
const lines: string[] = [];
lines.push(`/**
 * Outlines of DejaVu Sans and DejaVu Sans Bold for the characters a chart writes (ADR 0030), in
 * 1000 units per em, y up. Each entry is [advance, path]: "M" starts a contour, a pair of numbers
 * is a line to that point, "Q" a quadratic curve (control point, end point); contours close.
 * Generated by scripts/chart-font.ts; do not edit.
 *
 * Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is a trademark of
 * Bitstream, Inc. DejaVu changes are in public domain.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of the fonts
 * accompanying this license ("Fonts") and associated documentation files (the "Font Software"),
 * to reproduce and distribute the Font Software, including without limitation the rights to use,
 * copy, merge, publish, distribute, and/or sell copies of the Font Software, and to permit
 * persons to whom the Font Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright and trademark notices and this permission notice shall be included in all
 * copies of one or more of the Font Software typefaces.
 *
 * The Font Software may be modified, altered, or added to, and in particular the designs of
 * glyphs or characters in the Fonts may be modified and additional glyphs or characters may be
 * added to the Fonts, only if the fonts are renamed to names not containing either the words
 * "Bitstream" or the word "Vera".
 *
 * This License becomes null and void to the extent applicable to Fonts or Font Software that has
 * been modified and is distributed under the "Bitstream Vera" names.
 *
 * The Font Software may be sold as part of a larger software package but no copy of one or more
 * of the Font Software typefaces may be sold by itself.
 *
 * THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL
 * BITSTREAM OR THE GNOME FOUNDATION BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE
 * FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
 *
 * Except as contained in this notice, the names of Gnome, the Gnome Foundation, and Bitstream
 * Inc., shall not be used in advertising or otherwise to promote the sale, use or other dealings
 * in this Font Software without prior written authorization from the Gnome Foundation or
 * Bitstream Inc., respectively. For further information, contact: fonts at gnome dot org.
 */
`);
for (const [name, face] of Object.entries(faces)) {
	const scale = UNITS / face.unitsPerEm;
	const constName = name === "regular" ? "SANS" : "SANS_BOLD";
	lines.push(`export const ${constName}: { readonly ascent: number; readonly descent: number; readonly glyphs: Readonly<Record<number, readonly [number, string]>> } = {`);
	lines.push(`\tascent: ${Math.round(face.ascent * scale)},`);
	lines.push(`\tdescent: ${Math.round(face.descent * scale)},`);
	lines.push(`\tglyphs: {`);
	// Bold writes titles and values: Latin-1 is enough, a missing letter is drawn in the regular face.
	for (const code of name === "regular" ? CODES : CODES.filter((c) => c < 0x100 || EXTRA.includes(c))) {
		const g = face.glyphOf(code);
		if (g === 0) continue;
		lines.push(`\t\t${code}: [${Math.round(face.advance(g) * scale)}, ${JSON.stringify(path(face.contours(g), scale))}],`);
	}
	lines.push(`\t},`);
	lines.push(`};`);
	lines.push(``);
}
process.stdout.write(lines.join("\n"));
