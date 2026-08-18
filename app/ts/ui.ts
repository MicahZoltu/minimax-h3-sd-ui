// DOM rendering and user interaction wiring.
// The UI is small and deliberately simple: render functions rebuild section containers from the store, and a single event delegation handler routes user actions.
// No markup is ever built from unescaped strings, so uploaded prompts / file names are always safe.

import { getConfigurableBase } from "./config.js";
import { planLabel } from "./compression.plan.js";
import { probeCompression, runCompression, type CompressionRun } from "./compression.js";
import type { CompressionPlan, UnsupportedReason } from "./compression.types.js";
import { h, clear, type Child } from "./dom.js";
import { downloadBlob, downloadDataUrl } from "./download.js";
import { setupFavicon } from "./favicon.js";
import { estimateStorage } from "./history.js";
import { pump } from "./queue.js";
import { GENERATION_PRESET } from "./request.js";
import type { Store } from "./state.js";
import { FALLBACK_DIMS } from "./state.js";
import type { JobProgress } from "./api.js";
import type { HistoryItem, QueueItem } from "./types.js";
import { dataUrlToBytes, formatElapsed, sanitizeBasename, uid } from "./utils.js";
import { analyzeZip, buildSourceZip } from "./zip.js";

const isHTMLElement = (el: unknown): el is HTMLElement => el instanceof HTMLElement;
const isInputElement = (el: unknown): el is HTMLInputElement => el instanceof HTMLInputElement;
const isVideoElement = (el: unknown): el is HTMLVideoElement => el instanceof HTMLVideoElement;

function frameDurationLabel(frames: number): string {
	const seconds = frames / GENERATION_PRESET.fps;
	return `≈ ${seconds.toFixed(1)} seconds`;
}

function requiredElement<T extends Element>(el: unknown, guard: (el: unknown) => el is T, what: string): T {
	if (!guard(el)) throw new Error(`Required ${what} element is missing.`);
	return el;
}

function maybeElement<T extends Element>(el: unknown, guard: (el: unknown) => el is T): T | null {
	return guard(el) ? el : null;
}

