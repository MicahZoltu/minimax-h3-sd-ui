// History store.
//
// History is kept in memory (the source of truth) and, when a persistent storage backend is available, best-effort persisted to it.
// The backend is async and interchangeable; the browser uses an IndexedDB backend (see idb.ts) whose quota is large enough for full video payloads.
// If persistence is unavailable (private browsing) or a write fails, items are kept in memory only (`persisted === false`).
// This module never throws to the rest of the app.
//
// This module also owns the queue persistence backend contract and the storage-usage estimator.

import { fileKey, refAudioKey, refVideoAudioKey, refVideoSourceKey, refVideoThumbKey, thumbnailKey, videoKey } from "./media.js";
import { dateCutoffCount, predatesCutoff } from "./storageDate.js";
import type { HistoryItem, QueueItem, QueueStatus, RefAudioFile, RefVideoFile, ZipMode } from "./types.js";

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

function isRefVideoFile(value: unknown): value is RefVideoFile {
	if (typeof value !== "object" || value === null) return false;
	if (!("name" in value) || !("fps" in value) || !("frames" in value) || !("audio" in value) || !("sourceDataUrl" in value)) return false;
	if (typeof value.name !== "string") return false;
	if (!isFiniteNumber(value.fps) || value.fps <= 0) return false;
	if (!Array.isArray(value.frames) || value.frames.some((f) => typeof f !== "string")) return false;
	if (value.audio !== null && typeof value.audio !== "string") return false;
	if (typeof value.sourceDataUrl !== "string") return false;
	return true;
}

function isRefAudioFile(value: unknown): value is RefAudioFile {
	if (typeof value !== "object" || value === null) return false;
	if (!("name" in value) || !("dataUrl" in value) || !("sourceDataUrl" in value)) return false;
	return typeof value.name === "string" && typeof value.dataUrl === "string" && typeof value.sourceDataUrl === "string";
}

function isPersistedRefVideo(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (!("name" in value) || !("thumbKey" in value) || !("thumbBytes" in value) || !("audioKey" in value) || !("audioBytes" in value) || !("sourceKey" in value) || !("sourceBytes" in value)) return false;
	if (typeof value.name !== "string" || typeof value.thumbKey !== "string" || !isFiniteNumber(value.thumbBytes)) return false;
	if (value.audioKey !== null && typeof value.audioKey !== "string") return false;
	if (!isFiniteNumber(value.audioBytes)) return false;
	return typeof value.sourceKey === "string" && isFiniteNumber(value.sourceBytes);
}

function isPersistedRefAudio(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	return ("name" in value && typeof value.name === "string") && ("key" in value && typeof value.key === "string") && ("bytes" in value && isFiniteNumber(value.bytes));
}

// Reference-video/audio arrays predate older persisted records; absent fields are treated as empty rather than rejected.
// When present they are validated strictly so a malformed ref cannot ride along into a request.
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
	const refs = value as Record<string, unknown>;
	if (refs["videos"] !== undefined && refs["videos"] !== null && !Array.isArray(refs["videos"])) return false;
	if (Array.isArray(refs["videos"]) && refs["videos"].some((v: unknown) => !isRefVideoFile(v))) return false;
	if (refs["audios"] !== undefined && refs["audios"] !== null && !Array.isArray(refs["audios"])) return false;
	if (Array.isArray(refs["audios"]) && refs["audios"].some((a: unknown) => !isRefAudioFile(a))) return false;
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
	// Reference-video/audio lists predate older records; absent fields are treated as empty rather than rejected.
	if ("videos" in value && value.videos !== null) {
		if (!Array.isArray(value.videos) || value.videos.some((v) => !isPersistedRefVideo(v))) return false;
	}
	if ("audios" in value && value.audios !== null) {
		if (!Array.isArray(value.audios) || value.audios.some((a) => !isPersistedRefAudio(a))) return false;
	}
	return true;
}

/** The Blobs to persist under a completed item's media-store keys. */
export interface HistoryMedia {
	video: Blob;
	thumbnail: Blob;
	files: Blob[];
	/** First-frame preview Blob per reference video. */
	videoThumbs: Blob[];
	/** WAV soundtrack Blob per reference video (null when the video has no soundtrack). */
	videoAudios: (Blob | null)[];
	/** Original container Bytes per reference video. */
	videoSources: Blob[];
	/** Original file Bytes per reference audio clip. */
	audioSources: Blob[];
}

/** The `{ id, createdAt }` pair a backend scan exposes so the store can order the whole archive without loading full items. */
export interface HistoryRecordMeta {
	id: string;
	createdAt: number;
}

