// DOM rendering and user interaction wiring.
// The UI is small and deliberately simple: render functions rebuild section containers from the store, and a single event delegation handler routes user actions.
// No markup is ever built from unescaped strings, so uploaded prompts / file names are always safe.

import { analyzeZip, buildSourceZip } from "./zip.js";
import { h, clear, type Child } from "./dom.js";
import { downloadFile, downloadVideo } from "./download.js";
import { getConfigurableBase } from "./config.js";
import { pump } from "./queue.js";
import type { Store } from "./state.js";
import { FALLBACK_DIMS } from "./state.js";
import type { HistoryItem, QueueItem } from "./types.js";
import { dataUrlToBytes, formatElapsed, uid } from "./utils.js";

const isHTMLElement = (el: unknown): el is HTMLElement => el instanceof HTMLElement;
const isInputElement = (el: unknown): el is HTMLInputElement => el instanceof HTMLInputElement;
const isVideoElement = (el: unknown): el is HTMLVideoElement => el instanceof HTMLVideoElement;

function requiredElement<T extends Element>(el: unknown, guard: (el: unknown) => el is T, what: string): T {
	if (!guard(el)) throw new Error(`Required ${what} element is missing.`);
	return el;
}

function maybeElement<T extends Element>(el: unknown, guard: (el: unknown) => el is T): T | null {
	return guard(el) ? el : null;
}

export function mount(store: Store, root: HTMLElement): void {
	let lastHistorySig = "";
	let lastSelectedId: string | null = null;
	let lastFormRev = -1;
	let lastQueueRev = -1;

	const header = buildHeader();
	const statusEl = requiredElement(header.querySelector(".status"), isHTMLElement, "status");
	const storageEl = requiredElement(header.querySelector(".storage-note"), isHTMLElement, "storage note");
	const apiInput = maybeElement(header.querySelector("#apiBase"), isInputElement);
	const apiHintEl = maybeElement(header.querySelector("[data-api-hint]"), isHTMLElement);
	if (apiInput) apiInput.value = getConfigurableBase();
	updateHeader(store, statusEl, storageEl, apiHintEl);

	const app = h("div", { class: "app" }, [
		header,
		buildLayout(),
		h("div", { id: "overlay-root" }),
		h("div", { id: "lightbox-root" }),
	]);
	clear(root);
	root.appendChild(app);

	const layout = requiredElement(app.querySelector("#layout"), isHTMLElement, "layout");
	const formEl = requiredElement(layout.querySelector("#form"), isHTMLElement, "form");
	const queueRowsEl = requiredElement(layout.querySelector("#queueRows"), isHTMLElement, "queue rows");
	const historyRowsEl = requiredElement(layout.querySelector("#historyRows"), isHTMLElement, "history rows");
	const listEmptyEl = requiredElement(layout.querySelector("#listEmpty"), isHTMLElement, "list empty");
	const overlayEl = requiredElement(app.querySelector("#overlay-root"), isHTMLElement, "overlay");
	const lightboxEl = requiredElement(app.querySelector("#lightbox-root"), isHTMLElement, "lightbox");

	// Lightbox: click an input image anywhere in the list (or detail) to view it at its native size, shrunk to fit the viewport.
	// Clicking the backdrop closes it.
	let lightboxSrc: string | null = null;
	const renderLightbox = (): void => {
		clear(lightboxEl);
		if (!lightboxSrc) {
			lightboxEl.style.display = "none";
			return;
		}
		lightboxEl.style.display = "block";
		lightboxEl.appendChild(
			h("div", { class: "overlay lightbox-overlay" }, [
				h("img", { class: "lightbox-media", src: lightboxSrc, alt: "Enlarged input image" }),
				h("button", { class: "btn lightbox-close", "data-action": "close-lightbox" }, "Close"),
			]),
		);
	};
	const lookupImage = (id: string, name: string): string | null => {
		const inQueue = store.state.queue.find((i) => i.id === id)?.files.find((f) => f.name === name);
		if (inQueue) return inQueue.dataUrl;
		const inHistory = store.history.items().find((i) => i.id === id)?.files.find((f) => f.name === name);
		return inHistory ? inHistory.dataUrl : null;
	};
	// Capture-phase guard: interacting with a row's prompt block or actions (e.g. expanding the collapsed <details>) must not bubble into the history-row click that opens the detail modal.
	// Elements that carry their own [data-action] (thumbnails, download buttons) still bubble normally.
	app.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			// Only swallow clicks that are not themselves actionable controls (thumbnails / download buttons) living inside the block.
			// The row itself carries data-action="select-history", so we must check for a *descendant* [data-action], not any ancestor.
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
		// Clicking the overlay backdrop (outside the content) closes it.
		if (target.classList.contains("overlay")) {
			if (target.classList.contains("lightbox-overlay")) lightboxSrc = null;
			else store.selectHistory(null);
			renderLightbox();
			return;
		}
		const actionEl = maybeElement(target.closest("[data-action]"), isHTMLElement);
		if (!actionEl) return;
		const action = actionEl.getAttribute("data-action");
		const id = actionEl.getAttribute("data-id") ?? "";
		if (action === "view-image" && id) {
			event.stopPropagation();
			lightboxSrc = lookupImage(id, actionEl.getAttribute("data-name") ?? "");
			renderLightbox();
		} else if (action === "close-lightbox") {
			lightboxSrc = null;
			renderLightbox();
		}
	});

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
		// Intentionally excludes the selection so opening a detail view does not rebuild (and restart playback of) the gallery videos.
		return store.history.items().map((i) => i.id + ":" + i.persisted + ":" + i.createdAt).join(",");
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

	function renderOverlay(): void {
		clear(overlayEl);
		const item = store.history.items().find((i) => i.id === store.state.selectedId);
		if (!item) {
			overlayEl.style.display = "none";
			return;
		}
		overlayEl.style.display = "block";
		overlayEl.appendChild(buildDetail(item));
	}

	function render(): void {
		updateHeader(store, statusEl, storageEl, apiHintEl);
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
		}
		if (store.state.selectedId !== lastSelectedId) {
			lastSelectedId = store.state.selectedId;
			renderOverlay();
		}
	}

	store.subscribe(render);
	render();

	// Pause list videos once they scroll out of view so many completed items do not all decode simultaneously.
	// Visible ones keep their native autoplay.
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

	// Update live elapsed timers in place (does not rebuild video elements).
	setInterval(() => updateElapsed(store), 1000);

	setupDelegated(store, app);

	// Kick off right away in case a pump needs to resume.
	// After a reload there is nothing to resume, but the call is cheap and safe.
	void pump(store);
}

