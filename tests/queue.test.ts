import { describe, it, expect } from "bun:test";
import { createStore } from "../app/ts/state.js";
import { pump } from "../app/ts/queue.js";
import type { QueueItem } from "../app/ts/types.js";

function memoryLocalStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		key: (i: number) => [...map.keys()][i] ?? null,
		clear: () => map.clear(),
		get length() { return map.size; },
	} as Storage;
}

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
 * Install a DOM stub so captureVideoThumbnail resolves asynchronously (on a macrotask), exactly
 * like a real <video> loading. handleCompleted therefore contains real awaits before the item is
 * removed from the queue and recorded to history — the window in which a fire-and-forget call
 * would let pump wrongly see an active job and stop.
 */
function installAsyncThumbnail(): void {
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
		} as unknown as HTMLVideoElement & { __ready: () => void };
		const setReady = () => {
			Object.defineProperty(el, "readyState", { configurable: true, value: 2 });
			videoListeners.get("loadeddata")?.();
		};
		el.__ready = setReady;
		// Simulate media loading on the next macrotask.
		setTimeout(setReady, 10);
		return el;
	}
	(globalThis as unknown as { document: unknown }).document = {
		createElement: (tag: string) => (tag === "video" ? videoFactory() : tag === "canvas" ? { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }), toDataURL: () => "data:image/jpeg;base64,TG9yZW0=" } : {}),
	} as Document;
	(globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = () => "blob:queue-test";
	(globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = () => {};
}

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for predicate");
		await new Promise((r) => setTimeout(r, 25));
	}
};

describe("queue advancement", () => {
	it("advances to the next queued item only after a completing video job is fully booked", async () => {
		(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage();

		const submitted: string[] = [];
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/vid_gen")) {
				const id = "SRV-" + (submitted.length + 1);
				submitted.push(id);
				return new Response(JSON.stringify({ id, status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.includes("/jobs/")) {
				return new Response(JSON.stringify({ id: "SRV", status: "completed", started: 1700000000000, completed: 1700000001000, result: { output_format: "webm", b64_json: "QUJD", frame_count: 49, fps: 30 } }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		installAsyncThumbnail();

		const s = createStore();
		s.pushQueue(queued("q1"));
		s.pushQueue(queued("q2"));

		void pump(s);

		// q1 runs first (FIFO), submits, and its server job reports completed. Because the
		// thumbnail capture is async, q1's handleCompleted spans macrotasks before the item is
		// removed from the queue. The queue must still advance to q2 once that bookkeeping lands.
		await waitFor(() => submitted.length >= 2, 6000);

		expect(submitted.length).toBeGreaterThanOrEqual(2);
		// q1's completion is recorded to history (not just dropped).
		expect(s.history.items().some((i) => i.prompt === "a dog")).toBe(true);
	});
});
