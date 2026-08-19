// Pure assembly of a completed generation's history record.
// Everything here is DOM-free: it only derives the HistoryItem and converts data URLs to Blobs.
// The DOM-bound thumbnail capture stays in queue.ts; its output is passed in as a raw artifact.

import type { Job } from "./api.js";
import { dataUrlToBlob, fileKey, thumbnailKey } from "./media.js";
import { GENERATION_PRESET } from "./request.js";
import type { HistoryItem, PersistedFile, QueueItem } from "./types.js";
import { uid } from "./utils.js";

/** Raw completed-job artifacts that need a DOM step (video decode / thumbnail) to produce. */
export interface CompletionArtifacts {
	videoBlob: Blob;
	thumbBlob: Blob;
	format: string;
	mime: string;
}

/** The completed record plus the Blobs to persist under its media-store keys. */
export interface CompletionResult {
	historyItem: HistoryItem;
	videoBlob: Blob;
	thumbBlob: Blob;
	/** Media-store Blobs for the item's input files (an empty Blob keeps index alignment on a failed conversion). */
	fileBlobs: Blob[];
}

/**
 * Assemble the completion record for a finished job.
 * The returned historyItem and media Blobs match exactly what the queue used to build inline.
 * File data URLs are converted to Blobs once here, so both the record's byte sizes and the persisted media agree.
 */
export function buildCompletion(item: QueueItem, job: Job, artifacts: CompletionArtifacts): CompletionResult {
	const frameCount = job.result?.frame_count !== undefined && Number.isFinite(job.result.frame_count) ? job.result.frame_count : item.jobFrames;
	const fps = job.result?.fps !== undefined && Number.isFinite(job.result.fps) ? job.result.fps : GENERATION_PRESET.fps;
	const startedRaw = job.started ?? job.completed ?? 0;
	const completedRaw = job.completed ?? startedRaw;
	// Coerce any non-finite timestamp (a structurally-present but malformed value) to a finite default so
	// the persisted HistoryItem never carries NaN: fall back to 0 for a missing start and to the start for
	// a missing end, exactly like the pure-null path.
	const startedSec = Number.isFinite(startedRaw) ? startedRaw : 0;
	const completedSec = Number.isFinite(completedRaw) ? completedRaw : startedSec;
	const elapsedMs = Number.isFinite(completedSec - startedSec) ? Math.max(0, completedSec - startedSec) * 1000 : 0;

	const historyId = uid("h_");
	// A malformed dataUrl must not strand the completed item: a failed conversion records bytes 0 (and an
	// empty Blob keeps index alignment) so the item still progresses out of the queue.
	const fileBlobs: Blob[] = item.files.map((f) => {
		try {
			return dataUrlToBlob(f.dataUrl);
		} catch {
			return new Blob([], { type: "application/octet-stream" });
		}
	});
	const files: PersistedFile[] = item.files.map((f, index) => {
		const blob = fileBlobs[index];
		return { name: f.name, key: fileKey(historyId, index), bytes: blob ? blob.size : 0 };
	});

	const historyItem: HistoryItem = {
		id: historyId,
		createdAt: Date.now(),
		prompt: item.prompt,
		zipName: item.zipName,
		mode: item.mode,
		files,
		width: item.width,
		height: item.height,
		frameCount,
		fps,
		elapsedMs,
		startedAt: startedSec * 1000,
		completedAt: completedSec * 1000,
		thumbnailKey: thumbnailKey(historyId),
		thumbBytes: artifacts.thumbBlob.size,
		video: { mime: artifacts.mime, format: artifacts.format, byteSize: artifacts.videoBlob.size },
		persisted: false,
		viewed: false,
	};

	return { historyItem, videoBlob: artifacts.videoBlob, thumbBlob: artifacts.thumbBlob, fileBlobs };
}
