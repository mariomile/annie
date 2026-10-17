/**
 * Recordings cut into pieces a transcription service takes (ADR 0033): a meeting, a call, a voice
 * memo of an hour goes out ten minutes at a time. No new dependencies and no decoding: MP3 is cut
 * between frames, WAV between samples, Ogg (Opus, Vorbis) between pages with its headers repeated,
 * M4A and MP4 (AAC) rebuilt around a run of samples, so a video's sound goes without the picture.
 * FLAC, WebM and AMR go whole when they fit in one piece.
 */

export type AudioFormat = "mp3" | "wav" | "ogg" | "m4a" | "flac" | "webm" | "amr";

export type AudioInfo = {
	readonly format: AudioFormat;
	/** Length in seconds, when the file says it. */
	readonly seconds: number | undefined;
	/** True for a video whose sound is sent alone. */
	readonly video: boolean;
};

/** A piece ready to send: its own valid file, and where it starts in the recording. */
export type AudioPiece = {
	readonly data: Uint8Array;
	/** Seconds from the start of the recording. */
	readonly start: number;
	readonly seconds: number;
	readonly name: string;
	readonly mimeType: string;
};

export type SplitLimits = {
	/** Longest piece, in seconds. */
	readonly pieceSeconds: number;
	/** Largest piece, in bytes. */
	readonly pieceBytes: number;
};

/** Not a recording, or one that cannot be cut: the message is in Italian, for the person. */
export class AudioError extends Error {
	override readonly name = "AudioError";
}

const MIME: Record<AudioFormat, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", webm: "audio/webm", amr: "audio/amr" };

const LABEL: Record<AudioFormat, string> = { mp3: "MP3", wav: "WAV", ogg: "Ogg", m4a: "M4A", flac: "FLAC", webm: "WebM", amr: "AMR" };

export function audioLabel(info: AudioInfo): string {
	return info.video ? "video MP4" : LABEL[info.format];
}

/** What kind of recording this is, from its bytes; undefined when it is not one. */
export function audioFormat(data: Uint8Array): AudioFormat | undefined {
	const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
	if (data.length < 12) return undefined;
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
	if (ascii(0, 4) === "OggS") return "ogg";
	if (ascii(0, 4) === "fLaC") return "flac";
	if (ascii(0, 6) === "#!AMR\n" || ascii(0, 9) === "#!AMR-WB\n") return "amr";
	if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "webm";
	// ftyp opens MP4, M4A and QuickTime, but also HEIC and AVIF pictures: those are not recordings.
	if (ascii(4, 8) === "ftyp") return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis|crx )$/.test(ascii(8, 12)) ? undefined : "m4a";
	if (ascii(0, 3) === "ID3") return "mp3";
	return mp3Header(data, 0) !== undefined && mp3Header(data, mp3Header(data, 0)?.length ?? 0) !== undefined ? "mp3" : undefined;
}

/** The format and length of a recording; AudioError when it is not one this reader knows. */
export function audioInfo(data: Uint8Array): AudioInfo {
	return guarded(() => readInfo(data));
}

function readInfo(data: Uint8Array): AudioInfo {
	const format = audioFormat(data);
	if (format === undefined) throw new AudioError(NOT_AUDIO);
	switch (format) {
		case "mp3":
			return { format, seconds: total(mp3Frames(data)), video: false };
		case "wav":
			return { format, seconds: wavLayout(data).seconds, video: false };
		case "ogg":
			return { format, seconds: oggLayout(data).seconds, video: false };
		case "m4a": {
			const track = mp4Track(data);
			return { format, seconds: track.seconds, video: track.video };
		}
		case "flac":
			return { format, seconds: flacSeconds(data), video: false };
		case "amr":
			return { format, seconds: amrSeconds(data), video: false };
		default:
			return { format, seconds: undefined, video: false };
	}
}

/** The length of a recording in seconds; undefined when it is not one or does not say. */
export function audioSeconds(data: Uint8Array): number | undefined {
	try {
		return audioInfo(data).seconds;
	} catch (error) {
		if (error instanceof AudioError) return undefined;
		throw error;
	}
}

/**
 * The recording as pieces within the limits, each a file of its own. A recording that fits in one
 * piece goes as it is. AudioError when it must be cut and its format cannot be.
 */
export function splitAudio(data: Uint8Array, name: string, limits: SplitLimits): AudioPiece[] {
	return guarded(() => split(data, name, limits));
}