function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0 B";
	if (n < 1024) return `${Math.round(n)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = n;
	let unit = "KB";
	for (const u of units) {
		value /= 1024;
		unit = u;
		if (value < 1024) break;
	}
	const hasFraction = value < 10 && Math.floor(value) !== value;
	return `${hasFraction ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

export function mount(store: Store, root: HTMLElement): void {
	let lastHistorySig = "";
	let lastFormRev = -1;
	let lastQueueRev = -1;
	let lastResidentId = store.residentId();

	let storageModalOpen = false;
	let lastEstimate: { usage: number; quota: number } | null = null;
	let storageMeterRefreshing = false;
	const refreshStorageMeter = async (): Promise<void> => {
		if (storageMeterRefreshing) return;
		storageMeterRefreshing = true;
		try {
			const estimate = await estimateStorage();
			lastEstimate = estimate ? { usage: estimate.usage, quota: estimate.quota } : null;
			if (store.history.isPersistent() && estimate && estimate.quota > 0) {
				const pct = Math.min(100, Math.round((estimate.usage / estimate.quota) * 1000) / 10);
				storageTextEl.textContent = `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`;
				storageFillEl.style.width = pct + "%";
				storageBarEl.style.display = "";
			} else {
				storageTextEl.textContent = "session-only history";
				storageFillEl.style.width = "0%";
				storageBarEl.style.display = "none";
			}
			if (storageModalOpen) renderStorageModal();
		} finally {
			storageMeterRefreshing = false;
		}
	};
	const renderStorageModal = (): void => {
		clear(storageRootEl);
		if (!storageModalOpen) {
			storageRootEl.style.display = "none";
			return;
		}
		storageRootEl.style.display = "block";
		const usage = lastEstimate?.usage ?? 0;
		const quota = lastEstimate?.quota ?? 0;
		const items = store.history.items();
		const slices = items.map((it, index) => ({
			label: it.prompt,
			value: historyItemBytes(it),
			color: PIE_COLORS[index % PIE_COLORS.length] ?? PIE_COLORS[0] ?? "#5b8cff",
		}));
		const persistent = store.history.isPersistent();
		const canvas = document.createElement("canvas");
		canvas.className = "storage-pie";
		const overlay = h("div", { class: "overlay storage-overlay" }, [
			h("div", { class: "modal storage-modal" }, [
				h("div", { class: "modal-head" }, [
					h("h2", {}, "Storage"),
					h("button", { class: "btn", "data-action": "close-storage" }, "Close"),
				]),
				canvas,
				h("p", { class: "storage-summary" }, persistent ? `history saved in this browser · ${formatBytes(usage)} of ${formatBytes(quota)}` : "session-only history (not persisted)"),
				h("div", { class: "storage-delete-oldest" }, [
					h("label", { class: "storage-del-label" }, "Delete oldest history"),
					h("div", { class: "storage-del-row" }, [
						h("input", { type: "number", min: "1", value: "1", "data-delete-oldest-count": "", "aria-label": "How many oldest history items to delete" }),
						h("button", { class: "btn small", "data-action": "delete-oldest" }, "Delete oldest"),
					]),
				]),
				h("div", { class: "modal-actions" }, [
					h("button", { class: "btn small danger", "data-action": "clear-history" }, "Clear all history"),
				]),
			]),
		]);
		storageRootEl.appendChild(overlay);
		drawStoragePie(canvas, slices, usage, quota);
	};

	const header = buildHeader();
	const statusEl = requiredElement(header.querySelector(".status"), isHTMLElement, "status");
	const storageEl = requiredElement(header.querySelector(".storage-note"), isHTMLElement, "storage note");
	const storageTextEl = requiredElement(header.querySelector("[data-storage-text]"), isHTMLElement, "storage text");
	const storageBarEl = requiredElement(header.querySelector("[data-storage-bar]"), isHTMLElement, "storage bar");
	const storageFillEl = requiredElement(header.querySelector("[data-storage-fill]"), isHTMLElement, "storage fill");
	const apiUrlEl = requiredElement(header.querySelector("[data-api-url]"), isHTMLElement, "api url");
	const apiErrEl = maybeElement(header.querySelector("[data-api-err]"), isHTMLElement);
	updateHeader(store, statusEl, storageEl, apiUrlEl, apiErrEl);
	let apiEditing = false;
	let apiErrTimer: ReturnType<typeof setTimeout> | null = null;
	const hideApiError = (): void => {
		if (apiErrTimer != null) {
			clearTimeout(apiErrTimer);
			apiErrTimer = null;
		}
		if (apiErrEl) {
			apiErrEl.textContent = "";
			apiErrEl.classList.remove("show");
		}
	};
	const showApiError = (msg: string): void => {
		if (!apiErrEl) return;
		apiErrEl.textContent = msg;
		apiErrEl.classList.add("show");
		if (apiErrTimer != null) clearTimeout(apiErrTimer);
		apiErrTimer = setTimeout(hideApiError, 4000);
	};
	const endApiEdit = (): void => {
		apiEditing = false;
		clear(apiUrlEl);
		apiUrlEl.textContent = getConfigurableBase();
		hideApiError();
	};
	const beginApiEdit = (): void => {
		if (apiEditing) return;
		apiEditing = true;
		clear(apiUrlEl);
		const input = document.createElement("input");
		input.type = "url";
		input.value = getConfigurableBase();
		input.spellcheck = false;
		input.autocomplete = "off";
		input.className = "api-url-input";
		input.setAttribute("aria-label", "API server URL");
		apiUrlEl.appendChild(input);
		input.focus();
		input.select();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				try {
					store.setApiBase(input.value);
					endApiEdit();
				} catch (err) {
					showApiError(err instanceof Error ? err.message : String(err));
					input.focus();
				}
			} else if (e.key === "Escape") {
				endApiEdit();
			}
		});
		input.addEventListener("blur", () => {
			if (apiEditing) endApiEdit();
		});
	};
	apiUrlEl.addEventListener("click", beginApiEdit);

	const app = h("div", { class: "app" }, [
		header,
		buildLayout(),
		h("div", { id: "lightbox-root" }),
		h("div", { id: "storage-root" }),
	]);
	clear(root);
	root.appendChild(app);

	const layout = requiredElement(app.querySelector("#layout"), isHTMLElement, "layout");
	const formEl = requiredElement(layout.querySelector("#form"), isHTMLElement, "form");
	const queueRowsEl = requiredElement(layout.querySelector("#queueRows"), isHTMLElement, "queue rows");
	const historyRowsEl = requiredElement(layout.querySelector("#historyRows"), isHTMLElement, "history rows");
	const listEmptyEl = requiredElement(layout.querySelector("#listEmpty"), isHTMLElement, "list empty");
	const lightboxEl = requiredElement(app.querySelector("#lightbox-root"), isHTMLElement, "lightbox");
	const storageRootEl = requiredElement(app.querySelector("#storage-root"), isHTMLElement, "storage root");

	// Lightbox: click the media preview or an input thumbnail anywhere in the list to view it enlarged, shrunk to fit the viewport.
	// Clicking the backdrop closes it.
	// The compressed plan/reason are filled in asynchronously by a probe once a video opens; until then the button stays disabled.
	interface LightboxState {
		kind: "image" | "video";
		src: string;
		filename: string;
		stem: string;
		plan: CompressionPlan | null;
		reason: UnsupportedReason | null;
	}
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
			// A canceled run reports "Compression canceled."; that is handled as a clean unlock, not an error.
			const canceled = err instanceof Error && err.message === "Compression canceled.";
			if (!canceled) showTransientError(`Compression failed: ${err instanceof Error ? err.message : String(err)}`);
			activeCompression = null;
			unlockAfterCompression();
		}
	};
	const lookupImage = (id: string, name: string): string | null => {
		const inQueue = store.state.queue.find((i) => i.id === id)?.files.find((f) => f.name === name);
		if (inQueue) return inQueue.dataUrl;
		const inHistory = store.history.items().find((i) => i.id === id)?.files.find((f) => f.name === name);
		return inHistory ? inHistory.dataUrl : null;
	};
	// Capture-phase guard: interacting with a row's prompt block or actions (e.g. expanding the collapsed <details>) must not bubble into the history-row click.
	// Elements that carry their own [data-action] (thumbnails, download buttons) still bubble normally.
	app.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			// Only swallow clicks that are not themselves actionable controls (thumbnails / download buttons) living inside the block.
			// The row itself is no longer a click action, but we still only swallow clicks that are not actionable controls.
			const block = target.closest(".prompt-block, .row-actions");
			if (block && !target.closest(".prompt-block [data-action], .row-actions [data-action]")) {
				event.stopPropagation();
			}
		},
		true,
	);

	app.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		if (target.classList.contains("storage-overlay")) {
			storageModalOpen = false;
			renderStorageModal();
			return;
		}
		// Clicking the overlay backdrop closes the lightbox, unless a compression is running (dismissal is locked for its duration).
		if (target.classList.contains("overlay")) {
			if (activeCompression) return;
			lightbox = null;
			renderLightbox();
			return;
		}
		const actionEl = maybeElement(target.closest("[data-action]"), isHTMLElement);
		if (!actionEl) return;
		const action = actionEl.getAttribute("data-action");
		if (action === "view-image") {
			event.stopPropagation();
			const name = actionEl.getAttribute("data-name") ?? "";
			const src = lookupImage(actionEl.getAttribute("data-id") ?? "", name) ?? actionEl.getAttribute("src") ?? "";
			if (src) lightbox = { kind: "image", src, filename: name || "image", stem: "", plan: null, reason: null };
			renderLightbox();
		} else if (action === "view-video") {
			event.stopPropagation();
			const id = actionEl.getAttribute("data-id") ?? "";
			const item = store.history.items().find((i) => i.id === id);
			const filename = item ? mediaDownloadName(item) : `${id || "media"}.webm`;
			const stem = item ? (zipStem(item.zipName) || sanitizeBasename(item.prompt) || item.id) : id;
			// Opening the full video clears this item's "new" highlight (and its green favicon contribution).
			store.markHistoryViewed(id);
			void (async () => {
				await store.setResident(id);
				const src = store.residentUrl();
				if (src) {
					lightbox = { kind: "video", src, filename, stem, plan: null, reason: null };
					renderLightbox();
					void probeVideoCompression(store, lightbox);
				}
			})();
		} else if (action === "download-compressed") {
			event.stopPropagation();
			void runCompressionFromLightbox(store);
		} else if (action === "cancel-compression") {
			event.stopPropagation();
			cancelCompressionFromLightbox();
		} else if (action === "download-lightbox") {
			event.stopPropagation();
			if (!lightbox) return;
			if (lightbox.kind === "video") {
				const blob = store.residentBlob();
				if (blob) downloadBlob(blob, lightbox.filename);
			} else {
				downloadDataUrl(lightbox.src, lightbox.filename);
			}
		} else if (action === "close-lightbox") {
			// Closing is refused while a compression runs; the Close button is also disabled during that window.
			if (activeCompression) return;
			lightbox = null;
			renderLightbox();
		} else if (action === "open-storage") {
			event.stopPropagation();
			storageModalOpen = true;
			renderStorageModal();
		} else if (action === "close-storage") {
			event.stopPropagation();
			storageModalOpen = false;
			renderStorageModal();
		}
	});
	// Hovering a history row's media preview makes that video the single resident one, unless the video modal is open.
	app.addEventListener(
		"mouseover",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			// Keep the resident video stable while the video/player modal is open.
			if (lightbox) return;
			const media = target.closest('.row-media[data-action="view-video"]');
			if (!media) return;
			const id = media.getAttribute("data-id") ?? "";
			if (id) void store.setResident(id);
		},
		true,
	);

	function renderForm(): void {
		clear(formEl);
		formEl.appendChild(buildForm(store));
	}

	function updateListEmpty(): void {
		const hasItems = store.state.queue.length > 0 || store.history.items().length > 0;
		listEmptyEl.style.display = hasItems ? "none" : "";
		// Only draw the hairline between the two sibling lists when there is actually a queue group above the history group.
		historyRowsEl.classList.toggle("divider", store.state.queue.length > 0);
	}

	function historySig(): string {
		// Intentionally excludes the resident selection so a resident change does not rebuild (and restart playback of) the gallery videos.
		// Includes `viewed` so opening a video clears its "new" highlight.
		return store.history.items().map((i) => i.id + ":" + i.persisted + ":" + i.createdAt + ":" + (i.viewed ? "1" : "0")).join(",");
	}

	function renderQueueSection(): void {
		clear(queueRowsEl);
		for (const row of buildQueueRows(store)) queueRowsEl.appendChild(row);
		updateListEmpty();
	}

	function renderHistorySection(): void {
		clear(historyRowsEl);
		for (const row of buildHistoryRows(store)) historyRowsEl.appendChild(row);
		observeListMedia(historyRowsEl);
		updateListEmpty();
	}

	function render(): void {
		updateHeader(store, statusEl, storageEl, apiUrlEl, apiErrEl);
		if (store.revs.form !== lastFormRev) {
			lastFormRev = store.revs.form;
			renderForm();
		}
		if (store.revs.queue !== lastQueueRev) {
			lastQueueRev = store.revs.queue;
			renderQueueSection();
		}
		const sig = historySig();
		if (sig !== lastHistorySig) {
			lastHistorySig = sig;
			renderHistorySection();
		} else {
			const nextResidentId = store.residentId();
			if (nextResidentId !== lastResidentId) {
				swapResidentMedia(lastResidentId, nextResidentId);
			}
		}
		lastResidentId = store.residentId();
		renderStorageModal();
	}

	// Pause list videos once they scroll out of view so many completed items do not all decode simultaneously.
	// Visible ones keep their native autoplay.
	// Declared before the first render() call below so renderHistorySection can observe media without hitting a temporal-dead-zone error.
	const listObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const video = maybeElement(entry.target, isVideoElement);
				if (!video) continue;
				if (entry.isIntersecting) {
					video.play().catch(() => {});
				} else {
					video.pause();
				}
			}
		},
		{ rootMargin: "120px" },
	);
	const observeListMedia = (scope: HTMLElement) => {
		listObserver.disconnect();
		scope.querySelectorAll("video.row-media").forEach((v) => listObserver.observe(v));
	};
	// Swap the resident <video> between rows in place, so an expanded prompt <details> on any other row survives the change.
	// Only the previous row's media becomes a thumbnail and the new row's media becomes the autoplay video; nothing else is re-rendered.
	const swapResidentMedia = (previousId: string | null, nextId: string | null): void => {
		const swapRow = (id: string | null, asResident: boolean): void => {
			if (id === null) return;
			const item = store.history.items().find((i) => i.id === id);
			if (!item) return;
			const media = historyRowsEl.querySelector(`.row-media[data-id="${CSS.escape(id)}"]`);
			const row = maybeElement(media ? media.closest("li.job-row.history") : null, isHTMLElement);
			if (!row || !media) return;
			const replacement = buildRowMedia(item, asResident, asResident ? store.residentUrl() : null);
			row.replaceChild(replacement, media);
		};
		swapRow(previousId, false);
		swapRow(nextId, true);
		observeListMedia(historyRowsEl);
	};

	store.subscribe(render);
	render();

	// Update live elapsed timers and progress bars in place (does not rebuild video elements).
	setInterval(() => updateLive(store), 1000);
	// Refresh the quota meter on a throttled cadence (StorageManager estimates are best-effort).
	refreshStorageMeter();
	setInterval(() => void refreshStorageMeter(), 2000);

	setupDelegated(store, app);
	setupFavicon(store);

	// Kick off right away in case a pump needs to resume.
	// After a reload there is nothing to resume, but the call is cheap and safe.
	void pump(store);
}

