// DOM rendering and user interaction wiring.
// The UI is small and deliberately simple: render functions rebuild section containers from the store, and a single event delegation handler routes user actions.
// No markup is ever built from unescaped strings, so uploaded prompts / file names are always safe.

import { cancelJob } from "./api.js";
import { createBatchDownload, type BatchDownloadHandle } from "./batchDownload.js";
import { buildCodecModal, probeCodecSupport, type CodecSupport } from "./codecs.js";
import { h, clear } from "./dom.js";
import { downloadBlob } from "./download.js";
import { setupDragReorder } from "./dragReorder.js";
import { setupFavicon } from "./favicon.js";
import { buildForm, handleZipFiles, updateRefNotes } from "./form.js";
import { buildHeader } from "./header.js";
import { formatBytes, frameDurationLabel, zipStem } from "./format.js";
import { buildHistoryRowSpecs, buildRowMedia } from "./historyList.js";
import { estimateStorage } from "./history.js";
import { createLightbox } from "./lightbox.js";
import { isHTMLElement, isInputElement, isVideoElement, maybeElement, reconcileRows, requiredElement } from "./list.js";
import { getOrCreate, revokeRowMedia } from "./objectUrl.js";
import { pump } from "./queue.js";
import { buildQueueRowSpecs, moveQueueItem, updateLive } from "./queueList.js";
import { dimsError, queueItemFromAnalysis, type QueueDims } from "./queueItem.js";
import type { Store } from "./state.js";
import { buildStorageModal, type StorageModalHandle } from "./storage.js";
import { buildSourceZip } from "./zip.js";

// History details that are loading (or loaded) their file thumbs, so a quick close/re-open does not double-load.
const populating = new Set<string>();

