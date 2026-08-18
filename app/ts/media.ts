// Canonical IndexedDB media-store key derivation and data-URL decoding.
// Keys are derived from a history item id so bytes can be fetched on demand without carrying them in the record.

/** Media-store key for a history item's video payload. */
export function videoKey(id: string): string {
	return id;
}

/** Media-store key for a history item's single-frame thumbnail. */
export function thumbnailKey(id: string): string {
	return `${id}:thumb`;
}

/** Media-store key for one of a history item's persisted input files. */
export function fileKey(id: string, index: number): string {
	return `${id}:file:${index}`;
}

/**
 * Decode a base64 data URL into a Blob carrying the declared MIME type.
 * Falls back to application/octet-stream when no MIME is declared or the data: prefix is missing.
 * Throws on a malformed base64 payload.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
	const comma = dataUrl.indexOf(",");
	const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
	const mime = header.match(/^data:([^;,]+)/)?.[1];
	const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
	const binary = atob(base64.trim());
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type: mime ?? "application/octet-stream" });
}