function buildHeader(): HTMLElement {
	return h("header", { class: "topbar" }, [
		h("div", { class: "brand" }, [h("h1", {}, "Video Studio")]),
		h("div", { class: "topbar-right" }, [
			h("span", { class: "status warn" }, "Connecting…"),
			h("div", { class: "api-inline" }, [
				h("span", { class: "api-url", "data-api-url": "", title: "Click to edit the API server URL" }, ""),
				h("span", { class: "api-err", "data-api-err": "" }, ""),
			]),
			h("div", { class: "storage-inline", "data-action": "open-storage", title: "Manage saved history and storage" }, [
				h("span", { class: "storage-note" }, ""),
				h("div", { class: "storage-meter", "data-storage-bar": "" }, [
					h("div", { class: "storage-meter-fill", "data-storage-fill": "" }),
				]),
				h("span", { class: "storage-meta", "data-storage-text": "" }, ""),
			]),
		]),
	]);
}

function updateHeader(store: Store, statusEl: HTMLElement, storageEl: HTMLElement, apiUrlEl: HTMLElement, apiErrEl: HTMLElement | null): void {
	if (store.state.progressError) {
		// The server is reachable but lacks the feature this UI requires; surface that clearly rather than silently degrading.
		statusEl.textContent = "Online";
		statusEl.className = "status warn";
		statusEl.title = store.state.progressError;
		if (apiErrEl) {
			apiErrEl.textContent = store.state.progressError;
			apiErrEl.className = "api-err show";
		}
	} else if (store.state.online) {
		statusEl.textContent = "Online";
		statusEl.className = "status ok";
	} else if (store.state.capsError) {
		statusEl.textContent = "Offline";
		statusEl.className = "status warn";
		statusEl.title = store.state.capsError;
	} else {
		statusEl.textContent = "Connecting…";
		statusEl.className = "status warn";
	}
	if (apiErrEl && !store.state.progressError) {
		apiErrEl.className = "api-err";
		apiErrEl.textContent = "";
	}
	// Don't clobber an in-progress URL edit.
	if (!apiUrlEl.querySelector("input")) apiUrlEl.textContent = getConfigurableBase();
	if (store.history.isPersistent()) {
		storageEl.textContent = "history saved";
		storageEl.title = "History is saved in this browser.";
	} else {
		storageEl.textContent = "session-only history";
		storageEl.title = "History is kept only for this session.";
	}
}

