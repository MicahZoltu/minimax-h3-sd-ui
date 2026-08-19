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
export function buildHistoryRow(store: Store, item: HistoryItem): HTMLElement {
	const media = buildRowMedia(store, item, false, null);

	return h("li", { class: item.viewed ? "job-row history" : "job-row history new", "data-id": item.id }, [
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

// A history row's lazy reconcile spec: an existing row is always reused in place (so its open <details> and the
// attached resident swap survive), only the "new" highlight is toggled, and a missing row is freshly built.
export function buildHistoryRowSpecs(store: Store): ReconcileRowSpec[] {
	const items = [...store.history.items()].reverse();
	return items.map((item) => ({
		id: item.id,
		isSame: () => true,
		build: () => buildHistoryRow(store, item),
		onKept: (row) => row.classList.toggle("new", !item.viewed),
	}));
}

export function historyItemBytes(item: HistoryItem): number {
	return item.video.byteSize + item.thumbBytes + item.files.reduce((n, f) => n + f.bytes, 0);
}
