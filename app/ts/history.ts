// History store.
//
// History is kept in memory (the source of truth) and, when a persistent storage backend is available, best-effort persisted to it.
// The backend is async and interchangeable; the browser uses an IndexedDB backend (see idb.ts) whose quota is large enough for full video payloads.
// If persistence is unavailable (private browsing) or a write fails, items are kept in memory only (`persisted === false`).
// This module never throws to the rest of the app.
//
// This module also owns the queue persistence backend contract and the storage-usage estimator.

import { fileKey, fileKeyPrefix, thumbnailKey, videoKey } from "./media.js";
import type { HistoryItem, QueueItem, QueueStatus, ZipMode } from "./types.js";

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

// Soft cap on in-memory items (each holds a full video) so an extended session cannot grow memory without bound.
// Eviction drops items from the resident list only; the persisted archive is never pruned by this cap.
const MAX_IN_MEMORY = 100;

const QUEUE_STATUSES: QueueStatus[] = ["queued", "submitting", "generating", "completed", "failed", "cancelled"];
const ZIP_MODES = ["prompt", "start-end", "refs"];

function isZipMode(value: string): value is ZipMode {
	return ZIP_MODES.includes(value);
}

function isFiniteNumber(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n);
}

export function isQueueItem(value: unknown): value is QueueItem {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || !("status" in value) || !("prompt" in value)) return false;
	if (typeof value.id !== "string") return false;
	if (typeof value.status !== "string" || !QUEUE_STATUSES.includes(value.status as QueueStatus)) return false;
	if (typeof value.prompt !== "string") return false;
	if (!("width" in value) || !("height" in value) || !("jobFrames" in value) || !("steps" in value)) return false;
	// The dimension/step fields feed the request form and generation math; the app's own form only allows
	// width/height/steps/jobFrames of at least 1, so a non-finite, negative, or zero value is malformed and must be rejected.
	if (!isFiniteNumber(value.width) || value.width <= 0) return false;
	if (!isFiniteNumber(value.height) || value.height <= 0) return false;
	if (!isFiniteNumber(value.jobFrames) || value.jobFrames <= 0) return false;
	if (!isFiniteNumber(value.steps) || value.steps <= 0) return false;
	if (!("files" in value) || !Array.isArray(value.files)) return false;
	if (value.files.some((f) => typeof f !== "object" || f === null || !("name" in f) || !("dataUrl" in f) || typeof f.name !== "string" || typeof f.dataUrl !== "string")) return false;
	if (!("serverId" in value) || (value.serverId !== null && typeof value.serverId !== "string")) return false;
	if (!("startedAt" in value) || (value.startedAt !== null && !isFiniteNumber(value.startedAt))) return false;
	if (!("error" in value) || (value.error !== null && typeof value.error !== "string")) return false;
	if (!("mode" in value) || typeof value.mode !== "string" || !isZipMode(value.mode)) return false;
	if (!("zipName" in value) || (value.zipName !== null && typeof value.zipName !== "string")) return false;
	return true;
}

export function isHistoryItem(value: unknown): value is HistoryItem {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || !("createdAt" in value) || !("thumbnailKey" in value) || !("thumbBytes" in value) || !("video" in value)) return false;
	if (typeof value.id !== "string" || typeof value.createdAt !== "number" || typeof value.thumbnailKey !== "string" || typeof value.thumbBytes !== "number") return false;
	// The dimension/frame/timing fields feed ${width}×${height} and duration rendering; a missing or
	// non-finite value would render as undefined, so reject the record outright like isQueueItem's rigor.
	if (!("width" in value) || !("height" in value) || !("frameCount" in value) || !("fps" in value) || !("elapsedMs" in value) || !("startedAt" in value) || !("completedAt" in value)) return false;
	if (!isFiniteNumber(value.width) || !isFiniteNumber(value.height) || !isFiniteNumber(value.frameCount) || !isFiniteNumber(value.fps) || !isFiniteNumber(value.elapsedMs) || !isFiniteNumber(value.startedAt) || !isFiniteNumber(value.completedAt)) return false;
	const video = value.video;
	if (typeof video !== "object" || video === null) return false;
	if (!("mime" in video) || !("format" in video) || !("byteSize" in video)) return false;
	if (typeof video.mime !== "string" || typeof video.format !== "string" || typeof video.byteSize !== "number") return false;
	if (!("zipName" in value) || (value.zipName !== null && typeof value.zipName !== "string")) return false;
	if (!("files" in value) || !Array.isArray(value.files)) return false;
	if (value.files.some((f) => typeof f !== "object" || f === null || !("name" in f) || !("key" in f) || !("bytes" in f) || typeof f.name !== "string" || typeof f.key !== "string" || typeof f.bytes !== "number")) return false;
	return true;
}

export interface HistoryBackend {
	/** Sync hint about whether durable storage is available at all. */
	isPersistent(): boolean;
	/** Return every persisted item, or an empty array on any failure. */
	loadAll(): Promise<HistoryItem[]>;
	save(item: HistoryItem, videoBlob: Blob): Promise<void>;
	/** Persist a single media Blob (thumbnail or input file) under its media-store key. */
	storeMedia(key: string, blob: Blob): Promise<void>;
	/** Update only an item's `viewed` field on the history object store key, not the whole record. */
	setViewed(id: string, viewed: boolean): Promise<void>;
	remove(id: string): Promise<void>;
	clear(): Promise<void>;
	loadMedia(key: string): Promise<Blob | null>;
}

