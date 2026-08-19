import { describe, it, expect } from "bun:test";
import { createHistoryStore, estimateStorage, isHistoryItem, isQueueItem, type HistoryBackend } from "../app/ts/history.js";
import { createIdbHistory, createIdbQueue } from "../app/ts/idb.js";
import { fileKey, thumbnailKey, videoKey } from "../app/ts/media.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { HistoryItem, QueueItem } from "../app/ts/types.js";

type AddMedia = { video: Blob; thumbnail: Blob; files: Blob[] };

function dummyMedia(): AddMedia {
	return { video: new Blob(["v"]), thumbnail: new Blob(["t"]), files: [] };
}

function makeQueueItem(partial: Partial<QueueItem> = {}): QueueItem {
	return {
		id: "q_" + Math.random().toString(36).slice(2),
		status: "queued",
		prompt: "a dog",
		zipName: null,
		mode: "prompt",
		files: [],
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
};

function memoryBackend(): MemoryBackend {
	const data: HistoryItem[] = [];
	const mediaMap = new Map<string, Blob>();
	const reads = new Map<string, number>();
	let viewedWrites = 0;
	let saves = 0;
	return {
		isPersistent: () => true,
		async loadAll(): Promise<HistoryItem[]> {
			return data.map((i) => ({ ...i, persisted: true }));
		},
		async save(item, videoBlob) {
			saves += 1;
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
			const removed = data[index];
			if (index < 0) return;
			data.splice(index, 1);
			// Mirror the real IndexedDB remove: drop the video, thumbnail, and every ${id}:file:<i> media key for this item.
			if (removed) {
				const fileCount = removed.files.length;
				mediaMap.delete(videoKey(id));
				mediaMap.delete(thumbnailKey(id));
				for (let i = 0; i < fileCount; i++) mediaMap.delete(fileKey(id, i));
			}
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
		async save() {},
		async storeMedia() {},
		async setViewed() {},
		async remove() {},
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
		await expect(backend.save(item, new Blob([]))).resolves.toBeUndefined();
		await expect(backend.storeMedia("k", new Blob([]))).resolves.toBeUndefined();
		await expect(backend.setViewed("id", true)).resolves.toBeUndefined();
		await expect(backend.loadMedia("k")).resolves.toBeNull();
		await expect(backend.remove("id")).resolves.toBeUndefined();
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
		expect(item.persisted).toBe(false);
		await flush();
		expect(item.persisted).toBe(true);
		expect(backend.data().some((i) => i.id === item.id)).toBe(true);
	});

	it("stores the thumbnail and file blobs to the backend media store", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const item = makeItem();
		store.add(item, { video: new Blob(["v"]), thumbnail: new Blob(["t"]), files: [new Blob(["f0"]), new Blob(["f1"])] });
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
		store.add(item, { video: new Blob(["v"]), thumbnail: thumb, files: [new Blob(["f0"])] });
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
		store.add(item, { video: new Blob(["v"]), thumbnail: new Blob(["t"]), files: [new Blob(["f0"])] });
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

	it("remove deletes the item's media from the backend (video, thumbnail, and every file)", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const id = "h_remove_media";
		const item = {
			...makeItem({ id }),
			files: [
				{ name: "a.png", key: fileKey(id, 0), bytes: 2 },
				{ name: "b.png", key: fileKey(id, 1), bytes: 2 },
			],
		};
		store.add(item, { video: new Blob(["v"]), thumbnail: new Blob(["t"]), files: [new Blob(["f0"]), new Blob(["f1"])] });
		await flush();

		expect(backend.media(videoKey(id))).not.toBeNull();
		expect(backend.media(thumbnailKey(id))).not.toBeNull();
		expect(backend.media(fileKey(id, 0))).not.toBeNull();
		expect(backend.media(fileKey(id, 1))).not.toBeNull();

		store.remove(id);
		await flush();

		// A direct read of every derived media key reports null after removal, mirroring the idb remove
		// that also deletes the video/thumbnail keys and every ${id}:file:<i> via the bound range cursor.
		expect(backend.media(videoKey(id))).toBeNull();
		expect(backend.media(thumbnailKey(id))).toBeNull();
		expect(backend.media(fileKey(id, 0))).toBeNull();
		expect(backend.media(fileKey(id, 1))).toBeNull();
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

	it("removeOldest removes the N oldest items", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const items = [makeItem({ createdAt: 1 }), makeItem({ createdAt: 2 }), makeItem({ createdAt: 3 }), makeItem({ createdAt: 4 })];
		for (const i of items) store.add(i, dummyMedia());
		await flush();

		store.removeOldest(2);
		expect(store.items().map((i) => i.id)).toEqual([items[2]?.id ?? "", items[3]?.id ?? ""]);
		expect(backend.data().length).toBe(2);
	});

	it("removeOldest ignores a non-positive count", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem({ createdAt: 1 });
		store.add(a, dummyMedia());
		await flush();
		store.removeOldest(0);
		store.removeOldest(-3);
		expect(store.items().map((i) => i.id)).toEqual([a.id]);
	});

	it("clear removes every item from memory and the backend", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		store.add(makeItem({ createdAt: 1 }), dummyMedia());
		store.add(makeItem({ createdAt: 2 }), dummyMedia());
		await flush();

		store.clear();
		expect(store.items().length).toBe(0);
		expect(backend.data().length).toBe(0);

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
			store.add(item, { video: new Blob([`v${i}`]), thumbnail: new Blob([`t${i}`]), files: [new Blob([`f${i}`])] });
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
