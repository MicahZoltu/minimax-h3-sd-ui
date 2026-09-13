// Batch download: a multi-selection of history videos is zipped into one archive and handed to the browser as a single download.
// The manager owns module-local transient state (selection, run phase, progress snapshot) exactly like the lightbox owns its open/close state — no store domain, no persistence: a refresh abandoning a running batch is correct, because blobs are never lost, only the download action.
//
// Two variants exist: "raw" zips the stored videos as-is, and "compressed" probes then re-encodes each item through the transcode worker before zipping (a missing blob, an unsupported probe, a failed convert, or a watchdog kill skips the item; only a user cancel or a zip-capacity violation aborts the batch).
//
// Every side effect rides on BatchPorts so the pipeline is bun-testable: the default wiring points at the real store / compression / download modules, and tests inject fakes.
// The DOM surface is small and isolated in paint(), which repaints the bar from the snapshot and sweeps the history rows' selection classes.
// The two elements are optional — the browser always passes real elements, while headless bun tests pass null and exercise only the orchestration state machine.

import { CompressionCanceledError, probeCompression, runCompression, type CompressionResult, type CompressionRun } from "./compression.js";
import type { CompressionPlan, UnsupportedReason } from "./compression.types.js";
import { clear, h } from "./dom.js";
import { downloadBlob } from "./download.js";
import { formatBytes, itemTitle, zipStem } from "./format.js";
import { historyItemBytes } from "./historyList.js";
import type { Store } from "./state.js";
import type { HistoryItem } from "./types.js";
import { sanitizeBasename } from "./utils.js";
import { assertZipCapacity, uniqueEntryName, ZipStreamWriter } from "./zipWrite.js";

export type BatchVariant = "raw" | "compressed";
export type BatchPhase = "idle" | "running" | "packing" | "done" | "canceled" | "failed";

export interface BatchPorts {
	loadVideo(id: string): Promise<Blob | null>;
	probe(blob: Blob): Promise<{ plan: CompressionPlan | null; reason: UnsupportedReason | null }>;
	run(blob: Blob, plan: CompressionPlan, opts: { quality: "medium"; stem: string }): CompressionRun;
	download(blob: Blob, filename: string): void;
	now(): number;
	/** Creates the archive writer; optional so tests can stall finish() or add() to pin cancel/capacity aborts. */
	createWriter?(): ZipStreamWriter;
	/** Non-null reason while a compression outside this manager (the lightbox) owns the worker; a compressed start refuses with it. */
	compressionBlocked?(): string | null;
}

export interface BatchFailure {
	title: string;
	reason: string;
}

export interface BatchSnapshot {
	phase: BatchPhase;
	variant: BatchVariant | null;
	total: number;
	done: number;
	skipped: number;
	currentTitle: string | null;
	currentPct: number | null;
	zipName: string | null;
	failures: BatchFailure[];
}

export interface BatchSelection {
	isSelected(id: string): boolean;
	ids(): string[];
}

export interface BatchDownloadHandle {
	selection: BatchSelection;
	snapshot(): BatchSnapshot;
	toggle(id: string): void;
	selectAll(): void;
	clearSelection(): void;
	isSelecting(): boolean;
	setSelecting(on: boolean): void;
	start(variant: BatchVariant): void;
	cancel(): void;
	dismiss(): void;
	/** Full idempotent repaint: bar from snapshot + per-row selection classes. Called by ui after every history reconcile and by the 1 s ticker. */
	paint(): void;
}