function buildLayout(): HTMLElement {
	return h("div", { id: "layout", class: "layout" }, [
		h("section", { id: "form", class: "panel form-panel", "aria-label": "New generation" }),
		h("section", { id: "list", class: "panel list-panel", "aria-label": "Generation queue and history" }, [
			h("ol", { id: "queueRows", class: "job-list" }),
			h("ol", { id: "historyRows", class: "job-list" }),
			h("p", { id: "listEmpty", class: "empty" }, "Nothing here yet."),
		]),
	]);
}

function buildForm(store: Store): HTMLElement {
	const f = store.state.form;
	const labels: Record<string, string> = {
		prompt: "Text only",
		"start-end": "Start/End frames",
		refs: "Reference frames",
	};

	const notice: Child[] = f.analysis
		? [
			  h("div", { class: "badge" }, labels[f.analysis.mode] ?? f.analysis.mode),
			  h("div", { class: "analysis" }, [
				  h("div", { class: "analysis-row" }, [
					  h("span", { class: "key" }, "prompt"),
					  h("span", { class: "val prompt-preview" }, truncate(f.analysis.prompt, 240)),
				  ]),
				  f.analysis.files.length > 0
					  ? h("div", { class: "analysis-row" }, [
							h("span", { class: "key" }, "images"),
							h("div", { class: "thumbs" },
								f.analysis.files.map((file) =>
									h("img", { class: "thumb", src: file.dataUrl, alt: file.name, title: file.name, "data-action": "view-image", "data-name": file.name }),
								)),
						])
					  : null,
			  ]),
		  ]
		: [];

	return h("div", { class: "inner" }, [
		h("h2", {}, "New generation"),
		h("div", { class: `dropzone ${f.parsing ? "busy" : ""}`, title: f.analysis ? (f.zipName ?? "zip loaded") : "Drop a .zip here or click to choose" }, [
			h("input", { id: "zipFile", type: "file", accept: ".zip,application/x-zip-compressed,application/zip", class: "hidden" }),
			h("div", { class: "dropzone-inner" }, [
				h("p", { class: "dz-title" }, f.analysis ? "Zip loaded" : "Drop a .zip here"),
				h("p", { class: "dz-sub" }, f.parsing ? "Reading zip…" : "or click to browse"),
			]),
		]),
		...notice,
		f.error ? h("div", { class: "form-error", role: "alert" }, f.error) : null,
		h("div", { class: "dims" }, [
			dimField("Width", "width", f.width, "width"),
			dimField("Height", "height", f.height, "height"),
			dimField("Frames", "frames", f.frames, "frames", frameDurationLabel(f.frames)),
			dimField("Steps", "steps", f.steps, "steps"),
		]),
		h("div", { class: "actions" }, [
			h("button", {
				class: "btn primary",
				type: "button",
				disabled: !f.analysis || f.parsing,
				"data-action": "add-queue",
			}, "Add to queue"),
		]),
	]);
}

