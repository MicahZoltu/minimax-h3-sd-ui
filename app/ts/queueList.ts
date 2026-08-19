// Queue list row builders, their reconcile specs, and the in-place live paint helpers.
// These take a store and optionally a row element; none of them holds mount-closure transient state.

import { h, type Child } from "./dom.js";
import { itemTitle, progressLabel, progressPercent, statusLabel, truncate } from "./format.js";
import type { ReconcileRowSpec } from "./list.js";
import type { Store } from "./state.js";
import type { QueueItem } from "./types.js";
import { formatElapsed } from "./utils.js";

// A queue row's lazy reconcile spec: reuse an existing row when its data-sig still matches, else rebuild it.
function queueRowSpec(item: QueueItem, queuedIndex: number, queuedCount: number, progressOk: boolean): ReconcileRowSpec {
	const sig = queueRowSignature(item, queuedIndex, queuedCount, progressOk);
	return {
		id: item.id,
		isSame: (existing) => existing.getAttribute("data-sig") === sig,
		build: () => buildQueueRow(item, queuedIndex, queuedCount, progressOk),
	};
}

// Emit queue reconcile specs in display order: queued items (array order), then failed/cancelled items, then the single active item pinned last so it sits just above the history group.
export function buildQueueRowSpecs(store: Store): ReconcileRowSpec[] {
	const q = store.state.queue;
	const queued = q.filter((i) => i.status === "queued");
	const stuck = q.filter((i) => i.status === "failed" || i.status === "cancelled");
	const active = q.filter((i) => i.status === "submitting" || i.status === "generating");
	const progressOk = store.state.vidProgress;
	const specs: ReconcileRowSpec[] = [];
	queued.forEach((item, index) => specs.push(queueRowSpec(item, index, queued.length, progressOk)));
	stuck.forEach((item) => specs.push(queueRowSpec(item, -1, 0, progressOk)));
	active.forEach((item) => specs.push(queueRowSpec(item, -1, 0, progressOk)));
	return specs;
}

// A stable fingerprint of a queue row's dynamic content, so the queue reconcile can reuse an existing node
// (preserving its open <details> and live [data-progress]) unless its content actually changed.
function queueRowSignature(item: QueueItem, queuedIndex: number, queuedCount: number, progressOk: boolean): string {
	return JSON.stringify([item.status, item.error ?? null, item.startedAt ?? null, queuedIndex === 0, queuedIndex === queuedCount - 1, progressOk]);
}

export function buildQueueRow(item: QueueItem, queuedIndex = -1, queuedCount = 0, progressOk = false): HTMLElement {
	const isQueued = item.status === "queued";
	const isActive = item.status === "submitting" || item.status === "generating";
	const chip = h("span", { class: `chip ${item.status}` }, statusLabel(item));
	const elapsed = isActive && item.startedAt != null ? h("span", { class: "elapsed", "data-elapsed": item.id }, formatElapsed(Date.now() - item.startedAt)) : isActive ? h("span", { class: "elapsed", "data-elapsed": item.id }, "…") : null;

	const meta = h("div", { class: "job-meta" }, [
		h("span", {}, `${item.width}×${item.height} · ${item.jobFrames}f · ${item.steps} steps`),
		elapsed,
	]);

	let progress: HTMLElement | null = null;
	if (item.status === "generating" && progressOk) {
		const node = h("div", { class: "job-progress", "data-progress": item.id }, [
			h("div", { class: "progress-track" }, [h("div", { class: "progress-fill" })]),
			h("span", { class: "progress-label" }),
		]);
		paintProgress(node, item);
		progress = node;
	}

	const promptBlock = h("details", { class: "prompt-block", "data-lazy-files": item.id, "data-files-kind": "queue" }, [
		h("summary", {}, "Prompt"),
		h("p", {}, item.prompt),
		h("div", { class: "thumbs" }),
		item.error ? h("p", { class: "item-error", role: "alert" }, item.error) : null,
	]);

	const actions: Child[] = [];
	if (isQueued) {
		actions.push(
			h("button", { class: "btn small", "data-action": "move-up", "data-id": item.id, disabled: queuedIndex === 0 }, "▲"),
			h("button", { class: "btn small", "data-action": "move-down", "data-id": item.id, disabled: queuedIndex === queuedCount - 1 }, "▼"),
		);
	}
	if (isQueued || isActive || item.status === "failed" || item.status === "cancelled") {
		actions.push(
			h("button", {
				class: "btn small danger",
				"data-action": "remove-queue",
				"data-id": item.id,
				title: isActive ? "Cancel this job and remove it" : "Remove from queue",
			}, "✕"),
		);
	}

	const body: Child[] = [
		h("div", { class: "row-head" }, [chip, h("div", { class: "row-title" }, truncate(itemTitle(item), 90))]),
		meta,
		...(progress ? [progress] : []),
		promptBlock,
	];
	if (actions.length > 0) body.push(h("div", { class: "row-actions" }, actions));

	return h("li", { class: `job-row queue ${item.status}`, "data-id": item.id, "data-sig": queueRowSignature(item, queuedIndex, queuedCount, progressOk) }, body);
}

export function moveQueueItem(store: Store, id: string, delta: number): void {
	const index = store.state.queue.findIndex((i) => i.id === id);
	if (index < 0) return;
	// Only queued items may be reordered, and only by swapping with an immediately adjacent queued item (never crossing failed/cancelled/active).
	const source = store.state.queue[index];
	if (!source || source.status !== "queued") return;
	const target = index + delta;
	if (target < 0 || target >= store.state.queue.length) return;
	const neighbor = store.state.queue[target];
	if (!neighbor || neighbor.status !== "queued") return;
	store.moveQueue(index, target);
}

function updateElapsed(store: Store): void {
	for (const item of store.state.queue) {
		if (item.status !== "generating" || item.startedAt === null) continue;
		const el = document.querySelector(`[data-elapsed="${CSS.escape(item.id)}"]`);
		if (el) el.textContent = formatElapsed(Date.now() - item.startedAt);
	}
}

// Paint both the fill width and the label for a progress bar in one place, so the build-time render and the live repaint can never drift: both call this identical write.
export function paintProgress(row: HTMLElement, item: QueueItem): void {
	const fill = row.querySelector(".progress-fill");
	const label = row.querySelector(".progress-label");
	if (fill instanceof HTMLElement) fill.style.width = `${item.progress ? progressPercent(item.progress) : 0}%`;
	if (label) label.textContent = item.progress ? progressLabel(item.progress) : "Generating…";
}

function updateProgress(store: Store): void {
	for (const item of store.state.queue) {
		if (item.status !== "generating" || !item.progress) continue;
		const root = document.querySelector(`[data-progress="${CSS.escape(item.id)}"]`);
		if (!(root instanceof HTMLElement)) continue;
		paintProgress(root, item);
	}
}

/** Refresh both live timers and progress bars in place (runs every second). */
export function updateLive(store: Store): void {
	updateElapsed(store);
	updateProgress(store);
}
