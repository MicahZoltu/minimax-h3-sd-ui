// Shared domain types for the video-only UI.

import type { JobProgress } from "./api.js";

export type ZipMode = "prompt" | "start-end" | "refs";

/** An image file extracted from an uploaded zip (start/end/ref frame). */
export interface ZipFile {
	name: string;
	dataUrl: string;
}

/** Result of validating + extracting a uploaded zip. */
export interface ZipAnalysis {
	prompt: string;
	mode: ZipMode;
	/** Ordered image files that make up the input: start/end pair or ref frames. */
	files: ZipFile[];
}

export type QueueStatus =
	| "queued"
	| "submitting"
	| "generating"
	| "completed"
	| "failed"
	| "cancelled";

export interface QueueItem {
	id: string;
	status: QueueStatus;
	prompt: string;
	/** Original uploaded .zip filename, so a source-zip download can restore it. */
	zipName: string | null;
	mode: ZipMode;
	files: ZipFile[];
	width: number;
	height: number;
	jobFrames: number;
	steps: number;
	error: string | null;
	serverId: string | null;
	/** Epoch ms of server-reported start, if any. */
	startedAt: number | null;
	/**
	 * Latest generation progress observed while `status === "generating"`.
	 * Transient: only held in memory and never persisted, so it may be missing after a hydration reload.
	 */
	progress?: JobProgress | null;
}

export interface VideoData {
	/** MIME type of the binary video payload, e.g. "video/webm". */
	mime: string;
	format: string;
	/** Approximate byte size of the stored binary video payload. */
	byteSize: number;
}

/** An image file persisted to IndexedDB. */
export interface PersistedFile {
	name: string;
	key: string;
	/** Exact byte size of the stored binary file (the persisted Blob's size). */
	bytes: number;
}

export interface HistoryItem {
	id: string;
	/** Epoch ms when the item was created (client clock). */
	createdAt: number;
	prompt: string;
	/** Original uploaded .zip filename, so a source-zip download can restore it. */
	zipName: string | null;
	mode: ZipMode;
	files: PersistedFile[];
	/** Final width used for generation (request value). */
	width: number;
	/** Final height used for generation (request value). */
	height: number;
	/** Final frame count actually generated (from server result). */
	frameCount: number;
	/** Playback fps used for generation. */
	fps: number;
	/** Generation time in ms (server completed - started). */
	elapsedMs: number;
	/** Epoch ms from the server. */
	startedAt: number;
	completedAt: number;
	/** Media store key for the small single-frame preview image. */
	thumbnailKey: string;
	/** Exact byte size of the stored binary thumbnail (the persisted Blob's size). */
	thumbBytes: number;
	video: VideoData;
	/** Whether this item is persisted to localStorage. */
	persisted: boolean;
	/**
	 * Whether the completed video has been opened (clicked to show the full video).
	 * New completions start `false` (highlighted + green favicon) and are flipped when viewed.
	 * Old persisted items without the field are treated as already viewed.
	 */
	viewed: boolean;
}

