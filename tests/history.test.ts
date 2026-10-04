import { describe, it, expect } from "bun:test";
import { createHistoryStore, estimateStorage, isHistoryItem, isQueueItem, type HistoryBackend, type HistoryMedia } from "../app/ts/history.js";
import { createIdbHistory, createIdbQueue } from "../app/ts/idb.js";
import { fileKey, refAudioKey, refVideoAudioKey, refVideoSourceKey, refVideoThumbKey, thumbnailKey, videoKey } from "../app/ts/media.js";
import { predatesCutoff } from "../app/ts/storageDate.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { HistoryItem, QueueItem } from "../app/ts/types.js";

function dummyMedia(overrides: Partial<HistoryMedia> = {}): HistoryMedia {
	return { video: new Blob(["v"]), thumbnail: new Blob(["t"]), files: [], videoThumbs: [], videoAudios: [], videoSources: [], audioSources: [], ...overrides };
}

function makeQueueItem(partial: Partial<QueueItem> = {}): QueueItem {
	return {
		id: "q_" + Math.random().toString(36).slice(2),
		status: "queued",
		prompt: "a dog",
		zipName: null,
		mode: "prompt",
		files: [],
		videos: [],
		audios: [],
		width: 640,
		height: 384,
		jobFrames: 49,
		steps: 20,
		error: null,
		serverId: null,
		startedAt: null,
		...partial,
	};
}

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	const id = "h_" + Math.random().toString(36).slice(2);
	return {
		id,
		createdAt: Date.now(),
		prompt: "test",
		zipName: null,
		mode: "prompt",
		files: [],
		videos: [],
		audios: [],
		width: 512,
		height: 512,
		frameCount: 33,
		fps: 24,
		elapsedMs: 1000,
		startedAt: Date.now() - 1000,
		completedAt: Date.now(),
		thumbnailKey: thumbnailKey(id),
		thumbBytes: 0,
		video: { mime: "video/webm", format: "webm", byteSize: 3 },
		persisted: false,
		viewed: false,
		...overrides,
	};
}

type MemoryBackend = HistoryBackend & {
	data(): HistoryItem[];
	media(key: string): Blob | null;
	mediaReadCount(key: string): number;
	setViewedCount(): number;
	saveCount(): number;
	failSaves(ids: string[]): void;
};

function memoryBackend(): MemoryBackend {
	const data: HistoryItem[] = [];
	const mediaMap = new Map<string, Blob>();
	const reads = new Map<string, number>();
	let viewedWrites = 0;
	let saves = 0;
	const failingSaves = new Set<string>();
	return {
		isPersistent: () => true,
		async loadAll(): Promise<HistoryItem[]> {
			return data.map((i) => ({ ...i, persisted: true }));
		},
		async listArchiveMeta() {
			// Mirror the real scan: every record's id + finite createdAt, evicted (non-resident) records included.
			return data.filter((i) => Number.isFinite(i.createdAt)).map((i) => ({ id: i.id, createdAt: i.createdAt }));
		},
		async save(item, videoBlob) {
			saves += 1;
			if (failingSaves.has(item.id)) throw new Error("save failed");
			data.push(item);
			mediaMap.set(videoKey(item.id), videoBlob);
		},
		async storeMedia(key, blob) {
			mediaMap.set(key, blob);
		},
		async setViewed(id, viewed) {
			viewedWrites += 1;
			const index = data.findIndex((x) => x.id === id);
			const current = data[index];
			if (index >= 0 && current) data[index] = { ...current, viewed };
		},
		async remove(id) {
			const index = data.findIndex((x) => x.id === id);
			if (index < 0) return;
			data.splice(index, 1);
			// Mirror the real IndexedDB remove: drop the bare video key plus every `${id}:`-prefixed media key (thumbnail, files, and reference-video/audio payloads) for this item.
			mediaMap.delete(videoKey(id));
			for (const key of mediaMap.keys()) {
				if (key.startsWith(`${id}:`)) mediaMap.delete(key);
			}
		},
		async countBefore(cutoffMs) {
			return data.filter((i) => predatesCutoff(i.createdAt, cutoffMs)).length;
		},
		async removeBefore(cutoffMs) {
			const matches = data.filter((i) => predatesCutoff(i.createdAt, cutoffMs)).map((i) => i.id);
			for (const id of matches) await this.remove(id);
		},
		async clear() {
			data.length = 0;
			mediaMap.clear();
		},
		async loadMedia(key) {
			reads.set(key, (reads.get(key) ?? 0) + 1);
			return mediaMap.get(key) ?? null;
		},
		data: () => data,
		media: (key) => mediaMap.get(key) ?? null,
		mediaReadCount: (key) => reads.get(key) ?? 0,
		setViewedCount: () => viewedWrites,
		saveCount: () => saves,
		failSaves: (ids) => {
			for (const id of ids) failingSaves.add(id);
		},
	};
}