export function mount(store: Store, root: HTMLElement): void {
	let lastHistorySig = "";
	let lastFormRev = -1;
	let lastQueueRev = -1;
	// Start unset so the first resident render forces a swap to the recorded resident, even when the
	// history load's setResident emit already fired before this UI subscribed.
	let lastResidentId: string | null = null;

	let storageModalOpen = false;
	// The modal handle is built once per open and then patched in place, so the number and date inputs survive every poll/emit with their value and focus intact.
	let storageModal: StorageModalHandle | null = null;
	let lastEstimate: { usage: number; quota: number } | null = null;
	let storageMeterRefreshing = false;

	let codecModalOpen = false;
	let codecSupport: CodecSupport | null = null;
	let codecSupportLoading = false;
	const renderCodecModal = (): void => {
		clear(codecRootEl);
		if (!codecModalOpen) {
			codecRootEl.style.display = "none";
			return;
		}
		codecRootEl.style.display = "block";
		codecRootEl.appendChild(buildCodecModal(codecSupport ?? { video: [], audio: [], note: "Probing codec support…" }));
	};
	const loadCodecSupport = async (): Promise<void> => {
		if (codecSupport || codecSupportLoading) return;
		codecSupportLoading = true;
		const support = await probeCodecSupport();
		codecSupportLoading = false;
		codecSupport = support;
		// Only re-render if the modal is still open; a closed modal picks the cached result up on the next open.
		if (codecModalOpen) renderCodecModal();
	};
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
		if (!storageModalOpen) {
			if (storageModal) {
				clear(storageRootEl);
				storageModal = null;
			}
			storageRootEl.style.display = "none";
			return;
		}
		if (!storageModal) {
			// A fresh build on every open, so a previously typed number or chosen date never leaks into the new session.
			clear(storageRootEl);
			storageModal = buildStorageModal(store, lastEstimate?.usage ?? 0, lastEstimate?.quota ?? 0);
			storageRootEl.appendChild(storageModal.el);
			storageRootEl.style.display = "block";
			return;
		}
		storageModal.update(lastEstimate?.usage ?? 0, lastEstimate?.quota ?? 0);
	};

	// The storage modal's destructive arms live beside the modal handle so they can consult the painted preview and refresh the modal via the update path.
	const armDeleteOldest = (): void => {
		const input = maybeElement(storageRootEl.querySelector("[data-delete-oldest-count]"), isInputElement);
		if (!input) return;
		const n = Number(input.value);
		if (!Number.isFinite(n) || n < 1) return;
		// The archive-wide deletion is async, so the button is disabled until it settles: a double-click must not queue a second deletion with a stale n (the same guard the date arm uses).
		// No resident clamp: the deletion targets the whole archive, and the store naturally caps the victims at what the archive holds.
		const modal = storageModal;
		modal?.setDeleteOldestBusy(true);
		void store.removeOldestHistory(Math.floor(n)).then(() => {
			void refreshStorageMeter();
		}).catch(() => {}).finally(() => {
			modal?.setDeleteOldestBusy(false);
			// An evicted-only deletion leaves every resident in place, so the emit-driven repaint gate sees an unchanged signature and would never re-scan; force both readouts against the shrunken archive instead.
			// When the emit path also fires its gated scan, the generation counter discards the loser (a redundant scan is fine; a stale paint is not).
			modal?.refreshArchiveCount();
			modal?.refreshPreview();
		});
	};
	const armDeleteBefore = (): void => {
		const armed = storageModal?.deleteBeforePreview();
		if (!armed || armed.count <= 0) return;
		if (!window.confirm(`Delete ${armed.count} generations before ${armed.date}? This cannot be undone.`)) return;
		const modal = storageModal;
		modal?.setDeleteBeforeBusy(true);
		void store.removeHistoryBefore(armed.cutoffMs).then(() => {
			void refreshStorageMeter();
		}).catch(() => {}).finally(() => {
			modal?.setDeleteBeforeBusy(false);
			// Same forced re-resolve as the delete-oldest arm: the archive shrank, and an evicted-only sweep leaves the repaint gate's signature untouched.
			modal?.refreshArchiveCount();
			modal?.refreshPreview();
		});
	};
	const armClearHistory = (): void => {
		if (!window.confirm("Clear all saved history? This cannot be undone.")) return;
		store.clearHistory();
		void refreshStorageMeter();
	};

	const header = buildHeader(store);
	const storageTextEl = header.storageTextEl;
	const storageBarEl = header.storageBarEl;
	const storageFillEl = header.storageFillEl;

	const app = h("div", { class: "app" }, [
		header.el,
		buildLayout(),
		h("div", { id: "lightbox-root" }),
		h("div", { id: "storage-root" }),
		h("div", { id: "codec-root" }),
	]);
	clear(root);
	root.appendChild(app);

	const layout = requiredElement(app.querySelector("#layout"), isHTMLElement, "layout");
	const formEl = requiredElement(layout.querySelector("#form"), isHTMLElement, "form");
	const queueRowsEl = requiredElement(layout.querySelector("#queueRows"), isHTMLElement, "queue rows");
	const historyRowsEl = requiredElement(layout.querySelector("#historyRows"), isHTMLElement, "history rows");
	const batchBarEl = requiredElement(layout.querySelector("#batchBar"), isHTMLElement, "batch bar");
	const listEmptyEl = requiredElement(layout.querySelector("#listEmpty"), isHTMLElement, "list empty");
	const lightboxEl = requiredElement(app.querySelector("#lightbox-root"), isHTMLElement, "lightbox");
	const storageRootEl = requiredElement(app.querySelector("#storage-root"), isHTMLElement, "storage root");
	const codecRootEl = requiredElement(app.querySelector("#codec-root"), isHTMLElement, "codec root");
	// The batch download manager is module-local the same way: mount passes the bar + history row elements, calls batch.paint() after every history reconcile, and routes the batch arms of the delegated dispatcher to it.
	// The compressionBlocked port closes the mutual exclusion in this direction: a running lightbox compression refuses a compressed batch start, with the wording owned here.
	// The swapped creation order is deliberate and safe: each callback dereferences the other handle lazily at invocation time, never during mount.
	const batch = createBatchDownload(store, batchBarEl, historyRowsEl, { compressionBlocked: () => (box.compressionActive() ? "A compression is already running in the viewer." : null) });
	// The lightbox owns its own open/close state, compression run, and delegated dispatch; mount keeps the handle to consult isOpen() from the resident mouseover guard and to re-route the lightbox-owned dispatch arms to it.
	// compressionBlocked is load-bearing, not cosmetic: it gates BOTH the lightbox probe and the convert start, because an un-gated probe would interleave between the batch's items (serializing the batch behind it), could self-kill on its watchdog while a large blob clones into the worker (a spurious plan-null in the lightbox), and an un-gated convert could legally grab the worker slot between batch items.
	const box = createLightbox(store, lightboxEl, { compressionBlocked: () => (batch.snapshot().phase === "running" && batch.snapshot().variant === "compressed" ? "A batch download is running." : null) });
	setupDragReorder(store, queueRowsEl);

	// List videos pause once they scroll out of view so many completed items do not all decode simultaneously.
	// Visible rows keep their native autoplay.
	//
	// These three must be initialized before any render section can run:
	// renderQueueSection, renderHistorySection, and swapResidentMedia each call observeListMedia, and the
	// initial render block below executes them as soon as mount() drives the domains, so a later declaration
	// would read the const inside its temporal dead zone and throw a ReferenceError on first render.
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
			const replacement = buildRowMedia(store, item, asResident, asResident ? store.residentUrl() : null);
			row.replaceChild(replacement, media);
		};
		swapRow(previousId, false);
		swapRow(nextId, true);
		observeListMedia(historyRowsEl);
	};

	// Capture-phase guard: interacting with a row's prompt block or actions (e.g. expanding the collapsed <details>) must not bubble into the history-row click.
	// Elements that carry their own [data-action] (thumbnails, download buttons) still bubble normally.
	app.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			// Only swallow clicks that are not themselves actionable controls (thumbnails / download buttons) living inside the block.
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
		if (target.classList.contains("codec-overlay")) {
			codecModalOpen = false;
			renderCodecModal();
			return;
		}
		// The storage and codec overlays each carry both `overlay` and their own class, so they are caught by the branches above and never reach here.
		// Clicking any other overlay backdrop closes the lightbox, unless a compression is running (dismissal is locked for its duration).
		if (target.classList.contains("overlay")) {
			box.handleBackdropClose();
			return;
		}
		const actionEl = maybeElement(target.closest("[data-action]"), isHTMLElement);
		if (!actionEl) return;
		const action = actionEl.getAttribute("data-action");
		if (action === "open-storage") {
			event.stopPropagation();
			storageModalOpen = true;
			renderStorageModal();
		} else if (action === "close-storage") {
			event.stopPropagation();
			storageModalOpen = false;
			renderStorageModal();
		} else if (action === "open-codecs") {
			event.stopPropagation();
			codecModalOpen = true;
			renderCodecModal();
			void loadCodecSupport();
		} else if (action === "close-codecs") {
			event.stopPropagation();
			codecModalOpen = false;
			renderCodecModal();
		} else if (action === "delete-oldest") {
			armDeleteOldest();
		} else if (action === "delete-before") {
			armDeleteBefore();
		} else if (action === "clear-history") {
			armClearHistory();
		} else if (action !== null) {
			// All remaining arms (image/video open, downloads, cancel, close) belong to the lightbox module.
			box.handleAction(action, { event, element: actionEl });
		}
	});
	// Hovering a history row's media preview makes that video the single resident one, unless the video modal is open.
	app.addEventListener(
		"mouseover",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			// Keep the resident video stable while the video/player modal is open.
			if (box.isOpen()) return;
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
		// Intentionally excludes the resident selection (so a resident change does not rebuild/restart playback) and `persisted`
		// (which flips asynchronously on save, so including it would manufacture a second unnecessary history reconcile).
		// Includes `viewed` so opening a video clears its "new" highlight.
		return store.history.items().map((i) => `${i.id}:${i.createdAt}:${i.viewed ? "1" : "0"}`).join(",");
	}

	// Reconcile the queue list in place by data-id rather than clearing and rebuilding every row.
	// Unchanged rows keep their existing node (so an open <details> and the live [data-progress] bar survive),
	// while changed or new rows are swapped for freshly built ones. The queue is small, so this stays synchronous.
	function renderQueueSection(): void {
		reconcileRows(queueRowsEl, buildQueueRowSpecs(store), { rowSelector: "li.job-row.queue" });
		observeListMedia(queueRowsEl);
		updateListEmpty();
	}

	// Reconcile the history list in place rather than clearing and rebuilding every row.
	// A completion must add a single row and a view must remove a single highlight, without tearing down
	// the other ~N rows (each of which embeds a large base64 thumbnail) — a full rebuild caused the post-generation studders.
	function renderHistorySection(): void {
		reconcileRows(historyRowsEl, buildHistoryRowSpecs(store, batch.selection), {
			rowSelector: "li.job-row.history",
			// Revoke this item's URLs only after its row left the DOM so no live media still references them.
			onRemoved: (id) => revokeRowMedia(id),
		});
		observeListMedia(historyRowsEl);
		updateListEmpty();
		// Explicit one-line coupling: the batch bar and the rows' selection classes repaint from the manager's snapshot after every reconcile (rows are reused in place, so only this keeps their checkbox paint current).
		batch.paint();
	}

	// Subscribe per domain so a queue/progress/resident emission never scans the history list (and vice versa).
	// The history renderer still gates on historySig(), but only runs when the `history` domain actually fired.
	const renderHeader = (): void => header.update(store);
	const renderFormDomain = (): void => {
		if (store.revs.form !== lastFormRev) {
			lastFormRev = store.revs.form;
			renderForm();
		}
	};
	const renderQueueDomain = (): void => {
		if (store.revs.queue !== lastQueueRev) {
			lastQueueRev = store.revs.queue;
			renderQueueSection();
		}
	};
	const renderHistoryDomain = (): void => {
		const sig = historySig();
		if (sig !== lastHistorySig) {
			lastHistorySig = sig;
			renderHistorySection();
		}
	};
	// The resident change is always applied in place on the single affected row, whether or not the signature changed.
	const renderResidentDomain = (): void => {
		const nextResidentId = store.residentId();
		if (nextResidentId !== lastResidentId) swapResidentMedia(lastResidentId, nextResidentId);
		lastResidentId = nextResidentId;
	};
	const renderStorageDomain = (): void => renderStorageModal();

	store.subscribe(renderHeader, ["caps"]);
	store.subscribe(renderFormDomain, ["form"]);
	store.subscribe(renderQueueDomain, ["queue"]);
	store.subscribe(renderHistoryDomain, ["history"]);
	store.subscribe(renderResidentDomain, ["resident"]);
	store.subscribe(renderStorageDomain, ["history", "queue", "caps"]);

	renderHeader();
	renderFormDomain();
	renderQueueDomain();
	renderHistoryDomain();
	renderResidentDomain();
	renderStorageDomain();
	renderCodecModal();

	// Update live elapsed timers and progress bars in place (does not rebuild video elements).
	setInterval(() => updateLive(store), 1000);
	// Refresh the quota meter on a throttled cadence (StorageManager estimates are best-effort).
	refreshStorageMeter();
	setInterval(() => void refreshStorageMeter(), 2000);

	setupDelegated(store, app, batch);
	setupFavicon(store);

	// Kick off right away in case a pump needs to resume.
	// After a reload there is nothing to resume, but the call is cheap and safe.
	void pump(store);
}

