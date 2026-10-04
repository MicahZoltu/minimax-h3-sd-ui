import { describe, it, expect } from "bun:test";
import { createStore } from "../app/ts/state.js";
import { resumeActiveJobs } from "../app/ts/queue.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { QueueItem } from "../app/ts/types.js";

// A realistic persisted queue as the app's OWN write path would have left it in IndexedDB before a
// refresh: one `generating` item that had been patched with a serverId, plus a `queued` item.
const generatingItem: QueueItem = {
	id: "q_GEN",
	status: "generating",
	prompt: "persisted dog",
	zipName: "d.zip",
	mode: "prompt",
	files: [{ name: "a.png", dataUrl: "data:image/png;base64,AAAA" }],
	videos: [],
	audios: [],
	width: 640,
	height: 384,
	jobFrames: 49,
	steps: 20,
	error: null,
	serverId: "SRV-GENERATING",
	startedAt: 1700000000000,
};

const queuedItem: QueueItem = {
	id: "q_QUEUED",
	status: "queued",
	prompt: "queued cat",
	zipName: "c.zip",
	mode: "refs",
	files: [{ name: "r1.png", dataUrl: "data:image/png;base64,QUFB" }],
	videos: [],
	audios: [],
	width: 512,
	height: 512,
	jobFrames: 33,
	steps: 25,
	error: null,
	serverId: null,
	startedAt: null,
};

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for predicate");
		await new Promise((r) => setTimeout(r, 25));
	}
};

/**
 * Install a minimal DOM stub so the completion path's video-thumbnail capture can run in Bun.
 * The capture is best-effort inside the app, so a degraded canvas (no getImageData) still lets the
 * completed item land in history with its video Blob.
 */
