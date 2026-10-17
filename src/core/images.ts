/**
 * Pictures the model looks at: photos people send, and images in the workspace an instance
 * opens with image_view. Recognized by their bytes, not by name or declared type. A photo
 * too big for the model is shrunk on the way to it (the engine does that); the workspace
 * keeps the original.
 */

/** Up to 4 pictures a message, each up to 20 MB as stored (what a Telegram bot may download, and a web upload). */
export const IMAGE_LIMITS = { maxBytes: 20 * 1024 * 1024, perMessage: 4 } as const;

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** The image type of these bytes, or undefined if they are not a JPEG, PNG, GIF or WebP. */
export function imageType(data: Uint8Array): ImageMime | undefined {
	const at = (i: number) => data[i] ?? -1;
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
	const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
	if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

/** What is said of a picture over the size limit. */
export const IMAGE_TOO_BIG = "è più grande di 20 MB";

/** Why these bytes cannot go to the model as a picture, or undefined if they can. */
export function imageProblem(data: Uint8Array): string | undefined {
	if (imageType(data) === undefined) return "non è un'immagine JPEG, PNG, GIF o WebP";
	if (data.length > IMAGE_LIMITS.maxBytes) return IMAGE_TOO_BIG;
	return undefined;
}

/** A JPEG or PNG no larger than `max`: what chat apps show as a picture rather than a file. */
export function isPhoto(data: Uint8Array, max: number): boolean {
	const type = imageType(data);
	return (type === "image/jpeg" || type === "image/png") && data.length <= max;
}
