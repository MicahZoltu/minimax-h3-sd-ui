// Pure, browser-free plan-selection logic for compressing a resident video.
// Nothing in this file touches the DOM or Mediabunny, so it is fully unit-testable in Bun.

import type { AudioCodecVerb, CompressionContainer, CompressionPlan, UnsupportedReason, VideoCodecVerb } from "./compression.types.js";

// Preferred output plans, best first.
// Chromium-class browsers get the MP4/AVC/AAC plan; everyone else falls back to a WebM plan.
export const COMPRESSION_ORDER: CompressionPlan[] = [
	{ container: "mp4", videoCodec: "avc", audioCodec: "aac", extension: "mp4", mime: "video/mp4" },
	{ container: "webm", videoCodec: "vp9", audioCodec: "opus", extension: "webm", mime: "video/webm" },
	{ container: "webm", videoCodec: "vp8", audioCodec: "opus", extension: "webm", mime: "video/webm" },
	{ container: "webm", videoCodec: "av1", audioCodec: "opus", extension: "webm", mime: "video/webm" },
];

// The video codecs we are willing to pick for the WebM fallback, in preference order.
const WEBM_VIDEO_ORDER: readonly VideoCodecVerb[] = ["vp9", "vp8", "av1"];

export interface DevCodecSupport {
	hasWebCodecs: boolean;
	canEncodeAac: boolean;
	canEncodeOpus: boolean;
	encodableVideo: VideoCodecVerb[];
}

export function decidePlan(s: DevCodecSupport): { plan: CompressionPlan | null; reason: UnsupportedReason | null } {
	if (!s.hasWebCodecs) return { plan: null, reason: "no-webcodecs" };
	// Prefer the MP4/AVC/AAC plan whenever it is fully encodable.
	// AAC is mandatory for the MP4 plan: without it we must NOT pick MP4, even if AVC is encodable.
	const mp4Plan = COMPRESSION_ORDER.find((p) => p.container === "mp4" && p.videoCodec === "avc" && p.audioCodec === "aac");
	if (s.canEncodeAac && s.encodableVideo.includes("avc")) {
		return { plan: mp4Plan ?? null, reason: null };
	}
	if (s.canEncodeOpus) {
		const video = WEBM_VIDEO_ORDER.find((v) => s.encodableVideo.includes(v));
		if (!video) return { plan: null, reason: "no-encodable-codec" };
		const plan = COMPRESSION_ORDER.find((p) => p.container === "webm" && p.videoCodec === video);
		return { plan: plan ?? null, reason: plan ? null : "no-encodable-codec" };
	}
	return { plan: null, reason: "no-encodable-codec" };
}

// Builds the fallback ladder for a conversion: the requested plan first, then each remaining distinct plan in COMPRESSION_ORDER order.
// The worker tries them in this order because the browser may only be able to produce a different container/codec than the probed plan.
export function candidatePlans(plan: CompressionPlan): CompressionPlan[] {
	return [plan, ...COMPRESSION_ORDER.filter((p) => p.container !== plan.container || p.videoCodec !== plan.videoCodec || p.audioCodec !== plan.audioCodec)];
}

export function compressedFilename(stem: string, plan: CompressionPlan): string {
	return `${stem}.${plan.extension}`;
}

const VIDEO_LABELS: Record<VideoCodecVerb, string> = { avc: "H.264", vp9: "VP9", vp8: "VP8", av1: "AV1" };
const AUDIO_LABELS: Record<AudioCodecVerb, string> = { aac: "AAC", opus: "Opus" };
const CONTAINER_LABELS: Record<CompressionContainer, string> = { mp4: "MP4", webm: "WebM" };

export function planLabel(plan: CompressionPlan): string {
	return `${VIDEO_LABELS[plan.videoCodec]} + ${AUDIO_LABELS[plan.audioCodec]} (${CONTAINER_LABELS[plan.container]})`;
}

const VIDEO_CODEC_STRINGS: Record<VideoCodecVerb, string> = { avc: "avc1", vp9: "vp09", vp8: "vp08", av1: "av01" };
const AUDIO_CODEC_STRINGS: Record<AudioCodecVerb, string> = { aac: "mp4a.40.2", opus: "opus" };

export function codecString(plan: CompressionPlan): { video: string; audio: string } {
	return { video: VIDEO_CODEC_STRINGS[plan.videoCodec], audio: AUDIO_CODEC_STRINGS[plan.audioCodec] };
}
