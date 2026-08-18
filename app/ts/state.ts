// Central in-memory app state with a minimal subscription model.
// This is the single source of truth the UI renders from; generation logic mutates it and emits change notifications.
// Nothing here touches the network or storage backend directly -- that lives in api.ts / history.ts.

import { getCapabilities, supportsVideoProgress, type Capabilities, type JobProgress } from "./api.js";
import { getApiBase, getDefaultBase, setApiBase as writeApiBase, resetApiBase as clearApiBase } from "./config.js";
import type { HistoryItem, QueueItem, ZipAnalysis } from "./types.js";
import { createHistoryStore, detectSyncStorage, type QueueBackend, type SyncStorage } from "./history.js";
import { createIdbHistory, createIdbQueue } from "./idb.js";
import { GENERATION_PRESET } from "./request.js";

const FORM_STORAGE_KEY = "sdcpp.video.formDims";

/**
 * Shown when the connected server does not advertise video generation progress.
 * Set once the server is known to be online but missing the feature, and used both to surface a
 * clear connect-time error in the UI and to refuse to start generation without the feature.
 */
export const VIDEO_PROGRESS_ERROR =
	"The attached server is missing the generation-progress feature, which this UI requires. Please serve from a stable-diffusion.cpp examples/server that reports video generation progress.";

interface SavedFormDims {
	width: number;
	height: number;
	frames: number;
	steps: number;
}

function readSavedFormDims(storage: SyncStorage | null): SavedFormDims | null {
	if (!storage) return null;
	try {
		const raw = storage.getItem(FORM_STORAGE_KEY);
		if (!raw) return null;
		const v: unknown = JSON.parse(raw);
		if (typeof v !== "object" || v === null) return null;
		try {
			const o = v as Record<string, unknown>;
			const width = o["width"];
			const height = o["height"];
			const frames = o["frames"];
			const steps = o["steps"];
			if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
			if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
			if (typeof frames !== "number" || !Number.isFinite(frames) || frames <= 0) return null;
			if (typeof steps !== "number" || !Number.isFinite(steps) || steps <= 0) return null;
			return { width, height, frames, steps };
		} catch {
			return null;
		}
	} catch {
		return null;
	}
}

function writeSavedFormDims(storage: SyncStorage | null, dims: SavedFormDims): void {
	if (!storage) return;
	try {
		storage.setItem(FORM_STORAGE_KEY, JSON.stringify(dims));
	} catch {
		// Best-effort; ignore.
	}
}

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
	/** True when the server advertises generation progress for video jobs. */
	vidProgress: boolean;
	/** Non-null when the server is online but does not advertise video generation progress. */
	progressError: string | null;
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
	/** Resolves once the initial queue load from the persisted backend has completed. */
	queueReady: Promise<void>;
	subscribe(fn: () => void): () => void;
	emit(): void;
	pushQueue(item: QueueItem): void;
	patchQueueItem(id: string, patch: Partial<QueueItem>): void;
	/**
	 * Record the latest generation progress for a running item.
	 * Unlike patchQueueItem it is in-memory only: it neither bumps the queue revision (so frequent
	 * polls do not rebuild the list) nor persists, because progress is transient and changes every poll.
	 */
	setQueueProgress(id: string, progress: JobProgress): void;
	removeQueue(id: string): void;
	moveQueue(from: number, to: number): void;
	addHistory(item: HistoryItem, videoBlob: Blob): void;
	removeHistory(id: string): void;
	removeOldestHistory(count: number): void;
	clearHistory(): void;
	setResident(id: string): Promise<void>;
	residentId(): string | null;
	residentUrl(): string | null;
	residentBlob(): Blob | null;
	setForm(patch: Partial<NewJobForm>): void;
	setFormDim(field: "width" | "height" | "frames" | "steps", value: number): void;
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

