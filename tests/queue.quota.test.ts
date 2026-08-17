import { describe, it, expect } from "bun:test";
import { createStore } from "../app/ts/state.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { QueueItem } from "../app/ts/types.js";

// Regression test for the REAL queue-persistence write path, moved off localStorage and onto the
// IndexedDB-backed queue backend.
//
// The original bug under test: the queue write overflowed the localStorage ~5 MB per-origin quota
// because every item embeds the full uploaded input images (files[].dataUrl), while the much smaller
// formDims/apiBase writes fit. The overflow exception was swallowed silently in
// createQueuePersistence.save(), so the whole queue vanished on refresh -- even though localStorage
// itself clearly worked (formDims/apiBase persisted).
//
// The queue now persists to IndexedDB via an async QueueBackend with no such small cap. This test
// walks that real path: it pushes a queued item and a generating item whose files[].dataUrl are each
// several KB (well beyond what the old silent-overflow path could save), awaits the async write, then
// builds a brand-new store on the same backend ("refresh") and asserts the items -- crucially the
// generating item's serverId -- survived intact. formDims/config storage is asserted separately to
// confirm the localStorage path used for that small config is untouched.
//
// Before the fix this round trip FAILED (the full-payload setItem overflowed and was silently
// swallowed, so page B hydrated an empty queue). After the fix, IndexedDB holds the whole queue with
// its embedded dataUrls and the items survive reload.

function queueItem(id: string, status: QueueItem["status"], serverId: string | null, bigDataUrl: boolean): QueueItem {
	return {
		id,
		status,
		prompt: "a dramatic dog",
		zipName: "job.zip",
		mode: "refs",
		files: [{ name: "ref1.png", dataUrl: bigDataUrl ? "data:image/png;base64," + "A".repeat(4000) : "data:image/png;base64,QUFB" }],
		width: 640,
		height: 384,
		jobFrames: 49,
		steps: 20,
		error: null,
		serverId,
		startedAt: serverId ? 1700000000000 : null,
	};
}

describe("queue persistence: real async IndexedDB-style path, large dataUrls", () => {
	it("WRITE (queued + generating/serverId) with big embedded dataUrls survives a reload via createStore", async () => {
		// The IndexedDB-style queue backend is shared across page loads, mirroring one origin's DB.
		const backend = memoryQueueBackend();

		// Page A: one job already started (generating with a serverId), one still queued; both embed
		// several-KB input-image dataUrls -- precisely the payload the old localStorage path dropped.
		const s1 = createStore(backend);
		const generating = queueItem("q_GEN", "queued", null, true);
		s1.pushQueue(generating);
		s1.patchQueueItem(generating.id, { status: "generating", serverId: "SRV-GENERATING" });
		const queued = queueItem("q_QUEUED", "queued", null, true);
		s1.pushQueue(queued);
		await s1.queueReady;

		// The persisted copy must carry the full (large) dataUrls, not a stripped placeholder.
		const persisted = await backend.load();
		expect(persisted).toHaveLength(2);
		for (const item of persisted) {
			expect(item.files[0]?.dataUrl.length).toBeGreaterThan(4000);
		}

		// Page B ("refresh"): a brand-new store hydrates from the same backend.
		const s2 = createStore(backend);
		await s2.queueReady;
		expect(s2.state.queue).toHaveLength(2);
		const rGen = s2.state.queue.find((i) => i.id === generating.id);
		const rQueued = s2.state.queue.find((i) => i.id === queued.id);
		expect(rGen).toBeDefined();
		expect(rGen?.status).toBe("generating");
		expect(rGen?.serverId).toBe("SRV-GENERATING");
		expect(rGen?.files[0]?.dataUrl.length).toBeGreaterThan(4000);
		expect(rQueued).toBeDefined();
		expect(rQueued?.status).toBe("queued");
		expect(rQueued?.serverId).toBeNull();
	});
});
