// Generation runner.
//
// The browser queue is a client-side list.
// This module advances it one item at a time: it submits the next pending item to the server, polls the job until it reaches a terminal state, records a completed item into history, then automatically advances to the next queued item.
// Only one server job is in-flight from this browser at a time.

import { ApiError, getJob, isJobProgress, submitVideoJob } from "./api.js";
import type { Job } from "./api.js";
import { buildVidGenRequest, mimeForFormat, GENERATION_PRESET } from "./request.js";
import type { Store } from "./state.js";
import type { HistoryItem, QueueItem } from "./types.js";
import { base64ToBytes, bytesToBlob, sleep, uid } from "./utils.js";

export const POLL_MS = 1500;
const SUBMIT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_SUBMIT_RETRIES = SUBMIT_RETRY_DELAYS_MS.length;

function isRetriable(err: unknown): boolean {
	if (!(err instanceof ApiError)) return false;
	// Network issues (status 0) and transient server errors can be retried.
	return err.status === 0 || err.status === 429 || err.status === 500 || err.status === 503;
}

export function hasActiveJob(store: Store): boolean {
	return store.state.queue.some((i) => i.status === "submitting" || i.status === "generating");
}

/**
 * Re-attach to server jobs that were in flight when the page was reloaded.
 * The queue (including each item's `serverId`) is persisted, so an item that was `generating` can resume simply by polling its server job again.
 * An item stuck at `submitting` without a `serverId` cannot be traced to a server job, so it degrades to a failed note per the product requirement.
 * This runs synchronously before the pump starts, so a resumed job still occupies the single active slot and keeps the pump from double-submitting.
 */
export function resumeActiveJobs(store: Store): void {
	for (const item of [...store.state.queue]) {
		if (item.status !== "submitting" && item.status !== "generating") continue;
		if (item.serverId) {
			// Continue the queue once the resumed job reaches a terminal state.
			void pollUntilTerminal(store, item.id, item.serverId, "generation lost due to page refresh").then(() => void pump(store));
		} else {
			store.patchQueueItem(item.id, { status: "failed", error: "generation lost due to page refresh" });
		}
	}
}

function nextPending(store: Store): QueueItem | undefined {
	// The array is newest-first (pushQueue unshifts), so the oldest queued item sits last and runs next (FIFO).
	for (let i = store.state.queue.length - 1; i >= 0; i--) {
		const item = store.state.queue[i];
		if (item && item.status === "queued") return item;
	}
	return undefined;
}

/**
 * Start the next pending job if none is currently in-flight.
 * Called after any queue mutation and when a running job finishes.
 */
export async function pump(store: Store): Promise<void> {
	if (hasActiveJob(store)) return;
	const item = nextPending(store);
	if (!item) return;
	await runItem(store, item);
	// Automatically continue to the next queued item when this one finishes.
	await pump(store);
}

async function runItem(store: Store, item: QueueItem): Promise<void> {
	// The UI requires generation progress; refuse to run on a server that does not report it.
	if (store.state.progressError) {
		store.patchQueueItem(item.id, { status: "failed", error: store.state.progressError });
		return;
	}
	const body = buildVidGenRequest(item);
	store.patchQueueItem(item.id, { status: "submitting", startedAt: null, error: null });

	let job: Job;
	try {
		job = await submitWithRetry(body);
	} catch (err) {
		store.patchQueueItem(item.id, { status: "failed", error: `Could not start the job: ${messageOf(err)}` });
		return;
	}

	store.patchQueueItem(item.id, { status: "generating", serverId: job.id });
	await pollUntilTerminal(store, item.id, job.id);
}

async function submitWithRetry(body: unknown): Promise<Job> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_SUBMIT_RETRIES; attempt++) {
		try {
			return await submitVideoJob(body);
		} catch (err) {
			lastError = err;
			const delay = SUBMIT_RETRY_DELAYS_MS[attempt];
			if (!isRetriable(err) || attempt === MAX_SUBMIT_RETRIES || delay === undefined) {
				throw err;
			}
			await sleep(delay);
		}
	}
	throw lastError;
}

const MAX_CONSECUTIVE_POLL_ERRORS = 120;

