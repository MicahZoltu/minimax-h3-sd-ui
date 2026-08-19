// Central ownership of in-memory object URLs keyed by media-store key.
// A key maps to one stable URL for its Blob; getOrCreate is idempotent (reusing an existing URL for the same key).
// revoke / revokeById are no-ops for missing keys, so duplicate cleanups are safe.
//
// Ownership split: the resident video key (a bare history-item id) is owned by state.ts and must survive a row
// leaving the DOM, while a history row's `:thumb` and `:file:N` keys are owned by the UI and are revoked when the
// row leaves the DOM. revokeRowMedia revokes only those row-scoped keys so a resident video is never dropped by a UI row cleanup.

import { fileKeyPrefix, thumbnailKey, videoKey } from "./media.js";

interface OwnedUrl {
	url: string;
	blob: Blob;
}

const registry = new Map<string, OwnedUrl>();

/** Return the existing URL for a media key, creating and storing it when absent. */
export function getOrCreate(key: string, blob: Blob): string {
	const existing = registry.get(key);
	if (existing) return existing.url;
	const url = URL.createObjectURL(blob);
	registry.set(key, { url, blob });
	return url;
}

/** Revoke and forget a single media key; a missing key is a no-op. */
export function revoke(key: string): void {
	const entry = registry.get(key);
	if (!entry) return;
	URL.revokeObjectURL(entry.url);
	registry.delete(key);
}

/** Revoke and forget every media key owned by a history item id (its video, thumbnail, and input files). */
export function revokeById(id: string): void {
	revoke(videoKey(id));
	revokeRowMedia(id);
}

/** Revoke and forget a history row's thumbnail and input-file keys only, never its bare resident video key. */
export function revokeRowMedia(id: string): void {
	revoke(thumbnailKey(id));
	const filePrefix = fileKeyPrefix(id);
	for (const key of [...registry.keys()]) {
		if (key.startsWith(filePrefix)) revoke(key);
	}
}