function installThumbnailDomStubs(): void {
	const videoListeners = new Map<string, (() => void) | undefined>();
	function videoFactory(): HTMLVideoElement {
		const el = {
			src: "",
			muted: false,
			playsInline: true,
			currentTime: 0,
			videoWidth: 320,
			videoHeight: 240,
			readyState: 0,
			addEventListener: (t: string, cb: () => void) => void videoListeners.set(t, cb),
		} as unknown as HTMLVideoElement;
		const setReady = () => {
			Object.defineProperty(el, "readyState", { configurable: true, value: 2 });
			videoListeners.get("loadeddata")?.();
		};
		setTimeout(setReady, 10);
		return el;
	}
	(globalThis as unknown as { document: unknown }).document = {
		createElement: (tag: string) => (tag === "video" ? videoFactory() : tag === "canvas" ? { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }), toDataURL: () => "data:image/jpeg;base64,TG9yZW0=" } : {}),
	} as Document;
	(globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = () => "blob:refresh-test";
	(globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = () => {};
}

describe("refresh persistence round-trip (reported bug)", () => {
	it("load() restores both a queued item and a generating item with its serverId intact", async () => {
		const backend = memoryQueueBackend();
		backend.seed([generatingItem, queuedItem]);
		const loaded = await backend.load();
		expect(loaded.length).toBe(2);
		const gen = loaded.find((i) => i.id === generatingItem.id);
		const queued = loaded.find((i) => i.id === queuedItem.id);
		expect(gen).toBeDefined();
		expect(gen?.status).toBe("generating");
		expect(gen?.serverId).toBe("SRV-GENERATING");
		expect(queued).toBeDefined();
		expect(queued?.status).toBe("queued");
		expect(queued?.serverId).toBeNull();
	});

	it("createStore rehydrates both items and resumeActiveJobs re-polls the saved serverId while queued items remain", async () => {
		const backend = memoryQueueBackend();
		backend.seed([generatingItem, queuedItem]);

		// The resumed generating job stays generating on the server, so the client keeps polling it.
		const polledServerIds: string[] = [];
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.includes("/jobs/")) {
				const id = u.split("/jobs/")[1] ?? "";
				polledServerIds.push(id);
				return new Response(JSON.stringify({ id, status: "generating" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.endsWith("/vid_gen")) {
				return new Response(JSON.stringify({ id: "SRV-x", status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.endsWith("/capabilities")) {
				return new Response(JSON.stringify({ defaults_by_mode: { vid_gen: { width: 512, height: 512 } } }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const store = createStore(backend);
		// Wait for the async IndexedDB-style hydration before resuming jobs.
		await store.queueReady;
		// Assert rehydration landed BOTH items in state.queue.
		expect(store.state.queue.map((i) => i.id)).toEqual([generatingItem.id, queuedItem.id]);
		const gen = store.state.queue.find((i) => i.id === generatingItem.id);
		expect(gen?.status).toBe("generating");
		expect(gen?.serverId).toBe("SRV-GENERATING");

		resumeActiveJobs(store);

		// After at least one poll interval, the client must be re-polling the persisted serverId...
		await waitFor(() => polledServerIds.includes("SRV-GENERATING"), 4000);
		expect(polledServerIds).toContain("SRV-GENERATING");

		// ...and the queued item must still be present (nothing dropped, nothing force-advanced).
		await waitFor(() => polledServerIds.length >= 1, 4000);
		expect(store.state.queue.map((i) => i.id).sort()).toEqual([generatingItem.id, queuedItem.id]);
		expect(store.state.queue.find((i) => i.id === queuedItem.id)?.status).toBe("queued");
	});
});

describe("refresh resume flow fixes", () => {
	it("re-polls the resumed job immediately, without the initial POLL_MS wait", () => {
		const backend = memoryQueueBackend();
		backend.seed([generatingItem, queuedItem]);

		const polledServerIds: string[] = [];
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.includes("/jobs/")) {
				const id = u.split("/jobs/")[1] ?? "";
				polledServerIds.push(id);
				return new Response(JSON.stringify({ id, status: "generating" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const store = createStore(backend);
		return store.queueReady.then(() => {
			// resumeActiveJobs must fire the first jobs GET right away: the persisted job has long been
			// running, so sleeping a poll tick first would only delay the refreshed page's re-attachment.
			// No timer has advanced here, so the fetch must already have been invoked.
			resumeActiveJobs(store);
			expect(polledServerIds).toContain("SRV-GENERATING");
		});
	});

	it("a resumed submitting+serverId item is re-marked generating when the server reports the job running", async () => {
		const backend = memoryQueueBackend();
		const submittingItem: QueueItem = { ...generatingItem, id: "q_SUB", status: "submitting", startedAt: null, serverId: "SRV-SUBMITTING" };
		backend.seed([submittingItem, queuedItem]);

		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.includes("/jobs/")) {
				const id = u.split("/jobs/")[1] ?? "";
				return new Response(JSON.stringify({ id, status: "generating", started: 1700000000, progress: { step: 2, steps: 20, time: 0.5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.endsWith("/vid_gen")) {
				return new Response(JSON.stringify({ id: "SRV-x", status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const store = createStore(backend);
		await store.queueReady;
		expect(store.state.queue.find((i) => i.id === "q_SUB")?.status).toBe("submitting");

		resumeActiveJobs(store);

		await waitFor(() => store.state.queue.find((i) => i.id === "q_SUB")?.status === "generating", 4000);
		const sub = store.state.queue.find((i) => i.id === "q_SUB");
		expect(sub?.status).toBe("generating");
		// The server-reported start anchors the row's elapsed timer.
		expect(sub?.startedAt).toBe(1700000000000);
		// The queued item behind the resumed one is untouched (the pump must not double-start while the resumed job runs).
		expect(store.state.queue.find((i) => i.id === queuedItem.id)?.status).toBe("queued");
	});

	it("a queue mutation during hydration merges with the persisted snapshot instead of discarding it", async () => {
		const backend = memoryQueueBackend();
		backend.seed([queuedItem]);

		const store = createStore(backend);
		// Mutate while the hydration load is still in flight (before awaiting queueReady).
		const local: QueueItem = { ...queuedItem, id: "q_LOCAL", prompt: "locally added during hydration" };
		store.pushQueue(local);
		await store.queueReady;

		// The memory state is the union, the locally added item keeping its newest-first head position.
		expect(store.state.queue.map((i) => i.id)).toEqual(["q_LOCAL", queuedItem.id]);

		// The backend must have been repaired to the union as well, so a later rehydration sees both.
		const reloaded = createStore(backend);
		await reloaded.queueReady;
		expect(reloaded.state.queue.map((i) => i.id)).toEqual(["q_LOCAL", queuedItem.id]);
	});

	it("a resumed job completed while the page was closed lands in history with its video", async () => {
		const backend = memoryQueueBackend();
		backend.seed([generatingItem, queuedItem]);

		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.includes("/jobs/SRV-GENERATING")) {
				return new Response(JSON.stringify({ id: "SRV-GENERATING", status: "completed", started: 1700000000, completed: 1700000002, result: { output_format: "webm", b64_json: "QUJD", frame_count: 49, fps: 30 } }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.includes("/jobs/")) {
				const id = u.split("/jobs/")[1] ?? "";
				return new Response(JSON.stringify({ id, status: "generating" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.endsWith("/vid_gen")) {
				return new Response(JSON.stringify({ id: "SRV-x", status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		installThumbnailDomStubs();

		const store = createStore(backend);
		await store.queueReady;
		resumeActiveJobs(store);

		// The completed job leaves the queue and is recorded into history...
		await waitFor(() => !store.state.queue.some((i) => i.id === generatingItem.id), 6000);
		const entry = store.history.items().find((i) => i.prompt === generatingItem.prompt);
		expect(entry).toBeDefined();
		// ...with its video payload retrievable from the history store.
		const video = entry ? await store.history.loadVideo(entry.id) : null;
		expect(video).not.toBeNull();
		// The queued item behind it remains (it only starts after the resumed job's bookkeeping settles).
		expect(store.state.queue.some((i) => i.id === queuedItem.id)).toBe(true);
	});
});