export interface HistoryBackend {
	/** Sync hint about whether durable storage is available at all. */
	isPersistent(): boolean;
	/** Return every persisted item, or an empty array on any failure. */
	loadAll(): Promise<HistoryItem[]>;
	/**
	 * Every persisted record's id + createdAt meta, or an empty array on any failure.
	 * The archive-wide ordering surface: it sees past the in-memory cap, so the store can pick the oldest victims across the whole archive.
	 * A record whose createdAt is not a finite number is invisible here (its age is unknown), mirroring predatesCutoff's fail-safe.
	 */
	listArchiveMeta(): Promise<HistoryRecordMeta[]>;
	save(item: HistoryItem, videoBlob: Blob): Promise<void>;
	/** Persist a single media Blob (thumbnail, input file, or reference-video/audio payload) under its media-store key. */
	storeMedia(key: string, blob: Blob): Promise<void>;
	/** Update only an item's `viewed` field on the history object store key, not the whole record. */
	setViewed(id: string, viewed: boolean): Promise<void>;
	remove(id: string): Promise<void>;
	/** Count every persisted record strictly older than the epoch-ms cutoff (the shared predicate; a non-finite createdAt never matches). */
	countBefore(cutoffMs: number): Promise<number>;
	/** Remove every persisted record strictly older than the epoch-ms cutoff along with its media. */
	removeBefore(cutoffMs: number): Promise<void>;
	clear(): Promise<void>;
	loadMedia(key: string): Promise<Blob | null>;
}