function split(data: Uint8Array, name: string, limits: SplitLimits): AudioPiece[] {
	const info = readInfo(data);
	const base = (name.split("/").at(-1) ?? "").replace(/\.[^.]*$/, "") || "registrazione";
	const fits = data.length <= limits.pieceBytes && (info.seconds === undefined || info.seconds <= limits.pieceSeconds);
	if (fits && !info.video) return [{ data, start: 0, seconds: info.seconds ?? 0, name: `${base}.${info.format}`, mimeType: MIME[info.format] }];
	let cuts: { data: Uint8Array; start: number; seconds: number }[];
	switch (info.format) {
		case "mp3":
			cuts = cutMp3(data, limits);
			break;
		case "wav":
			cuts = cutWav(data, limits);
			break;
		case "ogg":
			cuts = cutOgg(data, limits);
			break;
		case "m4a":
			cuts = cutMp4(data, limits);
			break;
		default:
			throw new AudioError(`questa registrazione ${LABEL[info.format]} è troppo lunga per mandarla in un pezzo solo e non so dividerla: convertila in MP3 o M4A, o mandala in parti più brevi`);
	}
	if (cuts.length === 0) throw new AudioError("nella registrazione non c'è audio da trascrivere");
	// However the file describes itself, it never becomes more pieces than its size and length need.
	const most = Math.ceil(data.length / (limits.pieceBytes / 2)) + Math.ceil((info.seconds ?? 0) / (limits.pieceSeconds / 2)) + 2;
	if (cuts.length > most) throw new AudioError(DAMAGED);
	const ext = info.format;
	return cuts.map((cut, i) => ({ ...cut, name: cuts.length === 1 ? `${base}.${ext}` : `${base}-${i + 1}.${ext}`, mimeType: MIME[ext] }));
}

const NOT_AUDIO = "non è una registrazione che so leggere (MP3, M4A, WAV, Ogg, Opus, FLAC, WebM, AMR o un video MP4)";
const DAMAGED = "il file è rovinato: quello che dice di sé non torna";

/**
 * A compressed recording never holds more than this many bytes a second (320 kbit/s is the most
 * MP3 and AAC take, with room): a file that claims to last less for its size is lying about it,
 * and its length is what the limits and the daily minutes count.
 */
const MAX_COMPRESSED_BYTES_PER_SECOND = 64_000;

/** Header bytes repeated in every piece (Ogg pages, WAV chunks): tags with a cover picture fit, a padded header does not. */
const MAX_HEADER_BYTES = 1024 * 1024;

/** Lengths read from the file are checked against its size: a damaged or forged file is refused, never trusted. */
function plausible(bytes: number, seconds: number): void {
	if (bytes > 64 * 1024 && bytes > seconds * MAX_COMPRESSED_BYTES_PER_SECOND) throw new AudioError(DAMAGED);
}

/** The parsers read bytes anyone can send: a read past the end they missed is a damaged file, not a crash. */
function guarded<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof RangeError) throw new AudioError(DAMAGED);
		throw error;
	}
}

function total(frames: readonly { seconds: number }[]): number {
	return frames.reduce((sum, f) => sum + f.seconds, 0);
}

/**
 * Consecutive units (frames, samples, pages) grouped into pieces within the limits, of about the
 * same length: 25 minutes go as 3 pieces of 8 and a bit, not 10, 10 and 5 (nor a last piece of a
 * second, where a service hears nothing to transcribe).
 */
