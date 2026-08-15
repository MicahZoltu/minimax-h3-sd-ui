// IndexedDB history backend.
//
// localStorage cannot hold generated video data (a single webm routinely exceeds its ~5 MB per-origin cap), which is why completed history used to vanish on refresh.
// IndexedDB has real, generous per-origin quota, so completed videos and their source files persist there reliably.
// Every operation degrades to a no-op when IndexedDB is unavailable (private browsing, security policy), leaving history session-only.
// This module never rejects; callers treat it as best-effort.

import { isHistoryItem, type HistoryBackend } from "./history.js";
import type { HistoryItem } from "./types.js";

const DB_NAME = "sdcpp.video";
const DB_VERSION = 1;
const STORE = "history";

function database(): Promise<IDBDatabase | null> {
	if (typeof globalThis.indexedDB === "undefined") return Promise.resolve(null);
	const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
	return new Promise((resolve) => {
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) {
				db.createObjectStore(STORE, { keyPath: "id" });
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

function runWrite(run: (store: IDBObjectStore) => void): Promise<void> {
	return database().then((db) => {
		if (!db) return Promise.resolve();
		return new Promise<void>((resolve) => {
			try {
				const tx = db.transaction(STORE, "readwrite");
				run(tx.objectStore(STORE));
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
			const tx = db.transaction(STORE, "readonly");
			const raw: unknown = await onRequest(tx.objectStore(STORE).getAll());
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
		async save(item: HistoryItem): Promise<void> {
			await runWrite((store) => void store.put(item));
		},
		async remove(id: string): Promise<void> {
			await runWrite((store) => void store.delete(id));
		},
		async clear(): Promise<void> {
			await runWrite((store) => void store.clear());
		},
	};
}
