// The new-job form DOM builder and the .zip intake that fills it.
// Both take the store as input and neither reaches into any mount-closure transient state.
//
// The intake has two entry points.
// handleZipFile keeps the single-zip preview flow; handleZipFiles routes every pick/drop through the multi-zip batch, where a lone file delegates to the single-zip flow unchanged.

import { h, type Child } from "./dom.js";
import { frameDurationLabel, truncate } from "./format.js";
import { pump } from "./queue.js";
import { FALLBACK_DIMS, type Store } from "./state.js";
import type { QueueItem } from "./types.js";
import { analyzeZip } from "./zip.js";
import { dimsError, queueItemFromAnalysis, summarizeZipBatch, type QueueDims, type ZipBatchFailure } from "./queueItem.js";

export function buildForm(store: Store): HTMLElement {
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
									h("img", { class: "thumb", src: file.dataUrl, alt: file.name, title: file.name, decoding: "async", "data-action": "view-image", "data-name": file.name }),
								)),
						])
					  : null,
				  f.analysis.videos.length > 0
					  ? h("div", { class: "analysis-row" }, [
							h("span", { class: "key" }, "videos"),
							h("div", { class: "thumbs" },
								f.analysis.videos.map((video) =>
									h("img", { class: "thumb", src: video.frames[0] ?? "", alt: video.name, title: `Play ${video.name} (${video.frames.length} frames at ${video.fps}fps)`, decoding: "async", "data-action": "view-ref-video", "data-name": video.name }),
								)),
						])
					  : null,
				  f.analysis.audios.length > 0
					  ? h("div", { class: "analysis-row" }, [
							h("span", { class: "key" }, `audio (${f.analysis.audios.length})`),
							h("div", { class: "ref-audios" }, f.analysis.audios.map((audio) => h("button", { class: "badge", type: "button", title: `Play ${audio.name}`, "data-action": "view-ref-audio", "data-name": audio.name }, audio.name))),
						])
					  : null,
			  ]),
		  ]
		: [];

	return h("div", { class: "inner" }, [
		h("h2", {}, "New generation"),
		h("div", { class: `dropzone ${f.parsing ? "busy" : ""}`, title: f.analysis ? (f.zipName ?? "zip loaded") : "Drop a .zip here or click to choose" }, [
			h("input", { id: "zipFile", type: "file", accept: ".zip,application/x-zip-compressed,application/zip", class: "hidden", multiple: true }),
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
			h("button", { class: "btn secondary", type: "button", "data-action": "open-codecs" }, "Codec support"),
			h("div", { class: "actions-spacer" }),
			h("button", {
				class: "btn primary",
				type: "button",
				disabled: !f.analysis || f.parsing,
				"data-action": "add-queue",
			}, "Add to queue"),
		]),
	]);
}

export function dimField(label: string, name: string, value: number, aria: string, hint?: string): HTMLElement {
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

/**
 * Intake for every picked or dropped zip selection.
 * A selection arriving while another intake is still parsing is ignored, so two in-flight intakes cannot interleave their form writes.
 * Exactly one file keeps the single-zip preview flow untouched.
 * More than one skips the preview and queues each valid zip with the form's current dimensions, then reports the failures as a single one-line form error while leaving the form empty and ready.
 */
export async function handleZipFiles(store: Store, files: File[]): Promise<void> {
	// A second pick/drop while a batch (or a single parse) is still in flight must not interleave setForm writes and summaries, so ignore it.
	if (store.state.form.parsing) return;
	if (files.length <= 1) {
		const file = files[0];
		if (file) await handleZipFile(store, file);
		return;
	}
	store.setForm({ parsing: true, error: null });
	try {
		// Read the form's dimensions once for the whole batch, so every queued item shares the same values.
		const f = store.state.form;
		const dims: QueueDims = { width: Number(f.width), height: Number(f.height), frames: Number(f.frames), steps: Number(f.steps) };
		const problem = dimsError(dims);
		if (problem) {
			store.setForm({ parsing: false, error: problem });
			return;
		}
		const { queued, failures } = await queueZipsFromFiles(store, files, dims);
		// One form write at the end of the batch: clear back to the empty/ready state and either summarize the failures or clear any stale error.
		store.setForm({ analysis: null, zipName: null, parsing: false, error: summarizeZipBatch(queued, files.length, failures) });
		void pump(store);
	} catch (err) {
		// No failure path may leave the form stuck in the parsing state.
		store.setForm({ parsing: false, error: err instanceof Error ? err.message : String(err) });
		// Pump in case any item was queued before an unexpected error (a no-op otherwise).
		void pump(store);
	}
}

/**
 * Parse the batch's files sequentially, awaiting each analysis before the next starts so peak memory stays bounded to one parse.
 * Queues every valid item at the end in one pushQueueMany write, in file-selection order, so FIFO runs the first picked file first (pushing per file would re-persist the whole queue each time, O(N²) bytes for a batch).
 * A per-file validation failure is isolated: it lands in `failures` and never stops the remaining files.
 */
export async function queueZipsFromFiles(store: Store, files: File[], dims: QueueDims): Promise<{ queued: number; failures: ZipBatchFailure[] }> {
	const failures: ZipBatchFailure[] = [];
	const items: QueueItem[] = [];
	for (const file of files) {
		try {
			const analysis = await analyzeZip(file, file.name);
			items.push(queueItemFromAnalysis(analysis, dims, file.name));
		} catch (err) {
			failures.push({ name: file.name, message: err instanceof Error ? err.message : String(err) });
		}
	}
	store.pushQueueMany(items);
	return { queued: items.length, failures };
}