async function pollUntilTerminal(store: Store, itemId: string, serverId: string, lostJobMessage = "The server lost track of this job."): Promise<void> {
	let consecutiveErrors = 0;
	while (true) {
		await sleep(POLL_MS);
		// Item was removed from the queue while running (client chose to drop it).
		if (!store.state.queue.some((i) => i.id === itemId)) return;

		let job: Job;
		try {
			job = await getJob(serverId);
			consecutiveErrors = 0;
		} catch (err) {
			if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
				store.patchQueueItem(itemId, { status: "failed", error: lostJobMessage });
				return;
			}
			// Transient network/server issue: the job may still be running, so keep polling, but bound how long we wait before giving up.
			consecutiveErrors += 1;
			if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
				store.patchQueueItem(itemId, { status: "failed", error: "Lost contact with the server while generating." });
				return;
			}
			continue;
		}

		if (job.started) {
			store.patchQueueItem(itemId, { startedAt: job.started * 1000 });
		}
		if (job.status === "generating" && isJobProgress(job.progress)) {
			store.setQueueProgress(itemId, job.progress);
		}

		if (job.status === "completed") {
			await handleCompleted(store, itemId, job);
			return;
		}
		if (job.status === "failed") {
			store.patchQueueItem(itemId, { status: "failed", error: job.error?.message || "Generation failed." });
			return;
		}
		if (job.status === "cancelled") {
			store.patchQueueItem(itemId, { status: "cancelled", error: job.error?.message || "Job was cancelled." });
			return;
		}
		// Still queued/generating: loop again.
	}
}

async function handleCompleted(store: Store, itemId: string, job: Job): Promise<void> {
	const item = store.state.queue.find((i) => i.id === itemId);
	const result = job.result;
	const b64 = result?.b64_json || (result?.images && result.images[0]?.b64_json);
	if (!item || !b64) {
		store.patchQueueItem(itemId, { status: "failed", error: "Server returned no video data." });
		return;
	}

	const format = safeFormat(result.output_format);
	const mime = mimeForFormat(format);
	const videoBlob = bytesToBlob(base64ToBytes(b64), mime);
	let thumbnail = "";
	try {
		thumbnail = await captureVideoThumbnail(b64, mime, format);
	} catch {
		// Thumbnail decode is best-effort; a missing preview must not fail the generation.
		thumbnail = "";
	}
	const frameCount = result.frame_count !== undefined && Number.isFinite(result.frame_count) ? result.frame_count : item.jobFrames;
	const fps = result.fps !== undefined && Number.isFinite(result.fps) ? result.fps : GENERATION_PRESET.fps;
	const startedSec = job.started ?? job.completed ?? 0;
	const completedSec = job.completed ?? startedSec;
	const elapsedMs = Math.max(0, completedSec - startedSec) * 1000;

	const historyItem: HistoryItem = {
		id: uid("h_"),
		createdAt: Date.now(),
		prompt: item.prompt,
		zipName: item.zipName,
		mode: item.mode,
		files: item.files,
		width: item.width,
		height: item.height,
		frameCount,
		fps,
		elapsedMs,
		startedAt: startedSec * 1000,
		completedAt: completedSec * 1000,
		thumbnail,
		video: { mime, format, byteSize: videoBlob.size },
		persisted: false,
		viewed: false,
	};

	store.addHistory(historyItem, videoBlob);
	store.removeQueue(itemId);
	void store.setResident(historyItem.id);
}

async function captureVideoThumbnail(b64: string, mime: string, _format: string): Promise<string> {
	// For image outputs (webp), the "video" is already a still; reuse it directly.
	if (mime.startsWith("image/")) {
		return `data:${mime};base64,${b64}`;
	}
	const blob = bytesToBlob(base64ToBytes(b64), mime);
	const url = URL.createObjectURL(blob);
	try {
		const video = document.createElement("video");
		video.src = url;
		video.muted = true;
		video.playsInline = true;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("thumbnail timeout")), 10000);
			video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
			video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("thumbnail decode error")); }, { once: true });
		});
		if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error("thumbnail has no dimensions");
		video.currentTime = 0;
		await new Promise<void>((resolve) => {
			if (video.readyState >= 2 || video.currentTime !== 0) { resolve(); return; }
			video.addEventListener("seeked", () => resolve(), { once: true });
		});
		const scale = Math.min(1, 320 / video.videoWidth);
		const w = Math.max(1, Math.round(video.videoWidth * scale));
		const h = Math.max(1, Math.round(video.videoHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("thumbnail canvas unavailable");
		ctx.drawImage(video, 0, 0, w, h);
		return canvas.toDataURL("image/jpeg", 0.7);
	} finally {
		URL.revokeObjectURL(url);
	}
}

function safeFormat(outputFormat: unknown): string {
	const f = String(outputFormat ?? "");
	return f === "webm" || f === "webp" || f === "avi" ? f : "webm";
}

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
