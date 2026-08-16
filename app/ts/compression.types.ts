// Protocol and pure types shared between the main thread and the transcode worker.
// This module is browser-free: it only declares shapes, so both the coordinator and the worker can depend on it.

export type CompressionQuality = "low" | "medium" | "high";
export type CompressionContainer = "mp4" | "webm";
export type VideoCodecVerb = "avc" | "vp9" | "vp8" | "av1";
export type AudioCodecVerb = "aac" | "opus";

export interface CompressionPlan {
	container: CompressionContainer;
	videoCodec: VideoCodecVerb;
	audioCodec: AudioCodecVerb;
	extension: string;
	mime: string;
}

export type UnsupportedReason = "no-webcodecs" | "no-encodable-codec";

export type WorkerRequest =
	| { type: "probe"; blob: Blob }
	| { type: "convert"; blob: Blob; plan: CompressionPlan; quality: CompressionQuality; stem: string };

export type WorkerResponse =
	| { type: "probe-result"; plan: CompressionPlan | null; reason: UnsupportedReason | null }
	| { type: "progress"; percent: number }
	| { type: "result"; blob: Blob; codecUsed: string; filename: string; label: string; size: number }
	| { type: "error"; message: string };
