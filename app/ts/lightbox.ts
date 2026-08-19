// The lightbox: a modal that shows an enlarged image or video thumbnail, with in-browser compression orchestration.
// It owns the lightbox open/close state machine, the async compression probe, the running-compression progress row
// with its Cancel button, and the backdrop-close / compression-lock guards.
// mount owns the storage modal and the resident-swap machinery; it calls back into this module for the lightbox's
// delegated dispatch arms and consults isOpen() from its resident mouseover guard.
// This module must never import ui.js.

import { planLabel } from "./compression.plan.js";
import { CompressionCanceledError, probeCompression, runCompression, type CompressionRun } from "./compression.js";
import type { CompressionPlan, UnsupportedReason } from "./compression.types.js";
import { h, clear, type Child } from "./dom.js";
import { downloadBlob, downloadDataUrl } from "./download.js";
import { mediaDownloadName, zipStem } from "./format.js";
import { isHTMLElement, maybeElement } from "./list.js";
import { getOrCreate } from "./objectUrl.js";
import type { Store } from "./state.js";
import { sanitizeBasename } from "./utils.js";

export interface LightboxActionContext {
	event: Event;
	element: HTMLElement;
}

export interface LightboxHandle {
	/** True while any lightbox (image or video) is open; mount's mouseover resident guard consults this. */
	isOpen(): boolean;
	/** Route a delegated [data-action] click that this module owns (the non-storage lightbox arms). */
	handleAction(action: string, ctx: LightboxActionContext): void;
	/** Close the lightbox, refused while a compression runs; the backdrop-click guard calls this. */
	handleBackdropClose(): void;
}

interface LightboxState {
	kind: "image" | "video";
	src: string;
	filename: string;
	stem: string;
	plan: CompressionPlan | null;
	reason: UnsupportedReason | null;
	imageBlob?: Blob;
}

