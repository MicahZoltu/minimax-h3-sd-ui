import { describe, it, expect } from "bun:test";
import { createStore } from "../app/ts/state.js";
import { nextPending, pump, isRetriable } from "../app/ts/queue.js";
import { ApiError, isJobProgress } from "../app/ts/api.js";
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

describe("isJobProgress boundary", () => {
	it("rejects non-finite step/steps/time so a server value that parses to Infinity never renders", () => {
		expect(isJobProgress({ step: 1, steps: 20, time: 0.5 })).toBe(true);
		expect(isJobProgress({ step: Number.POSITIVE_INFINITY, steps: 20, time: 0.5 })).toBe(false);
		expect(isJobProgress({ step: 1, steps: Number.NaN, time: 0.5 })).toBe(false);
		expect(isJobProgress({ step: 1, steps: 20, time: Number.NEGATIVE_INFINITY })).toBe(false);
	});
});

describe("FIFO run-order invariant", () => {
	it("keeps the queue newest-first and runs the oldest queued item next (FIFO)", () => {
		(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage();
		const s = createStore();
		s.pushQueue(queued("q1"));
		s.pushQueue(queued("q2"));
		s.pushQueue(queued("q3"));

		// pushQueue unshifts, so the in-memory array is newest-first.
		expect(s.state.queue.map((i) => i.id)).toEqual(["q3", "q2", "q1"]);

		// nextPending scans from the end: the oldest item runs first each time it is consumed.
		expect(nextPending(s)?.id).toBe("q1");
		s.removeQueue("q1");
		expect(nextPending(s)?.id).toBe("q2");
		s.removeQueue("q2");
		expect(nextPending(s)?.id).toBe("q3");
	});
});

describe("job-poll status handling", () => {
	it("fails the item promptly when the server reports an unrecognized job status (no infinite spin)", async () => {
		(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage();
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/vid_gen")) {
				return new Response(JSON.stringify({ id: "SRV-X", status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.includes("/jobs/")) {
				// A status outside the known set must terminate the poll, not spin forever.
				return new Response(JSON.stringify({ id: "SRV-X", status: "mystery" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const s = createStore();
		s.pushQueue(queued("q_bad"));
		void pump(s);

		await waitFor(() => s.state.queue.some((i) => i.id === "q_bad" && i.status === "failed"), 5000);
		const item = s.state.queue.find((i) => i.id === "q_bad");
		expect(item?.status).toBe("failed");
		expect(item?.error).toBeTruthy();
	});

	it("keeps the known terminal status transitions unchanged (failed marks failed, cancelled marks cancelled)", async () => {
		(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage();
		let submitted = 0;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/vid_gen")) {
				submitted += 1;
				return new Response(JSON.stringify({ id: "SRV-" + submitted, status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.includes("/jobs/")) {
				const serverId = u.split("/jobs/")[1] ?? "";
				if (serverId === "SRV-1") {
					return new Response(JSON.stringify({ id: "SRV-1", status: "failed", error: { message: "model blew up" } }), { status: 200, headers: { "Content-Type": "application/json" } });
				}
				return new Response(JSON.stringify({ id: "SRV-2", status: "cancelled" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const s = createStore();
		s.pushQueue(queued("q_f"));
		s.pushQueue(queued("q_c"));
		void pump(s);

		await waitFor(() => {
			const f = s.state.queue.find((i) => i.id === "q_f");
			const c = s.state.queue.find((i) => i.id === "q_c");
			return f?.status === "failed" && c?.status === "cancelled";
		}, 6000);

		const failed = s.state.queue.find((i) => i.id === "q_f");
		const cancelled = s.state.queue.find((i) => i.id === "q_c");
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toBe("model blew up");
		expect(cancelled?.status).toBe("cancelled");
		expect(cancelled?.error).toBe("Job was cancelled.");
	});
});

describe("completed-job payload robustness", () => {
	it("fails the item (and does not freeze the queue) when b64_json is a truthy non-string", async () => {
		(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage();
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/vid_gen")) {
				return new Response(JSON.stringify({ id: "SRV-NS", status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.includes("/jobs/")) {
				return new Response(JSON.stringify({ id: "SRV-NS", status: "completed", result: { output_format: "webm", b64_json: 12345 } }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const s = createStore();
		s.pushQueue(queued("q_ns"));
		void pump(s);

		// A truthy non-string b64_json would make the old b64.trim()/atob throw outside any catch, stranding the item at generating.
		await waitFor(() => s.state.queue.some((i) => i.id === "q_ns" && i.status === "failed"), 5000);
		const item = s.state.queue.find((i) => i.id === "q_ns");
		expect(item?.status).toBe("failed");
		expect(item?.error).toBeTruthy();
		// The queue is not left wedged on a generating item.
		expect(s.state.queue.some((i) => i.id === "q_ns" && i.status === "generating")).toBe(false);
	});

	it("fails the item (and does not freeze the queue) when b64_json holds invalid base64", async () => {
		(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage();
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/vid_gen")) {
				return new Response(JSON.stringify({ id: "SRV-IB64", status: "queued" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (u.includes("/jobs/")) {
				return new Response(JSON.stringify({ id: "SRV-IB64", status: "completed", result: { output_format: "webm", b64_json: "!!!not-base64!!!" } }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const s = createStore();
		s.pushQueue(queued("q_ib64"));
		void pump(s);

		// atob throws a DOMException on illegal characters; it must degrade the item to failed, not freeze the queue.
		await waitFor(() => s.state.queue.some((i) => i.id === "q_ib64" && i.status === "failed"), 5000);
		const item = s.state.queue.find((i) => i.id === "q_ib64");
		expect(item?.status).toBe("failed");
		expect(item?.error).toContain("video payload");
		expect(s.state.queue.some((i) => i.id === "q_ib64" && i.status === "generating")).toBe(false);
	});
});

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
				return new Response(JSON.stringify({ id: "SRV", status: "completed", started: 1700000000, completed: 1700000002, result: { output_format: "webm", b64_json: "QUJD", frame_count: 49, fps: 30 } }), { status: 200, headers: { "Content-Type": "application/json" } });
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

describe("submit retry classification", () => {
	it("treats a protocol/service error as non-transient but a network failure as retriable", () => {
		// A 200 response whose body is not a valid Job throws ApiError(..., 0, "service").
		// It must NOT be classified retriable: re-POSTing can spawn a duplicate server job.
		expect(isRetriable(new ApiError("Invalid job response.", 0, "service"))).toBe(false);
		// A genuine transient network failure (the request() path wraps it as status 0, code "network")
		// stays retriable, matching the poll path that keeps polling on such transient issues.
		expect(isRetriable(new ApiError("Could not reach the server.", 0, "network"))).toBe(true);
		// Not an ApiError at all is not retriable (nothing to retry against a malformed submit).
		expect(isRetriable(new Error("boom"))).toBe(false);
	});

	it("fails the item after a single POST when submit returns a malformed (but HTTP 200) job body", async () => {
		(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage();
		let submitted = 0;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/vid_gen")) {
				submitted += 1;
				// A 200 with a body that is not a valid Job: submitVideoJob throws a "service" error.
				return new Response(JSON.stringify({ nope: true }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const s = createStore();
		s.pushQueue(queued("q_malformed"));
		void pump(s);

		await waitFor(() => s.state.queue.some((i) => i.id === "q_malformed" && i.status === "failed"), 5000);
		const item = s.state.queue.find((i) => i.id === "q_malformed");
		expect(item?.status).toBe("failed");
		expect(item?.error).toContain("Could not start the job");
		// A malformed-but-acknowledged response must be POSTed exactly once; the previous code
		// re-POSTed it up to 3 extra times, each cap-shedding a distinct server-side job.
		expect(submitted).toBe(1);
	});
});