/** `videos-<yyyy-mm-dd-HHMMSS>.zip` in local time; pure and testable. */
export function batchZipName(now: number): string {
	const d = new Date(now);
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return `videos-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
}

// The entry stem rule shared with the lightbox's per-item download name: zip stem, then sanitized prompt, then id.
function entryStem(item: HistoryItem): string {
	return zipStem(item.zipName) || sanitizeBasename(item.prompt) || item.id;
}

// One snapshot per selected item, frozen at start(): the id to load plus the title/stem/format used for skip and failure records and entry naming, so a mid-batch removal reports the item by its title instead of a raw id.
interface BatchEntry {
	id: string;
	title: string;
	stem: string;
	format: string;
}

// Every member can be overridden individually (ui.ts injects only the lightbox mutex; tests inject full fakes).
export function createBatchDownload(store: Store, barEl: HTMLElement | null, rowsEl: HTMLElement | null, ports?: Partial<BatchPorts>): BatchDownloadHandle {
	const io: BatchPorts = {
		loadVideo: ports?.loadVideo ?? ((id) => store.history.loadVideo(id)),
		// The defaults wire the real compression coordinator; the raw pipeline never calls probe/run.
		probe: ports?.probe ?? ((blob) => probeCompression(blob)),
		run: ports?.run ?? ((blob, plan, opts) => runCompression(blob, plan, opts)),
		download: ports?.download ?? ((blob, filename) => downloadBlob(blob, filename)),
		now: ports?.now ?? (() => Date.now()),
		...(ports?.createWriter ? { createWriter: ports.createWriter } : {}),
		...(ports?.compressionBlocked ? { compressionBlocked: ports.compressionBlocked } : {}),
	};
	const createWriter = io.createWriter ?? ((): ZipStreamWriter => new ZipStreamWriter());

	// Module-local run state; every field is observable through snapshot().
	const selection = new Set<string>();
	let selecting = false;
	let phase: BatchPhase = "idle";
	let variant: BatchVariant | null = null;
	let total = 0;
	let done = 0;
	let skipped = 0;
	let currentTitle: string | null = null;
	let currentPct: number | null = null;
	let zipName: string | null = null;
	let failures: BatchFailure[] = [];
	let cancelRequested = false;
	let currentRun: CompressionRun | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;

	// Prune selection of ids that no longer exist on every history emission; a fully emptied history (clear / remove-all) additionally exits selecting mode.
	// Eviction is not distinguished from removal here — the runner re-validates each id before loading, and persisted bytes reload on demand regardless.
	store.subscribe(() => {
		const live = new Set(store.history.items().map((i) => i.id));
		for (const id of selection) {
			if (!live.has(id)) selection.delete(id);
		}
		if (live.size === 0) selecting = false;
	}, ["history"]);

	const stopTicker = (): void => {
		if (ticker != null) {
			clearInterval(ticker);
			ticker = null;
		}
	};

	// Settles the run: stops the 1 s repaint ticker, drops the in-flight run reference, and paints the final surface.
	// Nulling currentRun here means a stale settled run can never be cancelled/terminated later.
	const settle = (next: BatchPhase): void => {
		phase = next;
		currentTitle = null;
		currentPct = null;
		currentRun = null;
		stopTicker();
		paint();
	};

	const recordSkip = (title: string, reason: string): void => {
		failures.push({ title, reason });
		skipped += 1;
		// A skipped item no longer contributes progress to the blended bar.
		currentPct = null;
		paint();
	};

	// Shared pipeline tail: assemble the zip and hand it to the browser exactly once.
	// A cancel landing during the (potentially slow) packing must not download the finished archive.
	const packAndDeliver = async (writer: ZipStreamWriter): Promise<void> => {
		// Zero successful entries: nothing to download; the collected skip reasons are the failure list.
		if (writer.entryCount === 0) {
			settle("failed");
			return;
		}
		phase = "packing";
		paint();
		try {
			const zip = await writer.finish();
			if (cancelRequested) {
				settle("canceled");
				return;
			}
			io.download(zip, zipName ?? "videos.zip");
			settle("done");
		} catch (err) {
			failures.push({ title: zipName ?? "zip", reason: err instanceof Error ? err.message : String(err) });
			settle("failed");
		}
	};

	// The raw pipeline: loadVideo → zipWriter.add → finish → download exactly once.
	// Selection order == display order (newest-first), so the zip lists top-to-bottom like the UI.
	const runRaw = async (entries: BatchEntry[]): Promise<void> => {
		const writer = createWriter();
		const used = new Set<string>();
		for (const entry of entries) {
			if (cancelRequested) {
				settle("canceled");
				return;
			}
			currentTitle = entry.title;
			currentPct = null;
			let blob: Blob | null = null;
			try {
				blob = await io.loadVideo(entry.id);
			} catch {
				blob = null;
			}
			// A cancel landing during the awaited load must not zip the just-loaded blob.
			if (cancelRequested) {
				settle("canceled");
				return;
			}
			if (!blob) {
				recordSkip(entry.title, "video data unavailable");
				continue;
			}
			const name = uniqueEntryName(entry.stem, entry.format, used);
			try {
				await writer.add({ name, blob });
			} catch (err) {
				// A zip-capacity violation means the archive cannot be completed as spec'd — abort the whole batch and surface the reason.
				failures.push({ title: entry.title, reason: err instanceof Error ? err.message : String(err) });
				settle("failed");
				return;
			}
			done += 1;
			currentTitle = null;
			paint();
		}
		if (cancelRequested) {
			settle("canceled");
			return;
		}
		await packAndDeliver(writer);
	};

	// The compressed pipeline: loadVideo → probe → run → collect, per item, strictly sequentially.
	// Isolation: a missing blob, an unsupported or failed probe, a failed convert, or a watchdog kill skips the item; only a user cancel or a zip-capacity violation aborts the whole batch.
	const runCompressed = async (entries: BatchEntry[]): Promise<void> => {
		const writer = createWriter();
		const used = new Set<string>();
		for (const entry of entries) {
			if (cancelRequested) {
				settle("canceled");
				return;
			}
			currentTitle = entry.title;
			currentPct = null;
			let blob: Blob | null = null;
			try {
				blob = await io.loadVideo(entry.id);
			} catch {
				blob = null;
			}
			// A cancel landing during the awaited load must not keep processing the just-loaded blob.
			if (cancelRequested) {
				settle("canceled");
				return;
			}
			if (!blob) {
				recordSkip(entry.title, "video data unavailable");
				continue;
			}
			// The probe decides the plan; a probe error is an isolated skip, never a batch abort.
			let plan: CompressionPlan | null = null;
			let reason = "compression probe failed";
			try {
				const outcome = await io.probe(blob);
				plan = outcome.plan;
				if (outcome.plan === null && outcome.reason !== null) reason = outcome.reason;
			} catch {
				plan = null;
			}
			if (cancelRequested) {
				settle("canceled");
				return;
			}
			if (plan === null) {
				recordSkip(entry.title, reason);
				continue;
			}
			const run = io.run(blob, plan, { quality: "medium", stem: entry.stem });
			currentRun = run;
			// onProgress only mutates the snapshot; the 1 s ticker paints.
			run.onProgress((pct) => {
				currentPct = pct;
			});
			let result: CompressionResult;
			try {
				result = await run.done;
			} catch (err) {
				currentRun = null;
				// The cancelRequested flag, not the error source, separates a user cancel (abort) from a watchdog kill (skip), mirroring the lightbox's typed-sentinel discipline.
				if (err instanceof CompressionCanceledError) {
					if (cancelRequested) {
						settle("canceled");
						return;
					}
					recordSkip(entry.title, "compression stalled");
					continue;
				}
				recordSkip(entry.title, err instanceof Error ? err.message : String(err));
				continue;
			}
			// The convert resolved but a cancel was requested meanwhile — the result is dropped and the batch aborts.
			if (cancelRequested) {
				settle("canceled");
				return;
			}
			currentRun = null;
			// The worker's result.filename is ignored: the zip entry name is assigned here, with the plan's extension.
			const name = uniqueEntryName(entry.stem, plan.extension, used);
			try {
				await writer.add({ name, blob: result.blob });
			} catch (err) {
				// A zip-capacity violation means the archive cannot be completed as spec'd — abort the whole batch and surface the reason.
				failures.push({ title: entry.title, reason: err instanceof Error ? err.message : String(err) });
				settle("failed");
				return;
			}
			done += 1;
			currentTitle = null;
			currentPct = null;
			paint();
		}
		if (cancelRequested) {
			settle("canceled");
			return;
		}
		await packAndDeliver(writer);
	};

	const start = (nextVariant: BatchVariant): void => {
		if (phase === "running" || phase === "packing") return;
		if (nextVariant === "compressed") {
			// A running lightbox compression owns the worker; the batch cannot start until it settles (the bar shows the port's reason).
			const blocked = io.compressionBlocked?.() ?? null;
			if (blocked !== null) {
				failures.push({ title: "Batch download", reason: blocked });
				// No zip is made, so a prior settled run's zip name must not linger in the snapshot.
				zipName = null;
				phase = "failed";
				paint();
				return;
			}
		}
		// Snapshot the selection once, in display order (newest-first), so titles and entry names stay stable when items are removed mid-batch.
		const selected = [...store.history.items()].reverse().filter((i) => selection.has(i.id));
		if (selected.length === 0) return;
		const entries = selected.map((i) => ({ id: i.id, title: itemTitle(i), stem: entryStem(i), format: i.video.format }));
		// Pre-flight the classic zip limits from the items' recorded byte sizes, so a doomed batch fails before any loading (the writer re-checks per add as the belt).
		try {
			let bytes = 0;
			let maxBytes = 0;
			for (const item of selected) {
				const n = historyItemBytes(item);
				bytes += n;
				maxBytes = Math.max(maxBytes, n);
			}
			assertZipCapacity({ entryCount: entries.length, totalBytes: bytes, maxEntryBytes: maxBytes });
		} catch (err) {
			failures.push({ title: "Batch download", reason: err instanceof Error ? err.message : String(err) });
			// A prior settled run's zip name must not linger in the snapshot of a failed pre-flight.
			zipName = null;
			phase = "failed";
			paint();
			return;
		}
		variant = nextVariant;
		total = entries.length;
		done = 0;
		skipped = 0;
		failures = [];
		currentTitle = null;
		currentPct = null;
		zipName = batchZipName(io.now());
		cancelRequested = false;
		phase = "running";
		stopTicker();
		ticker = setInterval(paint, 1000);
		paint();
		if (nextVariant === "raw") void runRaw(entries);
		else void runCompressed(entries);
	};

	// Full idempotent repaint: the bar is rebuilt from the snapshot and the history rows' selection classes are swept.
	// Called by ui after every history reconcile and by the 1 s ticker while a batch runs.
	function paint(): void {
		if (!barEl || !rowsEl) return;
		clear(barEl);
		// The bar exists only while there is history to select from; this holds in every mode, so an emptied history hides even a running or settled bar.
		if (store.history.items().length === 0) {
			barEl.style.display = "none";
			return;
		}
		const items = store.history.items();
		if (phase === "idle" && !selecting) {
			barEl.style.display = "";
			barEl.appendChild(h("button", { class: "btn small", "data-action": "history-select", title: "Choose history items to download in bulk" }, "Select…"));
		} else if (phase === "idle") {
			barEl.style.display = "";
			const chosen = items.filter((i) => selection.has(i.id));
			const bytes = chosen.reduce((n, i) => n + historyItemBytes(i), 0);
			barEl.appendChild(h("span", { class: "batch-summary" }, `${chosen.length} selected · ${formatBytes(bytes)}`));
			barEl.appendChild(h("button", { class: "btn small", "data-action": "batch-select-all" }, "All"));
			barEl.appendChild(h("button", { class: "btn small", "data-action": "batch-select-none" }, "None"));
			barEl.appendChild(h("button", { class: "btn small", "data-action": "batch-select-exit" }, "Exit"));
			barEl.appendChild(h("button", { class: "btn small primary", "data-action": "batch-raw", title: "Zip the selected videos as-is" }, "Download raw"));
			barEl.appendChild(h("button", { class: "btn small primary", "data-action": "batch-compressed", title: "Compress each selected video, then zip the results" }, "Download compressed"));
		} else if (phase === "running" || phase === "packing") {
			barEl.style.display = "";
			const fill = h("div", { class: "progress-fill" });
			// Compressed blends the in-flight item's reported percent into the bar; raw has no per-item percent, so its fill moves only at item granularity.
			const blended = variant === "compressed" ? done + (currentPct ?? 0) : done;
			const fraction = total > 0 ? Math.min(1, blended / total) : 0;
			fill.style.width = `${Math.round(fraction * 100)}%`;
			const parts: string[] = [`${done} / ${total}`];
			if (skipped > 0) parts.push(`${skipped} skipped`);
			parts.push(phase === "packing" ? "Packing zip…" : variant === "compressed" ? (currentTitle !== null ? `Compressing ${currentTitle}…` : "Compressing…") : currentTitle !== null ? `Reading ${currentTitle}…` : "Reading…");
			barEl.appendChild(h("span", { class: "batch-summary" }, parts.join(" · ")));
			barEl.appendChild(h("div", { class: "progress-track" }, [fill]));
			barEl.appendChild(h("button", { class: "btn small", "data-action": "batch-cancel" }, "Cancel"));
		} else {
			barEl.style.display = "";
			if (phase === "done") {
				const counts = `${done} ${done === 1 ? "video" : "videos"}`;
				barEl.appendChild(h("span", { class: "batch-summary" }, `Downloaded ${zipName ?? "zip"} · ${counts}${skipped > 0 ? ` · ${skipped} skipped` : ""}`));
			} else if (phase === "canceled") {
				barEl.appendChild(h("span", { class: "batch-summary" }, `Canceled · ${done} of ${total} videos`));
			} else {
				barEl.appendChild(h("span", { class: "batch-summary" }, "Batch download failed."));
			}
			for (const failure of failures) barEl.appendChild(h("div", { class: "batch-fail" }, `${failure.title}: ${failure.reason}`));
			barEl.appendChild(h("button", { class: "btn small", "data-action": "batch-dismiss" }, "Dismiss"));
		}
		// Arming is a class toggle: the CSS reveals the otherwise hidden .row-select columns; no rebuild, live media untouched.
		rowsEl.classList.toggle("selecting", selecting);
		for (const row of rowsEl.querySelectorAll<HTMLElement>("li.job-row.history")) {
			const id = row.getAttribute("data-id") ?? "";
			const selected = selection.has(id);
			const input = row.querySelector('input[data-action="toggle-select"]');
			if (input instanceof HTMLInputElement) input.checked = selected;
			row.classList.toggle("selected", selected);
		}
	}

	return {
		selection: {
			isSelected: (id) => selection.has(id),
			ids: () => [...selection],
		},
		snapshot: () => ({ phase, variant, total, done, skipped, currentTitle, currentPct, zipName, failures: [...failures] }),
		toggle: (id) => {
			if (selection.has(id)) selection.delete(id);
			else selection.add(id);
			paint();
		},
		selectAll: () => {
			for (const item of store.history.items()) selection.add(item.id);
			paint();
		},
		clearSelection: () => {
			selection.clear();
			paint();
		},
		isSelecting: () => selecting,
		setSelecting: (on) => {
			selecting = on;
			paint();
		},
		start,
		cancel: () => {
			if (phase !== "running" && phase !== "packing") return;
			cancelRequested = true;
			// An in-flight convert is terminated so its CompressionCanceledError takes the cancel path immediately; a raw batch has no run and just stops the loop.
			currentRun?.cancel();
		},
		dismiss: () => {
			stopTicker();
			phase = "idle";
			variant = null;
			total = 0;
			done = 0;
			skipped = 0;
			currentTitle = null;
			currentPct = null;
			zipName = null;
			failures = [];
			cancelRequested = false;
			selection.clear();
			selecting = false;
			paint();
		},
		paint,
	};
}