function buildLayout(): HTMLElement {
	return h("div", { id: "layout", class: "layout" }, [
		h("section", { id: "form", class: "panel form-panel", "aria-label": "New generation" }),
		h("section", { id: "list", class: "panel list-panel", "aria-label": "Generation queue and history" }, [
			h("ol", { id: "queueRows", class: "job-list" }),
			h("div", { id: "batchBar", class: "batch-bar" }),
			h("ol", { id: "historyRows", class: "job-list" }),
			h("p", { id: "listEmpty", class: "empty" }, "Nothing here yet."),
		]),
	]);
}

function setupDelegated(store: Store, root: HTMLElement, batch: BatchDownloadHandle): void {
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
			case "remove-queue": {
				const item = store.state.queue.find((i) => i.id === id);
				// Removing a running (submitting/generating) item is a best-effort server-side cancel so the job is not left running orphaned server-side.
				if (item?.serverId && (item.status === "submitting" || item.status === "generating")) {
					void cancelJob(item.serverId).catch(() => {});
				}
				store.removeQueue(id);
				break;
			}
			case "move-up":
			case "move-down":
				moveQueueItem(store, id, action === "move-up" ? -1 : 1);
				break;
			case "delete-history":
				store.removeHistory(id);
				break;
			case "download-zip":
				void downloadSourceZip(store, id);
				break;
			// Batch download arms: selection entry/exit + toggles, start (raw; compressed lands later), cancel, dismiss.
			case "history-select":
				batch.setSelecting(true);
				break;
			case "toggle-select":
				if (id) batch.toggle(id);
				break;
			case "batch-select-all":
				batch.selectAll();
				break;
			case "batch-select-none":
				batch.clearSelection();
				break;
			case "batch-select-exit":
				batch.setSelecting(false);
				break;
			case "batch-raw":
				batch.start("raw");
				break;
			case "batch-compressed":
				batch.start("compressed");
				break;
			case "batch-cancel":
				batch.cancel();
				break;
			case "batch-dismiss":
				batch.dismiss();
				break;
			default:
				break;
		}
	});
	// Deferred <details> thumbs: fill the empty .thumbs container the first time a prompt block is opened.
	// Listen in the capture phase because some browsers and webviews do not bubble `toggle` from <details>;
	// a bubble-phase delegated listener would never fire there, leaving the .thumbs container empty.
	// In capture phase event.target is still the actual <details> row, and the guards below stay idempotent for browsers that do bubble.
	root.addEventListener("toggle", (event) => {
		const el = event.target instanceof HTMLElement ? event.target.closest("details[data-lazy-files]") : null;
		if (!(el instanceof HTMLDetailsElement) || !el.open) return;
		const container = maybeElement(el.querySelector(".thumbs"), isHTMLElement);
		if (!container || container.childElementCount > 0) return;
		const id = el.getAttribute("data-lazy-files");
		const kind = el.getAttribute("data-files-kind");
		if (!id || populating.has(id)) return;
		if (kind === "history") {
			// History media bytes live as Blobs; load each on demand and attach only once it resolves and the details are still open.
			const item = store.history.items().find((i) => i.id === id);
			if (!item || (item.files.length === 0 && item.videos?.length === 0 && item.audios?.length === 0)) return;
			populating.add(id);
			// Load each blob by the RECORDED media-store key, never by a renumbered array index.
			// A record's file keys are authoritative and can be non-contiguous with the array (e.g. legacy items
			// migrated from inline base64 that skipped a non-object entry); an array index would read the wrong key and drop the image.
			const done = () => {
				remaining -= 1;
				if (remaining <= 0) populating.delete(id);
			};
			// Do not hold the .thumbs node captured at toggle time and write into it on resolve: the keyed
			// reconcile (renderHistorySection) can rebuild the row while an async IndexedDB load is in flight,
			// detaching that old container so a resolved blob would be dropped by the isConnected guard and the
			// images would never appear. Re-resolve the current row by data-id and its live .thumbs at resolve
			// time instead, so a freshly rendered row still receives the thumbs.
			const liveContainer = () => {
				const liveRow = maybeElement(root.querySelector(`details[data-lazy-files="${CSS.escape(id)}"]`), isHTMLElement);
				return liveRow ? maybeElement(liveRow.querySelector(".thumbs"), isHTMLElement) : null;
			};
			const appendRefThumb = (blob: Blob | null, key: string, name: string, action: string): void => {
				const live = liveContainer();
				if (!blob || !live || !live.isConnected) return;
				const img = h("img", { class: "thumb", alt: name, title: name, "data-action": action, "data-name": name, "data-id": id, decoding: "async", loading: "lazy" });
				if (img instanceof HTMLImageElement) img.src = getOrCreate(key, blob);
				live.appendChild(img);
			};
			let remaining = item.files.length + (item.videos?.length ?? 0);
			item.files.forEach((file) => {
				void store.history.loadFileByKey(file.key).then((blob) => appendRefThumb(blob, file.key, file.name, "view-image")).finally(done).catch(() => {});
			});
			(item.videos ?? []).forEach((video) => {
				void store.history.loadFileByKey(video.thumbKey).then((blob) => appendRefThumb(blob, video.thumbKey, video.name, "view-ref-video")).finally(done).catch(() => {});
			});
			if ((item.audios?.length ?? 0) > 0) {
				const live = liveContainer();
				if (live && live.isConnected) {
					const audioEl = h("div", { class: "ref-audios" });
					for (const a of item.audios) audioEl.appendChild(h("button", { class: "badge", type: "button", title: `Play ${a.name}`, "data-action": "view-ref-audio", "data-name": a.name, "data-id": id }, a.name));
					live.appendChild(audioEl);
				}
			}
			return;
		}
		const qitem = kind === "queue" ? store.state.queue.find((i) => i.id === id) : undefined;
		if (!qitem || (qitem.files.length === 0 && (qitem.videos?.length ?? 0) === 0 && (qitem.audios?.length ?? 0) === 0)) return;
		for (const file of qitem.files) {
			container.appendChild(h("img", { class: "thumb", src: file.dataUrl, alt: file.name, title: file.name, "data-action": "view-image", "data-name": file.name, "data-id": id, decoding: "async", loading: "lazy" }));
		}
		for (const video of qitem.videos ?? []) {
			container.appendChild(h("img", { class: "thumb", src: video.frames[0] ?? "", alt: video.name, title: `Play ${video.name}`, "data-action": "view-ref-video", "data-name": video.name, "data-id": id, decoding: "async", loading: "lazy" }));
		}
		if ((qitem.audios?.length ?? 0) > 0) {
			const audioEl = h("div", { class: "ref-audios" });
			for (const a of qitem.audios) audioEl.appendChild(h("button", { class: "badge", type: "button", title: `Play ${a.name}`, "data-action": "view-ref-audio", "data-name": a.name, "data-id": id }, a.name));
			container.appendChild(audioEl);
		}
	}, true);

	// Drop zone: open the picker on click (freshly query the re-rendered input).
	root.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		if (target.closest(".dropzone") && !target.closest("button")) {
			maybeElement(root.querySelector("#zipFile"), isInputElement)?.click();
		}
	});

	// Dropping a .zip or .txt onto the drop zone (capture so re-rendered zones work).
	root.addEventListener(
		"dragover",
		(event) => {
			if (event.target instanceof HTMLElement && event.target.closest(".dropzone")) {
				event.preventDefault();
			}
		},
		true,
	);
	// Dropping zip(s) or .txt file(s) onto the drop zone (capture so re-rendered zones work).
	// Every drop routes through the multi-file intake, so a lone file keeps the single-file preview flow.
	root.addEventListener(
		"drop",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement) || !target.closest(".dropzone")) return;
			event.preventDefault();
			const dropped = event.dataTransfer?.files;
			if (dropped && dropped.length > 0) void handleZipFiles(store, Array.from(dropped));
		},
		true,
	);

	// Read picked files (change bubbles from the hidden input).
	// Every selection routes through the multi-file intake, so a lone file keeps the single-file preview flow.
	root.addEventListener("change", (event) => {
		const target = maybeElement(event.target, isInputElement);
		if (!target || target.id !== "zipFile") return;
		const picked = target.files ? Array.from(target.files) : [];
		target.value = "";
		if (picked.length > 0) void handleZipFiles(store, picked);
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
				// The preview's reference-video trim notes read the form's frame count; refresh them in place alongside the hint (no re-render, so focus survives).
				updateRefNotes(root, value);
			}
		}
	});
}

