import { describe, it, expect } from "bun:test";
import { createStore } from "../app/ts/state.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { QueueItem } from "../app/ts/types.js";

function queued(uid: string): QueueItem {
	return {
		id: uid,
		status: "queued",
		prompt: "a dog",
		zipName: "d.zip",
		mode: "prompt",
		files: [],
		width: 640,
		height: 384,
		jobFrames: 49,
		steps: 20,
		error: null,
		serverId: null,
		startedAt: null,
	};
}

/**
 * Regression test for the WRITE side of queue persistence through the async IndexedDB-style backend.
 * The app's own mutation path (pushQueue then patchQueueItem, exactly as addToQueue and the generation
 * runner do) must persist to the backend, and a fresh store reading the same backend on a simulated
 * reload must restore both a queued item and a generating item with its serverId intact.
 */
describe("queue persistence WRITE -> backend -> reload round trip", () => {
	it("populating via pushQueue/patchQueueItem persists both items to the backend", async () => {
		const backend = memoryQueueBackend();

		// Simulate the live session: one item was added then started (became generating w/ serverId);
		// a second item is still queued.
		const store = createStore(backend);
		const gen = queued("q_GEN");
		store.pushQueue(gen);
		store.patchQueueItem(gen.id, { status: "generating", serverId: "SRV-GENERATING", startedAt: 1700000000000 });
		const queuedItem = queued("q_QUEUED");
		store.pushQueue(queuedItem);
		await store.queueReady;

		// The mutation path must have persisted both items to the backend.
		const persisted = await backend.load();
		expect(persisted).toHaveLength(2);
		const pGen = persisted.find((i) => i.id === gen.id);
		const pQueued = persisted.find((i) => i.id === queuedItem.id);
		expect(pGen?.status).toBe("generating");
		expect(pGen?.serverId).toBe("SRV-GENERATING");
		expect(pQueued?.status).toBe("queued");
	});

	it("a brand-new store hydrating the persisted backend restores both items", async () => {
		const backend = memoryQueueBackend();

		const store = createStore(backend);
		const gen = queued("q_GEN");
		store.pushQueue(gen);
		store.patchQueueItem(gen.id, { status: "generating", serverId: "SRV-GENERATING", startedAt: 1700000000000 });
		const queuedItem = queued("q_QUEUED");
		store.pushQueue(queuedItem);
		await store.queueReady;

		// A page refresh shares the same origin's persisted queue: reuse the same backend instance,
		// exactly as a real IndexedDB database is shared across page loads.
		const reloaded = createStore(backend);
		await reloaded.queueReady;

		expect(reloaded.state.queue).toHaveLength(2);
		const rGen = reloaded.state.queue.find((i) => i.id === gen.id);
		const rQueued = reloaded.state.queue.find((i) => i.id === queuedItem.id);
		expect(rGen).toBeDefined();
		expect(rGen?.status).toBe("generating");
		expect(rGen?.serverId).toBe("SRV-GENERATING");
		expect(rQueued).toBeDefined();
		expect(rQueued?.status).toBe("queued");
		expect(rQueued?.serverId).toBeNull();
	});

	it("backend save then load round-trips the same items", async () => {
		const backend = memoryQueueBackend();
		const list = [queued("qA"), queued("qB")];
		await backend.save(list);
		const loaded = await backend.load();
		expect(loaded.map((i) => i.id).sort()).toEqual(["qA", "qB"]);
	});
});
