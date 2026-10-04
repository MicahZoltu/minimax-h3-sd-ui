// Shared domain types for the video-only UI.

import type { JobProgress } from "./api.js";

export type ZipMode = "prompt" | "start-end" | "refs";

/** An image file extracted from an uploaded zip (start/end/ref frame). */
export interface ZipFile {
	name: string;
	dataUrl: string;
}

/**
 * A reference video extracted from an uploaded zip.
 * The server accepts reference video only as an ordered frame list, so the container is decoded client-side:
 * the SOURCE container bytes are kept (to regenerate a source zip) while the decoded frames + fps + optional
 * soundtrack are what gets POSTed as `ref_videos[]`.
 */
export interface RefVideoFile {
	/** Original video file name from the zip. */
	name: string;
	/** Frame rate of the delivered frames (always 24; extraction resamples the source onto that grid). */
	fps: number;
	/** Ordered JPEG data URLs, one per video frame, in playback order. */
	frames: string[];
	/** WAV soundtrack data URL, or null when the source container carried no audio. */
	audio: string | null;
	/** Original container bytes as a data URL, kept so a regenerated source zip reproduces the upload. */
	sourceDataUrl: string;
}

/** A reference audio clip extracted from an uploaded zip. */
export interface RefAudioFile {
	/** Original audio file name from the zip. */
	name: string;
	/** WAV data URL (transcoded when the source was already WAV it is passed through unmodified). */
	dataUrl: string;
	/** Original file bytes as a data URL, kept so a regenerated source zip reproduces the upload. */
	sourceDataUrl: string;
}

/** Result of validating + extracting a uploaded zip. */
export interface ZipAnalysis {
	prompt: string;
	mode: ZipMode;
	/** Ordered image files that make up the input: start/end pair or ref frames. */
	files: ZipFile[];
	/** Numbered reference videos, ordered by video number. */
	videos: RefVideoFile[];
	/** Numbered reference audio clips, ordered by audio number. */
	audios: RefAudioFile[];
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
	/** Original uploaded .zip or .txt filename, so a source-zip download can restore it. */
	zipName: string | null;
	mode: ZipMode;
	files: ZipFile[];
	/** Numbered reference videos (mode "refs"), ordered by video number. */
	videos: RefVideoFile[];
	/** Numbered reference audio clips (mode "refs"), ordered by audio number. */
	audios: RefAudioFile[];
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

/** A reference video persisted to IndexedDB (media blobs stored under the recorded keys). */
export interface PersistedRefVideo {
	/** Original video file name from the zip. */
	name: string;
	/** Media-store key of the first-frame preview image. */
	thumbKey: string;
	/** Exact byte size of the stored first-frame thumbnail. */
	thumbBytes: number;
	/** Media-store key of the WAV soundtrack, or null when the source carried no audio. */
	audioKey: string | null;
	/** Exact byte size of the stored soundtrack. */
	audioBytes: number;
	/** Media-store key of the original container bytes for source-zip regeneration. */
	sourceKey: string;
	/** Exact byte size of the stored original container. */
	sourceBytes: number;
}

/** A reference audio clip persisted to IndexedDB. */
export interface PersistedRefAudio {
	/** Original audio file name from the zip. */
	name: string;
	/** Media-store key of the original file bytes for source-zip regeneration. */
	key: string;
	/** Exact byte size of the stored original file. */
	bytes: number;
}

export interface HistoryItem {
	id: string;
	/** Epoch ms when the item was created (client clock). */
	createdAt: number;
	prompt: string;
	/** Original uploaded .zip or .txt filename, so a source-zip download can restore it. */
	zipName: string | null;
	mode: ZipMode;
	files: PersistedFile[];
	/** Reference videos persisted alongside the item (blobs under the recorded keys). */
	videos: PersistedRefVideo[];
	/** Reference audio clips persisted alongside the item. */
	audios: PersistedRefAudio[];
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
	/** Epoch ms derived from the server's seconds-precision `started`. */
	startedAt: number;
	completedAt: number;
	/** Media store key for the small single-frame preview image. */
	thumbnailKey: string;
	/** Exact byte size of the stored binary thumbnail (the persisted Blob's size). */
	thumbBytes: number;
	video: VideoData;
	/** Whether this item is persisted to IndexedDB. */
	persisted: boolean;
	/**
	 * Whether the completed video has been opened (clicked to show the full video).
	 * New completions start `false` (highlighted + green favicon) and are flipped when viewed.
	 * Old persisted items without the field are treated as already viewed.
	 */
	viewed: boolean;
}

