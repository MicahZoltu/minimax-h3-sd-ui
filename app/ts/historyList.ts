// History list row / media builders and their reconcile specs.
// These take a store and an item; none of them holds mount-closure transient state.

import { h } from "./dom.js";
import { itemTitle, truncate } from "./format.js";
import type { ReconcileRowSpec } from "./list.js";
import { thumbnailKey } from "./media.js";
import { getOrCreate } from "./objectUrl.js";
import type { Store } from "./state.js";
import type { HistoryItem } from "./types.js";
import { formatElapsed } from "./utils.js";

// The non-resident row media is an <img> built without a src; its Blob is loaded on demand and attached in
// place only once it resolves and the node is still connected. Building the list therefore loads no bytes.
export function attachRowThumb(store: Store, img: HTMLImageElement, id: string): void {
	void store.history.loadThumbnail(id).then((blob) => {
		if (!blob || !img.isConnected) return;
		img.src = getOrCreate(thumbnailKey(id), blob);
	}).catch(() => {});
}

/** Read-only view of the batch download manager's selection, so rows can paint checkbox state without importing it. */
export interface HistorySelectionReader {
	isSelected(id: string): boolean;
}

// Applies the item's selection state to its row: the checkbox's checked property and the row's `selected` class.
// Called at build time and in onKept; selection never enters historySig(), so rows never rebuild for it.
function paintSelection(row: HTMLElement, id: string, selection?: HistorySelectionReader): void {
	const selected = selection ? selection.isSelected(id) : false;
	const input = row.querySelector('input[data-action="toggle-select"]');
	if (input instanceof HTMLInputElement) input.checked = selected;
	row.classList.toggle("selected", selected);
}

export function buildRowMedia(store: Store, item: HistoryItem, isResident: boolean, residentUrl: string | null): HTMLElement {
	if (item.video.mime.startsWith("video/") && isResident && residentUrl) {
		return h("video", { class: "row-media", src: residentUrl, autoplay: true, muted: true, loop: true, playsinline: true, "aria-label": item.prompt, "data-action": "view-video", "data-id": item.id });
	}
	const img = h("img", { class: "row-media", alt: item.prompt, decoding: "async", loading: "lazy", "data-action": "view-video", "data-id": item.id });
	if (img instanceof HTMLImageElement) attachRowThumb(store, img, item.id);
	return img;
}

// History rows always render their thumbnail (never the resident video); the resident <video> is attached in place by swapResidentMedia.
// The resident id is attached to the <li> so the history reconcile can reuse rows by id without rebuilding them.
// The leading .row-select label carries the batch-selection checkbox; it stays display:none until #historyRows gains `selecting`.
export function buildHistoryRow(store: Store, item: HistoryItem): HTMLElement {
	const media = buildRowMedia(store, item, false, null);

	return h("li", { class: item.viewed ? "job-row history" : "job-row history new", "data-id": item.id }, [
		h("label", { class: "row-select" }, [
			h("input", { type: "checkbox", "data-action": "toggle-select", "data-id": item.id, "aria-label": `Select ${itemTitle(item)}` }),
		]),
		media,
		h("div", { class: "row-body" }, [
			h("div", { class: "row-title" }, truncate(itemTitle(item), 90)),
			h("div", { class: "job-meta" }, [
				h("span", {}, `${formatElapsed(item.elapsedMs)} · ${item.frameCount}f · ${item.width}×${item.height}`),
				h("div", { class: "row-actions" }, [
					h("button", {
						class: "btn small",
						"data-action": "download-zip",
						"data-id": item.id,
						title: "Download source zip",
					}, "Download zip"),
					h("button", {
						class: "btn small danger",
						"data-action": "delete-history",
						"data-id": item.id,
						title: "Remove this item",
					}, "Delete"),
				]),
			]),
			h("details", { class: "prompt-block", "data-lazy-files": item.id, "data-files-kind": "history" }, [
				h("summary", {}, "Prompt"),
				h("p", {}, item.prompt),
				h("div", { class: "thumbs" }),
			]),
		]),
	]);
}

// A history row's lazy reconcile spec: an existing row is always reused in place (so its open <details> and the attached resident swap survive), only the "new" highlight and the selection paint are toggled, and a missing row is freshly built.
// The optional selection reader comes from the batch download manager; rows paint checkbox state from it without the batch state ever entering historySig().
export function buildHistoryRowSpecs(store: Store, selection?: HistorySelectionReader): ReconcileRowSpec[] {
	const items = [...store.history.items()].reverse();
	return items.map((item) => ({
		id: item.id,
		isSame: () => true,
		build: () => {
			const row = buildHistoryRow(store, item);
			paintSelection(row, item.id, selection);
			return row;
		},
		onKept: (row) => {
			row.classList.toggle("new", !item.viewed);
			paintSelection(row, item.id, selection);
		},
	}));
}

export function historyItemBytes(item: HistoryItem): number {
	const refBytes = (item.videos ?? []).reduce((n, v) => n + v.thumbBytes + v.audioBytes + v.sourceBytes, 0)
		+ (item.audios ?? []).reduce((n, a) => n + a.bytes, 0);
	return item.video.byteSize + item.thumbBytes + item.files.reduce((n, f) => n + f.bytes, 0) + refBytes;
}
