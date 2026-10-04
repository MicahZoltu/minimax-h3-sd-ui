// Shared QueueItem construction from a validated zip analysis, the form-dimension validation behind it, and the multi-file batch failure summary.
// This lives in its own DOM-free module (rather than inside form.ts or ui.ts) so the add button and the multi-file intake can share one constructor without an import cycle, and so bun tests can exercise all of it without a DOM.

import type { QueueItem, ZipAnalysis } from "./types.js";
import { uid } from "./utils.js";

/** The form's generation dimensions shared by every queued item of a batch. */
export interface QueueDims {
	width: number;
	height: number;
	frames: number;
	steps: number;
}

/**
 * Return the user-facing error message for unusable generation dimensions, or null when they are fine.
 * The messages and their frames -> steps -> width/height order are the add button's historical ones, kept byte-identical.
 */
export function dimsError(dims: QueueDims): string | null {
	if (!Number.isFinite(dims.frames) || dims.frames < 1) return "Frames must be at least 1.";
	if (!Number.isFinite(dims.steps) || dims.steps < 1) return "Steps must be at least 1.";
	if (!Number.isFinite(dims.width) || dims.width < 1 || !Number.isFinite(dims.height) || dims.height < 1) return "Width and height must be positive numbers.";
	return null;
}

/** Build one queued item from a validated zip analysis and the shared generation dimensions. */
export function queueItemFromAnalysis(analysis: ZipAnalysis, dims: QueueDims, zipName: string | null): QueueItem {
	return {
		id: uid("q_"),
		status: "queued",
		prompt: analysis.prompt,
		zipName,
		mode: analysis.mode,
		files: analysis.files,
		videos: analysis.videos,
		audios: analysis.audios,
		width: dims.width,
		height: dims.height,
		jobFrames: dims.frames,
		steps: dims.steps,
		error: null,
		serverId: null,
		startedAt: null,
	};
}

/** One file of a multi-selection that failed validation, with its user-facing message. */
export interface ZipBatchFailure {
	name: string;
	message: string;
}

/**
 * Summarize a multi-file batch as a single one-line form error, or null when nothing failed (so a stale error is cleared).
 * Failure lines keep the caller's file order, so the summary reads in selection order.
 * The noun is "files" because a batch may mix zips and plain .txt prompt files.
 */
export function summarizeZipBatch(queued: number, total: number, failures: readonly ZipBatchFailure[]): string | null {
	if (failures.length === 0) return null;
	const lines = failures.map((f) => `${f.name} — ${f.message}`).join("; ");
	return `Queued ${queued} of ${total} files. Failed: ${lines}`;
}