export function createLightbox(store: Store, lightboxEl: HTMLElement): LightboxHandle {
	let lightbox: LightboxState | null = null;
	const renderLightbox = (): void => {
		clear(lightboxEl);
		if (!lightbox) {
			lightboxEl.style.display = "none";
			return;
		}
		const lb = lightbox;
		// The bar always reads "Download • Download Compressed • Close".
		// Cancellation does not live here: a transient progress row (bar + Cancel) is managed imperatively below and exists only while a compression is running.
		const barChildren: Child[] = [h("button", { class: "btn primary", "data-action": "download-lightbox" }, "Download")];
		if (lb.kind === "video") {
			const plan = lb.plan;
			const ready = plan !== null;
			// Informational tooltip: the plan label once a probe resolves, or a helpful note while disabled/unavailable.
			const title = plan !== null ? planLabel(plan) : "Compression not available in this browser";
			barChildren.push(
				h("button", { class: "btn", "data-action": "download-compressed", disabled: !ready, title: title }, "Download Compressed"),
			);
		}
		barChildren.push(h("button", { class: "btn", "data-action": "close-lightbox" }, "Close"));
		lightboxEl.style.display = "block";
		lightboxEl.appendChild(
			h("div", { class: "overlay lightbox-overlay" }, [
				// Column wrapper lets the button bar and progress row span the wider of the media or bar, centered like the rest of the lightbox.
				h("div", { class: "lightbox-column" }, [
					lb.kind === "video"
						? h("video", { class: "lightbox-media", src: lb.src, controls: true, playsinline: true, autoplay: true })
						: h("img", { class: "lightbox-media", src: lb.src, alt: "Enlarged media" }),
					h("div", { class: "lightbox-bar" }, barChildren),
				]),
			]),
		);
	};
	// Probe the resident blob once (idempotently) when a video lightbox opens, then enable the compress button if a plan is viable.
	// Stale results (the lightbox changed or closed meanwhile) are ignored.
	const probeVideoCompression = async (store: Store, lb: LightboxState): Promise<void> => {
		const blob = store.residentBlob();
		if (!blob) return;
		try {
			const outcome = await probeCompression(blob);
			if (lightbox !== lb || lightbox.kind !== "video") return;
			lightbox = { ...lightbox, plan: outcome.plan, reason: outcome.reason };
			renderLightbox();
		} catch {
			if (lightbox !== lb || lightbox.kind !== "video") return;
			lightbox = { ...lightbox, plan: null, reason: null };
			renderLightbox();
		}
	};
	// The compression currently running from the lightbox, if any.
	// While this is set the lightbox is locked: closing and backdrop dismissal are refused and the download/close buttons are disabled.
	// The delegated Cancel handler nulls this so the awaiting run's completion/cancellation bookkeeping is skipped.
	let activeCompression: CompressionRun | null = null;
	// Progress row is managed imperatively (not rebuilt by renderLightbox):
	// renderLightbox re-renders the <video>, which would restart playback, so the row must be added/updated/removed directly in place around a single render.
	let progressRowEl: HTMLElement | null = null;
	let progressFillEl: HTMLElement | null = null;
	let progressTextEl: HTMLElement | null = null;
	let transientTimer: ReturnType<typeof setTimeout> | null = null;
	const lightboxColumn = (): HTMLElement | null => maybeElement(lightboxEl.querySelector(".lightbox-column"), isHTMLElement);
	const setLightboxControlsDisabled = (disabled: boolean): void => {
		for (const action of ["download-lightbox", "download-compressed", "close-lightbox"]) {
			const el = maybeElement(lightboxEl.querySelector(`[data-action="${action}"]`), isHTMLElement);
			if (el) el.toggleAttribute("disabled", disabled);
		}
	};
	const appendProgressRow = (): void => {
		const column = lightboxColumn();
		if (!column || progressRowEl) return;
		const fill = h("div", { class: "lightbox-progress-fill", "data-compression-fill": "" });
		const text = h("span", { class: "lightbox-progress-text", "data-compression-text": "" }, "0%");
		const row = h("div", { class: "lightbox-progress" }, [
			h("div", { class: "lightbox-progress-track" }, [fill]),
			text,
			h("button", { class: "btn small", "data-action": "cancel-compression" }, "Cancel"),
		]);
		column.appendChild(row);
		progressRowEl = row;
		progressFillEl = fill;
		progressTextEl = text;
	};
	const removeProgressRow = (): void => {
		progressRowEl?.remove();
		progressRowEl = null;
		progressFillEl = null;
		progressTextEl = null;
	};
	const setProgress = (pct: number): void => {
		if (progressFillEl) progressFillEl.style.width = `${pct * 100}%`;
		if (progressTextEl) progressTextEl.textContent = `${Math.round(pct * 100)}%`;
	};
	const clearTransient = (): void => {
		if (transientTimer != null) {
			clearTimeout(transientTimer);
			transientTimer = null;
		}
		lightboxEl.querySelector(".lightbox-message")?.remove();
	};
	const showTransientError = (message: string): void => {
		clearTransient();
		const column = lightboxColumn();
		if (!column) return;
		const node = h("div", { class: "lightbox-message", role: "alert" }, message);
		column.appendChild(node);
		transientTimer = setTimeout(() => node.remove(), 3500);
	};
	// Re-enable the locked controls and drop the progress row (which only ever exists for the duration of a run).
	const unlockAfterCompression = (): void => {
		removeProgressRow();
		setLightboxControlsDisabled(false);
	};
	// Cancel helper: stops the active run, then unlocks the lightbox.
	// Stale cancellations (lightbox changed/closed meanwhile) are handled gracefully by the guards: a run that no longer owns the slot does no bookkeeping.
	const cancelCompressionFromLightbox = (): void => {
		const run = activeCompression;
		if (!run) return;
		activeCompression = null;
		run.cancel();
		unlockAfterCompression();
	};
	// Run the compression for the currently-open video lightbox, drive the transient progress row, and hand the result to the browser on completion.
	const runCompressionFromLightbox = async (store: Store): Promise<void> => {
		const lb = lightbox;
		if (!lb || lb.kind !== "video" || lb.plan === null) return;
		if (activeCompression) return;
		const blob = store.residentBlob();
		if (!blob) return;
		const plan = lb.plan;
		// Lock the lightbox: disable the two download buttons and Close, and (via activeCompression) refuse backdrop dismissal and Close clicks.
		clearTransient();
		appendProgressRow();
		setLightboxControlsDisabled(true);
		setProgress(0);
		const run = runCompression(blob, plan, { quality: "medium", stem: lb.stem });
		activeCompression = run;
		run.onProgress((pct) => {
			if (activeCompression === run) setProgress(pct);
		});
		try {
			const result = await run.done;
			if (activeCompression !== run) return;
			setProgress(1);
			downloadBlob(result.blob, result.filename);
			// Let the 100% readout paint for a beat before the row is removed and the controls re-enable.
			setTimeout(() => {
				if (activeCompression === run) {
					activeCompression = null;
					unlockAfterCompression();
				}
			}, 180);
		} catch (err) {
			if (activeCompression !== run) return;
			// A canceled run is a clean unlock, not an error; detect it by the typed sentinel, never by the message text.
			const canceled = err instanceof CompressionCanceledError;
			if (!canceled) showTransientError(`Compression failed: ${err instanceof Error ? err.message : String(err)}`);
			activeCompression = null;
			unlockAfterCompression();
		}
	};
	const openImage = (ctx: LightboxActionContext): void => {
		ctx.event.stopPropagation();
		const name = ctx.element.getAttribute("data-name") ?? "";
		const id = ctx.element.getAttribute("data-id") ?? "";
		const fallback = ctx.element.getAttribute("src") ?? "";
		const show = (src: string, imageBlob?: Blob): void => {
			if (!src) return;
			const state: LightboxState = { kind: "image", src, filename: name || "image", stem: "", plan: null, reason: null };
			if (imageBlob) state.imageBlob = imageBlob;
			lightbox = state;
			renderLightbox();
		};
		const item = store.history.items().find((i) => i.id === id);
		const index = item ? item.files.findIndex((f) => f.name === name) : -1;
		const file = item && index >= 0 ? item.files[index] : undefined;
		if (file) {
			// Load by the file's recorded media-store key, never by the array index: a legacy record's
			// keys can be non-contiguous with the array, and an index read would show the wrong image.
			void store.history.loadFileByKey(file.key).then((blob) => {
				if (blob) show(getOrCreate(file.key, blob), blob);
				else show(fallback);
			}).catch(() => show(fallback));
		} else {
			show(fallback);
		}
	};
	const openVideo = (ctx: LightboxActionContext): void => {
		ctx.event.stopPropagation();
		const id = ctx.element.getAttribute("data-id") ?? "";
		const item = store.history.items().find((i) => i.id === id);
		const filename = item ? mediaDownloadName(item) : `${id || "media"}.webm`;
		const stem = item ? (zipStem(item.zipName) || sanitizeBasename(item.prompt) || item.id) : id;
		// Opening the full video clears this item's "new" highlight (and its green favicon contribution).
		store.markHistoryViewed(id);
		void (async () => {
			await store.setResident(id);
			// setResident is async when the blob must be read back from the backend. While it awaited, a hover
			// on another row could have set a different resident (the mouseover guard checks isOpen(), which is
			// still false until the lightbox opens). Only open the video we actually requested: if the resident
			// was superseded, residentId() is no longer `id`, so abort rather than display a mislabeled video.
			if (store.residentId() !== id) return;
			const src = store.residentUrl();
			if (src) {
				lightbox = { kind: "video", src, filename, stem, plan: null, reason: null };
				renderLightbox();
				void probeVideoCompression(store, lightbox);
			}
		})();
	};
	const downloadLightboxMedia = (): void => {
		if (!lightbox) return;
		if (lightbox.kind === "video") {
			const blob = store.residentBlob();
			if (blob) downloadBlob(blob, lightbox.filename);
		} else if (lightbox.imageBlob) {
			downloadBlob(lightbox.imageBlob, lightbox.filename);
		} else {
			downloadDataUrl(lightbox.src, lightbox.filename);
		}
	};
	return {
		isOpen: (): boolean => lightbox !== null,
		handleBackdropClose: (): void => {
			// Clicking the overlay backdrop closes the lightbox, unless a compression is running (dismissal is locked for its duration).
			if (activeCompression) return;
			lightbox = null;
			renderLightbox();
		},
		handleAction: (action, ctx): void => {
			switch (action) {
				case "view-image":
					openImage(ctx);
					break;
				case "view-video":
					openVideo(ctx);
					break;
				case "download-compressed":
					ctx.event.stopPropagation();
					void runCompressionFromLightbox(store);
					break;
				case "cancel-compression":
					ctx.event.stopPropagation();
					cancelCompressionFromLightbox();
					break;
				case "download-lightbox":
					downloadLightboxMedia();
					break;
				case "close-lightbox":
					// Closing is refused while a compression runs; the Close button is also disabled during that window.
					if (activeCompression) return;
					lightbox = null;
					renderLightbox();
					break;
				default:
					break;
			}
		},
	};
}
