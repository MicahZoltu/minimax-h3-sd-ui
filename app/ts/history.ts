// History store.
//
// History is kept in memory (the source of truth) and, when a persistent storage backend is available, best-effort persisted to it.
// If persistence is unavailable (private browsing) or a payload exceeds storage quota, items are kept in memory only (`persisted === false`).
// This module never throws to the rest of the app.

import type { HistoryItem } from "./types.js";

export interface SyncStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	/**
	 * All keys currently stored.
	 * Must include every stored item key.
	 */
	keys(): string[];
}

const ITEM_PREFIX = "sdcpp.video.history.item.";
const MAX_PERSISTED = 10;
// Soft cap on in-memory items (each holds a full video) so an extended session cannot grow memory without bound.
// Persisted items are dropped first.
const MAX_IN_MEMORY = 100;

function isHistoryItem(value: unknown): value is HistoryItem {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || !("createdAt" in value) || !("video" in value)) return false;
	if (typeof value.id !== "string" || typeof value.createdAt !== "number") return false;
	const video = value.video;
	if (typeof video !== "object" || video === null) return false;
	if (!("b64" in video) || !("mime" in video) || !("format" in video)) return false;
	return typeof video.b64 === "string" && typeof video.mime === "string" && typeof video.format === "string";
}

function readItem(storage: SyncStorage, id: string): HistoryItem | null {
	try {
		const raw = storage.getItem(ITEM_PREFIX + id);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!isHistoryItem(parsed)) {
			return null;
		}
		parsed.persisted = true;
		return parsed;
	} catch {
		return null;
	}
}

export interface HistoryStore {
	items(): HistoryItem[];
	add(item: HistoryItem): void;
	remove(id: string): void;
	isPersistent(): boolean;
}

export function createHistoryStore(storage: SyncStorage | null): HistoryStore {
	const items: HistoryItem[] = [];

	// Load anything already persisted at construction time (scan, no index).
	if (storage) {
		let storedIds: string[] = [];
		try {
			storedIds = storage.keys().filter((k) => k.startsWith(ITEM_PREFIX)).map((k) => k.slice(ITEM_PREFIX.length));
		} catch {
			storedIds = [];
		}
		const loaded: HistoryItem[] = [];
		for (const id of storedIds) {
			const item = readItem(storage, id);
			if (item) loaded.push(item);
		}
		loaded.sort((a, b) => a.createdAt - b.createdAt);
		items.push(...loaded);
	}

	const persistedCount = () => items.filter((i) => i.persisted).length;

	function evictOldestPersisted(): void {
		if (!storage) return;
		const victim = items.filter((i) => i.persisted).sort((a, b) => a.createdAt - b.createdAt)[0];
		if (!victim) return;
		try {
			storage.removeItem(ITEM_PREFIX + victim.id);
		} catch {
			// ignore
		}
		victim.persisted = false;
	}

	function persistNew(item: HistoryItem): void {
		if (!storage) return;
		const key = ITEM_PREFIX + item.id;
		const payload = JSON.stringify(item);
		const tryWrite = (): boolean => {
			try {
				storage.setItem(key, payload);
				return true;
			} catch {
				// Any failure (quota, security, disk) falls back to in-memory so we never claim an item was persisted when it was not.
				return false;
			}
		};
		let ok = tryWrite();
		if (!ok) {
			// Quota pressure: drop the oldest persisted items until it fits.
			while (!ok && persistedCount() > 0) {
				evictOldestPersisted();
				ok = tryWrite();
			}
		}
		if (!ok) {
			// Still cannot fit even with history cleared: keep in memory only.
			return;
		}
		// Never persist more than a bounded number of recent items.
		while (persistedCount() >= MAX_PERSISTED) {
			evictOldestPersisted();
		}
		item.persisted = true;
	}

	return {
		items: () => items,
		isPersistent: () => storage !== null,
		add(item: HistoryItem): void {
			items.push(item);
			item.persisted = false;
			persistNew(item);
			// Bound in-memory growth; drop the oldest items over the cap.
			const excess = items.length - MAX_IN_MEMORY;
			if (excess > 0) {
				const removed = items.splice(0, excess);
				for (const it of removed) {
					if (it.persisted && storage) {
						try {
							storage.removeItem(ITEM_PREFIX + it.id);
						} catch {
							// ignore
						}
					}
				}
			}
		},
		remove(id: string): void {
			const idx = items.findIndex((i) => i.id === id);
			if (idx < 0) return;
			if (storage) {
				try {
					storage.removeItem(ITEM_PREFIX + id);
				} catch {
					// ignore
				}
			}
			items.splice(idx, 1);
		},
	};
}

/**
 * Detect whether the browser provides working persistent storage and return a minimal wrapper, or null so the store degrades to in-memory only.
 */
export function detectSyncStorage(): SyncStorage | null {
	try {
		const ls = globalThis.localStorage;
		const probe = "__sdcpp_storage_probe__";
		ls.setItem(probe, "1");
		ls.removeItem(probe);
		const keys = () => {
			const out: string[] = [];
			for (let i = 0; i < ls.length; i++) {
				const key = ls.key(i);
				if (key != null) out.push(key);
			}
			return out;
		};
		return {
			getItem: (k) => ls.getItem(k),
			setItem: (k, v) => ls.setItem(k, v),
			removeItem: (k) => ls.removeItem(k),
			keys,
		};
	} catch {
		return null;
	}
}
