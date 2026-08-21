import { describe, it, expect } from "bun:test";
import { buildVidGenRequest, GENERATION_PRESET, splitFrameInputs } from "../app/ts/request.js";
import { bytesToDataUrl } from "../app/ts/utils.js";
import type { QueueItem } from "../app/ts/types.js";

function baseItem(partial: Partial<QueueItem> = {}): QueueItem {
	return {
		id: "q_1",
		status: "queued",
		prompt: "a dog",
		zipName: null,
		mode: "prompt",
		files: [],
		videos: [],
		audios: [],
		width: 640,
		height: 384,
		jobFrames: 49,
		steps: 20,
		error: null,
		serverId: null,
		startedAt: null,
		...partial,
	};
}

const PNG = Uint8Array.from([1, 2, 3, 4]);

describe("GENERATION_PRESET", () => {
	it("implements the hard-coded spec values", () => {
		expect(GENERATION_PRESET.fps).toBe(24);
		expect(GENERATION_PRESET.sampleSteps).toBe(20);
		expect(GENERATION_PRESET.txtCfg).toBe(1);
		expect(GENERATION_PRESET.distilledGuidance).toBe(3.5);
		expect(GENERATION_PRESET.outputFormat).toBe("webm");
	});
});

describe("buildVidGenRequest", () => {
	it("builds a text-only request with the hard-coded parameters", () => {
		const body = buildVidGenRequest(baseItem());
		expect(body.prompt).toBe("a dog");
		expect(body.video_frames).toBe(49);
		expect(body.fps).toBe(24);
		expect(body.init_image).toBe(null);
		expect(body.end_image).toBe(null);
		expect(body.ref_images).toEqual([]);
		const sp = body.sample_params;
		expect(sp.sample_steps).toBe(20);
		expect("scheduler" in sp).toBe(false);
		expect("sample_method" in sp).toBe(false);
		const g = sp.guidance;
		expect(g.txt_cfg).toBe(1);
		expect(g.distilled_guidance).toBe(3.5);
		expect(body.output_format).toBe("webm");
	});

	it("uses the per-item step count (not a hard-coded value)", () => {
		const body = buildVidGenRequest(baseItem({ steps: 55 }));
		expect(body.sample_params.sample_steps).toBe(55);
	});

	it("maps start/end files onto init_image/end_image", () => {
		const d1 = bytesToDataUrl(PNG, "image/png");
		const d2 = bytesToDataUrl(PNG, "image/png");
		const item = baseItem({
			mode: "start-end",
			files: [
				{ name: "start.png", dataUrl: d1 },
				{ name: "end.png", dataUrl: d2 },
			],
		});
		expect(splitFrameInputs(item)).toEqual({ start: d1, end: d2, refs: [] });
		const body = buildVidGenRequest(item);
		expect(body.init_image).toBe(d1);
		expect(body.end_image).toBe(d2);
	});

	it("maps a single start file by suffix but leaves end null", () => {
		const item = baseItem({
			mode: "start-end",
			files: [{ name: "foo_start.png", dataUrl: "data:x" }],
		});
		expect(splitFrameInputs(item)).toEqual({ start: "data:x", end: null, refs: [] });
	});

	it("maps suffix-named start/end files onto init_image/end_image", () => {
		const d1 = bytesToDataUrl(PNG, "image/png");
		const d2 = bytesToDataUrl(PNG, "image/png");
		const item = baseItem({
			mode: "start-end",
			files: [
				{ name: "key_start.png", dataUrl: d1 },
				{ name: "final_end.jpg", dataUrl: d2 },
			],
		});
		expect(splitFrameInputs(item)).toEqual({ start: d1, end: d2, refs: [] });
	});

	it("maps numbered files onto ref_images in order", () => {
		const item = baseItem({
			mode: "refs",
			files: [
				{ name: "f1.png", dataUrl: "data:1" },
				{ name: "f2.png", dataUrl: "data:2" },
			],
		});
		expect(splitFrameInputs(item)).toEqual({ start: null, end: null, refs: ["data:1", "data:2"] });
		const body = buildVidGenRequest(item);
		expect(body.ref_images).toEqual(["data:1", "data:2"]);
		expect(body.init_image).toBe(null);
	});

	it("serializes reference videos with frames, real fps, and an optional soundtrack", () => {
		const item = baseItem({
			mode: "refs",
			videos: [
				{ name: "clip.mp4", fps: 60, frames: ["data:a", "data:b"], audio: "data:wav", sourceDataUrl: "data:mp4" },
				{ name: "silent.mp4", fps: 24, frames: ["data:c"], audio: null, sourceDataUrl: "data:mp4" },
			],
		});
		const body = buildVidGenRequest(item);
		expect(body.ref_videos).toEqual([
			{ frames: ["data:a", "data:b"], fps: 60, audio: "data:wav" },
			{ frames: ["data:c"], fps: 24 },
		]);
		expect(body.ref_audios).toEqual([]);
		// References are mutually exclusive with first/last-frame conditioning.
		expect(body.init_image).toBe(null);
		expect(body.end_image).toBe(null);
	});

	it("serializes reference audio as WAV data URLs", () => {
		const item = baseItem({
			mode: "refs",
			audios: [{ name: "tune.mp3", dataUrl: "data:audio/wav;base64,QQ==", sourceDataUrl: "data:mp3" }],
		});
		const body = buildVidGenRequest(item);
		expect(body.ref_audios).toEqual(["data:audio/wav;base64,QQ=="]);
		expect(body.ref_videos).toEqual([]);
	});

	it("keeps init/end conditioning only when no reference of any type is present", () => {
		const plain = baseItem({ mode: "prompt", videos: [], audios: [] });
		expect(buildVidGenRequest(plain).init_image).toBe(null);
		const withAudio = baseItem({ mode: "refs", audios: [{ name: "a.wav", dataUrl: "data:audio/wav;base64,QQ==", sourceDataUrl: "data:wav" }] });
		expect(buildVidGenRequest(withAudio).init_image).toBe(null);
	});
});