export interface HistoryStore {
	items(): HistoryItem[];
	add(item: HistoryItem, media: { video: Blob; thumbnail: Blob; files: Blob[] }): void;
	/** Mark an item viewed (persist best-effort); a no-op when it is already viewed. */
	markViewed(id: string): void;
	remove(id: string): void;
	removeOldest(count: number): void;
	clear(): void;
	isPersistent(): boolean;
	loadVideo(id: string): Promise<Blob | null>;
	loadThumbnail(id: string): Promise<Blob | null>;
	/**
	 * Load a persisted file Blob by its recorded media-store key (the authoritative index, from `file.key`).
	 * The key is authoritative: it does not re-derive the key from a renumbered array position, so it cannot
	 * miss a blob when a record's file keys are not contiguous with its array indexes (e.g. after a legacy migration).
	 */
	loadFileByKey(key: string): Promise<Blob | null>;
	/** Hydrate persisted history into memory; resolves when items() reflects the backend. */
	load(): Promise<void>;
}

export function createHistoryStore(backend: HistoryBackend | null, onEvictItem?: (id: string) => void): HistoryStore {
	const items: HistoryItem[] = [];
	// In-memory byte cache keyed by media-store key.
	// It backs the non-persistent path (private browsing / failed writes must still show images) and
	// serves repeated reads of the same key without a second backend hit while the session is alive.
	const mediaCache = new Map<string, Blob | null>();

	const cacheMedia = (key: string, blob: Blob | null): void => {
		mediaCache.set(key, blob);
	};

	const loadMedia = async (key: string): Promise<Blob | null> => {
		if (mediaCache.has(key)) return mediaCache.get(key) ?? null;
		if (!backend) return null;
		const blob = await backend.loadMedia(key);
		mediaCache.set(key, blob);
		return blob;
	};

	const evictItemMedia = (id: string): void => {
		mediaCache.delete(videoKey(id));
		mediaCache.delete(thumbnailKey(id));
		// Drop every cached file key by its shared prefix so legacy non-contiguous keys are evicted as well.
		for (const key of mediaCache.keys()) {
			if (key.startsWith(fileKeyPrefix(id))) mediaCache.delete(key);
		}
	};

	let loadPromise: Promise<void> | null = null;

	async function persistItem(item: HistoryItem, videoBlob: Blob, thumbnailBlob: Blob, fileBlobs: Blob[]): Promise<void> {
		if (!backend) return;
		try {
			await backend.save(item, videoBlob);
			item.persisted = true;
		} catch {
			// Best-effort: a failed write leaves the item session-only rather than missing from the running list.
			item.persisted = false;
			return;
		}
		try {
			await backend.storeMedia(thumbnailKey(item.id), thumbnailBlob);
			for (let i = 0; i < fileBlobs.length; i++) {
				const blob = fileBlobs[i];
				if (blob) await backend.storeMedia(fileKey(item.id, i), blob);
			}
		} catch {
			// A failed media write is also best-effort; the record still persists and media degrades to a placeholder.
		}
	}

	// Bounds in-memory cardinality, not byte size directly: it caps the item COUNT (MAX_IN_MEMORY) so an extended session cannot grow memory without bound.
	// Eviction never touches the backend: the persisted archive stays intact so a refresh (via load()) restores everything.
	// Evicting an item also releases its cached media Blobs (full-size inputs + videos), and dropping the oldest items is what keeps the resident byte cache bounded.
	function trimMemory(): void {
		const excess = items.length - MAX_IN_MEMORY;
		if (excess <= 0) return;
		const evicted = items.slice(0, excess);
		for (const item of evicted) {
			evictItemMedia(item.id);
			// Surface the eviction so a caller can release the store "resident" object URL / Blob
			// when the item currently shown full-size leaves memory (otherwise it leaks for the session).
			onEvictItem?.(item.id);
		}
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
							// Legacy persisted items predate the `viewed` flag; treat them as already seen.
							item.viewed = item.viewed === false ? false : true;
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
		add(item: HistoryItem, media: { video: Blob; thumbnail: Blob; files: Blob[] }): void {
			items.push(item);
			item.persisted = false;
			cacheMedia(videoKey(item.id), media.video);
			cacheMedia(thumbnailKey(item.id), media.thumbnail);
			for (let i = 0; i < media.files.length; i++) {
				const blob = media.files[i];
				if (blob) cacheMedia(fileKey(item.id, i), blob);
			}
			void persistItem(item, media.video, media.thumbnail, media.files);
			trimMemory();
		},
		loadVideo(id: string): Promise<Blob | null> {
			return loadMedia(videoKey(id));
		},
		loadThumbnail(id: string): Promise<Blob | null> {
			return loadMedia(thumbnailKey(id));
		},
		loadFileByKey(key: string): Promise<Blob | null> {
			return loadMedia(key);
		},
		markViewed(id: string): void {
			const item = items.find((i) => i.id === id);
			if (!item || item.viewed) return;
			item.viewed = true;
			if (backend) {
				backend.setViewed(id, true).catch(() => {
					// Best-effort: only the persisted flag may be stale; the running list is already updated.
				});
			}
		},
		remove(id: string): void {
			const idx = items.findIndex((i) => i.id === id);
			if (idx < 0) return;
			items.splice(idx, 1);
			evictItemMedia(id);
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
			mediaCache.clear();
			if (backend) {
				backend.clear().catch(() => {
					// ignore
				});
			}
		},
	};
}

export interface QueueBackend {
	/** Return every persisted item, or an empty array on any failure. */
	load(): Promise<QueueItem[]>;
	/** Best-effort persist the whole queue; never throws. */
	save(items: QueueItem[]): Promise<void>;
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
