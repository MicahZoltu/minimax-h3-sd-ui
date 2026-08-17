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