function group<T extends { bytes: number; seconds: number }>(units: readonly T[], limits: SplitLimits, overhead = 0): T[][] {
	const totalSeconds = units.reduce((n, u) => n + u.seconds, 0);
	const totalBytes = units.reduce((n, u) => n + u.bytes, 0);
	// Room for the largest unit, so that cutting between units never needs one piece more.
	const longest = units.reduce((n, u) => Math.max(n, u.seconds), 0);
	const largest = units.reduce((n, u) => Math.max(n, u.bytes), 0);
	const count = Math.max(1, Math.ceil(totalSeconds / Math.max(longest, limits.pieceSeconds - longest)), Math.ceil(totalBytes / Math.max(largest, limits.pieceBytes - overhead - largest)));
	const target = totalSeconds / count;
	const groups: T[][] = [];
	let current: T[] = [];
	let bytes = overhead;
	let seconds = 0;
	for (const unit of units) {
		const over = bytes + unit.bytes > limits.pieceBytes || seconds + unit.seconds > limits.pieceSeconds;
		// The last piece takes what is left, within the limits.
		const due = groups.length < count - 1 && seconds + unit.seconds / 2 > target;
		if (current.length > 0 && (over || due)) {
			groups.push(current);
			current = [];
			bytes = overhead;
			seconds = 0;
		}
		current.push(unit);
		bytes += unit.bytes;
		seconds += unit.seconds;
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

// ---------------------------------------------------------------- MP3

/** Kbit/s by version (1, or 2 and 2.5) and layer (I, II, III). */
const MP3_BITRATES: Record<string, readonly number[]> = {
	"1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
	"1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
	"1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	"2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
	"2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
	"2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

type Mp3Frame = { readonly at: number; readonly bytes: number; readonly seconds: number };

/** The MPEG audio frame header at `at`: its length in bytes and its duration. */
function mp3Header(data: Uint8Array, at: number): { length: number; seconds: number } | undefined {
	if (at + 4 > data.length) return undefined;
	const b1 = data[at + 1] as number;
	const b2 = data[at + 2] as number;
	if (data[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
	const version = (b1 >> 3) & 3;
	const layer = 4 - ((b1 >> 1) & 3);
	const bitrateIndex = b2 >> 4;
	const rateIndex = (b2 >> 2) & 3;
	if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
	const kbps = MP3_BITRATES[`${version === 3 ? 1 : 2}-${layer}`]?.[bitrateIndex] ?? 0;
	const rate = MP3_RATES[version]?.[rateIndex] ?? 0;
	if (kbps === 0 || rate === 0) return undefined;
	const padding = (b2 >> 1) & 1;
	const bitrate = kbps * 1000;
	const length = layer === 1 ? (Math.floor((12 * bitrate) / rate) + padding) * 4 : layer === 3 && version !== 3 ? Math.floor((72 * bitrate) / rate) + padding : Math.floor((144 * bitrate) / rate) + padding;
	const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
	return { length, seconds: samples / rate };
}

/** The audio frames, skipping tags, the Xing/Info/VBRI frame and junk between frames. */
function mp3Frames(data: Uint8Array): Mp3Frame[] {
	let at = 0;
	if (String.fromCharCode(...data.subarray(0, 3)) === "ID3" && data.length >= 10) {
		const size = (((data[6] as number) & 0x7f) << 21) | (((data[7] as number) & 0x7f) << 14) | (((data[8] as number) & 0x7f) << 7) | ((data[9] as number) & 0x7f);
		at = 10 + size + (((data[5] as number) & 0x10) !== 0 ? 10 : 0);
	}
	const end = data.length >= 128 && String.fromCharCode(...data.subarray(data.length - 128, data.length - 125)) === "TAG" ? data.length - 128 : data.length;
	const frames: Mp3Frame[] = [];
	while (at + 4 <= end) {
		const header = mp3Header(data, at);
		// A frame counts when it fits and the next one follows it (or the file ends there): a stray 0xFF in junk does not.
		if (header !== undefined && at + header.length <= end && (at + header.length + 4 > end || mp3Header(data, at + header.length) !== undefined || frames.length > 0)) {
			if (!(frames.length === 0 && isVbrInfo(data, at, header.length))) frames.push({ at, bytes: header.length, seconds: header.seconds });
			at += header.length;
			continue;
		}
		at += 1;
	}
	return frames;
}

/** The first frame of a VBR file holds only its table of contents: not sound, and wrong for a piece. */
function isVbrInfo(data: Uint8Array, at: number, length: number): boolean {
	const head = String.fromCharCode(...data.subarray(at + 4, at + Math.min(length, 48)));
	return /Xing|Info|VBRI/.test(head);
}

function cutMp3(data: Uint8Array, limits: SplitLimits): { data: Uint8Array; start: number; seconds: number }[] {
	let start = 0;
	return group(mp3Frames(data), limits).map((frames) => {
		const first = frames[0] as Mp3Frame;
		const last = frames.at(-1) as Mp3Frame;
		const seconds = total(frames);
		const piece = { data: data.slice(first.at, last.at + last.bytes), start, seconds };
		start += seconds;
		return piece;
	});
}

// ---------------------------------------------------------------- WAV

type WavLayout = { readonly header: Uint8Array; readonly dataAt: number; readonly dataBytes: number; readonly blockAlign: number; readonly byteRate: number; readonly seconds: number };

function wavLayout(data: Uint8Array): WavLayout {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let at = 12;
	let fmt: Uint8Array | undefined;
	while (at + 8 <= data.length) {
		const id = String.fromCharCode(...data.subarray(at, at + 4));
		const size = view.getUint32(at + 4, true);
		if (id === "fmt " && size >= 16 && at + 8 + size <= data.length) fmt = data.slice(at, at + 8 + size);
		if (id === "data") {
			if (fmt === undefined || at > MAX_HEADER_BYTES) break;
			const fmtView = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
			const sampleRate = fmtView.getUint32(12, true);
			const byteRate = fmtView.getUint32(16, true);
			const blockAlign = fmtView.getUint16(20, true);
			// The rate is what the length is worked out from: it must agree with the rest of the header and be a real one.
			if (blockAlign === 0 || blockAlign > 64 || sampleRate === 0 || sampleRate > 384_000 || byteRate !== sampleRate * blockAlign) break;
			// A recorder that stopped mid-file leaves the size at 0 or at its maximum: the rest of the file is the sound.
			const room = data.length - (at + 8);
			const bytes = size === 0 || size > room ? room : size;
			const dataBytes = bytes - (bytes % blockAlign);
			// Every chunk before the sound (fmt, fact, tags) goes with each piece, as the file has them.
			return { header: data.slice(12, at), dataAt: at + 8, dataBytes, blockAlign, byteRate, seconds: dataBytes / byteRate };
		}
		at += 8 + size + (size % 2);
	}
	throw new AudioError("questo WAV è rovinato o in un formato che non conosco");
}

function cutWav(data: Uint8Array, limits: SplitLimits): { data: Uint8Array; start: number; seconds: number }[] {
	const wav = wavLayout(data);
	const header = 12 + wav.header.length + 8;
	const bytesBySize = Math.floor((limits.pieceBytes - header) / wav.blockAlign) * wav.blockAlign;
	const bytesByTime = Math.floor((limits.pieceSeconds * wav.byteRate) / wav.blockAlign) * wav.blockAlign;
	const most = Math.min(bytesBySize, bytesByTime);
	if (most <= 0) throw new AudioError("questo WAV ha un formato che non so dividere");
	// Pieces of the same length, each within the limits.
	const count = Math.ceil(wav.dataBytes / most);
	const step = Math.ceil(wav.dataBytes / count / wav.blockAlign) * wav.blockAlign;
	const pieces = [];
	for (let from = 0; from < wav.dataBytes; from += step) {
		const bytes = Math.min(step, wav.dataBytes - from);
		const out = new Uint8Array(header + bytes);
		const view = new DataView(out.buffer);
		out.set([0x52, 0x49, 0x46, 0x46], 0);
		view.setUint32(4, out.length - 8, true);
		out.set([0x57, 0x41, 0x56, 0x45], 8);
		out.set(wav.header, 12);
		out.set([0x64, 0x61, 0x74, 0x61], 12 + wav.header.length);
		view.setUint32(16 + wav.header.length, bytes, true);
		out.set(data.subarray(wav.dataAt + from, wav.dataAt + from + bytes), header);
		pieces.push({ data: out, start: from / wav.byteRate, seconds: bytes / wav.byteRate });
	}
	return pieces;
}

// ---------------------------------------------------------------- Ogg

type OggPage = { readonly at: number; readonly bytes: number; readonly granule: number; readonly serial: number; readonly continued: boolean; readonly packetsEnded: number };

type OggLayout = { readonly headers: readonly OggPage[]; readonly audio: readonly OggPage[]; readonly rate: number; readonly preSkip: number; readonly seconds: number };

function oggPages(data: Uint8Array): OggPage[] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const pages: OggPage[] = [];
	let at = 0;
	while (at + 27 <= data.length) {
		if (!(data[at] === 0x4f && data[at + 1] === 0x67 && data[at + 2] === 0x67 && data[at + 3] === 0x53)) break;
		const segments = data[at + 26] as number;
		if (at + 27 + segments > data.length) break;
		let body = 0;
		let packetsEnded = 0;
		for (let i = 0; i < segments; i++) {
			const lacing = data[at + 27 + i] as number;
			body += lacing;
			if (lacing < 255) packetsEnded++;
		}
		const bytes = 27 + segments + body;
		if (at + bytes > data.length) break;
		const low = view.getUint32(at + 6, true);
		const high = view.getInt32(at + 10, true);
		pages.push({ at, bytes, granule: high * 2 ** 32 + low, serial: view.getUint32(at + 14, true), continued: ((data[at + 5] as number) & 1) !== 0, packetsEnded });
		at += bytes;
	}
	return pages;
}

function oggLayout(data: Uint8Array): OggLayout {
	const all = oggPages(data);
	const first = all[0];
	if (first === undefined) throw new AudioError("questo file Ogg è rovinato");
	// One stream only: a second one multiplexed in (rare in recordings) is left out.
	const pages = all.filter((p) => p.serial === first.serial);
	const head = data.subarray(first.at + 27 + (data[first.at + 26] as number), first.at + first.bytes);
	const ascii = String.fromCharCode(...head.subarray(0, 8));
	let rate: number;
	let preSkip = 0;
	let headerPackets: number;
	if (ascii === "OpusHead") {
		rate = 48_000;
		preSkip = (head[10] as number) | ((head[11] as number) << 8);
		headerPackets = 2;
	} else if (ascii.slice(1, 7) === "vorbis" && head.length >= 16) {
		rate = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(12, true);
		headerPackets = 3;
	} else throw new AudioError("questo Ogg non contiene né Opus né Vorbis");
	if (rate === 0) throw new AudioError("questo file Ogg è rovinato");
	// Header pages are those until the header packets are complete; audio starts on a fresh page.
	let split = 0;
	for (let ended = 0; split < pages.length && ended < headerPackets; split++) ended += (pages[split] as OggPage).packetsEnded;
	const headers = pages.slice(0, split);
	const audio = pages.slice(split);
	if (headers.reduce((n, p) => n + p.bytes, 0) > MAX_HEADER_BYTES) throw new AudioError(DAMAGED);
	// Time only goes forward: -1 marks a page where no packet ends.
	let lastGranule = 0;
	for (const page of audio) {
		if (page.granule < 0) continue;
		if (page.granule < lastGranule) throw new AudioError(DAMAGED);
		lastGranule = page.granule;
	}
	const seconds = Math.max(0, lastGranule - preSkip) / rate;
	plausible(audio.reduce((n, p) => n + p.bytes, 0), seconds);
	return { headers, audio, rate, preSkip, seconds };
}

function cutOgg(data: Uint8Array, limits: SplitLimits): { data: Uint8Array; start: number; seconds: number }[] {
	const ogg = oggLayout(data);
	const headerBytes = ogg.headers.reduce((n, p) => n + p.bytes, 0);
	// Pages that carry the rest of a packet stay with the page before: a piece starts on a whole packet.
	const runs: { pages: OggPage[]; bytes: number; seconds: number; startGranule: number }[] = [];
	let previous = 0;
	for (const page of ogg.audio) {
		const run = runs.at(-1);
		// -1: no packet ends on this page, so it adds no time of its own.
		const granule = page.granule >= 0 ? page.granule : previous;
		if (run !== undefined && page.continued) {
			run.pages.push(page);
			run.bytes += page.bytes;
			run.seconds += (granule - previous) / ogg.rate;
		} else runs.push({ pages: [page], bytes: page.bytes, seconds: (granule - previous) / ogg.rate, startGranule: previous });
		previous = granule;
	}
	return group(runs, limits, headerBytes).map((piece) => {
		const pages = [...ogg.headers, ...piece.flatMap((r) => r.pages)];
		const out = concat(pages.map((p) => data.slice(p.at, p.at + p.bytes)));
		const startGranule = (piece[0] as (typeof runs)[number]).startGranule;
		// Each piece is a stream of its own: pages numbered from 0, the last marked as the end, checksums
		// redone, its time from 0 again (some decoders take a late start for silence to play first).
		const view = new DataView(out.buffer);
		let at = 0;
		pages.forEach((page, seq) => {
			out[at + 5] = ((out[at + 5] as number) & ~0x04) | (seq === pages.length - 1 ? 0x04 : 0);
			if (seq >= ogg.headers.length && page.granule >= 0) {
				const granule = page.granule - Math.max(0, startGranule - ogg.preSkip);
				view.setUint32(at + 6, granule % 2 ** 32, true);
				view.setUint32(at + 10, Math.floor(granule / 2 ** 32), true);
			}
			view.setUint32(at + 18, seq, true);
			view.setUint32(at + 22, 0, true);
			view.setUint32(at + 22, oggCrc(out.subarray(at, at + page.bytes)), true);
			at += page.bytes;
		});
		return { data: out, start: Math.max(0, startGranule - ogg.preSkip) / ogg.rate, seconds: piece.reduce((n, r) => n + r.seconds, 0) };
	});
}

let crcTable: Uint32Array | undefined;

/** Ogg's page checksum: CRC-32 with polynomial 0x04C11DB7, not reflected, initial value 0. */
export function oggCrc(page: Uint8Array): number {
	if (crcTable === undefined) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let r = i << 24;
			for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
			crcTable[i] = r >>> 0;
		}
	}
	let crc = 0;
	for (const byte of page) crc = ((crc << 8) ^ (crcTable[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0;
	return crc;
}

// ---------------------------------------------------------------- MP4 / M4A

type Box = { readonly type: string; readonly start: number; readonly body: number; readonly end: number };

/** The boxes between `from` and `to`, with 64-bit and to-the-end sizes; never past `to`. */
function boxes(data: Uint8Array, from: number, to: number): Box[] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const found: Box[] = [];
	let at = from;
	while (at + 8 <= to) {
		let size = view.getUint32(at);
		const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
		let body = at + 8;
		if (size === 1) {
			if (at + 16 > to) break;
			size = Number(view.getBigUint64(at + 8));
			body = at + 16;
		} else if (size === 0) size = to - at;
		if (size < body - at || at + size > to) break;
		found.push({ type, start: at, body, end: at + size });
		at += size;
	}
	return found;
}

function child(data: Uint8Array, parent: Box, type: string): Box | undefined {
	return boxes(data, parent.body, parent.end).find((b) => b.type === type);
}

function path(data: Uint8Array, parent: Box, ...types: string[]): Box | undefined {
	let box: Box | undefined = parent;
	for (const type of types) {
		if (box === undefined) return undefined;
		box = child(data, box, type);
	}
	return box;
}

type Mp4Track = {
	readonly timescale: number;
	readonly language: number;
	readonly stsd: Uint8Array;
	readonly sizes: Uint32Array;
	readonly offsets: Float64Array;
	readonly durations: Uint32Array;
	readonly seconds: number;
	readonly video: boolean;
};

const MP4_MAX_SAMPLES = 2_000_000;

function mp4Track(data: Uint8Array): Mp4Track {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const top = boxes(data, 0, data.length);
	const moov = top.find((b) => b.type === "moov");
	if (moov === undefined) throw new AudioError(top.some((b) => b.type === "moof") ? "questo MP4 è registrato a frammenti e non so dividerlo: convertilo in MP3 o M4A" : "questo M4A è rovinato o incompleto: manca l'indice");
	const traks = boxes(data, moov.body, moov.end).filter((b) => b.type === "trak");
	const handler = (trak: Box) => {
		const hdlr = path(data, trak, "mdia", "hdlr");
		return hdlr === undefined || hdlr.body + 12 > hdlr.end ? "" : String.fromCharCode(...data.subarray(hdlr.body + 8, hdlr.body + 12));
	};
	const trak = traks.find((t) => handler(t) === "soun");
	if (trak === undefined) throw new AudioError("questo file non ha una traccia audio");
	const video = traks.some((t) => handler(t) === "vide");
	const mdhd = path(data, trak, "mdia", "mdhd");
	const stbl = path(data, trak, "mdia", "minf", "stbl");
	if (mdhd === undefined || stbl === undefined) throw new AudioError("questo M4A è rovinato");
	const v1 = data[mdhd.body] === 1;
	if (mdhd.body + (v1 ? 34 : 22) > mdhd.end) throw new AudioError("questo M4A è rovinato");
	const timescale = view.getUint32(mdhd.body + (v1 ? 20 : 12));
	const language = view.getUint16(mdhd.body + (v1 ? 32 : 20));
	const table = (type: string) => {
		const box = child(data, stbl, type);
		if (box === undefined || box.body + 8 > box.end) return undefined;
		return { box, count: view.getUint32(box.body + 4), at: box.body + 8 };
	};
	const stsd = child(data, stbl, "stsd");
	const stsz = table("stsz");
	if (stsz !== undefined && stsz.box.body + 12 > stsz.box.end) throw new AudioError("questo M4A è rovinato: l'indice dei campioni è incompleto");
	const stts = table("stts");
	const stsc = table("stsc");
	const co = table("stco") ?? table("co64");
	if (stsd === undefined || stsz === undefined || stts === undefined || stsc === undefined || co === undefined || timescale === 0) throw new AudioError("questo M4A è rovinato: l'indice dei campioni è incompleto");
	const uniform = view.getUint32(stsz.box.body + 4);
	const count = view.getUint32(stsz.box.body + 8);
	if (count > MP4_MAX_SAMPLES || (uniform === 0 && stsz.box.body + 12 + count * 4 > stsz.box.end)) throw new AudioError("questo M4A è rovinato o troppo lungo");
	const sizes = new Uint32Array(count);
	let payload = 0;
	for (let i = 0; i < count; i++) payload += sizes[i] = uniform !== 0 ? uniform : view.getUint32(stsz.box.body + 12 + i * 4);
	// Samples are parts of the file: together they cannot be more than it.
	if (payload > data.length) throw new AudioError(DAMAGED);
	const durations = new Uint32Array(count);
	let filled = 0;
	for (let e = 0; e < stts.count && stts.at + e * 8 + 8 <= stts.box.end && filled < count; e++) {
		const n = view.getUint32(stts.at + e * 8);
		const delta = view.getUint32(stts.at + e * 8 + 4);
		for (let k = 0; k < n && filled < count; k++) durations[filled++] = delta;
	}
	const wide = co.box.type === "co64";
	const chunks: number[] = [];
	for (let c = 0; c < co.count && co.at + (c + 1) * (wide ? 8 : 4) <= co.box.end; c++) chunks.push(wide ? Number(view.getBigUint64(co.at + c * 8)) : view.getUint32(co.at + c * 4));
	const offsets = new Float64Array(count);
	let sample = 0;
	const entries = Math.min(stsc.count, Math.floor((stsc.box.end - stsc.at) / 12));
	for (let e = 0; e < entries && sample < count; e++) {
		const firstChunk = view.getUint32(stsc.at + e * 12) - 1;
		const perChunk = view.getUint32(stsc.at + e * 12 + 4);
		const nextFirst = e + 1 < entries ? view.getUint32(stsc.at + (e + 1) * 12) - 1 : chunks.length;
		// Runs of chunks go forward and hold samples: otherwise the same chunks would be walked again and again.
		if (firstChunk < 0 || perChunk === 0 || nextFirst <= firstChunk) throw new AudioError("questo M4A è rovinato: l'indice dei campioni è incompleto");
		for (let c = firstChunk; c < Math.min(nextFirst, chunks.length) && sample < count; c++) {
			let at = chunks[c] as number;
			for (let k = 0; k < perChunk && sample < count; k++) {
				offsets[sample] = at;
				at += sizes[sample] as number;
				sample++;
			}
		}
	}
	if (sample < count) throw new AudioError("questo M4A è rovinato: l'indice dei campioni è incompleto");
	for (let i = 0; i < count; i++) if ((offsets[i] as number) + (sizes[i] as number) > data.length) throw new AudioError("questo M4A è incompleto: il file è stato tagliato");
	let ticks = 0;
	for (const d of durations) ticks += d;
	plausible(payload, ticks / timescale);
	return { timescale, language, stsd: data.slice(stsd.start, stsd.end), sizes, offsets, durations, seconds: ticks / timescale, video };
}

function cutMp4(data: Uint8Array, limits: SplitLimits): { data: Uint8Array; start: number; seconds: number }[] {
	const track = mp4Track(data);
	const units = Array.from(track.sizes, (bytes, i) => ({ i, bytes, seconds: (track.durations[i] as number) / track.timescale }));
	// The index of a piece is about 4 bytes a sample plus fixed boxes: room for it is kept.
	let start = 0;
	return group(units, { ...limits, pieceBytes: Math.floor(limits.pieceBytes * 0.97) - 2048 }).map((samples) => {
		const piece = buildM4a(data, track, samples.map((s) => s.i));
		const seconds = samples.reduce((n, s) => n + s.seconds, 0);
		const out = { data: piece, start, seconds };
		start += seconds;
		return out;
	});
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(parts);
	const out = new Uint8Array(8 + body.length);
	new DataView(out.buffer).setUint32(0, out.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
	return out;
}

function u32s(...values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((v, i) => view.setUint32(i * 4, v >>> 0));
	return out;
}

const MATRIX = u32s(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

/** A small M4A with the given samples: one track, one chunk, the original sample description. */
function buildM4a(data: Uint8Array, track: Mp4Track, samples: readonly number[]): Uint8Array {
	let ticks = 0;
	const stts: number[] = [];
	for (const i of samples) {
		const d = track.durations[i] as number;
		ticks += d;
		if (stts.length > 0 && stts.at(-1) === d) stts[stts.length - 2] = (stts[stts.length - 2] as number) + 1;
		else stts.push(1, d);
	}
	const media = concat(samples.map((i) => data.subarray(track.offsets[i] as number, (track.offsets[i] as number) + (track.sizes[i] as number))));
	const language = new Uint8Array([track.language >> 8, track.language & 0xff, 0, 0]);
	const ftyp = box("ftyp", new TextEncoder().encode("M4A "), u32s(0), new TextEncoder().encode("M4A mp42isom"));
	const moovWith = (offset: number) =>
		box(
			"moov",
			box("mvhd", u32s(0, 0, 0, track.timescale, ticks, 0x10000), new Uint8Array([1, 0, 0, 0]), u32s(0, 0), MATRIX, u32s(0, 0, 0, 0, 0, 0, 2)),
			box(
				"trak",
				box("tkhd", u32s(7, 0, 0, 1, 0, ticks, 0, 0), new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0]), MATRIX, u32s(0, 0)),
				box(
					"mdia",
					box("mdhd", u32s(0, 0, 0, track.timescale, ticks), language),
					box("hdlr", u32s(0, 0), new TextEncoder().encode("soun"), u32s(0, 0, 0), new Uint8Array([0x53, 0x6f, 0x75, 0x6e, 0x64, 0])),
					box(
						"minf",
						box("smhd", u32s(0, 0)),
						box("dinf", box("dref", u32s(0, 1), box("url ", u32s(1)))),
						box(
							"stbl",
							track.stsd,
							box("stts", u32s(0, stts.length / 2, ...stts)),
							box("stsc", u32s(0, 1, 1, samples.length, 1)),
							box("stsz", u32s(0, 0, samples.length, ...samples.map((i) => track.sizes[i] as number))),
							box("stco", u32s(0, 1, offset)),
						),
					),
				),
			),
		);
	const moovLength = moovWith(0).length;
	const mdatHeader = u32s(8 + media.length, 0x6d646174);
	return concat([ftyp, moovWith(ftyp.length + moovLength + 8), mdatHeader, media]);
}

// ---------------------------------------------------------------- FLAC

function flacSeconds(data: Uint8Array): number | undefined {
	// STREAMINFO is the first metadata block: sample rate (20 bits) and total samples (36 bits).
	if (data.length < 42 || ((data[4] as number) & 0x7f) !== 0) return undefined;
	const at = 8 + 10;
	const rate = ((data[at] as number) << 12) | ((data[at + 1] as number) << 4) | ((data[at + 2] as number) >> 4);
	const samples = ((data[at + 3] as number) & 0x0f) * 2 ** 32 + (((data[at + 4] as number) << 24) >>> 0) + ((data[at + 5] as number) << 16) + ((data[at + 6] as number) << 8) + (data[at + 7] as number);
	return rate === 0 || samples === 0 ? undefined : samples / rate;
}

// ---------------------------------------------------------------- AMR

/** Bytes of a frame, header included, by frame type; 0 for types that do not occur in files. Each frame is 20 ms. */
const AMR_NB_FRAME = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1];
const AMR_WB_FRAME = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 0, 0, 0, 0, 1, 1];

/** The frames counted one by one: phone call recorders write AMR, which has no length in its header. */
function amrSeconds(data: Uint8Array): number | undefined {
	const wide = String.fromCharCode(...data.subarray(0, 9)) === "#!AMR-WB\n";
	const sizes = wide ? AMR_WB_FRAME : AMR_NB_FRAME;
	let at = wide ? 9 : 6;
	let frames = 0;
	while (at < data.length) {
		const size = sizes[((data[at] as number) >> 3) & 0x0f] as number;
		if (size === 0) return undefined;
		at += size;
		frames++;
	}
	return frames * 0.02;
}
