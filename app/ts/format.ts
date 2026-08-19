// Pure, browser-free formatting helpers for queue/history row rendering.
// Nothing in this file touches the DOM, so it is fully unit-testable in Bun.

import type { JobProgress } from "./api.js";
import { GENERATION_PRESET } from "./request.js";
import type { HistoryItem, QueueItem } from "./types.js";
import { sanitizeBasename } from "./utils.js";

export function frameDurationLabel(frames: number): string {
	const seconds = frames / GENERATION_PRESET.fps;
	return `≈ ${seconds.toFixed(1)} seconds`;
}

export function formatBytes(n: number): string {
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

export function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function progressPercent(progress: JobProgress): number {
	if (!Number.isFinite(progress.step) || !Number.isFinite(progress.steps) || progress.steps <= 0) return 0;
	return Math.max(0, Math.min(100, (progress.step / progress.steps) * 100));
}

export function stepSpeed(seconds: number): string | null {
	if (!Number.isFinite(seconds) || seconds <= 0) return null;
	// High throughput reads better as a per-second rate than as a tiny s/step figure.
	if (seconds < 0.05) return `${(1 / seconds).toFixed(0)} steps/s`;
	return `${seconds.toFixed(2)} s/step`;
}

export function progressLabel(progress: JobProgress): string {
	const speed = stepSpeed(progress.time);
	return `Step ${progress.step} of ${progress.steps}${speed ? ` · ${speed}` : ""}`;
}

export function statusLabel(item: QueueItem): string {
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

/** The uploaded zip's filename with its trailing .zip extension stripped, or "" when absent. */
export function zipStem(name: string | null): string {
	return name?.replace(/\.zip$/i, "") ?? "";
}

/** Human-facing title for a row/item: the zip filename (minus extension), falling back to the prompt then the id. */
export function itemTitle(item: { prompt: string; id: string; zipName: string | null }): string {
	return zipStem(item.zipName) || item.prompt || item.id;
}

/** Derive a download filename for a history item's media preview from its zip name (or prompt) and output format. */
export function mediaDownloadName(item: HistoryItem): string {
	const stem = zipStem(item.zipName) || sanitizeBasename(item.prompt) || item.id;
	return `${stem}.${item.video.format}`;
}