function dimField(label: string, name: string, value: number, aria: string, hint?: string): HTMLElement {
	return h("label", { class: "field" }, [
		h("span", {}, label),
		h("input", {
			type: "number",
			name: name,
			value: String(value),
			min: "1",
			step: "1",
			"data-dim": name,
			"aria-label": aria,
		}),
		hint ? h("span", { class: "field-hint", "data-dim-hint": name }, hint) : null,
	]);
}

/**
 * Emit queue rows in display order: queued items (array order), then failed/cancelled items, then the single active item pinned last so it sits just above the history group.
 */
function buildQueueRows(store: Store): HTMLElement[] {
	const q = store.state.queue;
	const queued = q.filter((i) => i.status === "queued");
	const stuck = q.filter((i) => i.status === "failed" || i.status === "cancelled");
	const active = q.filter((i) => i.status === "submitting" || i.status === "generating");

	const rows: HTMLElement[] = [];
	const progressOk = store.state.vidProgress;
	queued.forEach((item, index) => rows.push(buildQueueRow(item, index, queued.length, progressOk)));
	stuck.forEach((item) => rows.push(buildQueueRow(item, -1, 0, progressOk)));
	active.forEach((item) => rows.push(buildQueueRow(item, -1, 0, progressOk)));
	return rows;
}

