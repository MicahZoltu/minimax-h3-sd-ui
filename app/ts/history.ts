// History store.
//
// History is kept in memory (the source of truth) and, when a persistent storage backend is available, best-effort persisted to it.
// The backend is async and interchangeable; the browser uses an IndexedDB backend (see idb.ts) whose quota is large enough for full video payloads.
// If persistence is unavailable (private browsing) or a write fails, items are kept in memory only (`persisted === false`).
// This module never throws to the rest of the app.
//
// This module also owns the queue persistence (a small JSON payload in localStorage) and the storage-usage estimator.

import type { HistoryItem, QueueItem, QueueStatus } from "./types.js";

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

const QUEUE_KEY = "sdcpp.video.queue";
// Soft cap on in-memory items (each holds a full video) so an extended session cannot grow memory without bound.
// Eviction drops items from the resident list only; the persisted archive is never pruned by this cap.
const MAX_IN_MEMORY = 100;

const QUEUE_STATUSES: QueueStatus[] = ["queued", "submitting", "generating", "completed", "failed", "cancelled"];

function isQueueItem(value: unknown): value is QueueItem {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || !("status" in value) || !("prompt" in value)) return false;
	if (typeof value.id !== "string") return false;
	if (typeof value.status !== "string" || !QUEUE_STATUSES.includes(value.status as QueueStatus)) return false;
	if (typeof value.prompt !== "string") return false;
	if (!("width" in value) || !("height" in value) || !("jobFrames" in value) || !("steps" in value)) return false;
	if (typeof value.width !== "number" || typeof value.height !== "number") return false;
	if (typeof value.jobFrames !== "number" || typeof value.steps !== "number") return false;
	if (!("files" in value) || !Array.isArray(value.files)) return false;
	if (value.files.some((f) => typeof f !== "object" || f === null || !("name" in f) || !("dataUrl" in f) || typeof f.name !== "string" || typeof f.dataUrl !== "string")) return false;
	if (!("serverId" in value) || (value.serverId !== null && typeof value.serverId !== "string")) return false;
	if (!("startedAt" in value) || (value.startedAt !== null && typeof value.startedAt !== "number")) return false;
	if (!("error" in value) || (value.error !== null && typeof value.error !== "string")) return false;
	if (!("mode" in value) || typeof value.mode !== "string") return false;
	if (!("zipName" in value) || (value.zipName !== null && typeof value.zipName !== "string")) return false;
	return true;
}

export function isHistoryItem(value: unknown): value is HistoryItem {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || !("createdAt" in value) || !("thumbnail" in value) || !("video" in value)) return false;
	if (typeof value.id !== "string" || typeof value.createdAt !== "number" || typeof value.thumbnail !== "string") return false;
	const video = value.video;
	if (typeof video !== "object" || video === null) return false;
	if (!("mime" in video) || !("format" in video) || !("byteSize" in video)) return false;
	return typeof video.mime === "string" && typeof video.format === "string" && typeof video.byteSize === "number" && ("zipName" in value) && (value.zipName === null || typeof value.zipName === "string");
}

export interface HistoryBackend {
	/** Sync hint about whether durable storage is available at all. */
	isPersistent(): boolean;
	/** Return every persisted item, or an empty array on any failure. */
	loadAll(): Promise<HistoryItem[]>;
	save(item: HistoryItem, videoBlob: Blob): Promise<void>;
	remove(id: string): Promise<void>;
	clear(): Promise<void>;
	loadVideoBlob(id: string): Promise<Blob | null>;
}

export interface HistoryStore {
	items(): HistoryItem[];
	add(item: HistoryItem, videoBlob: Blob): void;
	remove(id: string): void;
	removeOldest(count: number): void;
	clear(): void;
	isPersistent(): boolean;
	loadVideoBlob(id: string): Promise<Blob | null>;
	/** Hydrate persisted history into memory; resolves when items() reflects the backend. */
	load(): Promise<void>;
}

