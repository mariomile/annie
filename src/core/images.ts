/**
 * Pictures the model looks at: photos people send, and images in the workspace an instance
 * opens with image_view. Recognized by their bytes, not by name or declared type, and capped
 * so a message stays within what the model providers accept.
 */

/** Model providers take up to about 5 MB per image once encoded: 3.75 MB of bytes is under that. */
export const IMAGE_LIMITS = { maxBytes: 3_750_000, perMessage: 4 } as const;

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A picture for the model: where it is in the workspace, its type and its bytes. */
export type ModelImage = { readonly path: string; readonly mimeType: ImageMime; readonly data: Uint8Array };

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

/** Why these bytes cannot go to the model as a picture, or undefined if they can. */
export function imageProblem(data: Uint8Array): string | undefined {
	if (imageType(data) === undefined) return "non è un'immagine JPEG, PNG, GIF o WebP";
	if (data.length > IMAGE_LIMITS.maxBytes) return `è più grande di ${(IMAGE_LIMITS.maxBytes / 1_000_000).toFixed(2).replace(".", ",")} MB`;
	return undefined;
}
