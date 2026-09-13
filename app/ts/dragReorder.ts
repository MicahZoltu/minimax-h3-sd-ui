// Queue drag-to-reorder: a handle-gated native HTML5 drag over the queue list.
// Only rows whose item has status "queued" can enter a drag, and only when the gesture starts on the row's drag handle; every other dragstart inside the list is prevented so text selections and prompt thumbnails never become draggable.
// A drag reorders rows live with insertBefore (the dragged row is its own placeholder) and commits exactly one store.moveQueue on drop, so the keyed reconcile confirms the visual order instead of fighting it.
// Any queue-domain emission while a drag is live aborts it, so a background job completing can never race the pointer.
// Touch is intentionally unsupported here: native DnD is unreliable on touch screens, and the existing up/down buttons remain the pointer-alternative path (WCAG 2.2 SC 2.5.7).

import type { Store } from "./state.js";
import type { QueueItem } from "./types.js";

export interface DragReorderHandle {
	dispose(): void;
}

interface LiveDrag {
	id: string;
	row: HTMLElement;
	/** Id of the queued row the dragged row should sit before, or null for the end of the queued group. */
	beforeId: string | null;
}

const QUEUE_DRAG_TYPE = "application/x-queue-row";

// Maps (queue array, dragged id, insert-before id or null) to store.moveQueue coordinates.
// Returns null when the move is a no-op (dropped onto itself or onto the slot directly below it), when either endpoint is not a queued item, or when the dragged id is unknown.
// An unknown beforeId degrades to end-of-queued-group, matching the cursor's own fallback.
export function resolveMoveIndices(queue: QueueItem[], draggedId: string, beforeId: string | null): { from: number; to: number } | null {
	const from = queue.findIndex((i) => i.id === draggedId);
	const dragged = queue[from];
	if (from < 0 || !dragged || dragged.status !== "queued") return null;
	let lastQueued = -1;
	for (let i = queue.length - 1; i >= 0; i--) {
		if (queue[i]?.status === "queued") {
			lastQueued = i;
			break;
		}
	}
	let insertAt: number;
	if (beforeId === null) {
		insertAt = lastQueued + 1;
	} else {
		const target = queue.findIndex((i) => i.id === beforeId);
		const targetItem = queue[target];
		if (target < 0 || !targetItem) {
			insertAt = lastQueued + 1;
		} else if (targetItem.status !== "queued") {
			return null;
		} else {
			insertAt = target;
		}
	}
	if (insertAt === from || insertAt === from + 1) return null;
	return { from, to: from < insertAt ? insertAt - 1 : insertAt };
}