function buildQueueRow(item: QueueItem, queuedIndex = -1, queuedCount = 0, progressOk = false): HTMLElement {
	const isQueued = item.status === "queued";
	const isActive = item.status === "submitting" || item.status === "generating";
	const chip = h("span", { class: `chip ${item.status}` }, statusLabel(item));
	const elapsed = isActive && item.startedAt != null ? h("span", { class: "elapsed", "data-elapsed": item.id }, formatElapsed(Date.now() - item.startedAt)) : isActive ? h("span", { class: "elapsed", "data-elapsed": item.id }, "…") : null;

	const meta = h("div", { class: "job-meta" }, [
		h("span", {}, `${item.width}×${item.height} · ${item.jobFrames}f · ${item.steps} steps`),
		elapsed,
	]);

	const progress = item.status === "generating" && progressOk ? h("div", { class: "job-progress", "data-progress": item.id }, [
		h("div", { class: "progress-track" }, [h("div", { class: "progress-fill", style: `width:${item.progress ? progressPercent(item.progress) : 0}%` })]),
		h("span", { class: "progress-label" }, item.progress ? progressLabel(item.progress) : "Generating…"),
	]) : null;

	const promptBlock = h("details", { class: "prompt-block" }, [
		h("summary", {}, "Prompt"),
		h("p", {}, item.prompt),
		item.files.length > 0
			? h("div", { class: "thumbs" },
				  item.files.map((f) =>
					  h("img", {
						  class: "thumb",
						  src: f.dataUrl,
						  alt: f.name,
						  title: f.name,
						  "data-action": "view-image",
						  "data-id": item.id,
						  "data-name": f.name,
					  }),
				  ))
			: null,
		item.error ? h("p", { class: "item-error", role: "alert" }, item.error) : null,
	]);

	const actions: Child[] = [];
	if (isQueued) {
		actions.push(
			h("button", { class: "btn small", "data-action": "move-up", "data-id": item.id, disabled: queuedIndex === 0 }, "▲"),
			h("button", { class: "btn small", "data-action": "move-down", "data-id": item.id, disabled: queuedIndex === queuedCount - 1 }, "▼"),
		);
	}
	if (isQueued || item.status === "failed" || item.status === "cancelled") {
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

	return h("li", { class: `job-row queue ${item.status}` }, body);
}

/** Emit history rows newest-first (immediately below the active queue row). */
function buildHistoryRows(store: Store): HTMLElement[] {
	const residentId = store.residentId();
	const residentUrl = store.residentUrl();
	return [...store.history.items()].reverse().map((item) => {
		const isResident = item.id === residentId && item.video.mime.startsWith("video/") && !!residentUrl;
		return buildHistoryRow(item, isResident, isResident ? residentUrl : null);
	});
}

function buildRowMedia(item: HistoryItem, isResident: boolean, residentUrl: string | null): HTMLElement {
	if (item.video.mime.startsWith("video/") && isResident && residentUrl) {
		return h("video", { class: "row-media", src: residentUrl, autoplay: true, muted: true, loop: true, playsinline: true, "aria-label": item.prompt, "data-action": "view-video", "data-id": item.id });
	}
	return h("img", { class: "row-media", src: item.thumbnail, alt: item.prompt, loading: "lazy", "data-action": "view-video", "data-id": item.id });
}

function buildHistoryRow(item: HistoryItem, isResident: boolean, residentUrl: string | null): HTMLElement {
	const media = buildRowMedia(item, isResident, residentUrl);

	return h("li", { class: item.viewed ? "job-row history" : "job-row history new" }, [
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
			h("details", { class: "prompt-block" }, [
				h("summary", {}, "Prompt"),
				h("p", {}, item.prompt),
				item.files.length > 0
					? h("div", { class: "thumbs" },
						  item.files.map((f) =>
							  h("img", {
								  class: "thumb",
								  src: f.dataUrl,
								  alt: f.name,
								  title: f.name,
								  "data-action": "view-image",
								  "data-id": item.id,
								  "data-name": f.name,
							  }),
						  ))
					: null,
			]),
		]),
	]);
}

/** The uploaded zip's filename with its trailing .zip extension stripped, or "" when absent. */
function zipStem(name: string | null): string {
	return name?.replace(/\.zip$/i, "") ?? "";
}