export function createStore(queueBackend: QueueBackend = createIdbQueue()): Store {
	const listeners = new Set<() => void>();
	const state: AppState = {
		caps: null,
		online: false,
		capsError: null,
		vidProgress: false,
		progressError: null,
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
	// The in-memory queue starts empty and is hydrated asynchronously from the IndexedDB backend.
	// queueReady resolves once that initial load lands, so startup can await it before resuming jobs.
	let resolveQueueReady: () => void = () => {};
	const queueReady = new Promise<void>((resolve) => {
		resolveQueueReady = resolve;
	});
	// Counts in-memory queue mutations; hydration only applies the loaded snapshot when none happened
	// while the load was in flight, so a fast user action is never clobbered by a stale read.
	let queueWrites = 0;
	const queueWritesAtStart = 0;
	let hadSavedDims = false;
	const savedDims = readSavedFormDims(storage);
	if (savedDims) {
		state.form.width = savedDims.width;
		state.form.height = savedDims.height;
		state.form.frames = savedDims.frames;
		state.form.steps = savedDims.steps;
		hadSavedDims = true;
	}
	let resident: { id: string; blob: Blob; url: string } | null = null;

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

	const clearResident = (): void => {
		if (!resident) return;
		URL.revokeObjectURL(resident.url);
		resident = null;
	};

	const fetchCapabilities = async (): Promise<void> => {
		try {
			const caps = await getCapabilities();
			state.caps = caps;
			state.online = true;
			state.capsError = null;
			state.vidProgress = supportsVideoProgress(caps);
			state.progressError = state.vidProgress ? null : VIDEO_PROGRESS_ERROR;
			state.apiBase = getApiBase();
			emit();
			const v = caps.defaults_by_mode?.vid_gen;
			const f = state.form;
			if (!f.analysis && !hadSavedDims) {
				// Width/height come from server defaults when available; frames and steps keep the app defaults (107 / preset steps).
				state.form.width = v?.width ?? FALLBACK_DIMS.width;
				state.form.height = v?.height ?? FALLBACK_DIMS.height;
			}
		} catch (err) {
			state.online = false;
			state.capsError = err instanceof Error ? err.message : String(err);
			state.progressError = null;
			emit();
		}
	};

	// History is hydrated asynchronously from the backend; emit once it lands so the UI renders persisted items.
	const store: Store = {
		state,
		revs,
		history,
		queueReady,
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
		setFormDim: (field, value) => {
			state.form[field] = value;
			hadSavedDims = true;
			writeSavedFormDims(storage, {
				width: state.form.width,
				height: state.form.height,
				frames: state.form.frames,
				steps: state.form.steps,
			});
		},
		pushQueue: (item) => {
			state.queue.unshift(item);
			revs.queue += 1;
			queueWrites += 1;
			emit();
			// Mutate in-memory synchronously (the UI source of truth), persist best-effort in the background.
			void queueBackend.save(state.queue);
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
				queueWrites += 1;
				emit();
				void queueBackend.save(state.queue);
			}
		},
		setQueueProgress: (id, progress) => {
			const item = state.queue.find((i) => i.id === id);
			if (!item) return;
			// Skip work when the value is unchanged so emit() fires only on an actual update.
			if (item.progress && item.progress.step === progress.step && item.progress.steps === progress.steps) return;
			item.progress = progress;
			emit();
		},
		removeQueue: (id) => {
			const idx = findIndex(id);
			if (idx < 0) return;
			state.queue.splice(idx, 1);
			revs.queue += 1;
			queueWrites += 1;
			emit();
			void queueBackend.save(state.queue);
		},
		moveQueue: (from, to) => {
			const q = state.queue;
			if (from < 0 || from >= q.length || to < 0 || to >= q.length) return;
			const [item] = q.splice(from, 1);
			if (item === undefined) return;
			q.splice(to, 0, item);
			revs.queue += 1;
			queueWrites += 1;
			void queueBackend.save(state.queue);
			emit();
		},
		addHistory: (item, videoBlob) => {
			history.add(item, videoBlob);
			emit();
		},
		removeHistory: (id) => {
			history.remove(id);
			if (resident?.id === id) clearResident();
			emit();
		},
		removeOldestHistory: (count) => {
			history.removeOldest(count);
			const rid = resident?.id ?? null;
			if (rid !== null && !history.items().some((i) => i.id === rid)) clearResident();
			emit();
		},
		clearHistory: () => {
			history.clear();
			const rid = resident?.id ?? null;
			if (rid !== null && !history.items().some((i) => i.id === rid)) clearResident();
			emit();
		},
		setResident: async (id) => {
			if (resident?.id === id) return;
			const blob = await history.loadVideoBlob(id);
			if (!blob) return;
			if (resident) URL.revokeObjectURL(resident.url);
			resident = { id, blob, url: URL.createObjectURL(blob) };
			emit();
		},
		residentId: () => (resident ? resident.id : null),
		residentUrl: () => (resident ? resident.url : null),
		residentBlob: () => (resident ? resident.blob : null),
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

	void history.load().then(() => {
		emit();
		const newest = history.items().at(-1);
		if (newest) void store.setResident(newest.id);
	});

	// Hydrate the queue from the persisted backend. The load is best-effort (never throws): when the
	// backend is unavailable it resolves to an empty queue and the session is queue-only-like-memory.
	void (async () => {
		const loaded = await queueBackend.load();
		// Only surface the persisted snapshot if nothing was mutated while it was loading, so an early
		// user action is never clobbered by a stale read (load is typically faster than user input).
		if (queueWrites === queueWritesAtStart) {
			state.queue = loaded;
			revs.queue += 1;
			emit();
		}
		resolveQueueReady();
	})();
	return store;
}
