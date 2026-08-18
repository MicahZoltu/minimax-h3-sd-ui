// Tab-favicon status indicator.
//
// The favicon is drawn onto a canvas and exposed as a data-URL <link rel="icon">.
// The whole icon is a single max-size digit communicating two things at a glance:
//   - its value is the number of jobs in flight (the currently generating item plus everything queued and not yet terminal), clamped to a single digit with "9+" for anything larger, and
//   - its color is green (accent) whenever at least one completed generation has not been viewed, blue otherwise.
//
// "Viewed" is the persisted per-item `viewed` flag: a completion is highlighted in the list and the
// favicon stays green until the user clicks a video thumbnail to view it.

import type { Store } from "./state.js";

export interface FaviconView {
	/** Jobs in flight: the generating item plus everything queued and not yet terminal. */
	active: number;
	/** Whether at least one completed generation has not been viewed yet. */
	unreviewed: boolean;
}

const SIZE = 64;
const TYPE = "image/png";

function faviconLink(): HTMLLinkElement {
	let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		link.type = TYPE;
		document.head.appendChild(link);
	}
	return link;
}

export function paintFavicon(view: FaviconView): void {
	const canvas = document.createElement("canvas");
	canvas.width = SIZE;
	canvas.height = SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	// A single max-size digit is the whole icon: its value is the in-flight count, its color is the unreviewed state.
	const label = view.active > 9 ? "9+" : String(view.active);
	ctx.fillStyle = view.unreviewed ? "#4cc38a" : "#5b8cff";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.font = `bold ${label.length > 1 ? 40 : 58}px system-ui, sans-serif`;
	ctx.fillText(label, SIZE / 2, SIZE / 2);
	faviconLink().href = canvas.toDataURL(TYPE);
}

let setUp = false;

export function setupFavicon(store: Store): void {
	if (setUp) return;
	setUp = true;
	const hasUnviewed = (): boolean => store.history.items().some((i) => !i.viewed);
	const inFlight = (): number =>
		store.state.queue.reduce((n, i) => n + (i.status === "queued" || i.status === "submitting" || i.status === "generating" ? 1 : 0), 0);
	// Coalesce paints to once per animation frame: several store emissions in the same frame draw once.
	let raf = 0;
	const schedulePaint = (): void => {
		if (raf !== 0) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			paintFavicon({ active: inFlight(), unreviewed: hasUnviewed() });
		});
	};
	// Only the history and queue domains can change the icon (a completion adds an unviewed item, viewing one removes it).
	store.subscribe(schedulePaint, ["history", "queue"]);
	schedulePaint();
}
