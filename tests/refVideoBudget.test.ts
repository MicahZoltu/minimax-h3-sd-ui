// Integration: the reference-video budget and resolution limits enforced in analyzeZip flow into the
// single-upload form error and the per-file ZipBatchFailure lines, with nothing queued for a failing file.
// Real ref-video extraction needs browser WebCodecs + a dedicated worker, so the worker-facing coordinator
// (refExtract.js) is mocked with fabricated whole-source reports; the logic under test is zip.ts's budget
// check, resolution bounds, and remaining-budget extraction call.
// The mock is inert for every other suite: only zips containing video files reach extractRefVideo.

import { describe, it, expect, mock } from "bun:test";
import { createStore, type Store } from "../app/ts/state.js";
import { handleZipFiles, queueZipsFromFiles } from "../app/ts/form.js";
import { buildSourceZip } from "../app/ts/zip.js";
import type { QueueDims } from "../app/ts/queueItem.js";
import { memoryQueueBackend } from "./support/queueBackend.js";

// Fabricated whole-source reports, consumed in extraction order.
const sources: { sourceFrames: number; sourceWidth: number; sourceHeight: number }[] = [];
// The maxFrames values extraction was actually handed (the remaining combined budget, per zip.ts).
const extractCalls: number[] = [];

// Fresh recorders per test: the module-level mock is shared across the file, so each test clears both.
function resetSources(): void {
	sources.length = 0;
	extractCalls.length = 0;
}

mock.module("../app/ts/refExtract.js", () => ({
	extractRefVideo: (_blob: Blob, maxFrames: number, _quality: number) => {
		extractCalls.push(maxFrames);
		const next = sources.shift() ?? { sourceFrames: 5, sourceWidth: 1280, sourceHeight: 720 };
		const delivered = Math.min(next.sourceFrames, Math.max(1, maxFrames));
		return Promise.resolve({
			fps: 24,
			frames: Array.from({ length: delivered }, (_, i) => `data:frame-${i}`),
			audio: null,
			sourceWidth: next.sourceWidth,
			sourceHeight: next.sourceHeight,
			sourceFrames: next.sourceFrames,
		});
	},
	transcodeAudioRef: () => Promise.reject(new Error("not exercised in this test")),
}));

// A valid refs-mode zip whose video entries carry arbitrary bytes (the mock never decodes them).
function videoZip(name: string, videoNames: string[]): File {
	return new File([buildSourceZip(videoNames.map((v) => ({ name: v, bytes: new Uint8Array([1, 2, 3, 4]) })), "a cat")], name, { type: "application/zip" });
}

function store(): Store {
	return createStore(memoryQueueBackend());
}

const dims: QueueDims = { width: 768, height: 384, frames: 107, steps: 20 };

describe("combined reference-video budget in analyzeZip", () => {
	it("accepts a combined total of exactly the budget", async () => {
		resetSources();
		const s = store();
		sources.push({ sourceFrames: 360, sourceWidth: 1280, sourceHeight: 720 });
		const { queued, failures } = await queueZipsFromFiles(s, [videoZip("exact.zip", ["v1.mp4"])], dims);
		expect(queued).toBe(1);
		expect(failures).toEqual([]);
		expect(extractCalls).toEqual([360]);
		expect(s.state.queue[0]?.videos.length).toBe(1);
	});

	it("errors a single oversized source that stops at the budget, queueing nothing", async () => {
		resetSources();
		const s = store();
		sources.push({ sourceFrames: 400, sourceWidth: 1280, sourceHeight: 720 });
		const { queued, failures } = await queueZipsFromFiles(s, [videoZip("long.zip", ["v1.mp4"])], dims);
		expect(queued).toBe(0);
		expect(s.state.queue).toEqual([]);
		expect(failures.map((f) => f.message)).toEqual(["v1.mp4: Reference videos are limited to 15 seconds combined across all videos."]);
		// The extraction was bounded by the remaining budget (the whole 360 for the first video), and the uncapped source count is what errored the upload.
		expect(extractCalls).toEqual([360]);
	});

	it("errors the whole multi-video upload mid-way past the budget, after handing extraction the remaining budget", async () => {
		resetSources();
		const s = store();
		sources.push({ sourceFrames: 200, sourceWidth: 1280, sourceHeight: 720 });
		sources.push({ sourceFrames: 300, sourceWidth: 1280, sourceHeight: 720 });
		const { queued, failures } = await queueZipsFromFiles(s, [videoZip("two.zip", ["v1.mp4", "v2.mp4"])], dims);
		expect(queued).toBe(0);
		expect(s.state.queue).toEqual([]);
		expect(failures.map((f) => f.message)).toEqual(["v2.mp4: Reference videos are limited to 15 seconds combined across all videos."]);
		// The second extraction was capped at the remaining budget (360 - 200) instead of decoding unbounded.
		expect(extractCalls).toEqual([360, 160]);
	});

	it("surfaces the budget error as the single-upload form error with nothing queued", async () => {
		resetSources();
		const s = store();
		sources.push({ sourceFrames: 400, sourceWidth: 1280, sourceHeight: 720 });
		await handleZipFiles(s, [videoZip("solo.zip", ["v1.mp4"])]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.analysis).toBeNull();
		expect(s.state.form.error).toBe("v1.mp4: Reference videos are limited to 15 seconds combined across all videos.");
	});
});

describe("reference-video resolution bounds in analyzeZip", () => {
	it("errors a source below the per-side minimum, queueing nothing", async () => {
		resetSources();
		const s = store();
		sources.push({ sourceFrames: 48, sourceWidth: 255, sourceHeight: 720 });
		const { queued, failures } = await queueZipsFromFiles(s, [videoZip("small.zip", ["v1.mp4"])], dims);
		expect(queued).toBe(0);
		expect(s.state.queue).toEqual([]);
		expect(failures.map((f) => f.message)).toEqual(["v1.mp4: Reference video resolution must be at least 256 pixels per side (the source is 255×720 px); please increase your video's resolution."]);
	});

	it("errors a source above the per-side maximum, queueing nothing", async () => {
		resetSources();
		const s = store();
		sources.push({ sourceFrames: 48, sourceWidth: 1280, sourceHeight: 5761 });
		const { queued, failures } = await queueZipsFromFiles(s, [videoZip("huge.zip", ["v1.mp4"])], dims);
		expect(queued).toBe(0);
		expect(s.state.queue).toEqual([]);
		expect(failures.map((f) => f.message)).toEqual(["v1.mp4: Reference video resolution must be at most 5760 pixels per side (the source is 1280×5761 px); please decrease your video's resolution."]);
	});
});