function addToQueue(store: Store): void {
	const f = store.state.form;
	const analysis = f.analysis;
	if (!analysis) {
		store.setForm({ error: "Upload a .zip or .txt first." });
		return;
	}
	// The Number() wrap mirrors the historical read, and the shared validator keeps its exact messages and check order.
	const dims: QueueDims = { width: Number(f.width), height: Number(f.height), frames: Number(f.frames), steps: Number(f.steps) };
	const problem = dimsError(dims);
	if (problem) {
		store.setForm({ error: problem });
		return;
	}
	store.pushQueue(queueItemFromAnalysis(analysis, dims, f.zipName));
	store.setForm({ analysis: null, zipName: null, error: null });
	void pump(store);
}

async function downloadSourceZip(store: Store, id: string): Promise<void> {
	const item = store.history.items().find((i) => i.id === id);
	if (!item) return;
	// Load each persisted input file's Blob on demand and rebuild the source zip from its bytes.
	// Load by the file's recorded media-store key, never by a renumbered array index: a legacy
	// record's keys can be non-contiguous with the array, and an index read would drop files from the zip.
	const source: { name: string; bytes: Uint8Array }[] = [];
	const pushSource = async (name: string, key: string): Promise<void> => {
		// A missing blob is skipped gracefully; the rest of the files still land in the zip.
		const blob = await store.history.loadFileByKey(key);
		if (!blob) return;
		source.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
	};
	for (const file of item.files) await pushSource(file.name, file.key);
	// The original container/file bytes reproduce the reference videos and audio in the regenerated zip.
	for (const video of item.videos ?? []) await pushSource(video.name, video.sourceKey);
	for (const audio of item.audios ?? []) await pushSource(audio.name, audio.key);
	const blob = buildSourceZip(source, item.prompt);
	downloadBlob(blob, `${zipStem(item.zipName) || id}.zip`);
}
