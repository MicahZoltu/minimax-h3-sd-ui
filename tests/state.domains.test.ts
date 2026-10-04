import { describe, it, expect, beforeEach } from "bun:test";
import { thumbnailKey } from "../app/ts/media.js";
import { createStore } from "../app/ts/state.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { HistoryMedia } from "../app/ts/history.js";
import type { HistoryItem, QueueItem } from "../app/ts/types.js";

let urlCounter = 0;
const revoked: string[] = [];

beforeEach(() => {
	urlCounter = 0;
	revoked.length = 0;
	(globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = (() => `blob:state/${++urlCounter}`) as typeof URL.createObjectURL;
	(globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
});

function historyItem(id: string): HistoryItem {
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
		video: { mime: "video/webm", format: "webm", byteSize: 1 },
		persisted: false,
		viewed: false,
	};
}

function media(overrides: Partial<HistoryMedia> = {}): HistoryMedia {
	return { video: new Blob(["v"]), thumbnail: new Blob(["t"]), files: [] as Blob[], videoThumbs: [], videoAudios: [], videoSources: [], audioSources: [], ...overrides };
}

function queued(uid: string): QueueItem {
	return {
		id: uid,
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
	};
}

describe("store domain notifications", () => {
	it("a subscriber registered for one domain is not called by another domain's emit", () => {
		const store = createStore(memoryQueueBackend());
		let formCalls = 0;
		let queueCalls = 0;
		let historyCalls = 0;
		store.subscribe(() => { formCalls += 1; }, ["form"]);
		store.subscribe(() => { queueCalls += 1; }, ["queue"]);
		store.subscribe(() => { historyCalls += 1; }, ["history"]);
		const item = queued("q1");

		store.setForm({ error: "x" });
		expect(formCalls).toBe(1);
		expect(queueCalls).toBe(0);
		expect(historyCalls).toBe(0);

		store.pushQueue(item);
		expect(queueCalls).toBe(1);
		expect(formCalls).toBe(1);
		expect(historyCalls).toBe(0);

		store.markHistoryViewed(item.id);
		expect(historyCalls).toBe(1);
		expect(queueCalls).toBe(1);
		expect(formCalls).toBe(1);
	});

	it("a default subscriber (no domain) is notified on any domain", () => {
		const store = createStore(memoryQueueBackend());
		let calls = 0;
		store.subscribe(() => { calls += 1; });
		store.setForm({ error: "y" });
		expect(calls).toBe(1);
	});

	it("setQueueProgress emits nothing (per-poll ticks neither bump the queue revision nor notify)", () => {
		const store = createStore(memoryQueueBackend());
		let queueCalls = 0;
		let historyCalls = 0;
		store.subscribe(() => { queueCalls += 1; }, ["queue"]);
		store.subscribe(() => { historyCalls += 1; }, ["history"]);

		store.pushQueue({ ...queued("q1"), status: "generating", serverId: "srv", startedAt: Date.now(), progress: { step: 1, steps: 20, time: 0.5 } });
		queueCalls = 0;
		historyCalls = 0;

		store.setQueueProgress("q1", { step: 5, steps: 20, time: 0.5 });
		expect(queueCalls).toBe(0);
		expect(historyCalls).toBe(0);
	});

	it("setQueueProgress skips a same-step/SAME-time no-op but stores a same-step with a newer time", () => {
		const store = createStore(memoryQueueBackend());
		const item: QueueItem = { ...queued("q1"), status: "generating", serverId: "srv", startedAt: Date.now() };
		store.pushQueue(item);
		store.setQueueProgress("q1", { step: 3, steps: 20, time: 0.5 });
		expect(store.state.queue[0]?.progress).toEqual({ step: 3, steps: 20, time: 0.5 });

		store.setQueueProgress("q1", { step: 3, steps: 20, time: 0.5 });
		expect(store.state.queue[0]?.progress).toEqual({ step: 3, steps: 20, time: 0.5 });

		store.setQueueProgress("q1", { step: 3, steps: 20, time: 0.8 });
		expect(store.state.queue[0]?.progress).toEqual({ step: 3, steps: 20, time: 0.8 });

		store.setQueueProgress("q1", { step: 4, steps: 20, time: 0.8 });
		expect(store.state.queue[0]?.progress).toEqual({ step: 4, steps: 20, time: 0.8 });
	});
});

describe("capability defaults", () => {
	it("fetchCapabilities routes server defaults through setForm: bumps revs.form and emits once", async () => {
		const originalFetch = globalThis.fetch;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => new Response(JSON.stringify({ defaults_by_mode: { vid_gen: { width: 640, height: 384 } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
		try {
			const store = createStore(memoryQueueBackend());
			let formCalls = 0;
			store.subscribe(() => { formCalls += 1; }, ["form"]);
			expect(store.state.form.width).toBe(512);
			expect(store.state.form.height).toBe(512);

			await store.fetchCapabilities();
			expect(store.state.form.width).toBe(640);
			expect(store.state.form.height).toBe(384);
			expect(store.revs.form).toBe(1);
			expect(formCalls).toBe(1);

			// A later probe with identical defaults must not re-emit, so the reconcile render (focus) is left alone.
			await store.fetchCapabilities();
			expect(store.revs.form).toBe(1);
			expect(formCalls).toBe(1);
		} finally {
			(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
		}
	});

	it("fetchCapabilities notifies the queue domain exactly when vidProgress flips (a resumed row can gain or lose its progress bar)", async () => {
		const originalFetch = globalThis.fetch;
		let advertiseProgress = true;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => new Response(JSON.stringify(advertiseProgress ? { features_by_mode: { vid_gen: { progress: true } } } : {}), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
		try {
			const store = createStore(memoryQueueBackend());
			await store.queueReady;
			let queueCalls = 0;
			store.subscribe(() => { queueCalls += 1; }, ["queue"]);
			// Baseline: the hydration merge has already made its own single queue bump by the time queueReady resolves.
			const baseRev = store.revs.queue;

			// First successful probe: vidProgress flips false -> true, so the queue domain must be notified.
			// This is what lets a job resumed before the first caps probe rebuild its row with a live bar:
			// the row's reconcile signature carries progressOk, so the notified render rebuilds only that row.
			await store.fetchCapabilities();
			expect(store.state.vidProgress).toBe(true);
			expect(store.revs.queue).toBe(baseRev + 1);
			expect(queueCalls).toBe(1);

			// A repeat probe with the flag already known is not a flip: the periodic probe must not re-render the queue.
			await store.fetchCapabilities();
			expect(store.revs.queue).toBe(baseRev + 1);
			expect(queueCalls).toBe(1);

			// A flip back (the server lost the feature) must notify again, so the bar is removed.
			advertiseProgress = false;
			await store.fetchCapabilities();
			expect(store.state.vidProgress).toBe(false);
			expect(store.revs.queue).toBe(baseRev + 2);
			expect(queueCalls).toBe(2);

			// Still no feature advertised: no flip, no notification.
			await store.fetchCapabilities();
			expect(store.revs.queue).toBe(baseRev + 2);
			expect(queueCalls).toBe(2);
		} finally {
			(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
		}
	});
});

describe("resident supersession", () => {
	it("drops a setResident whose blob read was superseded by a later request (residentId() never regresses)", async () => {
		// Drives the exact interleaving the lightbox view-video arm must survive: two setResident calls where each
		// awaits its own blob read. Because the reads are cached, each `await history.loadVideo` still yields a
		// microtask, so the calls overlap: the second starts before the first's await resumes. The first must be
		// dropped (its token was superseded) so residentId() reflects only the later request, never the earlier one.
		// If the lightbox arm merely re-read residentUrl() after its await, a superseded request would show the wrong
		// video; the guard `store.residentId() !== id` is what keeps it from opening a mislabeled one.
		const store = createStore(memoryQueueBackend());
		const mediaA = media({ video: new Blob(["va"]), thumbnail: new Blob(["ta"]) });
		store.addHistory(historyItem("a"), mediaA);
		store.addHistory(historyItem("b"), media({ video: new Blob(["vb"]), thumbnail: new Blob(["tb"]) }));

		expect(store.residentId()).toBeNull();
		const first = store.setResident("a");
		const second = store.setResident("b");
		await first;
		await second;
		// The first request was superseded: only the latest survives.
		expect(store.residentId()).toBe("b");
	});
});

describe("resident eviction", () => {
	it("clears and revokes the resident when memory-trimming evicts its item id", async () => {
		const store = createStore(memoryQueueBackend());
		const ids: string[] = [];
		for (let i = 0; i < 100; i++) {
			const id = `h_${i.toString().padStart(3, "0")}`;
			ids.push(id);
			store.addHistory(historyItem(id), media());
		}
		// Make the oldest item the resident; its URL is created and owned by the objectUrl registry.
		const residentId = "h_000";
		await store.setResident(residentId, new Blob(["vid"]));
		expect(store.residentId()).toBe(residentId);
		const residentUrl = store.residentUrl();
		if (residentUrl === null) throw new Error("expected a resident url");
		expect(residentUrl).toContain("blob:state/");

		// Adding one more item pushes h_000 past the in-memory cap, evicting it via trimMemory.
		store.addHistory(historyItem("h_101"), media());

		expect(store.residentId()).toBeNull();
		expect(store.residentUrl()).toBeNull();
		expect(store.residentBlob()).toBeNull();
		// The eviction must have revoked the resident's object URL.
		expect(revoked).toContain(residentUrl);
	});
});

describe("date-based history deletion", () => {
	it("removeHistoryBefore emits history once and clears the resident when it is removed", async () => {
		const store = createStore(memoryQueueBackend());
		// Let the store's initial async history hydration emit before counting emissions.
		await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
		store.addHistory({ ...historyItem("a"), createdAt: 1000 }, media());
		store.addHistory({ ...historyItem("b"), createdAt: 2000 }, media());
		await store.setResident("a", new Blob(["vid"]));
		expect(store.residentId()).toBe("a");

		let historyCalls = 0;
		store.subscribe(() => { historyCalls += 1; }, ["history"]);

		await store.removeHistoryBefore(2000);
		expect(historyCalls).toBe(1);
		// The boundary item (createdAt === cutoff) survives.
		expect(store.history.items().map((i) => i.id)).toEqual(["b"]);
		expect(store.residentId()).toBeNull();
	});
});

describe("oldest-based history deletion", () => {
	it("removeOldestHistory emits history once and clears the resident when it is removed", async () => {
		const store = createStore(memoryQueueBackend());
		// Let the store's initial async history hydration emit before counting emissions.
		await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
		store.addHistory({ ...historyItem("a"), createdAt: 1000 }, media());
		store.addHistory({ ...historyItem("b"), createdAt: 2000 }, media());
		await store.setResident("a", new Blob(["vid"]));
		expect(store.residentId()).toBe("a");

		let historyCalls = 0;
		store.subscribe(() => { historyCalls += 1; }, ["history"]);

		const removed = await store.removeOldestHistory(1);
		expect(removed).toEqual(["a"]);
		expect(historyCalls).toBe(1);
		expect(store.history.items().map((i) => i.id)).toEqual(["b"]);
		expect(store.residentId()).toBeNull();
	});

	it("countHistory reflects the archive union the delete-oldest control acts on", async () => {
		const store = createStore(memoryQueueBackend());
		// Let the store's initial async history hydration emit before counting.
		await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
		store.addHistory(historyItem("a"), media());
		store.addHistory(historyItem("b"), media());
		expect(await store.countHistory()).toBe(2);
		await store.removeOldestHistory(1);
		expect(await store.countHistory()).toBe(1);
	});
});