/** Human-facing title for a row/item: the zip filename (minus extension), falling back to the prompt then the id. */
function itemTitle(item: { prompt: string; id: string; zipName: string | null }): string {
	return zipStem(item.zipName) || item.prompt || item.id;
}

/** Derive a download filename for a history item's media preview from its zip name (or prompt) and output format. */
function mediaDownloadName(item: HistoryItem): string {
	const stem = zipStem(item.zipName) || sanitizeBasename(item.prompt) || item.id;
	return `${stem}.${item.video.format}`;
}

const PIE_COLORS = ["#5b8cff", "#e6b45c", "#4cc38a", "#e0605f", "#c678dd", "#7aa3b0"];

function historyItemBytes(item: HistoryItem): number {
	const video = item.video.byteSize;
	const files = item.files.reduce((n, f) => n + f.dataUrl.length, 0);
	return Math.round((files * 3) / 4) + video;
}

function drawStoragePie(canvas: HTMLCanvasElement, slices: { value: number; color: string }[], usage: number, quota: number): void {
	const size = 220;
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const cx = size / 2;
	const cy = size / 2;
	const r = 88;
	const total = quota > 0 ? quota : usage > 0 ? usage : 1;
	const used = usage > 0 ? usage : 0;
	const itemTotal = slices.reduce((n, s) => n + s.value, 0);
	let start = -Math.PI / 2;
	if (itemTotal > 0 && used > 0) {
		for (const s of slices) {
			const angle = ((used * (s.value / itemTotal)) / total) * Math.PI * 2;
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.arc(cx, cy, r, start, start + angle);
			ctx.closePath();
			ctx.fillStyle = s.color;
			ctx.fill();
			start += angle;
		}
	}
	const otherVal = itemTotal === 0 ? used : used - itemTotal;
	if (otherVal > 0) {
		const angle = (otherVal / total) * Math.PI * 2;
		if (angle > 0) {
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.arc(cx, cy, r, start, start + angle);
			ctx.closePath();
			ctx.fillStyle = "#333a47";
			ctx.fill();
			start += angle;
		}
	}
	if (total > used) {
		const angle = ((total - used) / total) * Math.PI * 2;
		ctx.beginPath();
		ctx.moveTo(cx, cy);
		ctx.arc(cx, cy, r, start, start + angle);
		ctx.closePath();
		ctx.fillStyle = "#222832";
		ctx.fill();
	}
	ctx.fillStyle = "#e6e9ee";
	ctx.font = "bold 18px system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(formatBytes(usage), cx, cy);
}

async function handleZipFile(store: Store, file: File): Promise<void> {
	store.setForm({ parsing: true, error: null });
	try {
		const analysis = await analyzeZip(file, file.name);
		const form = store.state.form;
		// Prefill dimensions from server defaults only if the user has not customized them (fields are still at the fallback values).
		const caps = store.state.caps?.defaults_by_mode?.vid_gen;
		store.setForm({
			analysis,
			zipName: file.name,
			parsing: false,
			width: form.width === FALLBACK_DIMS.width && caps?.width ? caps.width : form.width,
			height: form.height === FALLBACK_DIMS.height && caps?.height ? caps.height : form.height,
		});
	} catch (err) {
		store.setForm({ parsing: false, error: err instanceof Error ? err.message : String(err) });
	}
}

function setupDelegated(store: Store, root: HTMLElement): void {
	root.addEventListener("click", (event) => {
		if (!(event.target instanceof HTMLElement)) return;
		const target = maybeElement(event.target.closest("[data-action]"), isHTMLElement);
		if (!target) return;
		const action = target.getAttribute("data-action");
		const id = target.getAttribute("data-id") ?? "";
		if (id) event.stopPropagation();
		switch (action) {
			case "add-queue":
				addToQueue(store);
				break;
			case "remove-queue":
				store.removeQueue(id);
				break;
			case "move-up":
			case "move-down":
				moveQueueItem(store, id, action === "move-up" ? -1 : 1);
				break;
			case "delete-history":
				store.removeHistory(id);
				break;
			case "delete-oldest": {
				const input = maybeElement(root.querySelector("[data-delete-oldest-count]"), isInputElement);
				if (!input) break;
				const n = Number(input.value);
				if (!Number.isFinite(n) || n < 1) break;
				store.removeOldestHistory(Math.floor(n));
				break;
			}
			case "clear-history":
				if (window.confirm("Clear all saved history? This cannot be undone.")) {
					store.clearHistory();
				}
				break;
			case "download-zip":
				void downloadSourceZip(store, id);
				break;
			default:
				break;
		}
	});
	// Drop zone: open the picker on click (freshly query the re-rendered input).
	root.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		if (target.closest(".dropzone") && !target.closest("button")) {
			maybeElement(root.querySelector("#zipFile"), isInputElement)?.click();
		}
	});

	// Dropping a zip onto the drop zone (capture so re-rendered zones work).
	root.addEventListener(
		"dragover",
		(event) => {
			if (event.target instanceof HTMLElement && event.target.closest(".dropzone")) {
				event.preventDefault();
			}
		},
		true,
	);
	root.addEventListener(
		"drop",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement) || !target.closest(".dropzone")) return;
			event.preventDefault();
			const file = event.dataTransfer?.files?.[0];
			if (file) void handleZipFile(store, file);
		},
		true,
	);

	// Read picked files (change bubbles from the hidden input).
	root.addEventListener("change", (event) => {
		const target = maybeElement(event.target, isInputElement);
		if (!target || target.id !== "zipFile") return;
		const file = target.files && target.files[0];
		target.value = "";
		if (file) void handleZipFile(store, file);
	});

	// Keep dimension inputs in sync with state without re-rendering the form (re-rendering on every keystroke would steal focus).
	root.addEventListener("input", (event) => {
		const target = maybeElement(event.target, isInputElement);
		if (!target) return;
		const name = target.getAttribute("data-dim");
		if (!name) return;
		const value = Number(target.value);
		if (!Number.isFinite(value)) return;
		if (name === "width" || name === "height" || name === "frames" || name === "steps") {
			store.setFormDim(name, value);
			if (name === "frames") {
				const hint = root.querySelector('[data-dim-hint="frames"]');
				if (hint) hint.textContent = frameDurationLabel(value);
			}
		}
	});
}

