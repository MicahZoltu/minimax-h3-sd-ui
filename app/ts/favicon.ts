// Tab-favicon status indicator.
//
// The favicon is drawn onto a canvas and exposed as a data-URL <link rel="icon">.
// The whole icon is a single max-size digit communicating two things at a glance:
//   - its value is the number of jobs in flight (the currently generating item plus everything queued and not yet terminal), clamped to a single digit with "9+" for anything larger, and
//   - its color is the unreviewed state (accent when a video completed since the tab was last looked at, muted otherwise).
//
// A completion that lands while the tab is being looked at is considered seen immediately.
// The unreviewed color is cleared the next time the tab becomes visible or the window regains focus.

import type { Store } from "./state.js";

export interface FaviconView {
	/** Total completed videos kept in history; used to detect new completions. */
	historyCount: number;
	/** Jobs in flight: the generating item plus everything queued and not yet terminal. */
	active: number;
	/** Whether a video completed since the tab was last looked at. */
	unreviewed: boolean;
}

export function computeFaviconView(prev: FaviconView | null, historyCount: number, active: number, visible: boolean): FaviconView {
	const completed = prev !== null && historyCount > prev.historyCount;
	let unreviewed = prev?.unreviewed ?? false;
	if (completed) {
		unreviewed = visible ? false : true;
	} else if (visible) {
		unreviewed = false;
	}
	return { historyCount, active, unreviewed };
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
	let view: FaviconView | null = null;
	let visible = document.visibilityState === "visible";
	const inFlight = (): number =>
		store.state.queue.reduce((n, i) => n + (i.status === "queued" || i.status === "submitting" || i.status === "generating" ? 1 : 0), 0);
	const flush = (): void => {
		view = computeFaviconView(view, store.history.items().length, inFlight(), visible);
		paintFavicon(view);
	};
	store.subscribe(flush);
	const onVisibility = (): void => {
		visible = document.visibilityState === "visible";
		flush();
	};
	const onFocus = (): void => {
		visible = true;
		flush();
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("focus", onFocus);
	flush();
}