export interface HistoryStore {
	items(): HistoryItem[];
	add(item: HistoryItem, media: HistoryMedia): void;
	/** Mark an item viewed (persist best-effort); a no-op when it is already viewed. */
	markViewed(id: string): void;
	remove(id: string): void;
	/**
	 * Delete the `count` oldest items across the ENTIRE persisted archive, not just the residents: the union of every persisted archive record and every resident (deduped by id) is sorted oldest-first and the first `count` ids die.
	 * Residents go through the same remove() path as a manual delete; non-residents go through the backend's per-id removal plus the memory-side media-cache eviction.
	 * An item whose createdAt is not finite is never a candidate (its age is unknown — the same fail-safe predatesCutoff applies to date deletions), so such an item effectively shrinks `count`.
	 * Returns the deleted ids; emits nothing (the state wrapper owns the single `history` emit).
	 */
	removeOldest(count: number): Promise<string[]>;
	/**
	 * Delete every item strictly older than the epoch-ms cutoff, resident and archived alike.
	 * Resident matches go through the same remove() path as a manual delete; the backend sweep covers the evicted (non-resident) tail of the archive.
	 */
	removeBefore(cutoffMs: number): Promise<void>;
	/**
	 * Count exactly what removeBefore would delete: the backend's archive-wide match count plus the resident matches that are absent from the backend.
	 * A resident item is absent from the backend exactly when its save failed (`persisted === false`); the flag flips optimistically before the save resolves, so an in-flight record is never double-counted against the archive copy the same save writes.
	 */
	countBefore(cutoffMs: number): Promise<number>;
	/** Count every item removeOldest can act on: the same archive-wide union, resident and evicted alike. */
	countAll(): Promise<number>;
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
	// Items spliced out by trimMemory's cap eviction, distinct from deleted ones: an evicted item's record stays in the archive, so its media must keep persisting to it.
	const evictedItems = new WeakSet<HistoryItem>();

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
		// Drop every cached media key belonging to this item: the thumbnail, each persisted file key (legacy
		// non-contiguous keys included), and every reference-video/audio key share the `<id>:` prefix.
		for (const key of mediaCache.keys()) {
			if (key.startsWith(`${id}:`)) mediaCache.delete(key);
		}
	};

	let loadPromise: Promise<void> | null = null;

	async function persistItem(item: HistoryItem, media: HistoryMedia): Promise<void> {
		if (!backend) return;
		// An item deleted mid-save must stop writing as soon as it is noticed gone, so a delete never overtakes the save and leaves transient orphan blobs behind.
		// An item merely evicted over the in-memory cap is NOT gone in this sense: its record stays in the archive, so its media must too.
		const gone = (): boolean => !items.includes(item) && !evictedItems.has(item);
		try {
			// The flag flips optimistically BEFORE the backend save resolves, so countBefore never double-counts the in-flight resident (as "non-persisted") against the archive copy its own save is writing.
			item.persisted = true;
			await backend.save(item, media.video);
		} catch {
			// Best-effort: a failed write leaves the item session-only rather than missing from the running list.
			item.persisted = false;
			return;
		}
		if (gone()) return;
		try {
			await backend.storeMedia(thumbnailKey(item.id), media.thumbnail);
			if (gone()) return;
			for (let i = 0; i < media.files.length; i++) {
				const blob = media.files[i];
				if (blob) await backend.storeMedia(fileKey(item.id, i), blob);
				if (gone()) return;
			}
			for (let i = 0; i < media.videoThumbs.length; i++) {
				const thumb = media.videoThumbs[i];
				const audio = media.videoAudios[i];
				const source = media.videoSources[i];
				if (thumb) await backend.storeMedia(refVideoThumbKey(item.id, i), thumb);
				if (gone()) return;
				if (audio) await backend.storeMedia(refVideoAudioKey(item.id, i), audio);
				if (gone()) return;
				if (source) await backend.storeMedia(refVideoSourceKey(item.id, i), source);
				if (gone()) return;
			}
			for (let i = 0; i < media.audioSources.length; i++) {
				const source = media.audioSources[i];
				if (source) await backend.storeMedia(refAudioKey(item.id, i), source);
				if (gone()) return;
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
			evictedItems.add(item);
			evictItemMedia(item.id);
			// Surface the eviction so a caller can release the store "resident" object URL / Blob
			// when the item currently shown full-size leaves memory (otherwise it leaks for the session).
			onEvictItem?.(item.id);
		}
		items.splice(0, excess);
	}

	// Enumerates the item universe every archive-wide n-oldest deletion (and its count) acts on: each persisted archive record plus every resident.
	// A resident cannot be assumed to sit inside the archive scan (its save may be in flight, failed, or degraded to a no-op), so residents join explicitly; an id present on both sides collapses to one entry, so an item is never counted or deleted twice.
	// An item with a non-finite createdAt is excluded: like predatesCutoff's fail-safe, an item of unknown age is never silently consumed by an n-tail deletion.
	async function archiveUnion(): Promise<HistoryRecordMeta[]> {
		const byId = new Map<string, HistoryRecordMeta>();
		if (backend) {
			try {
				for (const meta of await backend.listArchiveMeta()) byId.set(meta.id, meta);
			} catch {
				// A failed scan degrades to the resident view alone; deletion never blocks on it.
			}
		}
		for (const it of items) {
			if (!Number.isFinite(it.createdAt)) continue;
			byId.set(it.id, { id: it.id, createdAt: it.createdAt });
		}
		return [...byId.values()];
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
		add(item: HistoryItem, media: HistoryMedia): void {
			items.push(item);
			item.persisted = false;
			cacheMedia(videoKey(item.id), media.video);
			cacheMedia(thumbnailKey(item.id), media.thumbnail);
			for (let i = 0; i < media.files.length; i++) {
				const blob = media.files[i];
				if (blob) cacheMedia(fileKey(item.id, i), blob);
			}
			for (let i = 0; i < media.videoThumbs.length; i++) {
				const thumb = media.videoThumbs[i];
				const audio = media.videoAudios[i];
				const source = media.videoSources[i];
				if (thumb) cacheMedia(refVideoThumbKey(item.id, i), thumb);
				if (audio) cacheMedia(refVideoAudioKey(item.id, i), audio);
				if (source) cacheMedia(refVideoSourceKey(item.id, i), source);
			}
			for (let i = 0; i < media.audioSources.length; i++) {
				const source = media.audioSources[i];
				if (source) cacheMedia(refAudioKey(item.id, i), source);
			}
			void persistItem(item, media);
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
		async removeOldest(count: number): Promise<string[]> {
			const n = Number.isFinite(count) ? Math.floor(count) : 0;
			if (n <= 0) return [];
			// The union is sorted oldest-first; the first n ids are the victims whether they are residents or evicted archive-only items.
			const union = await archiveUnion();
			union.sort((a, b) => a.createdAt - b.createdAt);
			const victims = union.slice(0, n);
			const residentIds = new Set(items.map((i) => i.id));
			for (const victim of victims) {
				if (residentIds.has(victim.id)) {
					// A resident dies through the exact remove() path so the splice, media eviction, and per-id backend removal all stay correct.
					this.remove(victim.id);
				} else {
					// An evicted (non-resident) victim dies through the backend's per-id removal, and its media blobs are dropped from the memory-side cache so no stale Blob survives.
					evictItemMedia(victim.id);
					if (backend) await backend.remove(victim.id);
				}
			}
			return victims.map((v) => v.id);
		},
		async removeBefore(cutoffMs: number): Promise<void> {
			// Resident matches go through the exact remove() path so media eviction, cache clearing, and the per-id backend removal all stay correct.
			const residentMatches = items.filter((it) => predatesCutoff(it.createdAt, cutoffMs));
			for (const it of residentMatches) this.remove(it.id);
			// The backend sweep covers the evicted (non-resident) tail of the archive; already-removed ids delete idempotently.
			if (backend) await backend.removeBefore(cutoffMs);
		},
		async countBefore(cutoffMs: number): Promise<number> {
			// Only the resident matches that are absent from the backend are added here; the persisted ones are already inside the backend's own count.
			const nonPersistedMatches = dateCutoffCount(items.filter((it) => !it.persisted), cutoffMs);
			if (!backend) return nonPersistedMatches;
			let archiveCount = 0;
			try {
				archiveCount = await backend.countBefore(cutoffMs);
			} catch {
				archiveCount = 0;
			}
			return archiveCount + nonPersistedMatches;
		},
		async countAll(): Promise<number> {
			// Exactly the universe removeOldest draws from, so the delete-oldest control's readout can neither promise more nor less than the deletion delivers.
			return (await archiveUnion()).length;
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