function addToQueue(store: Store): void {
	const f = store.state.form;
	const analysis = f.analysis;
	const width = Number(f.width);
	const height = Number(f.height);
	const frames = Number(f.frames);
	const steps = Number(f.steps);
	if (!analysis) {
		store.setForm({ error: "Upload a .zip first." });
		return;
	}
	if (!Number.isFinite(frames) || frames < 1) {
		store.setForm({ error: "Frames must be at least 1." });
		return;
	}
	if (!Number.isFinite(steps) || steps < 1) {
		store.setForm({ error: "Steps must be at least 1." });
		return;
	}
	if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
		store.setForm({ error: "Width and height must be positive numbers." });
		return;
	}

	const item: QueueItem = {
		id: uid("q_"),
		status: "queued",
		prompt: analysis.prompt,
		zipName: f.zipName,
		mode: analysis.mode,
		files: analysis.files,
		width,
		height,
		jobFrames: frames,
		steps,
		error: null,
		serverId: null,
		startedAt: null,
	};
	store.pushQueue(item);
	store.setForm({ analysis: null, zipName: null, error: null });
	void pump(store);
}

function moveQueueItem(store: Store, id: string, delta: number): void {
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

function updateProgress(store: Store): void {
	for (const item of store.state.queue) {
		if (item.status !== "generating" || !item.progress) continue;
		const root = document.querySelector(`[data-progress="${CSS.escape(item.id)}"]`);
		if (!root) continue;
		const fill = root.querySelector(".progress-fill");
		const label = root.querySelector(".progress-label");
		if (fill instanceof HTMLElement) fill.style.width = progressPercent(item.progress) + "%";
		if (label) label.textContent = progressLabel(item.progress);
	}
}

/** Refresh both live timers and progress bars in place (runs every second). */
function updateLive(store: Store): void {
	updateElapsed(store);
	updateProgress(store);
}

function progressPercent(progress: JobProgress): number {
	if (!Number.isFinite(progress.step) || !Number.isFinite(progress.steps) || progress.steps <= 0) return 0;
	return Math.max(0, Math.min(100, (progress.step / progress.steps) * 100));
}

function stepSpeed(seconds: number): string | null {
	if (!Number.isFinite(seconds) || seconds <= 0) return null;
	// High throughput reads better as a per-second rate than as a tiny s/step figure.
	if (seconds < 0.05) return `${(1 / seconds).toFixed(0)} steps/s`;
	return `${seconds.toFixed(2)} s/step`;
}

function progressLabel(progress: JobProgress): string {
	const speed = stepSpeed(progress.time);
	return `Step ${progress.step} of ${progress.steps}${speed ? ` · ${speed}` : ""}`;
}

function statusLabel(item: QueueItem): string {
	switch (item.status) {
		case "queued":
			return "Queued";
		case "submitting":
			return "Submitting";
		case "generating":
			return "Generating";
		case "completed":
			return "Done";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
		default:
			return item.status;
	}
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function downloadSourceZip(store: Store, id: string): Promise<void> {
	const item = store.history.items().find((i) => i.id === id);
	if (!item) return;
	const source = item.files.map((file) => ({
		name: file.name,
		bytes: dataUrlToBytes(file.dataUrl),
	}));
	const blob = buildSourceZip(source, item.prompt);
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = item.zipName ?? `${id}.zip`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}