export function setupDragReorder(store: Store, queueRowsEl: HTMLElement): DragReorderHandle {
	let armedId: string | null = null;
	let drag: LiveDrag | null = null;
	// True while the commit's own store.moveQueue emit is in flight, so the abort subscription ignores it.
	let selfEmit = false;

	const isQueuedId = (id: string): boolean => {
		const item = store.state.queue.find((i) => i.id === id);
		return item?.status === "queued";
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (!(event.target instanceof Element)) return;
		const row = event.target.closest("li.job-row.queue");
		if (!event.target.closest("[data-drag-handle]") || !(row instanceof HTMLElement)) {
			armedId = null;
			return;
		}
		const id = row.getAttribute("data-id");
		armedId = id !== null && isQueuedId(id) ? id : null;
	};

	const onPointerEnd = (): void => {
		armedId = null;
	};

	const onDragStart = (event: DragEvent): void => {
		if (!(event.target instanceof Element)) return;
		const row = event.target.closest("li.job-row.queue");
		const transfer = event.dataTransfer;
		const id = row instanceof HTMLElement ? row.getAttribute("data-id") : null;
		if (!transfer || !(row instanceof HTMLElement) || id === null || armedId !== id || drag !== null || !isQueuedId(id)) {
			// Anything not armed from a queued row's handle must not become a drag.
			event.preventDefault();
			return;
		}
		// Firefox aborts a drag whose data store is never written; the payload travels in closure state because getData() is protected outside drop.
		transfer.effectAllowed = "move";
		transfer.setData(QUEUE_DRAG_TYPE, "");
		drag = { id, row, beforeId: null };
		row.classList.add("dragging");
		queueRowsEl.classList.add("dragging");
	};

	const cursorBeforeId = (clientY: number): string | null => {
		for (const node of Array.from(queueRowsEl.querySelectorAll("li.job-row.queue"))) {
			if (!(node instanceof HTMLElement) || node.classList.contains("dragging")) continue;
			const id = node.getAttribute("data-id");
			if (id === null || !isQueuedId(id)) continue;
			const rect = node.getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return id;
		}
		return null;
	};

	const firstNonQueuedRow = (): Element | null => {
		for (const node of Array.from(queueRowsEl.querySelectorAll("li.job-row.queue"))) {
			if (!(node instanceof HTMLElement) || node.classList.contains("dragging")) continue;
			const id = node.getAttribute("data-id");
			if (id === null || !isQueuedId(id)) return node;
		}
		return null;
	};

	// Moves the dragged row to its live slot: before the cursor row, or at the end of the queued group (before the first non-queued row, else the list end).
	const livePosition = (live: LiveDrag): void => {
		const queuedIds = store.state.queue.filter((i) => i.status === "queued" && i.id !== live.id).map((i) => i.id);
		let anchor: Element | null = null;
		if (live.beforeId !== null && queuedIds.includes(live.beforeId)) {
			anchor = queueRowsEl.querySelector(`li.job-row[data-id="${CSS.escape(live.beforeId)}"]`);
		}
		if (!anchor) {
			const lastQueuedId = queuedIds.at(-1) ?? null;
			const lastRow = lastQueuedId === null ? null : queueRowsEl.querySelector(`li.job-row[data-id="${CSS.escape(lastQueuedId)}"]`);
			anchor = lastRow !== null ? lastRow.nextElementSibling : firstNonQueuedRow();
		}
		const atSlot = anchor !== null ? live.row.nextElementSibling === anchor : live.row.nextElementSibling === null;
		if (atSlot) return;
		queueRowsEl.insertBefore(live.row, anchor);
	};

	// Restores the dragged row to the store's authoritative order (used when a drag ends without a drop).
	const restoreBeforeId = (id: string): string | null => {
		const q = store.state.queue;
		const at = q.findIndex((i) => i.id === id);
		for (let i = at + 1; i < q.length; i++) {
			const item = q[i];
			if (item?.status === "queued") return item.id;
		}
		return null;
	};

	const cleanup = (live: LiveDrag): void => {
		live.row.classList.remove("dragging");
		queueRowsEl.classList.remove("dragging");
		if (drag === live) drag = null;
	};

	const commit = (live: LiveDrag): void => {
		const indices = resolveMoveIndices(store.state.queue, live.id, live.beforeId);
		if (!indices) {
			cleanup(live);
			return;
		}
		// Open <details> state is snapshotted because the reconcile triggered by the move may rebuild rows (the row signature encodes first/last-ness).
		const openIds = new Set<string>();
		for (const node of Array.from(queueRowsEl.querySelectorAll("details[data-lazy-files]"))) {
			if (node instanceof HTMLDetailsElement && node.open) {
				const id = node.getAttribute("data-lazy-files");
				if (id !== null) openIds.add(id);
			}
		}
		selfEmit = true;
		try {
			store.moveQueue(indices.from, indices.to);
		} finally {
			selfEmit = false;
		}
		for (const node of Array.from(queueRowsEl.querySelectorAll("details[data-lazy-files]"))) {
			if (!(node instanceof HTMLDetailsElement)) continue;
			const id = node.getAttribute("data-lazy-files");
			if (id !== null && openIds.has(id)) node.open = true;
		}
		cleanup(live);
	};

	const onDragOver = (event: DragEvent): void => {
		const live = drag;
		if (!live) return;
		// Canceling dragover on every dispatch is what makes the list a valid drop target.
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		const beforeId = cursorBeforeId(event.clientY);
		if (beforeId === live.beforeId) return;
		live.beforeId = beforeId;
		livePosition(live);
	};

	const onDrop = (event: DragEvent): void => {
		const live = drag;
		if (!live) return;
		event.preventDefault();
		commit(live);
	};

	// A committed drag nulls `drag` synchronously inside commit(), so reaching here with a live drag always means no commit happened and the row must go back to the store's order (covers Esc, drops outside the list, and drops on foreign handlers such as the zip dropzone).
	const onDragEnd = (): void => {
		const live = drag;
		if (!live) return;
		live.beforeId = restoreBeforeId(live.id);
		livePosition(live);
		cleanup(live);
	};

	// The abort path leaves the DOM as it finds it: the queue emission that triggered it repaints the authoritative order.
	const unsubscribe = store.subscribe(() => {
		if (selfEmit) return;
		const live = drag;
		if (!live) return;
		cleanup(live);
	}, ["queue"]);

	queueRowsEl.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("pointerup", onPointerEnd, true);
	document.addEventListener("pointercancel", onPointerEnd, true);
	queueRowsEl.addEventListener("dragstart", onDragStart, true);
	queueRowsEl.addEventListener("dragover", onDragOver);
	queueRowsEl.addEventListener("drop", onDrop);
	queueRowsEl.addEventListener("dragend", onDragEnd);

	return {
		dispose(): void {
			unsubscribe();
			queueRowsEl.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("pointerup", onPointerEnd, true);
			document.removeEventListener("pointercancel", onPointerEnd, true);
			queueRowsEl.removeEventListener("dragstart", onDragStart, true);
			queueRowsEl.removeEventListener("dragover", onDragOver);
			queueRowsEl.removeEventListener("drop", onDrop);
			queueRowsEl.removeEventListener("dragend", onDragEnd);
			const live = drag;
			if (live) cleanup(live);
		},
	};
}