function buildHeader(): HTMLElement {
	return h("header", { class: "topbar" }, [
		h("div", { class: "brand" }, [h("h1", {}, "Video Studio")]),
		h("div", { class: "topbar-right" }, [
			h("span", { class: "status warn" }, "Connecting…"),
			h("span", { class: "storage-note" }, ""),
			h("details", { class: "api-settings" }, [
				h("summary", { title: "Configure the API server" }, "API"),
				h("div", { class: "api-settings-body" }, [
					h("label", { class: "field" }, [
						h("span", {}, "Server URL"),
						h("input", {
							type: "url",
							id: "apiBase",
							name: "apiBase",
							"data-api-base": "",
							placeholder: "http://localhost:1234",
							spellcheck: "false",
							"aria-label": "API server URL",
						}),
					]),
					h("div", { class: "api-settings-actions" }, [
						h("button", {
							class: "btn small primary",
							type: "button",
							"data-action": "apply-api-base",
						}, "Apply"),
						h("button", {
							class: "btn small",
							type: "button",
							"data-action": "reset-api-base",
						}, "Reset"),
					]),
					h("p", { class: "api-settings-hint", "data-api-hint": "" }, ""),
				]),
			]),
		]),
	]);
}

function updateHeader(store: Store, statusEl: HTMLElement, storageEl: HTMLElement, apiHintEl: HTMLElement | null): void {
	if (store.state.online) {
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
	if (apiHintEl) apiHintEl.textContent = `API: ${store.state.apiBase}`;
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
									h("img", { class: "thumb", src: file.dataUrl, alt: file.name, title: file.name }),
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
			dimField("Frames", "frames", f.frames, "frames"),
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

function dimField(label: string, name: string, value: number, aria: string): HTMLElement {
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
	queued.forEach((item, index) => rows.push(buildQueueRow(item, index, queued.length)));
	stuck.forEach((item) => rows.push(buildQueueRow(item)));
	active.forEach((item) => rows.push(buildQueueRow(item)));
	return rows;
}

function buildQueueRow(item: QueueItem, queuedIndex = -1, queuedCount = 0): HTMLElement {
	const isQueued = item.status === "queued";
	const isActive = item.status === "submitting" || item.status === "generating";
	const chip = h("span", { class: `chip ${item.status}` }, statusLabel(item));
	const elapsed = isActive && item.startedAt != null ? h("span", { class: "elapsed", "data-elapsed": item.id }, formatElapsed(Date.now() - item.startedAt)) : isActive ? h("span", { class: "elapsed", "data-elapsed": item.id }, "…") : null;

	const meta = h("div", { class: "job-meta" }, [
		h("span", {}, `${item.width}×${item.height} · ${item.jobFrames}f · ${item.steps} steps`),
		elapsed,
	]);

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
		h("div", { class: "row-head" }, [chip, h("div", { class: "row-title" }, truncate(item.prompt, 90))]),
		meta,
		promptBlock,
	];
	if (actions.length > 0) body.push(h("div", { class: "row-actions" }, actions));

	return h("li", { class: `job-row queue ${item.status}` }, body);
}

/** Emit history rows newest-first (immediately below the active queue row). */
function buildHistoryRows(store: Store): HTMLElement[] {
	return [...store.history.items()].reverse().map(buildHistoryRow);
}

function buildHistoryRow(item: HistoryItem): HTMLElement {
	const src = mediaSrc(item);
	const media = item.video.mime === "image/webp" ? h("img", { class: "row-media", src, alt: item.prompt, loading: "lazy" }) : h("video", { class: "row-media", src, autoplay: true, muted: true, loop: true, playsinline: true, "aria-label": item.prompt });

	const meta = h("div", { class: "job-meta" }, [
		h("span", {}, `${formatElapsed(item.elapsedMs)} · ${item.frameCount}f · ${item.width}×${item.height}`),
	]);

	return h("li", {
		class: "job-row history",
		"data-action": "select-history",
		"data-id": item.id,
		title: "Open details",
	}, [
		media,
		h("div", { class: "row-body" }, [
			h("div", { class: "row-title" }, truncate(item.prompt, 90)),
			meta,
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
		h("div", { class: "row-actions" }, [
			h("button", {
				class: "btn small",
				"data-action": "download-video",
				"data-id": item.id,
				title: "Download video",
			}, "Download"),
		]),
	]);
}

function buildDetail(item: HistoryItem): HTMLElement {
	const src = mediaSrc(item);
	const media = item.video.mime === "image/webp" ? h("img", { class: "detail-media", src, alt: item.prompt }) : h("video", { class: "detail-media", src, controls: true, playsinline: true });

	const files = item.files.length
		? h("div", { class: "detail-files" }, [
			  h("h3", {}, "Input files"),
			  h("div", { class: "thumbs" },
				  item.files.map((f, i) =>
					  h("figure", { class: "file-fig" }, [
						  h("img", {
							  class: "thumb",
							  src: f.dataUrl,
							  alt: f.name,
							  "data-action": "view-image",
							  "data-id": item.id,
							  "data-name": f.name,
						  }),
						  h("figcaption", {}, f.name),
						  h("button", {
							  class: "btn small",
							  "data-action": "download-file",
							  "data-id": item.id,
							  "data-file-index": String(i),
						  }, "Save"),
					  ]),
				  )),
		  ])
		: null;

	return h("div", { class: "overlay" }, [
		h("div", { class: "modal" }, [
			h("div", { class: "modal-head" }, [
				h("h2", {}, "Generation details"),
				h("button", { class: "btn", "data-action": "close-detail" }, "Close"),
			]),
			h("div", { class: "detail-meta" }, [
				h("span", {}, `${formatElapsed(item.elapsedMs)} elapsed · ${item.frameCount} frames · ${item.width}×${item.height} @${item.fps}fps`),
			]),
			media,
			h("div", { class: "detail-prompt" }, [
				h("h3", {}, "Prompt"),
				h("pre", {}, item.prompt),
			]),
			files,
			h("div", { class: "detail-actions" }, [
				h("button", {
					class: "btn primary",
					"data-action": "download-video",
					"data-id": item.id,
				}, "Download video"),
				h("button", {
					class: "btn secondary",
					"data-action": "download-zip",
					"data-id": item.id,
				}, "Download source zip"),
			]),
		]),
	]);
}

function mediaSrc(item: HistoryItem): string {
	return `data:${item.video.mime};base64,${item.video.b64}`;
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
			case "select-history":
				store.selectHistory(id);
				break;
			case "close-detail":
				store.selectHistory(null);
				break;
			case "apply-api-base": {
				const input = maybeElement(root.querySelector("#apiBase"), isInputElement);
				if (!input) break;
				const hint = maybeElement(root.querySelector("[data-api-hint]"), isHTMLElement);
				try {
					const normalized = store.setApiBase(input.value);
					input.value = normalized;
					if (hint) {
						hint.textContent = "";
						hint.classList.remove("error");
					}
				} catch (err) {
					if (hint) {
						hint.textContent = err instanceof Error ? err.message : String(err);
						hint.classList.add("error");
					}
				}
				break;
			}
			case "reset-api-base": {
				const input = maybeElement(root.querySelector("#apiBase"), isInputElement);
				store.resetApiBase();
				if (input) input.value = store.state.defaultApiBase;
				break;
			}
			case "download-video":
				void downloadVideo(store, id);
				break;
			case "download-zip":
				void downloadSourceZip(store, id);
				break;
			case "download-file": {
				const fileIndex = Number(target.getAttribute("data-file-index") ?? "");
				void downloadFile(store, id, Number.isFinite(fileIndex) ? fileIndex : -1);
				break;
			}
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
		if (name === "width") store.state.form.width = value;
		else if (name === "height") store.state.form.height = value;
		else if (name === "frames") store.state.form.frames = value;
		else if (name === "steps") store.state.form.steps = value;
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
		if (item.status === "generating" && item.startedAt != null) {
			const el = document.querySelector(`[data-elapsed="${CSS.escape(item.id)}"]`);
			if (el) el.textContent = formatElapsed(Date.now() - item.startedAt);
		}
	}
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
	a.download = `${id}.zip`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}
