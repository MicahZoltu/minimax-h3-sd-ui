import { describe, it, expect } from "bun:test";
import { createStore } from "../app/ts/state.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { QueueItem } from "../app/ts/types.js";

function queued(uid: string): QueueItem {
	return {
		id: uid,
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
});