export function createHistoryStore(backend: HistoryBackend | null): HistoryStore {
	const items: HistoryItem[] = [];
	let loadPromise: Promise<void> | null = null;

	async function persistItem(item: HistoryItem, videoBlob: Blob): Promise<void> {
		if (!backend) return;
		try {
			await backend.save(item, videoBlob);
			item.persisted = true;
		} catch {
			// Best-effort: a failed write leaves the item session-only rather than missing from the running list.
			item.persisted = false;
		}
	}

	// Bound in-memory growth only; drop the oldest items from the resident list so an extended session cannot grow memory without bound.
	// Eviction never touches the backend: the persisted archive stays intact so a refresh (via load()) restores everything.
	function trimMemory(): void {
		const excess = items.length - MAX_IN_MEMORY;
		if (excess <= 0) return;
		items.splice(0, excess);
	}

	return {
		items: () => items,
		isPersistent: () => (backend ? backend.isPersistent() : false),
		load: () => {
			if (!loadPromise) {
				loadPromise = (async () => {
					if (!backend) return;
					try {
						const remote = await backend.loadAll();
						const seen = new Set(items.map((i) => i.id));
						for (const item of remote) {
							item.persisted = true;
							if (!seen.has(item.id)) items.push(item);
						}
						items.sort((a, b) => a.createdAt - b.createdAt);
					} catch {
						// Keep whatever is already in memory; a failed load is never fatal.
					}
				})();
			}
			return loadPromise;
		},
		add(item: HistoryItem, videoBlob: Blob): void {
			items.push(item);
			item.persisted = false;
			void persistItem(item, videoBlob);
			trimMemory();
		},
		loadVideoBlob(id: string): Promise<Blob | null> {
			if (!backend) return Promise.resolve(null);
			return backend.loadVideoBlob(id);
		},
		remove(id: string): void {
			const idx = items.findIndex((i) => i.id === id);
			if (idx < 0) return;
			items.splice(idx, 1);
			if (backend) {
				backend.remove(id).catch(() => {
					// ignore
				});
			}
		},
		removeOldest(count: number): void {
			const n = Number.isFinite(count) ? Math.floor(count) : 0;
			if (n <= 0) return;
			const oldest = [...items].sort((a, b) => a.createdAt - b.createdAt).slice(0, n);
			for (const it of oldest) this.remove(it.id);
		},
		clear(): void {
			items.length = 0;
			if (backend) {
				backend.clear().catch(() => {
					// ignore
				});
			}
		},
	};
}

export interface QueuePersistence {
	load(): QueueItem[];
	save(queue: QueueItem[]): void;
}

/**
 * Persist the entire generation queue under one key so queued and in-progress (generating/submitting) items survive a page refresh.
 * The queue holds input file data URLs but no video bytes, so a single writes stays comfortably within storage quota.
 * When storage is unavailable the queue is session-only, mirroring history's degrade-to-memory behaviour.
 */
export function createQueuePersistence(storage: SyncStorage | null): QueuePersistence {
	if (!storage) {
		return {
			load: () => [],
			save: () => {
				// No backend: nothing to write.
			},
		};
	}
	return {
		load(): QueueItem[] {
			try {
				const raw = storage.getItem(QUEUE_KEY);
				if (!raw) return [];
				const parsed: unknown = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				return parsed.filter(isQueueItem);
			} catch {
				return [];
			}
		},
		save(queue: QueueItem[]): void {
			try {
				if (queue.length > 0) {
					storage.setItem(QUEUE_KEY, JSON.stringify(queue));
				} else {
					storage.removeItem(QUEUE_KEY);
				}
			} catch {
				// A failed write (quota, security) should never break generation; the queue is simply not persisted.
			}
		},
	};
}

export interface StorageEstimate {
	usage: number;
	quota: number;
}

/**
 * Estimate aggregate storage usage against quota, preferring the browser's StorageManager and falling back to an approximate localStorage byte count.
 * Returns null when neither is available (e.g. no persistent storage).
 */
export async function estimateStorage(): Promise<StorageEstimate | null> {
	try {
		const nav = globalThis.navigator;
		if (nav && typeof nav.storage?.estimate === "function") {
			const e = await nav.storage.estimate();
			if (typeof e.usage === "number" && typeof e.quota === "number") {
				return { usage: e.usage, quota: e.quota };
			}
		}
	} catch {
		// Fall through to the localStorage approximation.
	}
	const storage = detectSyncStorage();
	if (!storage) return null;
	try {
		let usage = 0;
		for (const key of storage.keys()) {
			const value = storage.getItem(key);
			usage += (key.length + (value?.length ?? 0)) * 2;
		}
		// Nominal per-origin quota when the browser exposes no real figure.
		return { usage, quota: 5 * 1024 * 1024 };
	} catch {
		return null;
	}
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
