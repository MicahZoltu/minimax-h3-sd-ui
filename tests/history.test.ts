import { describe, it, expect } from "bun:test";
import { createHistoryStore, estimateStorage, isHistoryItem, isQueueItem, type HistoryBackend } from "../app/ts/history.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { HistoryItem, QueueItem } from "../app/ts/types.js";

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
	return {
		id: "h_" + Math.random().toString(36).slice(2),
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
		thumbnail: "",
		video: { mime: "video/webm", format: "webm", byteSize: 3 },
		persisted: false,
		viewed: false,
		...overrides,
	};
}

function memoryBackend(): HistoryBackend & { data(): HistoryItem[] } {
	const data: HistoryItem[] = [];
	return {
		isPersistent: () => true,
		async loadAll() {
			return data.map((i) => ({ ...i, persisted: true }));
		},
		async save(item, _videoBlob) {
			data.push(item);
		},
		async update(item) {
			const i = data.findIndex((x) => x.id === item.id);
			if (i >= 0) data[i] = item;
		},
		async remove(id) {
			const i = data.findIndex((x) => x.id === id);
			if (i >= 0) data.splice(i, 1);
		},
		async clear() {
			data.length = 0;
		},
		async loadVideoBlob(_id) {
			return null;
		},
		data: () => data,
	};
}

// A backend that, like the real IndexedDB backend, validates its raw entries before exposing them.
function validatingBackend(): HistoryBackend & { setData(entries: unknown[]): void } {
	let data: unknown[] = [];
	return {
		isPersistent: () => true,
		async loadAll() {
			const out: HistoryItem[] = [];
			for (const entry of data) {
				if (isHistoryItem(entry)) {
					entry.persisted = true;
					out.push(entry);
				}
			}
			return out;
		},
		async save(_item, _videoBlob) {},
		async update() {},
		async remove() {},
		async clear() {},
		async loadVideoBlob(_id) {
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

	it("never throws on load or save", async () => {
		const backend = memoryQueueBackend();
		await expect(backend.save([makeQueueItem()])).resolves.toBeUndefined();
		await expect(backend.load()).resolves.toBeDefined();
	});
});

describe("estimateStorage", () => {
	it("does not throw and returns null without a storage backend", async () => {
		const estimate = await estimateStorage();
		expect(estimate).toBe(null);
	});
});

describe("createHistoryStore", () => {
	it("keeps items purely in memory when no backend is available", () => {
		const store = createHistoryStore(null);
		expect(store.isPersistent()).toBe(false);
		store.add(makeItem(), new Blob([]));
		store.add(makeItem(), new Blob([]));
		expect(store.items().length).toBe(2);
		expect(store.items().every((i) => i.persisted === false)).toBe(true);
	});

	it("persists an added item to the backend and marks it persisted", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const item = makeItem();
		store.add(item, new Blob([]));
		expect(item.persisted).toBe(false);
		await flush();
		expect(item.persisted).toBe(true);
		expect(backend.data().some((i) => i.id === item.id)).toBe(true);
	});

	it("starts items unviewed and markViewed flips them, persisting the flag", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem();
		const b = makeItem();
		store.add(a, new Blob([]));
		store.add(b, new Blob([]));
		await flush();
		expect(store.items().every((i) => i.viewed === false)).toBe(true);

		store.markViewed(a.id);
		expect(store.items().find((i) => i.id === a.id)?.viewed).toBe(true);
		expect(store.items().find((i) => i.id === b.id)?.viewed).toBe(false);
		await flush();
		expect(backend.data().find((i) => i.id === a.id)?.viewed).toBe(true);
	});

	it("treats legacy persisted items without a viewed flag as already viewed on rehydrate", async () => {
		const backend = validatingBackend();
		// Simulate a record written before the `viewed` flag existed.
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
		first.add(item, new Blob([]));
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
		store.add(a, new Blob([]));
		store.add(b, new Blob([]));
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
		for (const i of items) store.add(i, new Blob([]));
		await flush();

		store.removeOldest(2);
		expect(store.items().map((i) => i.id)).toEqual([items[2]?.id ?? "", items[3]?.id ?? ""]);
		expect(backend.data().length).toBe(2);
	});

	it("removeOldest ignores a non-positive count", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem({ createdAt: 1 });
		store.add(a, new Blob([]));
		await flush();
		store.removeOldest(0);
		store.removeOldest(-3);
		expect(store.items().map((i) => i.id)).toEqual([a.id]);
	});

	it("clear removes every item from memory and the backend", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		store.add(makeItem({ createdAt: 1 }), new Blob([]));
		store.add(makeItem({ createdAt: 2 }), new Blob([]));
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
		for (let i = 0; i < 105; i++) store.add(makeItem({ createdAt: i }), new Blob([]));
		expect(store.items().length).toBe(100);
	});

	it("evicting over the in-memory cap never deletes from the backend archive", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		for (let i = 0; i < 110; i++) store.add(makeItem({ createdAt: i }), new Blob([]));
		await flush();
		expect(store.items().length).toBe(100);
		expect(backend.data().length).toBe(110);

		const reloaded = createHistoryStore(backend);
		await reloaded.load();
		expect(reloaded.items().length).toBe(110);
	});
});
