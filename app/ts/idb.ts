// IndexedDB history backend.
//
// localStorage cannot hold generated video data (a single webm routinely exceeds its ~5 MB per-origin cap), which is why completed history used to vanish on refresh.
// IndexedDB has real, generous per-origin quota, so completed videos and their source files persist there reliably.
// Every operation degrades to a no-op when IndexedDB is unavailable (private browsing, security policy), leaving history session-only.
// This module never rejects; callers treat it as best-effort.

import { isHistoryItem, isQueueItem, type HistoryBackend, type HistoryRecordMeta, type QueueBackend } from "./history.js";
import { thumbnailKey, videoKey } from "./media.js";
import { predatesCutoff } from "./storageDate.js";
import type { HistoryItem, QueueItem } from "./types.js";

const DB_NAME = "sdcpp.video";
// The version must never drop below the highest version users' databases were ever opened at.
// IndexedDB refuses to open an existing database at a lower version (VersionError), which would hide all history.
// Users' databases are already at version 4, so it stays 4 forever; the `oldVersion < 3` branch still creates the stores for brand-new databases.
const DB_VERSION = 4;
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
		request.onupgradeneeded = (event) => {
			const db = request.result;
			if (event.oldVersion < 3) {
				if (!db.objectStoreNames.contains(HISTORY_STORE)) {
					db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
				}
				if (!db.objectStoreNames.contains(MEDIA_STORE)) {
					// No keyPath: media values are raw binary Blobs, keyed explicitly via put(blob, id).
					db.createObjectStore(MEDIA_STORE);
				}
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

function setViewed(id: string, viewed: boolean): Promise<void> {
	return database().then((db) => {
		if (!db) return Promise.resolve();
		return new Promise<void>((resolve) => {
			try {
				const tx = db.transaction(HISTORY_STORE, "readwrite");
				const store = tx.objectStore(HISTORY_STORE);
				const readReq = store.get(id);
				readReq.onsuccess = () => {
					const record = readReq.result;
					if (record !== null && typeof record === "object") {
						const next = { ...(record as Record<string, unknown>), viewed };
						store.put(next);
					}
				};
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			} catch {
				resolve();
			}
		});
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

// The single per-id removal routine: the record plus its video, thumbnail, and every `<id>:`-prefixed media key (files and reference-video/audio payloads alike) die in one readwrite transaction.
// Both remove(id) and removeBefore(cutoffMs) delete through this function, so the media cleanup can never diverge between the two paths.
function removeRecord(id: string): Promise<void> {
	return runWrite((history, media) => {
		// Every media key belonging to the id shares the `<id>:` prefix (keys are either exactly `<id>` or `<id>:…`), which this method does not know by count, so a bound range cursor deletes all of them for the id in the same transaction as the rest.
		// The colon delimiter keeps another item's keys out of the range: a distinct id is never a `<id>:`-prefixed continuation of this one.
		const range = IDBKeyRange.bound(`${id}:`, `${id}:\uFFFF`);
		const cursorReq = media.openCursor(range);
		cursorReq.onsuccess = () => {
			const cursor = cursorReq.result;
			if (!cursor) return;
			cursor.delete();
			cursor.continue();
		};
		void history.delete(id);
		void media.delete(videoKey(id));
		void media.delete(thumbnailKey(id));
	});
}

// Guard for a raw (unvalidated) IndexedDB record so its createdAt field can be read without a type assertion.
function isRecordWithCreatedAt(value: unknown): value is { createdAt: unknown } {
	return typeof value === "object" && value !== null && "createdAt" in value;
}

// An n-tail deletion orders records by createdAt, so a record whose createdAt is not a finite number is invisible to it (mirroring predatesCutoff's fail-safe).
function hasFiniteCreatedAt(value: { createdAt: unknown }): value is { createdAt: number } {
	return typeof value.createdAt === "number" && Number.isFinite(value.createdAt);
}

// Cursor-collect every persisted record's `{ id, createdAt }` meta so the store can order the whole archive (not just its resident window) for the n-oldest deletion and its count.
async function collectArchiveMeta(): Promise<HistoryRecordMeta[]> {
	const db = await database();
	if (!db) return [];
	const tx = db.transaction(HISTORY_STORE, "readonly");
	const metas: HistoryRecordMeta[] = [];
	await new Promise<void>((resolve) => {
		try {
			const cursorReq = tx.objectStore(HISTORY_STORE).openCursor();
			cursorReq.onsuccess = () => {
				const cursor = cursorReq.result;
				if (!cursor) {
					resolve();
					return;
				}
				const record: unknown = cursor.value;
				const id = cursor.primaryKey;
				if (isRecordWithCreatedAt(record) && hasFiniteCreatedAt(record) && typeof id === "string") metas.push({ id, createdAt: record.createdAt });
				cursor.continue();
			};
			cursorReq.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
	return metas;
}

// Cursor-collect the ids of the persisted records matching the shared date predicate.
async function collectIdsBefore(cutoffMs: number): Promise<string[]> {
	const db = await database();
	if (!db) return [];
	const tx = db.transaction(HISTORY_STORE, "readonly");
	const ids: string[] = [];
	await new Promise<void>((resolve) => {
		try {
			const cursorReq = tx.objectStore(HISTORY_STORE).openCursor();
			cursorReq.onsuccess = () => {
				const cursor = cursorReq.result;
				if (!cursor) {
					resolve();
					return;
				}
				const record: unknown = cursor.value;
				if (isRecordWithCreatedAt(record) && predatesCutoff(record.createdAt, cutoffMs)) {
					const id = cursor.primaryKey;
					if (typeof id === "string") ids.push(id);
				}
				cursor.continue();
			};
			cursorReq.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
	return ids;
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
				void media.put(videoBlob, videoKey(item.id));
			});
		},
		setViewed,
		remove: removeRecord,
		listArchiveMeta: collectArchiveMeta,
		async countBefore(cutoffMs: number): Promise<number> {
			const db = await database();
			if (!db) return 0;
			const tx = db.transaction(HISTORY_STORE, "readonly");
			return await new Promise<number>((resolve) => {
				try {
					let count = 0;
					const cursorReq = tx.objectStore(HISTORY_STORE).openCursor();
					cursorReq.onsuccess = () => {
						const cursor = cursorReq.result;
						if (!cursor) {
							resolve(count);
							return;
						}
						const record: unknown = cursor.value;
						if (isRecordWithCreatedAt(record) && predatesCutoff(record.createdAt, cutoffMs)) count += 1;
						cursor.continue();
					};
					cursorReq.onerror = () => resolve(count);
				} catch {
					resolve(0);
				}
			});
		},
		async removeBefore(cutoffMs: number): Promise<void> {
			// Collect the matching ids first, then delete each through the exact per-id routine, so the media cleanup is identical to remove(id).
			const ids = await collectIdsBefore(cutoffMs);
			for (const id of ids) await removeRecord(id);
		},
		async clear(): Promise<void> {
			await runWrite((history, media) => {
				void history.clear();
				void media.clear();
			});
		},
		async loadMedia(key: string): Promise<Blob | null> {
			const db = await database();
			if (!db) return null;
			const tx = db.transaction(MEDIA_STORE, "readonly");
			const raw: unknown = await onRequest(tx.objectStore(MEDIA_STORE).get(key));
			if (raw instanceof Blob) return raw;
			return null;
		},
		async storeMedia(key: string, blob: Blob): Promise<void> {
			const db = await database();
			if (!db) return;
			await new Promise<void>((resolve) => {
				try {
					const tx = db.transaction(MEDIA_STORE, "readwrite");
					tx.objectStore(MEDIA_STORE).put(blob, key);
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
