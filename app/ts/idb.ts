// IndexedDB history backend.
//
// localStorage cannot hold generated video data (a single webm routinely exceeds its ~5 MB per-origin cap), which is why completed history used to vanish on refresh.
// IndexedDB has real, generous per-origin quota, so completed videos and their source files persist there reliably.
// Every operation degrades to a no-op when IndexedDB is unavailable (private browsing, security policy), leaving history session-only.
// This module never rejects; callers treat it as best-effort.

import { isHistoryItem, isQueueItem, type HistoryBackend, type QueueBackend } from "./history.js";
import type { HistoryItem, QueueItem } from "./types.js";

const DB_NAME = "sdcpp.video";
const DB_VERSION = 3;
const HISTORY_STORE = "history";
const MEDIA_STORE = "media";
// The whole generation queue (queued + in-flight items, including each item's files[].dataUrl images) lives under one fixed key.
// IndexedDB has no tiny ~5 MB localStorage-style cap, so large queues with embedded image dataUrls persist reliably across refresh.
const QUEUE_STORE = "queue";
const QUEUE_KEY = "queue";

function database(): Promise<IDBDatabase | null> {
	if (typeof globalThis.indexedDB === "undefined") return Promise.resolve(null);
	const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
	return new Promise((resolve) => {
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(HISTORY_STORE)) {
				db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
			}
			if (!db.objectStoreNames.contains(MEDIA_STORE)) {
				// No keyPath: media values are raw binary Blobs, keyed explicitly via put(blob, id).
				db.createObjectStore(MEDIA_STORE);
			}
			if (!db.objectStoreNames.contains(QUEUE_STORE)) {
				// No keyPath: the queue is stored as a single array value keyed explicitly via put(items, "queue").
				db.createObjectStore(QUEUE_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
	});
}

function onRequest(request: IDBRequest): Promise<unknown> {
	return new Promise((resolve) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(undefined);
	});
}

function runWrite(run: (history: IDBObjectStore, media: IDBObjectStore) => void): Promise<void> {
	return database().then((db) => {
		if (!db) return Promise.resolve();
		return new Promise<void>((resolve) => {
			try {
				const tx = db.transaction([HISTORY_STORE, MEDIA_STORE], "readwrite");
				run(tx.objectStore(HISTORY_STORE), tx.objectStore(MEDIA_STORE));
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			} catch {
				resolve();
			}
		});
	});
}

export function createIdbHistory(): HistoryBackend {
	return {
		isPersistent: () => typeof globalThis.indexedDB !== "undefined",
		async loadAll(): Promise<HistoryItem[]> {
			const db = await database();
			if (!db) return [];
			const tx = db.transaction(HISTORY_STORE, "readonly");
			const raw: unknown = await onRequest(tx.objectStore(HISTORY_STORE).getAll());
			if (!Array.isArray(raw)) return [];
			const out: HistoryItem[] = [];
			for (const entry of raw) {
				if (isHistoryItem(entry)) {
					entry.persisted = true;
					out.push(entry);
				}
			}
			return out;
		},
		async save(item: HistoryItem, videoBlob: Blob): Promise<void> {
			await runWrite((history, media) => {
				void history.put(item);
				void media.put(videoBlob, item.id);
			});
		},
		async remove(id: string): Promise<void> {
			await runWrite((history, media) => {
				void history.delete(id);
				void media.delete(id);
			});
		},
		async clear(): Promise<void> {
			await runWrite((history, media) => {
				void history.clear();
				void media.clear();
			});
		},
		async loadVideoBlob(id: string): Promise<Blob | null> {
			const db = await database();
			if (!db) return null;
			const tx = db.transaction(MEDIA_STORE, "readonly");
			const raw: unknown = await onRequest(tx.objectStore(MEDIA_STORE).get(id));
			if (raw instanceof Blob) return raw;
			return null;
		},
	};
}

/**
 * IndexedDB-backed queue persistence.
 * The whole queue array is stored as one record under QUEUE_KEY within the "queue" object store.
 * Every operation degrades to a no-op when IndexedDB is unavailable (private browsing, security policy),
 * leaving the queue session-only, mirroring history's graceful degradation.
 * This module never rejects; callers treat it as best-effort.
 */
export function createIdbQueue(): QueueBackend {
	return {
		async load(): Promise<QueueItem[]> {
			const db = await database();
			if (!db) return [];
			const tx = db.transaction(QUEUE_STORE, "readonly");
			const raw: unknown = await onRequest(tx.objectStore(QUEUE_STORE).get(QUEUE_KEY));
			if (!Array.isArray(raw)) return [];
			return raw.filter(isQueueItem);
		},
		async save(items: QueueItem[]): Promise<void> {
			const db = await database();
			if (!db) return;
			await new Promise<void>((resolve) => {
				try {
					const tx = db.transaction(QUEUE_STORE, "readwrite");
					const store = tx.objectStore(QUEUE_STORE);
					if (items.length === 0) {
						store.delete(QUEUE_KEY);
					} else {
						store.put(items, QUEUE_KEY);
					}
					tx.oncomplete = () => resolve();
					tx.onerror = () => resolve();
					tx.onabort = () => resolve();
				} catch {
					resolve();
				}
			});
		},
	};
}
