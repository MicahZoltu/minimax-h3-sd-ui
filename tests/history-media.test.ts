import { describe, it, expect } from "bun:test";
import { createHistoryStore, type HistoryBackend, type HistoryStore } from "../app/ts/history.js";
import { fileKey, thumbnailKey, videoKey } from "../app/ts/media.js";
import type { HistoryItem } from "../app/ts/types.js";

// A faithful in-memory HistoryBackend mirroring idb.ts's store layout: history records under the
// id keyPath and raw Blobs under explicit keys in a separate media map. Bits live in a per-instance
// Map so a fresh createHistoryStore hydrating from the same backend simulates a page refresh.
type MemoryHistoryBackend = HistoryBackend & {
	records(): HistoryItem[];
	mediaMap(): Map<string, Blob>;
};

function memoryHistoryBackend(): MemoryHistoryBackend {
	const records: HistoryItem[] = [];
	const mediaMap = new Map<string, Blob>();
	return {
		isPersistent: () => true,
		async loadAll(): Promise<HistoryItem[]> {
			return records.map((r) => ({ ...r, persisted: true }));
		},
		async save(item, videoBlob): Promise<void> {
			records.push(item);
			mediaMap.set(videoKey(item.id), videoBlob);
		},
		async storeMedia(key, blob): Promise<void> {
			mediaMap.set(key, blob);
		},
		async setViewed(): Promise<void> {},
		async remove(id): Promise<void> {
			const index = records.findIndex((r) => r.id === id);
			const removed = records[index];
			if (index < 0) return;
			records.splice(index, 1);
			if (removed) {
				mediaMap.delete(videoKey(id));
				mediaMap.delete(thumbnailKey(id));
				for (let i = 0; i < removed.files.length; i++) mediaMap.delete(fileKey(id, i));
			}
		},
		async clear(): Promise<void> {
			records.length = 0;
			mediaMap.clear();
		},
		async loadMedia(key): Promise<Blob | null> {
			return mediaMap.get(key) ?? null;
		},
		records: () => records,
		mediaMap: () => mediaMap,
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	const id = "h_probe_" + Math.random().toString(36).slice(2);
	return {
		id,
		createdAt: Date.now(),
		prompt: "probe",
		zipName: null,
		mode: "prompt",
		// files is filled by the caller; the base shape must satisfy isHistoryItem.
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

function flushToFresh(backend: MemoryHistoryBackend): HistoryStore {
	// Seed the backend records/media, then hydrate a brand-new store the way a reloaded page would.
	const fresh = createHistoryStore(backend);
	return fresh;
}

describe("history media externalization round trip", () => {
	it("new-item path (a): add() persists blobs by fileKey/thumbnailKey and loadFile resolves the same bytes", async () => {
		const backend = memoryHistoryBackend();
		const store = createHistoryStore(backend);
		const id = "h_add_path";
		const item = { ...makeItem({ id }), files: [{ name: "a.png", key: fileKey(id, 0), bytes: 2 }, { name: "b.png", key: fileKey(id, 1), bytes: 2 }] };
		const fileA = new Blob(["Aa"], { type: "image/png" });
		const fileB = new Blob(["Bb"], { type: "image/png" });
		const thumb = new Blob(["thumb"], { type: "image/png" });
		store.add(item, { video: new Blob(["v"]), thumbnail: thumb, files: [fileA, fileB] });
		await flush();

		// The record's files use the derived keys.
		expect(item.files[0]?.key).toBe(fileKey(id, 0));
		expect(item.files[1]?.key).toBe(fileKey(id, 1));

		// Cache hit: loadFile returns the exact Blob objects stored for the derived keys.
		expect(await store.loadFile(id, 0)).toBe(fileA);
		expect(await store.loadFile(id, 1)).toBe(fileB);
		expect(await store.loadThumbnail(id)).toBe(thumb);

		// Persistence hit: the backend resolved those same keys to the stored blobs (same bytes).
		const persisted0 = await backend.loadMedia(item.files[0]?.key ?? "");
		const persisted1 = await backend.loadMedia(item.files[1]?.key ?? "");
		const persistedThumb = await backend.loadMedia(thumbnailKey(id));
		expect(persisted0).not.toBeNull();
		expect(persisted1).not.toBeNull();
		expect(persistedThumb).not.toBeNull();
		expect(new Uint8Array(await (persisted0 as Blob).arrayBuffer())).toEqual(new Uint8Array(await fileA.arrayBuffer()));
		expect(new Uint8Array(await (persisted1 as Blob).arrayBuffer())).toEqual(new Uint8Array(await fileB.arrayBuffer()));
		expect(persistedThumb?.size).toBe(thumb.size);
	});

	it("loads each blob by its recorded file.key, never by a renumbered array index (non-contiguous keys)", async () => {
		// A v4 record can carry file keys that are not contiguous with the array (historically a legacy migration
		// dropped an entry's dataUrl but kept a later file's original key). Re-deriving the key from the array index
		// (loadFile(id, index)) would read `${id}:file:1` here and miss, but the recorded key resolves.
		const id = "h_skew";
		const item = makeItem({ id, files: [{ name: "a.png", key: fileKey(id, 0), bytes: 2 }, { name: "c.png", key: fileKey(id, 2), bytes: 2 }] });
		const backend = memoryHistoryBackend();
		await backend.save(item, new Blob(["v"]));
		await backend.storeMedia(fileKey(id, 0), new Blob(["Aa"], { type: "image/png" }));
		await backend.storeMedia(fileKey(id, 2), new Blob(["Cc"], { type: "image/png" }));

		const store = flushToFresh(backend);
		await store.load();
		const hydrated = store.items()[0];
		if (!hydrated) throw new Error("item missing");

		// Array-index loadFile(id, 1) re-derives file:1 (no blob); the consumer must use the recorded key instead.
		expect(await store.loadFile(id, 1)).toBeNull();
		for (const file of hydrated.files) {
			const blob = await store.loadFileByKey(file.key);
			expect(blob).not.toBeNull();
		}
		expect((await store.loadFileByKey(hydrated.files[1]?.key ?? ""))?.size).toBe(2);
	});
});
