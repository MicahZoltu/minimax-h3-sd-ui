// Builds the native `vid_gen` request body.
// All generation parameters that the UI intentionally hides are hard-coded here (see the product spec).
// Only the width, height and frame count are user-supplied.

import { classifyName } from "./zip.js";
import type { QueueItem } from "./types.js";

export const GENERATION_PRESET = {
	fps: 24,
	sampleSteps: 20,
	txtCfg: 1,
	distilledGuidance: 3.5,
	outputFormat: "webm",
	outputCompression: 100,
} as const;

export interface Guidance {
	txt_cfg: number;
	distilled_guidance: number;
	slg: { layers: number[]; layer_start: number; layer_end: number; scale: number };
}

export interface SampleParams {
	sample_steps: number;
	shifted_timestep: number;
	custom_sigmas: number[];
	guidance: Guidance;
}

export interface VaeTilingParams {
	enabled: boolean;
	temporal_tiling: boolean;
	tile_size_x: number;
	tile_size_y: number;
	target_overlap: number;
	rel_size_x: number;
	rel_size_y: number;
	extra_tiling_args: string;
}

export interface VidGenRequest {
	prompt: string;
	negative_prompt: string;
	clip_skip: number;
	width: number;
	height: number;
	strength: number;
	seed: number;
	video_frames: number;
	fps: number;
	moe_boundary: number;
	vace_strength: number;
	init_image: string | null;
	end_image: string | null;
	control_frames: unknown[];
	ref_images: string[];
	ref_videos: { frames: string[]; fps: number; audio?: string }[];
	ref_audios: string[];
	sample_params: SampleParams;
	high_noise_sample_params: SampleParams;
	lora: unknown[];
	vae_tiling_params: VaeTilingParams;
	cache_mode: string;
	cache_option: string;
	scm_mask: string;
	scm_policy_dynamic: boolean;
	output_format: string;
	output_compression: number;
}

function guidance(): Guidance {
	return {
		txt_cfg: GENERATION_PRESET.txtCfg,
		distilled_guidance: GENERATION_PRESET.distilledGuidance,
		slg: { layers: [], layer_start: 0, layer_end: 0, scale: 0 },
	};
}

function sampleParams(steps: number): SampleParams {
	return {
		sample_steps: steps,
		shifted_timestep: 0,
		custom_sigmas: [],
		guidance: guidance(),
	};
}

/** Split an item's image files into init/end/ref frame inputs by mode. */
export function splitFrameInputs(item: QueueItem): { start: string | null; end: string | null; refs: string[] } {
	if (item.mode === "refs") {
		return { start: null, end: null, refs: item.files.map((f) => f.dataUrl) };
	}
	if (item.mode === "start-end") {
		const bucketStart: string[] = [];
		const bucketEnd: string[] = [];
		for (const f of item.files) {
			const kind = classifyName(f.name).kind;
			if (kind === "start") bucketStart.push(f.dataUrl);
			else if (kind === "end") bucketEnd.push(f.dataUrl);
		}
		return { start: bucketStart[0] ?? null, end: bucketEnd[0] ?? null, refs: [] };
	}
	return { start: null, end: null, refs: [] };
}

export function buildVidGenRequest(item: QueueItem): VidGenRequest {
	const { start, end, refs } = splitFrameInputs(item);
	// Reference videos and audio ride alongside the image references, numbered independently per type.
	// A ref_videos[].audio key is omitted (JSON.stringify drops `undefined`) when the video has no soundtrack.
	// The `?? []` guards items persisted before reference-video/audio support, which lack these fields.
	//
	// Extraction delivers the whole source (bounded only by the combined 15 s budget), so slicing the posted frames to the request's own video_frames is payload economy, not content loss: the server discards any excess prefix itself, making the clamped and unclamped requests identical.
	// The clamp never drops below the server's 5-frame minimum.
	// Extracted frames sit on the 24 fps reference grid and the posted `fps` always describes the delivered frames exactly, so the server's 24 fps normalization is the identity and never duplicates or drops frames.
	// The soundtrack is trimmed at extraction time to the extracted frames' span; when the form's frame count slices the posted frames below the extracted set, the posted soundtrack can outlast them, which the server absorbs by sizing the prefix block to max(video, audio).
	const refVideos = (item.videos ?? []).map((v) => {
		const cap = refVideoFrameCap(item.jobFrames, v.frames.length);
		return { frames: v.frames.slice(0, cap), fps: v.fps, ...(v.audio !== null ? { audio: v.audio } : {}) };
	});
	const refAudios = (item.audios ?? []).map((a) => a.dataUrl);
	return {
		prompt: item.prompt,
		negative_prompt: "",
		clip_skip: -1,
		width: item.width,
		height: item.height,
		strength: 0.75,
		seed: -1,
		video_frames: item.jobFrames,
		fps: GENERATION_PRESET.fps,
		moe_boundary: 0.875,
		vace_strength: 1.0,

		init_image: start,
		end_image: end,
		control_frames: [],
		ref_images: refs,
		ref_videos: refVideos,
		ref_audios: refAudios,

		sample_params: sampleParams(item.steps),
		high_noise_sample_params: {
			sample_steps: -1,
			shifted_timestep: 0,
			custom_sigmas: [],
			guidance: guidance(),
		},

		lora: [],
		vae_tiling_params: {
			enabled: false,
			temporal_tiling: false,
			tile_size_x: 0,
			tile_size_y: 0,
			target_overlap: 0.5,
			rel_size_x: 0,
			rel_size_y: 0,
			extra_tiling_args: "",
		},
		cache_mode: "disabled",
		cache_option: "",
		scm_mask: "",
		scm_policy_dynamic: true,

		output_format: GENERATION_PRESET.outputFormat,
		output_compression: GENERATION_PRESET.outputCompression,
	};
}

/**
 * The number of a reference video's extracted frames a job posts: the job's own frame count, never above what was extracted, never below the server's 5-frame minimum.
 * Payload economy only — the server discards any excess prefix itself, so the clamp changes nothing the server would compute.
 */
export function refVideoFrameCap(jobFrames: number, extractedFrames: number): number {
	return Math.max(5, Math.min(jobFrames, extractedFrames));
}

/**
 * The preview note for one reference video whose extracted frame count outruns the job's frame count (so the request clamps the posted prefix), or null when the whole reference is used.
 * Worded for the new-job form's preview; the seconds figure is the clamped span at the reference grid's 24 fps.
 */
export function refPreviewNote(videoFrames: number, jobFrames: number): string | null {
	if (!Number.isFinite(videoFrames) || !Number.isFinite(jobFrames)) return null;
	const cap = refVideoFrameCap(jobFrames, videoFrames);
	if (cap >= videoFrames) return null;
	const seconds = (cap / GENERATION_PRESET.fps).toFixed(1);
	return `Only the first ${seconds} s of this reference conditions a ${jobFrames}-frame generation.`;
}

/** Map a server output format to a MIME type for playback/download. */
export function mimeForFormat(format: string): string {
	switch (format) {
		case "webm":
			return "video/webm";
		case "avi":
			return "video/x-msvideo";
		case "webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}
