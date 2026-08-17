import { type QueueBackend } from "../../app/ts/history.js";
import { isQueueItem } from "../../app/ts/history.js";
import type { QueueItem } from "../../app/ts/types.js";

/**
 * In-memory QueueBackend standing in for the real IndexedDB backend (Bun has no native handle on
 * IndexedDB). It satisfies the async backend contract and persists at module-instance scope across
 * separate createStore() calls, simulating a page refresh sharing the same origin's database.
 */
export type MemoryQueueBackend = QueueBackend & {
	seed(payload: QueueItem[]): void;
};

export function memoryQueueBackend(): MemoryQueueBackend {
	let items: QueueItem[] = [];
	return {
		// Copy so the caller's live array mutations (the store mutates state.queue in place and passes
		// the same reference) never mutate what we think we persisted.
		async load(): Promise<QueueItem[]> {
			return items.map((i) => ({ ...i, files: i.files.map((f) => ({ ...f })) }));
		},
		async save(next: QueueItem[]): Promise<void> {
			items = next.map((i) => ({ ...i, files: i.files.map((f) => ({ ...f })) }));
		},
		// Exposed only so a test can seed the backend before a store hydrates from it.
		seed(payload: QueueItem[]): void {
			items = payload.filter(isQueueItem);
		},
	};
}
