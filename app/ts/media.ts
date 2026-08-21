// Canonical IndexedDB media-store key derivation and data-URL decoding.
// Keys are derived from a history item id so bytes can be fetched on demand without carrying them in the record.

import { bytesToBlob, dataUrlToBytes, mimeOfDataUrl } from "./utils.js";

/** Media-store key for a history item's video payload. */
export function videoKey(id: string): string {
	return id;
}

/** Media-store key for a history item's single-frame thumbnail. */
export function thumbnailKey(id: string): string {
	return `${id}:thumb`;
}

/** The shared prefix for every one of a history item's persisted input file keys, in one place. */
export function fileKeyPrefix(id: string): string {
	return `${id}:file:`;
}

/** Media-store key for one of a history item's persisted input files. */
export function fileKey(id: string, index: number): string {
	return `${fileKeyPrefix(id)}${index}`;
}

/** The shared prefix for every media-store key belonging to a history item's NTH reference video. */
export function refVideoPrefix(id: string, index: number): string {
	return `${id}:vref:${index}:`;
}

/** Media-store key of a reference video's first-frame preview image. */
export function refVideoThumbKey(id: string, index: number): string {
	return `${refVideoPrefix(id, index)}thumb`;
}

/** Media-store key of a reference video's WAV soundtrack. */
export function refVideoAudioKey(id: string, index: number): string {
	return `${refVideoPrefix(id, index)}audio`;
}

/** Media-store key of a reference video's original container bytes. */
export function refVideoSourceKey(id: string, index: number): string {
	return `${refVideoPrefix(id, index)}src`;
}

/** Media-store key of the NTH reference audio clip's original file bytes. */
export function refAudioKey(id: string, index: number): string {
	return `${id}:aref:${index}`;
}

/**
 * Decode a base64 data URL into a Blob carrying the declared MIME type.
 * Falls back to application/octet-stream when no MIME is declared or the data: prefix is missing.
 * Throws on a malformed base64 payload.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
	return bytesToBlob(dataUrlToBytes(dataUrl), mimeOfDataUrl(dataUrl));
}
