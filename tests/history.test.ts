import { describe, it, expect } from "bun:test";
import { createHistoryStore, type SyncStorage } from "../app/ts/history.js";
import type { HistoryItem } from "../app/ts/types.js";

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: "h_" + Math.random().toString(36).slice(2),
		createdAt: Date.now(),
		prompt: "test",
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

// (byte budget is computed inline in the quota tests above)

describe("createHistoryStore", () => {
	it("keeps items purely in memory when no storage is available", () => {
		const store = createHistoryStore(null);
		expect(store.isPersistent()).toBe(false);
		store.add(makeItem());
		store.add(makeItem());
		expect(store.items().length).toBe(2);
		expect(store.items().every((i) => i.persisted === false)).toBe(true);
	});

	it("persists items and reloads them into a new store", () => {
		const storage = memoryStorage();
		const first = createHistoryStore(storage);
		const item = makeItem();
		first.add(item);
		expect(item.persisted).toBe(true);

		const second = createHistoryStore(storage);
		expect(second.items().length).toBe(1);
		expect(second.items()[0]?.id).toBe(item.id);
		expect(second.items()[0]?.prompt).toBe("test");
		expect(second.items()[0]?.persisted).toBe(true);
	});

	it("removes an item from memory and storage", () => {
		const storage = memoryStorage();
		const store = createHistoryStore(storage);
		const a = makeItem();
		const b = makeItem();
		store.add(a);
		store.add(b);
		store.remove(a.id);
		expect(store.items().map((i) => i.id)).toEqual([b.id]);
		const reloaded = createHistoryStore(storage);
		expect(reloaded.items().map((i) => i.id)).toEqual([b.id]);
	});

	it("evicts the oldest persisted item on quota pressure", () => {
		// Budget sized to fit roughly one item plus modest overhead.
		const oneSize = JSON.stringify(makeItem()).length + 10;
		const storage = memoryStorage(oneSize);
		const store = createHistoryStore(storage);
		const x = makeItem({ createdAt: 1 });
		const y = makeItem({ createdAt: 2 });
		store.add(x);
		store.add(y);
		// The oldest (x) is dropped from storage (kept in memory) to fit y.
		expect(store.items().map((i) => i.id)).toEqual([x.id, y.id]);
		expect(x.persisted).toBe(false);
		expect(y.persisted).toBe(true);
		expect(storage.getItem("sdcpp.video.history.item." + x.id)).toBe(null);
	});

	it("falls back to in-memory only when a single item exceeds quota", () => {
		const storage = memoryStorage(40);
		const store = createHistoryStore(storage);
		const big = makeItem();
		big.video.b64 = "x".repeat(5000);
		store.add(big);
		expect(store.items().length).toBe(1);
		expect(big.persisted).toBe(false);
	});

	it("bounds in-memory growth to MAX_IN_MEMORY", () => {
		const store = createHistoryStore(null);
		for (let i = 0; i < 105; i++) store.add(makeItem({ createdAt: i }));
		expect(store.items().length).toBe(100);
		expect(store.items()[0]?.createdAt).toBe(5);
	});

	it("handles a corrupt persisted payload gracefully", () => {
		const storage = memoryStorage();
		storage.setItem("sdcpp.video.history.item.h_bad", "{not json");
		const store = createHistoryStore(storage);
		expect(store.items().length).toBe(0);
	});

	it("does not throw when storage throws inside calls", () => {
		const failing: SyncStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
			keys: () => [],
		};
		const store = createHistoryStore(failing);
		expect(() => store.add(makeItem())).not.toThrow();
		expect(store.items().length).toBe(1);
	});
});
