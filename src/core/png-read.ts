import { inflateSync } from "node:zlib";

/**
 * Just enough PNG reading to put a picture in a PDF (ADR 0029): the pixels as 8-bit grey or RGB,
 * and the transparency apart. Every size is checked before memory is taken for it.
 */
export class PngError extends Error {
	override readonly name = "PngError";
}

export const PNG_LIMITS = { maxPixels: 16_000_000, maxRaw: 96 * 1024 * 1024 } as const;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the header, without reading the rest. */
export function pngSize(data: Buffer): { width: number; height: number } | undefined {
	if (data.length < 24 || !data.subarray(0, 8).equals(SIGNATURE) || data.toString("latin1", 12, 16) !== "IHDR") return undefined;
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export type PngPicture = { readonly width: number; readonly height: number; readonly channels: 1 | 3; readonly pixels: Buffer; readonly alpha?: Buffer };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function readPng(data: Buffer): PngPicture {
	const size = pngSize(data);
	if (size === undefined) throw new PngError("non è un PNG");
	const { width, height } = size;
	const bitDepth = data[24] as number;
	const colorType = data[25] as number;
	const interlace = data[28] as number;
	const channels = CHANNELS[colorType];
	if (channels === undefined || ![1, 2, 4, 8, 16].includes(bitDepth) || ((colorType === 2 || colorType === 4 || colorType === 6) && bitDepth < 8) || (colorType === 3 && bitDepth === 16)) {
		throw new PngError("il PNG è rovinato");
	}
	if (interlace !== 0) throw new PngError("il PNG è interlacciato, un formato che nel PDF non so mettere");
	if (width === 0 || height === 0 || width * height > PNG_LIMITS.maxPixels) throw new PngError("l'immagine è troppo grande (più di 16 milioni di pixel)");
	const bits = channels * bitDepth;
	const rowBytes = Math.ceil((width * bits) / 8);
	const expected = height * (rowBytes + 1);
	if (expected > PNG_LIMITS.maxRaw) throw new PngError("l'immagine è troppo grande");
	let palette: Buffer | undefined;
	let transparency: Buffer | undefined;
	const idat: Buffer[] = [];
	for (let at = 8; at + 8 <= data.length; ) {
		const length = data.readUInt32BE(at);
		const type = data.toString("latin1", at + 4, at + 8);
		const body = data.subarray(at + 8, at + 8 + length);
		if (body.length !== length) throw new PngError("il PNG è troncato");
		if (type === "PLTE") palette = body;
		else if (type === "tRNS") transparency = body;
		else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		at += 12 + length;
	}
	if (colorType === 3 && palette === undefined) throw new PngError("il PNG è rovinato");
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
	} catch {
		throw new PngError("il PNG è rovinato");
	}
	if (raw.length < expected) throw new PngError("il PNG è troncato");
	unfilter(raw, rowBytes, height, Math.max(1, Math.ceil(bits / 8)));
	const outChannels: 1 | 3 = colorType === 0 || colorType === 4 ? 1 : 3;
	const pixels = Buffer.alloc(width * height * outChannels);
	const alpha = Buffer.alloc(colorType === 4 || colorType === 6 || transparency !== undefined ? width * height : 0, 255);
	const max = (1 << bitDepth) - 1;
	const sample = (row: number, index: number): number => {
		// The index-th sample of a row, at its own depth.
		const start = row * (rowBytes + 1) + 1;
		if (bitDepth === 8) return raw[start + index] as number;
		if (bitDepth === 16) return raw.readUInt16BE(start + index * 2);
		const bit = index * bitDepth;
		return ((raw[start + (bit >> 3)] as number) >> (8 - bitDepth - (bit & 7))) & max;
	};
	const eight = (v: number): number => (bitDepth === 16 ? v >> 8 : bitDepth === 8 ? v : Math.round((v * 255) / max));
	const key = transparency !== undefined && colorType === 0 && transparency.length >= 2 ? transparency.readUInt16BE(0) : undefined;
	const keyRgb = transparency !== undefined && colorType === 2 && transparency.length >= 6 ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)] : undefined;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = y * width + x;
			const s = x * channels;
			if (colorType === 3) {
				const index = sample(y, x);
				const pal = palette as Buffer;
				pixels[p * 3] = pal[index * 3] ?? 0;
				pixels[p * 3 + 1] = pal[index * 3 + 1] ?? 0;
				pixels[p * 3 + 2] = pal[index * 3 + 2] ?? 0;
				if (transparency !== undefined) alpha[p] = transparency[index] ?? 255;
			} else if (colorType === 0 || colorType === 4) {
				const v = sample(y, s);
				pixels[p] = eight(v);
				if (colorType === 4) alpha[p] = eight(sample(y, s + 1));
				else if (key !== undefined && v === key) alpha[p] = 0;
			} else {
				const r = sample(y, s);
				const g = sample(y, s + 1);
				const b = sample(y, s + 2);
				pixels[p * 3] = eight(r);
				pixels[p * 3 + 1] = eight(g);
				pixels[p * 3 + 2] = eight(b);
				if (colorType === 6) alpha[p] = eight(sample(y, s + 3));
				else if (keyRgb !== undefined && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2]) alpha[p] = 0;
			}
		}
	}
	const opaque = alpha.every((a) => a === 255);
	return { width, height, channels: outChannels, pixels, ...(alpha.length > 0 && !opaque ? { alpha } : {}) };
}

/** Undo the PNG row filters in place (None, Sub, Up, Average, Paeth). */
function unfilter(raw: Buffer, rowBytes: number, height: number, bpp: number): void {
	for (let y = 0; y < height; y++) {
		const start = y * (rowBytes + 1);
		const filter = raw[start] as number;
		const row = start + 1;
		const prior = row - rowBytes - 1;
		for (let i = 0; i < rowBytes; i++) {
			const left = i >= bpp ? (raw[row + i - bpp] as number) : 0;
			const up = y > 0 ? (raw[prior + i] as number) : 0;
			const corner = y > 0 && i >= bpp ? (raw[prior + i - bpp] as number) : 0;
			const value = raw[row + i] as number;
			let add = 0;
			if (filter === 1) add = left;
			else if (filter === 2) add = up;
			else if (filter === 3) add = (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - corner;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - corner);
				add = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
			} else if (filter !== 0) throw new PngError("il PNG è rovinato");
			raw[row + i] = (value + add) & 0xff;
		}
	}
}