// A backend that, like the real IndexedDB backend, validates its raw entries before exposing them.
function validatingBackend(): HistoryBackend & { setData(entries: unknown[]): void } {
	let data: unknown[] = [];
	return {
		isPersistent: () => true,
		async loadAll(): Promise<HistoryItem[]> {
			const out: HistoryItem[] = [];
			for (const entry of data) {
				if (isHistoryItem(entry)) {
					entry.persisted = true;
					out.push(entry);
				}
			}
			return out;
		},
		async listArchiveMeta() {
			const out: { id: string; createdAt: number }[] = [];
			for (const entry of data) {
				if (typeof entry !== "object" || entry === null || !("id" in entry) || !("createdAt" in entry)) continue;
				const id = entry.id;
				const createdAt = entry.createdAt;
				if (typeof id !== "string" || typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
				out.push({ id, createdAt });
			}
			return out;
		},
		async save() {},
		async storeMedia() {},
		async setViewed() {},
		async remove() {},
		async countBefore() {
			return 0;
		},
		async removeBefore() {},
		async clear() {},
		async loadMedia() {
			return null;
		},
		setData(entries: unknown[]) {
			data = entries;
		},
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("QueueBackend", () => {
	it("round-trips a queue through the async backend", async () => {
		const backend = memoryQueueBackend();
		const queue = [makeQueueItem(), makeQueueItem({ status: "generating", serverId: "srv" })];
		await backend.save(queue);

		const loaded = await backend.load();
		expect(loaded.length).toBe(2);
		expect(loaded[0]?.id).toBe(queue[0]?.id);
		expect(loaded[0]?.prompt).toBe("a dog");
		expect(loaded[1]?.id).toBe(queue[1]?.id);
		expect(loaded[1]?.status).toBe("generating");
		expect(loaded[1]?.serverId).toBe("srv");
	});

	it("isQueueItem rejects items missing required fields so a mixed payload strips them", async () => {
		const good = makeQueueItem();
		const backend = memoryQueueBackend();
		backend.seed([good, { id: "bad" } as unknown as QueueItem]);
		const loaded = await backend.load();
		expect(loaded.length).toBe(1);
		expect(loaded[0]?.id).toBe(good.id);
		expect(isQueueItem({ id: "x" })).toBe(false);
	});

	it("isQueueItem rejects a persisted record carrying an invalid mode", async () => {
		const good = makeQueueItem();
		expect(isQueueItem({ ...good, mode: "start-end" })).toBe(true);
		expect(isQueueItem({ ...good, mode: "refs" })).toBe(true);
		expect(isQueueItem({ ...good, mode: "bogus" })).toBe(false);
	});

	it("isQueueItem applies finite, positive rigor to the dimension/step fields like isHistoryItem does", () => {
		const good = makeQueueItem();
		expect(isQueueItem(good)).toBe(true);
		// Non-finite, negative, and zero dimension/step values are malformed and must be rejected.
		expect(isQueueItem({ ...good, width: Number.NaN })).toBe(false);
		expect(isQueueItem({ ...good, width: Number.POSITIVE_INFINITY })).toBe(false);
		expect(isQueueItem({ ...good, width: -5 })).toBe(false);
		expect(isQueueItem({ ...good, width: 0 })).toBe(false);
		expect(isQueueItem({ ...good, height: Number.NaN })).toBe(false);
		expect(isQueueItem({ ...good, height: -1 })).toBe(false);
		expect(isQueueItem({ ...good, height: 0 })).toBe(false);
		expect(isQueueItem({ ...good, steps: Number.NaN })).toBe(false);
		expect(isQueueItem({ ...good, steps: 0 })).toBe(false);
		expect(isQueueItem({ ...good, steps: -5 })).toBe(false);
		expect(isQueueItem({ ...good, jobFrames: Number.NaN })).toBe(false);
		expect(isQueueItem({ ...good, jobFrames: 0 })).toBe(false);
		expect(isQueueItem({ ...good, jobFrames: -5 })).toBe(false);
		// A complete valid record with all four fields present and positive passes.
		expect(isQueueItem({ ...good, width: 512, height: 256, steps: 10, jobFrames: 30 })).toBe(true);
	});

	it("isQueueItem rejects a non-finite startedAt like the dimension rigor", () => {
		const good = makeQueueItem();
		// null (still pending) and a finite timestamp are both accepted; only the non-finite number case is rejected.
		expect(isQueueItem({ ...good, startedAt: null })).toBe(true);
		expect(isQueueItem({ ...good, startedAt: 1700000000000 })).toBe(true);
		expect(isQueueItem({ ...good, startedAt: Number.POSITIVE_INFINITY })).toBe(false);
		expect(isQueueItem({ ...good, startedAt: Number.NaN })).toBe(false);
	});

	it("never throws on load or save", async () => {
		const backend = memoryQueueBackend();
		await expect(backend.save([makeQueueItem()])).resolves.toBeUndefined();
		await expect(backend.load()).resolves.toBeDefined();
	});
});

describe("no-browser fallback (Bun has no indexedDB)", () => {
	it("createIdbHistory resolves without throwing and without writing", async () => {
		expect(globalThis.indexedDB).toBeUndefined();
		const backend = createIdbHistory();
		const item: HistoryItem = {
			id: "h_x",
			createdAt: 1,
			prompt: "p",
			zipName: null,
			mode: "prompt",
			files: [],
			videos: [],
			audios: [],
			width: 512,
			height: 512,
			frameCount: 33,
			fps: 24,
			elapsedMs: 1000,
			startedAt: 1,
			completedAt: 2,
			thumbnailKey: thumbnailKey("h_x"),
			thumbBytes: 0,
			video: { mime: "video/webm", format: "webm", byteSize: 1 },
			persisted: false,
			viewed: false,
		};
		expect(backend.isPersistent()).toBe(false);
		await expect(backend.loadAll()).resolves.toEqual([]);
		await expect(backend.listArchiveMeta()).resolves.toEqual([]);
		await expect(backend.save(item, new Blob([]))).resolves.toBeUndefined();
		await expect(backend.storeMedia("k", new Blob([]))).resolves.toBeUndefined();
		await expect(backend.setViewed("id", true)).resolves.toBeUndefined();
		await expect(backend.loadMedia("k")).resolves.toBeNull();
		await expect(backend.remove("id")).resolves.toBeUndefined();
		await expect(backend.countBefore(0)).resolves.toBe(0);
		await expect(backend.removeBefore(0)).resolves.toBeUndefined();
		await expect(backend.clear()).resolves.toBeUndefined();
	});

	it("createIdbQueue resolves without throwing and without writing", async () => {
		const backend = createIdbQueue();
		await expect(backend.load()).resolves.toEqual([]);
		await expect(backend.save([])).resolves.toBeUndefined();
	});
});

describe("estimateStorage", () => {
	it("does not throw and returns null without a storage backend", async () => {
		const estimate = await estimateStorage();
		expect(estimate).toBe(null);
	});
});

describe("isHistoryItem numeric-field rigor", () => {
	it("accepts a complete valid record", () => {
		expect(isHistoryItem(makeItem())).toBe(true);
	});

	it("rejects when width is missing so the UI dimension never renders undefined", () => {
		const { width: _width, ...rest } = makeItem();
		expect(isHistoryItem(rest)).toBe(false);
	});

	it("rejects when frameCount is missing", () => {
		const { frameCount: _frameCount, ...rest } = makeItem();
		expect(isHistoryItem(rest)).toBe(false);
	});

	it("rejects when a required numeric field is not finite", () => {
		expect(isHistoryItem({ ...makeItem(), width: Number.NaN })).toBe(false);
		expect(isHistoryItem({ ...makeItem(), elapsedMs: Number.POSITIVE_INFINITY })).toBe(false);
		expect(isHistoryItem({ ...makeItem(), completedAt: Number.NaN })).toBe(false);
	});
});

describe("createHistoryStore", () => {
	it("keeps items purely in memory when no backend is available", () => {
		const store = createHistoryStore(null);
		expect(store.isPersistent()).toBe(false);
		store.add(makeItem(), dummyMedia());
		store.add(makeItem(), dummyMedia());
		expect(store.items().length).toBe(2);
		expect(store.items().every((i) => i.persisted === false)).toBe(true);
	});

	it("persists an added item to the backend and marks it persisted", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const item = makeItem();
		store.add(item, dummyMedia());
		// The flag flips optimistically inside add(), before the backend save resolves, so an in-flight record is never double-counted against the archive copy its own save writes.
		expect(item.persisted).toBe(true);
		await flush();
		expect(item.persisted).toBe(true);
		expect(backend.data().some((i) => i.id === item.id)).toBe(true);
	});

	it("stops storing media when the item is deleted mid-save", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const stored: string[] = [];
		// A save that stays in flight until the test releases it, so the deletion can land mid-save.
		const gatedBackend: HistoryBackend = {
			isPersistent: () => true,
			async loadAll() { return []; },
			async listArchiveMeta() { return []; },
			async save() { await gate; },
			async storeMedia(key) { stored.push(key); },
			async setViewed() {},
			async remove() {},
			async countBefore() { return 0; },
			async removeBefore() {},
			async clear() {},
			async loadMedia() { return null; },
		};
		const store = createHistoryStore(gatedBackend);
		const item = makeItem();
		store.add(item, dummyMedia({ thumbnail: new Blob(["t"]), files: [new Blob(["f0"])] }));
		store.remove(item.id);
		release();
		await flush();
		// The save resolved after the item was already gone, so not one media store may follow it.
		expect(stored).toEqual([]);
	});

	it("stores the thumbnail and file blobs to the backend media store", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const item = makeItem();
		store.add(item, dummyMedia({ files: [new Blob(["f0"]), new Blob(["f1"])] }));
		await flush();
		expect(backend.media(thumbnailKey(item.id))).not.toBeNull();
		expect(backend.media(fileKey(item.id, 0))).not.toBeNull();
		expect(backend.media(fileKey(item.id, 1))).not.toBeNull();
		expect(backend.media(videoKey(item.id))).not.toBeNull();
	});

	it("serves cached media from memory without another backend read", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const item = makeItem();
		const thumb = new Blob(["thumb"]);
		store.add(item, dummyMedia({ thumbnail: thumb, files: [new Blob(["f0"])] }));
		await flush();

		// The blobs were cached at add() time, so the loads never hit the backend.
		const loaded = await store.loadThumbnail(item.id);
		expect(loaded).not.toBeNull();
		expect(backend.mediaReadCount(thumbnailKey(item.id))).toBe(0);

		// Requires the matching keys so the cache is keyed correctly.
		const before = await store.loadThumbnail(item.id);
		const after = await store.loadThumbnail(item.id);
		expect(before).toBe(after);
		expect(backend.mediaReadCount(thumbnailKey(item.id))).toBe(0);
	});

	it("loads a file via the backend once and caches it for repeat reads", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const id = "h_cache_file";
		const item = { ...makeItem({ id }), files: [{ name: "a.png", key: fileKey(id, 0), bytes: 2 }] };
		await backend.save(item, new Blob(["vid"]));
		await backend.storeMedia(fileKey(id, 0), new Blob(["f0"]));
		await store.load();

		const first = await store.loadFileByKey(item.files[0]?.key ?? "");
		const second = await store.loadFileByKey(item.files[0]?.key ?? "");
		expect(first).not.toBeNull();
		expect(second).toBe(first);
		expect(backend.mediaReadCount(fileKey(id, 0))).toBe(1);
	});

	it("shows images for the non-persistent path from the in-memory cache", async () => {
		const store = createHistoryStore(null);
		const id = "h_mem";
		const item = { ...makeItem({ id }), files: [{ name: "a.png", key: fileKey(id, 0), bytes: 2 }] };
		store.add(item, dummyMedia({ files: [new Blob(["f0"])] }));
		const thumb = await store.loadThumbnail(id);
		const file = await store.loadFileByKey(item.files[0]?.key ?? "");
		expect(thumb).not.toBeNull();
		expect(file).not.toBeNull();
	});

	it("starts items unviewed and markViewed flips them via setViewed (not a full save)", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem();
		const b = makeItem();
		store.add(a, dummyMedia());
		store.add(b, dummyMedia());
		await flush();
		expect(store.items().every((i) => i.viewed === false)).toBe(true);
		const viewedWritesBefore = backend.setViewedCount();
		const savesBefore = backend.saveCount();

		store.markViewed(a.id);
		expect(store.items().find((i) => i.id === a.id)?.viewed).toBe(true);
		expect(store.items().find((i) => i.id === b.id)?.viewed).toBe(false);
		await flush();
		expect(backend.setViewedCount()).toBe(viewedWritesBefore + 1);
		// markViewed must not issue a full save: a regression that also called save would bump saveCount here.
		expect(backend.saveCount()).toBe(savesBefore);
		expect(backend.data().find((i) => i.id === a.id)?.viewed).toBe(true);
	});

	it("remove deletes the item's media from the backend (video, thumbnail, files, and reference media)", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const id = "h_remove_media";
		const item = {
			...makeItem({
				id,
				videos: [{ name: "r1.mp4", thumbKey: refVideoThumbKey(id, 0), thumbBytes: 2, audioKey: refVideoAudioKey(id, 0), audioBytes: 2, sourceKey: refVideoSourceKey(id, 0), sourceBytes: 2 }],
				audios: [{ name: "r1.wav", key: refAudioKey(id, 0), bytes: 2 }],
			}),
			files: [
				{ name: "a.png", key: fileKey(id, 0), bytes: 2 },
				{ name: "b.png", key: fileKey(id, 1), bytes: 2 },
			],
		};
		store.add(item, dummyMedia({ files: [new Blob(["f0"]), new Blob(["f1"])], videoThumbs: [new Blob(["vt0"])], videoAudios: [new Blob(["va0"])], videoSources: [new Blob(["vs0"])], audioSources: [new Blob(["as0"])] }));
		await flush();

		expect(backend.media(videoKey(id))).not.toBeNull();
		expect(backend.media(thumbnailKey(id))).not.toBeNull();
		expect(backend.media(fileKey(id, 0))).not.toBeNull();
		expect(backend.media(fileKey(id, 1))).not.toBeNull();
		expect(backend.media(refVideoThumbKey(id, 0))).not.toBeNull();
		expect(backend.media(refVideoAudioKey(id, 0))).not.toBeNull();
		expect(backend.media(refVideoSourceKey(id, 0))).not.toBeNull();
		expect(backend.media(refAudioKey(id, 0))).not.toBeNull();

		store.remove(id);
		await flush();

		// A direct read of every derived media key reports null after removal, mirroring the idb remove
		// that also deletes the video/thumbnail keys and every `${id}:`-prefixed key (files and reference-video/audio payloads alike) via the bound range cursor.
		expect(backend.media(videoKey(id))).toBeNull();
		expect(backend.media(thumbnailKey(id))).toBeNull();
		expect(backend.media(fileKey(id, 0))).toBeNull();
		expect(backend.media(fileKey(id, 1))).toBeNull();
		expect(backend.media(refVideoThumbKey(id, 0))).toBeNull();
		expect(backend.media(refVideoAudioKey(id, 0))).toBeNull();
		expect(backend.media(refVideoSourceKey(id, 0))).toBeNull();
		expect(backend.media(refAudioKey(id, 0))).toBeNull();
		expect(await store.loadVideo(id)).toBeNull();
		expect(await store.loadThumbnail(id)).toBeNull();
		expect(await store.loadFileByKey(fileKey(id, 0))).toBeNull();
		expect(await store.loadFileByKey(fileKey(id, 1))).toBeNull();
	});

	it("treats legacy persisted items without a viewed flag as already viewed on rehydrate", async () => {
		const backend = validatingBackend();
		// Simulate a post-migration record (thumbnailKey/files/bytes) written before the `viewed` flag existed.
		const { viewed: _viewed, ...legacy } = makeItem();
		backend.setData([legacy]);
		const store = createHistoryStore(backend);
		await store.load();
		expect(store.items().every((i) => i.viewed === true)).toBe(true);
	});

	it("rehydrates persisted history into a new store via load()", async () => {
		const backend = memoryBackend();
		const first = createHistoryStore(backend);
		const item = makeItem();
		first.add(item, dummyMedia());
		await flush();

		const second = createHistoryStore(backend);
		await second.load();
		expect(second.items().length).toBe(1);
		expect(second.items()[0]?.id).toBe(item.id);
		expect(second.items()[0]?.prompt).toBe("test");
		expect(second.items()[0]?.persisted).toBe(true);
	});

	it("removes an item from memory and the backend", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem();
		const b = makeItem();
		store.add(a, dummyMedia());
		store.add(b, dummyMedia());
		await flush();

		store.remove(a.id);
		expect(store.items().map((i) => i.id)).toEqual([b.id]);

		const reloaded = createHistoryStore(backend);
		await reloaded.load();
		expect(reloaded.items().map((i) => i.id)).toEqual([b.id]);
		expect(backend.data().length).toBe(1);
	});

	it("removeOldest removes the N oldest items and their media", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const items = [makeItem({ createdAt: 1 }), makeItem({ createdAt: 2 }), makeItem({ createdAt: 3 }), makeItem({ createdAt: 4 })];
		const first = items[0];
		const second = items[1];
		if (!first || !second) throw new Error("test setup failed");
		// The two oldest carry reference video/audio media so their cleanup is asserted alongside the record removal.
		store.add(first, dummyMedia({ videoThumbs: [new Blob(["vt0"])], videoAudios: [new Blob(["va0"])], videoSources: [new Blob(["vs0"])], audioSources: [new Blob(["as0"])] }));
		store.add(second, dummyMedia({ videoThumbs: [new Blob(["vt0"])], videoAudios: [new Blob(["va0"])], videoSources: [new Blob(["vs0"])], audioSources: [new Blob(["as0"])] }));
		for (const i of items.slice(2)) store.add(i, dummyMedia());
		await flush();
		expect(backend.media(refVideoThumbKey(first.id, 0))).not.toBeNull();
		expect(backend.media(refVideoAudioKey(first.id, 0))).not.toBeNull();
		expect(backend.media(refVideoSourceKey(first.id, 0))).not.toBeNull();
		expect(backend.media(refAudioKey(first.id, 0))).not.toBeNull();

		await store.removeOldest(2);
		await flush();
		expect(store.items().map((i) => i.id)).toEqual([items[2]?.id ?? "", items[3]?.id ?? ""]);
		expect(backend.data().length).toBe(2);
		// The removed oldest items' reference-media keys are deleted; a survivor's video key stays.
		expect(backend.media(refVideoThumbKey(first.id, 0))).toBeNull();
		expect(backend.media(refVideoAudioKey(first.id, 0))).toBeNull();
		expect(backend.media(refVideoSourceKey(first.id, 0))).toBeNull();
		expect(backend.media(refAudioKey(first.id, 0))).toBeNull();
		expect(backend.media(refVideoThumbKey(second.id, 0))).toBeNull();
		expect(backend.media(refAudioKey(second.id, 0))).toBeNull();
		const third = items[2];
		if (!third) throw new Error("test setup failed");
		expect(backend.media(videoKey(third.id))).not.toBeNull();
	});

	it("removeOldest ignores a non-positive count", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem({ createdAt: 1 });
		store.add(a, dummyMedia());
		await flush();
		await store.removeOldest(0);
		await store.removeOldest(-3);
		expect(store.items().map((i) => i.id)).toEqual([a.id]);
	});

	it("removeOldest deletes across the resident boundary (evicted archive items included)", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const created: HistoryItem[] = [];
		for (let i = 0; i < 105; i++) {
			const item = makeItem({ createdAt: i + 1 });
			created.push(item);
			store.add(item, dummyMedia());
		}
		await flush();
		// The archive holds all 105 while only the newest 100 are resident.
		expect(store.items().length).toBe(100);
		expect(backend.data().length).toBe(105);
		const oldestEvicted = created[0];
		const oldestResident = created[5];
		const newest = created[104];
		if (!oldestEvicted || !oldestResident || !newest) throw new Error("test setup failed");

		await store.removeOldest(10);

		// The 10 oldest of the WHOLE archive die: the 5 evicted (createdAt 1-5) and the 5 oldest residents (6-10), leaving 95 everywhere.
		expect(store.items().length).toBe(95);
		expect(store.items().every((i) => i.createdAt >= 11)).toBe(true);
		expect(backend.data().length).toBe(95);
		// Both victim groups lost their media; the newest survivor's video key is intact.
		expect(backend.media(videoKey(oldestEvicted.id))).toBeNull();
		expect(backend.media(thumbnailKey(oldestEvicted.id))).toBeNull();
		expect(backend.media(videoKey(oldestResident.id))).toBeNull();
		expect(backend.media(thumbnailKey(oldestResident.id))).toBeNull();
		expect(backend.media(videoKey(newest.id))).not.toBeNull();
	});

	it("removeOldest includes non-persisted residents in the tail", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		// Two archive-only records with no resident counterpart (as after an eviction).
		const archivedOld = makeItem({ createdAt: 10 });
		const archivedNew = makeItem({ createdAt: 20 });
		await backend.save(archivedOld, new Blob(["v"]));
		await backend.save(archivedNew, new Blob(["v"]));
		// A resident whose save failed keeps `persisted === false` while carrying the oldest createdAt of all.
		const failed = makeItem({ createdAt: 5 });
		const good = makeItem({ createdAt: 30 });
		backend.failSaves([failed.id]);
		store.add(failed, dummyMedia());
		store.add(good, dummyMedia());
		await flush();
		expect(failed.persisted).toBe(false);

		await store.removeOldest(2);

		// The failed resident (5) and archivedOld (10) are the two oldest of the union; archivedNew and the good resident survive.
		expect(store.items().map((i) => i.id)).toEqual([good.id]);
		expect(backend.data().map((i) => i.id)).toEqual([archivedNew.id, good.id]);
	});

	it("removeOldest never deletes an item with a non-finite createdAt", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const broken = makeItem({ createdAt: Number.NaN });
		const newest = makeItem({ createdAt: 3 });
		store.add(broken, dummyMedia());
		store.add(makeItem({ createdAt: 1 }), dummyMedia());
		store.add(makeItem({ createdAt: 2 }), dummyMedia());
		store.add(newest, dummyMedia());
		await flush();

		await store.removeOldest(2);

		// The NaN item is not an n-tail candidate (its age is unknown), so n effectively shrinks to the two finite oldest and the NaN record survives everywhere.
		expect(store.items().some((i) => i.id === broken.id)).toBe(true);
		expect(backend.data().some((i) => i.id === broken.id)).toBe(true);
		expect(store.items().map((i) => i.id)).toEqual([broken.id, newest.id]);
		expect(backend.data().length).toBe(2);
	});

	it("removeOldest is deterministic when several items share the exact same createdAt", async () => {
		const run = async (): Promise<{ deleted: string[]; survivors: string[] }> => {
			const backend = memoryBackend();
			const store = createHistoryStore(backend);
			// Three items tied on createdAt; only the ids and insertion order distinguish them.
			store.add(makeItem({ id: "h_tie_a", createdAt: 1000 }), dummyMedia());
			store.add(makeItem({ id: "h_tie_b", createdAt: 1000 }), dummyMedia());
			store.add(makeItem({ id: "h_tie_c", createdAt: 1000 }), dummyMedia());
			await flush();
			const deleted = await store.removeOldest(2);
			return { deleted, survivors: store.items().map((i) => i.id) };
		};
		const first = await run();
		const second = await run();
		// Exactly two of the three tied items die, chosen deterministically (stable sort over the union's insertion order).
		expect(first.deleted).toEqual(["h_tie_a", "h_tie_b"]);
		expect(first.survivors).toEqual(["h_tie_c"]);
		// Two identical setups must pick the identical two victims and the identical survivor.
		expect(second.deleted).toEqual(first.deleted);
		expect(second.survivors).toEqual(first.survivors);
	});

	it("removeOldest removes non-resident victims' media from the backend (files and reference media included)", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const id = "h_evicted_victim";
		const survivor = makeItem({ createdAt: 104 });
		const item = {
			...makeItem({ id, createdAt: 0, videos: [{ name: "r1.mp4", thumbKey: refVideoThumbKey(id, 0), thumbBytes: 2, audioKey: refVideoAudioKey(id, 0), audioBytes: 2, sourceKey: refVideoSourceKey(id, 0), sourceBytes: 2 }], audios: [{ name: "r1.wav", key: refAudioKey(id, 0), bytes: 2 }] }),
			files: [{ name: "a.png", key: fileKey(id, 0), bytes: 2 }],
		};
		store.add(item, dummyMedia({ files: [new Blob(["f0"])], videoThumbs: [new Blob(["vt0"])], videoAudios: [new Blob(["va0"])], videoSources: [new Blob(["vs0"])], audioSources: [new Blob(["as0"])] }));
		for (let i = 1; i <= 103; i++) store.add(makeItem({ createdAt: i }), dummyMedia());
		store.add(survivor, dummyMedia());
		await flush();
		// The victim was evicted past the in-memory cap while its archive copy and media all survived.
		expect(store.items().every((i) => i.id !== id)).toBe(true);
		// Re-cache the victim's video so the deletion must also drop the memory-side cache entry, not just the backend keys.
		expect(await store.loadVideo(id)).not.toBeNull();

		await store.removeOldest(1);
		await flush();

		expect(backend.data().length).toBe(104);
		expect(backend.media(videoKey(id))).toBeNull();
		expect(backend.media(thumbnailKey(id))).toBeNull();
		expect(backend.media(fileKey(id, 0))).toBeNull();
		expect(backend.media(refVideoThumbKey(id, 0))).toBeNull();
		expect(backend.media(refVideoAudioKey(id, 0))).toBeNull();
		expect(backend.media(refVideoSourceKey(id, 0))).toBeNull();
		expect(backend.media(refAudioKey(id, 0))).toBeNull();
		// The stale cache entry is gone too: the read falls through to the now-empty backend instead of serving the deleted Blob.
		expect(await store.loadVideo(id)).toBeNull();
		expect(await store.loadThumbnail(id)).toBeNull();
		expect(await store.loadFileByKey(fileKey(id, 0))).toBeNull();
		// A survivor's media is untouched.
		expect(backend.media(videoKey(survivor.id))).not.toBeNull();
	});

	it("countAll equals the archive-wide deletion universe (residents deduped against the archive)", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		for (let i = 0; i < 105; i++) store.add(makeItem({ createdAt: i + 1 }), dummyMedia());
		await flush();
		expect(store.items().length).toBe(100);
		// 105 archive records with the 100 residents deduped away, not 205.
		expect(await store.countAll()).toBe(105);
		await store.removeOldest(105);
		expect(await store.countAll()).toBe(0);
		expect(backend.data().length).toBe(0);
	});

	it("countAll falls back to the finite resident count when no backend exists", async () => {
		const store = createHistoryStore(null);
		store.add(makeItem({ createdAt: 1 }), dummyMedia());
		store.add(makeItem({ createdAt: Number.NaN }), dummyMedia());
		expect(await store.countAll()).toBe(1);
	});

	it("removeBefore deletes only items strictly older than the cutoff", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const items = [makeItem({ createdAt: 1000 }), makeItem({ createdAt: 2000 }), makeItem({ createdAt: 3000 })];
		for (const i of items) store.add(i, dummyMedia());
		await flush();

		await store.removeBefore(2000);
		// The boundary item (createdAt === cutoff) survives, resident and archived alike.
		expect(store.items().map((i) => i.createdAt)).toEqual([2000, 3000]);
		expect(backend.data().map((i) => i.createdAt)).toEqual([2000, 3000]);
	});

	it("removeBefore keeps items with a non-finite createdAt", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const finite = makeItem({ createdAt: 1000 });
		// add() does not run isHistoryItem validation (that gate is for persisted records), so a NaN createdAt rides in memory; the predicate must still never delete it.
		const broken = makeItem({ createdAt: Number.NaN });
		store.add(finite, dummyMedia());
		store.add(broken, dummyMedia());
		await flush();

		await store.removeBefore(5000);
		expect(store.items().some((i) => i.id === finite.id)).toBe(false);
		expect(store.items().map((i) => i.id)).toContain(broken.id);
		expect(backend.data().map((i) => i.id)).toContain(broken.id);
	});

	it("removeBefore removes each deleted item's media from the backend (including reference media)", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const idA = "h_rb_media_a";
		const idB = "h_rb_media_b";
		const itemA = {
			...makeItem({ id: idA, createdAt: 1000, videos: [{ name: "r1.mp4", thumbKey: refVideoThumbKey(idA, 0), thumbBytes: 2, audioKey: refVideoAudioKey(idA, 0), audioBytes: 2, sourceKey: refVideoSourceKey(idA, 0), sourceBytes: 2 }], audios: [{ name: "r1.wav", key: refAudioKey(idA, 0), bytes: 2 }] }),
			files: [{ name: "a.png", key: fileKey(idA, 0), bytes: 2 }],
		};
		const itemB = { ...makeItem({ id: idB, createdAt: 2000 }), files: [{ name: "b.png", key: fileKey(idB, 0), bytes: 2 }] };
		store.add(itemA, dummyMedia({ files: [new Blob(["a"])], videoThumbs: [new Blob(["va"])], videoAudios: [new Blob(["vaa"])], videoSources: [new Blob(["vas"])], audioSources: [new Blob(["aas"])] }));
		store.add(itemB, dummyMedia({ files: [new Blob(["b"])] }));
		await flush();

		await store.removeBefore(2000);
		// Every media key of the deleted item is gone — the reference-video/audio keys included; the survivor's keys are all intact.
		expect(backend.media(videoKey(idA))).toBeNull();
		expect(backend.media(thumbnailKey(idA))).toBeNull();
		expect(backend.media(fileKey(idA, 0))).toBeNull();
		expect(backend.media(refVideoThumbKey(idA, 0))).toBeNull();
		expect(backend.media(refVideoAudioKey(idA, 0))).toBeNull();
		expect(backend.media(refVideoSourceKey(idA, 0))).toBeNull();
		expect(backend.media(refAudioKey(idA, 0))).toBeNull();
		expect(backend.media(videoKey(idB))).not.toBeNull();
		expect(backend.media(thumbnailKey(idB))).not.toBeNull();
		expect(backend.media(fileKey(idB, 0))).not.toBeNull();
	});

	it("removeBefore is a no-op when nothing precedes the cutoff", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem({ createdAt: 2000 });
		store.add(a, dummyMedia());
		await flush();

		await store.removeBefore(1000);
		expect(store.items().map((i) => i.id)).toEqual([a.id]);
		expect(backend.data().length).toBe(1);
	});

	it("countBefore equals what removeBefore deletes", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		// Push past MAX_IN_MEMORY so part of the matching archive is evicted from memory but still counted and deleted.
		for (let i = 0; i < 105; i++) store.add(makeItem({ createdAt: i + 1 }), dummyMedia());
		await flush();
		expect(store.items().length).toBe(100);
		expect(backend.data().length).toBe(105);

		const cutoff = 51;
		const before = backend.data().length;
		const count = await store.countBefore(cutoff);
		await store.removeBefore(cutoff);
		expect(backend.data().length).toBe(before - count);
		expect(store.items().every((i) => i.createdAt >= cutoff)).toBe(true);
	});

	it("countBefore falls back to the resident predicate count when no backend exists", async () => {
		const store = createHistoryStore(null);
		store.add(makeItem({ createdAt: 1000 }), dummyMedia());
		store.add(makeItem({ createdAt: 2000 }), dummyMedia());
		expect(await store.countBefore(2000)).toBe(1);
		expect(await store.countBefore(1000)).toBe(0);
	});

	it("clear removes every item from memory and the backend", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem({ createdAt: 1 });
		store.add(a, dummyMedia({ videoThumbs: [new Blob(["vt0"])], videoAudios: [new Blob(["va0"])], videoSources: [new Blob(["vs0"])], audioSources: [new Blob(["as0"])] }));
		store.add(makeItem({ createdAt: 2 }), dummyMedia());
		await flush();
		expect(backend.media(refVideoThumbKey(a.id, 0))).not.toBeNull();
		expect(backend.media(refAudioKey(a.id, 0))).not.toBeNull();

		store.clear();
		expect(store.items().length).toBe(0);
		expect(backend.data().length).toBe(0);
		expect(backend.media(refVideoThumbKey(a.id, 0))).toBeNull();
		expect(backend.media(refAudioKey(a.id, 0))).toBeNull();

		const reloaded = createHistoryStore(backend);
		await reloaded.load();
		expect(reloaded.items().length).toBe(0);
	});

	it("load filters out invalid persisted entries", async () => {
		const backend = validatingBackend();
		const validItem = makeItem();
		backend.setData([validItem, { id: "bad" }]);

		const store = createHistoryStore(backend);
		await store.load();
		expect(store.items().length).toBe(1);
		expect(store.items()[0]?.id).toBe(validItem.id);
	});

	it("bounds in-memory growth to MAX_IN_MEMORY", () => {
		const store = createHistoryStore(null);
		for (let i = 0; i < 105; i++) store.add(makeItem({ createdAt: i }), dummyMedia());
		expect(store.items().length).toBe(100);
	});

	it("evicting over the in-memory cap never deletes from the backend archive", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		for (let i = 0; i < 110; i++) store.add(makeItem({ createdAt: i }), dummyMedia());
		await flush();
		expect(store.items().length).toBe(100);
		expect(backend.data().length).toBe(110);

		const reloaded = createHistoryStore(backend);
		await reloaded.load();
		expect(reloaded.items().length).toBe(110);
	});

	it("evicting over the cap also drops the evicted items' media from the byte cache", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const created: HistoryItem[] = [];
		for (let i = 0; i < 105; i++) {
			const item = makeItem({ createdAt: i });
			store.add(item, dummyMedia({ video: new Blob([`v${i}`]), thumbnail: new Blob([`t${i}`]), files: [new Blob([`f${i}`])] }));
			created.push(item);
		}
		await flush();
		expect(store.items().length).toBe(100);
		// The byte cache only ever must retain the resident 100; the backend archive keeps all 105.
		expect(backend.data().length).toBe(105);

		const evicted = created[0];
		const retained = created[104];
		if (!evicted || !retained) throw new Error("test setup failed");

		// A retained item's media is still served from the cache (no backend read).
		expect(await store.loadThumbnail(retained.id)).not.toBeNull();
		expect(await store.loadVideo(retained.id)).not.toBeNull();
		expect(backend.mediaReadCount(thumbnailKey(retained.id))).toBe(0);

		// An evicted item's media has been dropped from the cache, so the read falls through to the backend
		// (which still resolves it from the persisted archive, proving only the in-memory byte cache was trimmed).
		const readsBefore = backend.mediaReadCount(thumbnailKey(evicted.id));
		expect(await store.loadThumbnail(evicted.id)).not.toBeNull();
		expect(backend.mediaReadCount(thumbnailKey(evicted.id))).toBe(readsBefore + 1);
	});
});
