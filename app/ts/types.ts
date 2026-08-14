// Shared domain types for the video-only UI.

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
}

export interface VideoData {
	/** Raw base64 media payload from the server. */
	b64: string;
	mime: string;
	format: string;
}

export interface HistoryItem {
	id: string;
	/** Epoch ms when the item was created (client clock). */
	createdAt: number;
	prompt: string;
	mode: ZipMode;
	files: ZipFile[];
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
	video: VideoData;
	/** Whether this item is persisted to localStorage. */
	persisted: boolean;
}
