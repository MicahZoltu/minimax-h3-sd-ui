// Central in-memory app state with a minimal subscription model.
// This is the single source of truth the UI renders from; generation logic mutates it and emits change notifications.
// Nothing here touches the network or storage backend directly -- that lives in api.ts / history.ts.

import { getCapabilities, type Capabilities } from "./api.js";
import { getApiBase, getDefaultBase, setApiBase as writeApiBase, resetApiBase as clearApiBase } from "./config.js";
import type { HistoryItem, QueueItem, ZipAnalysis } from "./types.js";
import { createHistoryStore, createQueuePersistence, detectSyncStorage } from "./history.js";
import { createIdbHistory } from "./idb.js";
import { GENERATION_PRESET } from "./request.js";

// Keys of QueueItem, used to apply partial patches without untyped casts.
const QUEUE_KEYS = [
	"id",
	"status",
	"prompt",
	"mode",
	"files",
	"width",
	"height",
	"jobFrames",
	"steps",
	"error",
	"serverId",
	"startedAt",
] as const;

// Defaults shown in the new-job form.
// Steps mirrors the code's generation default; frames defaults to 107 per the product requirement.
export const FALLBACK_DIMS = {
	width: 512,
	height: 512,
	frames: 107,
	steps: GENERATION_PRESET.sampleSteps,
} as const;

export interface NewJobForm {
	zipName: string | null;
	analysis: ZipAnalysis | null;
	width: number;
	height: number;
	frames: number;
	steps: number;
	error: string | null;
	parsing: boolean;
}

export interface AppState {
	caps: Capabilities | null;
	online: boolean;
	capsError: string | null;
	/** Resolved API base URL currently used by the client. */
	apiBase: string;
	/** The base used when no override is configured. */
	defaultApiBase: string;
	queue: QueueItem[];
	form: NewJobForm;
}

export interface Revisions {
	/** Bumped whenever the add-job form state changes. */
	form: number;
	/** Bumped whenever the queue changes meaningfully. */
	queue: number;
}

export interface Store {
	state: AppState;
	/** Monotonic revision counters used by the UI to re-render only what changed. */
	revs: Revisions;
	history: ReturnType<typeof createHistoryStore>;
	subscribe(fn: () => void): () => void;
	emit(): void;
	pushQueue(item: QueueItem): void;
	patchQueueItem(id: string, patch: Partial<QueueItem>): void;
	removeQueue(id: string): void;
	moveQueue(from: number, to: number): void;
	addHistory(item: HistoryItem): void;
	removeHistory(id: string): void;
	removeOldestHistory(count: number): void;
	clearHistory(): void;
	setForm(patch: Partial<NewJobForm>): void;
	/**
	 * Set a new API base; throws on invalid input.
	 * Reconnects on success.
	 */
	setApiBase(value: string): string;
	/**
	 * Clear any API-base override back to the default.
	 * Reconnects.
	 */
	resetApiBase(): void;
	/** (Re)probe the server: fetch capabilities and update connectivity. */
	fetchCapabilities(): Promise<void>;
}

export function createStore(): Store {
	const listeners = new Set<() => void>();
	const state: AppState = {
		caps: null,
		online: false,
		capsError: null,
		apiBase: getApiBase(),
		defaultApiBase: getDefaultBase(),
		queue: [],
		form: {
			zipName: null,
			analysis: null,
			width: FALLBACK_DIMS.width,
			height: FALLBACK_DIMS.height,
			frames: FALLBACK_DIMS.frames,
			steps: FALLBACK_DIMS.steps,
			error: null,
			parsing: false,
		},
	};
	const storage = detectSyncStorage();
	const history = createHistoryStore(createIdbHistory());
	const queuePersistence = createQueuePersistence(storage);
	state.queue = queuePersistence.load();

	// Revision counters: the UI re-renders a region only when its counter changes, which keeps background polling from rebuilding the form and stealing focus while the user is typing.
	const revs: Revisions = { form: 0, queue: 0 };

	const emit = () => {
		for (const fn of [...listeners]) {
			try {
				fn();
			} catch {
				// A subscriber must never break the rest of the app.
			}
		}
	};

	const findIndex = (id: string) => state.queue.findIndex((i) => i.id === id);

	const fetchCapabilities = async (): Promise<void> => {
		try {
			const caps = await getCapabilities();
			state.caps = caps;
			state.online = true;
			state.capsError = null;
			state.apiBase = getApiBase();
			emit();
			const v = caps.defaults_by_mode?.vid_gen;
			const f = state.form;
			if (!f.analysis) {
				// Width/height come from server defaults when available; frames and steps keep the app defaults (107 / preset steps).
				state.form.width = v?.width ?? FALLBACK_DIMS.width;
				state.form.height = v?.height ?? FALLBACK_DIMS.height;
			}
		} catch (err) {
			state.online = false;
			state.capsError = err instanceof Error ? err.message : String(err);
			emit();
		}
	};

	// History is hydrated asynchronously from the backend; emit once it lands so the UI renders persisted items.
	const store: Store = {
		state,
		revs,
		history,
		subscribe: (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		emit,
		setForm: (patch) => {
			Object.assign(state.form, patch);
			revs.form += 1;
			emit();
		},
		pushQueue: (item) => {
			state.queue.unshift(item);
			revs.queue += 1;
			emit();
			queuePersistence.save(state.queue);
		},
		patchQueueItem: (id, patch) => {
			const item = state.queue.find((i) => i.id === id);
			if (!item) return;
			let changed = false;
			for (const k of QUEUE_KEYS) {
				if (!(k in patch)) continue;
				if (patch[k] !== item[k]) {
					changed = true;
					break;
				}
			}
			if (changed) {
				Object.assign(item, patch);
				revs.queue += 1;
				emit();
				queuePersistence.save(state.queue);
			}
		},
		removeQueue: (id) => {
			const idx = findIndex(id);
			if (idx < 0) return;
			state.queue.splice(idx, 1);
			revs.queue += 1;
			emit();
			queuePersistence.save(state.queue);
		},
		moveQueue: (from, to) => {
			const q = state.queue;
			if (from < 0 || from >= q.length || to < 0 || to >= q.length) return;
			const [item] = q.splice(from, 1);
			if (item === undefined) return;
			q.splice(to, 0, item);
			revs.queue += 1;
			queuePersistence.save(state.queue);
			emit();
		},
		addHistory: (item) => {
			history.add(item);
			emit();
		},
		removeHistory: (id) => {
			history.remove(id);
			emit();
		},
		removeOldestHistory: (count) => {
			history.removeOldest(count);
			emit();
		},
		clearHistory: () => {
			history.clear();
			emit();
		},
		setApiBase: (value) => {
			const normalized = writeApiBase(value);
			state.apiBase = getApiBase();
			emit();
			void fetchCapabilities();
			return normalized;
		},
		resetApiBase: () => {
			clearApiBase();
			state.apiBase = getApiBase();
			emit();
			void fetchCapabilities();
		},
		fetchCapabilities,
	};

	void history.load().then(() => emit());
	return store;
}
