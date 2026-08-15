import { describe, it, expect } from "bun:test";
import { createHistoryStore, createQueuePersistence, estimateStorage, isHistoryItem, type HistoryBackend, type SyncStorage } from "../app/ts/history.js";
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
		video: { b64: "AAAA", mime: "video/webm", format: "webm" },
		persisted: false,
		...overrides,
	};
}

function memoryStorage(limitBytes = Infinity): SyncStorage {
	const data = new Map<string, string>();
	let total = 0;
	return {
		getItem: (k) => data.get(k) ?? null,
		keys: () => [...data.keys()],
		setItem: (k, v) => {
			const delta = v.length - (data.get(k)?.length ?? 0);
			if (total + delta > limitBytes) {
				const e = new DOMException("Quota exceeded", "QuotaExceededError");
				throw e;
			}
			total += delta;
			data.set(k, v);
		},
		removeItem: (k) => {
			const v = data.get(k);
			if (v) total -= v.length;
			data.delete(k);
		},
	};
}

function memoryBackend(): HistoryBackend & { data(): HistoryItem[] } {
	const data: HistoryItem[] = [];
	return {
		isPersistent: () => true,
		async loadAll() {
			return data.map((i) => ({ ...i, persisted: true }));
		},
		async save(item) {
			data.push(item);
		},
		async remove(id) {
			const i = data.findIndex((x) => x.id === id);
			if (i >= 0) data.splice(i, 1);
		},
		async clear() {
			data.length = 0;
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
		async save() {},
		async remove() {},
		async clear() {},
		setData(entries: unknown[]) {
			data = entries;
		},
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createQueuePersistence", () => {
	it("round-trips a queue through a fake storage", () => {
		const storage = memoryStorage();
		const save = createQueuePersistence(storage);
		const queue = [makeQueueItem(), makeQueueItem({ status: "generating", serverId: "srv" })];
		save.save(queue);

		const load = createQueuePersistence(storage);
		const loaded = load.load();
		expect(loaded.length).toBe(2);
		expect(loaded[0]?.id).toBe(queue[0]?.id);
		expect(loaded[0]?.prompt).toBe("a dog");
		expect(loaded[1]?.id).toBe(queue[1]?.id);
		expect(loaded[1]?.status).toBe("generating");
		expect(loaded[1]?.serverId).toBe("srv");
	});

	it("rejects garbage payloads by returning an empty queue", () => {
		const storage = memoryStorage();
		storage.setItem("sdcpp.video.queue", "{not json");
		expect(createQueuePersistence(storage).load()).toEqual([]);

		storage.setItem("sdcpp.video.queue", JSON.stringify({ id: "x" }));
		expect(createQueuePersistence(storage).load()).toEqual([]);

		storage.setItem("sdcpp.video.queue", JSON.stringify([{ id: "x" }]));
		expect(createQueuePersistence(storage).load()).toEqual([]);
	});

	it("strips items missing required fields from a mixed payload", () => {
		const storage = memoryStorage();
		const good = makeQueueItem();
		storage.setItem("sdcpp.video.queue", JSON.stringify([good, { id: "bad" }]));
		const loaded = createQueuePersistence(storage).load();
		expect(loaded.length).toBe(1);
		expect(loaded[0]?.id).toBe(good.id);
	});

	it("no-ops when there is no storage", () => {
		const queuePersistence = createQueuePersistence(null);
		expect(queuePersistence.load()).toEqual([]);
		expect(() => queuePersistence.save([makeQueueItem()])).not.toThrow();
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
		store.add(makeItem());
		store.add(makeItem());
		expect(store.items().length).toBe(2);
		expect(store.items().every((i) => i.persisted === false)).toBe(true);
	});

	it("persists an added item to the backend and marks it persisted", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const item = makeItem();
		store.add(item);
		expect(item.persisted).toBe(false);
		await flush();
		expect(item.persisted).toBe(true);
		expect(backend.data().some((i) => i.id === item.id)).toBe(true);
	});

	it("rehydrates persisted history into a new store via load()", async () => {
		const backend = memoryBackend();
		const first = createHistoryStore(backend);
		const item = makeItem();
		first.add(item);
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
		store.add(a);
		store.add(b);
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
		for (const i of items) store.add(i);
		await flush();

		store.removeOldest(2);
		expect(store.items().map((i) => i.id)).toEqual([items[2]?.id ?? "", items[3]?.id ?? ""]);
		expect(backend.data().length).toBe(2);
	});

	it("removeOldest ignores a non-positive count", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		const a = makeItem({ createdAt: 1 });
		store.add(a);
		await flush();
		store.removeOldest(0);
		store.removeOldest(-3);
		expect(store.items().map((i) => i.id)).toEqual([a.id]);
	});

	it("clear removes every item from memory and the backend", async () => {
		const backend = memoryBackend();
		const store = createHistoryStore(backend);
		store.add(makeItem({ createdAt: 1 }));
		store.add(makeItem({ createdAt: 2 }));
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
		for (let i = 0; i < 105; i++) store.add(makeItem({ createdAt: i }));
		expect(store.items().length).toBe(100);
	});
});
