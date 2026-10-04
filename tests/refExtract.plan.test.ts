import { describe, it, expect } from "bun:test";
import { REF_VIDEO_FPS, REF_SHORT_EDGE, REF_MAX_AREA, planReferenceSampling, refCanvasScale, refCanvasSize, referenceFrameCount } from "../app/ts/refExtract.plan.js";

describe("REF_VIDEO_FPS", () => {
	it("is the server's 24 fps reference grid", () => {
		expect(REF_VIDEO_FPS).toBe(24);
	});
});

describe("refCanvasScale", () => {
	it("mirrors the server canvas constants (768 px short edge, 768×1344 px area)", () => {
		expect(REF_SHORT_EDGE).toBe(768);
		expect(REF_MAX_AREA).toBe(768 * 1344);
	});
	it("is 1 for sources at or below the canvas, so nothing is upscaled", () => {
		expect(refCanvasScale(640, 480)).toBe(1);
		expect(refCanvasScale(512, 512)).toBe(1);
		expect(refCanvasScale(768, 768)).toBe(1);
		expect(refCanvasScale(1024, 576)).toBe(1);
		// Under the canvas on both constraints even with an extreme aspect.
		expect(refCanvasScale(4000, 100)).toBe(1);
	});
	it("applies the short-edge constraint when it binds", () => {
		expect(refCanvasScale(2048, 2048)).toBe(768 / 2048);
		expect(refCanvasScale(900, 800)).toBe(768 / 800);
	});
	it("applies the area constraint when it binds, as the min of the two constraints and 1", () => {
		// 16:9 above the canvas: the area constraint binds before the short edge does.
		expect(refCanvasScale(1920, 1080)).toBe(Math.sqrt(REF_MAX_AREA / (1920 * 1080)));
		expect(refCanvasScale(1920, 1080)).toBeLessThan(768 / 1080);
		expect(refCanvasScale(3840, 2160)).toBe(Math.sqrt(REF_MAX_AREA / (3840 * 2160)));
	});
	it("is scale-invariant for a fixed aspect above the canvas: double the source, half the scale, same target dims", () => {
		expect(refCanvasScale(3840, 2160)).toBe(refCanvasScale(1920, 1080) / 2);
		expect(refCanvasSize(3840, 2160)).toEqual(refCanvasSize(1920, 1080));
	});
	it("returns 1 for degenerate dimensions", () => {
		expect(refCanvasScale(0, 100)).toBe(1);
		expect(refCanvasScale(100, 0)).toBe(1);
		expect(refCanvasScale(Number.NaN, 100)).toBe(1);
		expect(refCanvasScale(100, Number.POSITIVE_INFINITY)).toBe(1);
	});
});

describe("refCanvasSize", () => {
	it("keeps small and at-canvas sources at their exact native size", () => {
		expect(refCanvasSize(640, 480)).toEqual({ width: 640, height: 480 });
		expect(refCanvasSize(512, 512)).toEqual({ width: 512, height: 512 });
		expect(refCanvasSize(768, 768)).toEqual({ width: 768, height: 768 });
		expect(refCanvasSize(1024, 576)).toEqual({ width: 1024, height: 576 });
	});
	it("targets exact dims for a representative 16:9 source (area constraint binds)", () => {
		expect(refCanvasSize(1920, 1080)).toEqual({ width: 1355, height: 762 });
		expect(refCanvasSize(3840, 2160)).toEqual({ width: 1355, height: 762 });
	});
	it("targets exact dims for a representative 9:16 source", () => {
		expect(refCanvasSize(1080, 1920)).toEqual({ width: 762, height: 1355 });
	});
	it("targets exact dims for a representative 1:1 source (short-edge constraint binds)", () => {
		expect(refCanvasSize(2048, 2048)).toEqual({ width: 768, height: 768 });
		expect(refCanvasSize(5760, 5760)).toEqual({ width: 768, height: 768 });
	});
	it("targets exact dims for a source where the short edge binds inside the area budget", () => {
		expect(refCanvasSize(1200, 900)).toEqual({ width: 1024, height: 768 });
		expect(refCanvasSize(900, 800)).toEqual({ width: 864, height: 768 });
	});
	it("never exceeds the canvas short edge, and only by rounding slop on the area", () => {
		for (const [w, h] of [[1920, 1080], [1080, 1920], [2048, 2048], [3840, 2160], [5760, 5760]] as const) {
			const dims = refCanvasSize(w, h);
			expect(Math.min(dims.width, dims.height)).toBeLessThanOrEqual(REF_SHORT_EDGE);
			// Round-to-pixel may exceed the continuous area budget by less than one pixel per side; a full pixel of slack is the honest bound.
			expect(dims.width * dims.height).toBeLessThanOrEqual(REF_MAX_AREA + w + h + 1);
		}
	});
	it("never upscales, even for a one-pixel-per-side source", () => {
		expect(refCanvasSize(1, 1)).toEqual({ width: 1, height: 1 });
	});
});

describe("referenceFrameCount", () => {
	it("counts the whole source span on the 24 fps grid, uncapped", () => {
		expect(referenceFrameCount(0, 5)).toBe(120);
		expect(referenceFrameCount(0.25, 10.25)).toBe(240);
		expect(referenceFrameCount(0, 20)).toBe(480);
	});
	it("rounds past float slop in the container duration", () => {
		expect(referenceFrameCount(0, 73 / REF_VIDEO_FPS - 1e-9)).toBe(73);
	});
	it("yields 0 for a zero, negative, or non-finite span", () => {
		expect(referenceFrameCount(2, 2)).toBe(0);
		expect(referenceFrameCount(5, 1)).toBe(0);
		expect(referenceFrameCount(1, Number.NaN)).toBe(0);
		expect(referenceFrameCount(1, Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("planReferenceSampling", () => {
	it("caps a long span at maxFrames and propagates the first timestamp", () => {
		const timestamps = planReferenceSampling(0.25, 10.25, 100);
		expect(timestamps.length).toBe(100);
		expect(timestamps[0]).toBe(0.25);
		// The base offset must appear in every timestamp, not just index 0; the audio trim is aligned to `firstTimestamp + frames.length / REF_VIDEO_FPS`, which only lands on the grid if the offset propagates.
		expect(timestamps[1]).toBe(0.25 + 1 / REF_VIDEO_FPS);
	});

	it("spaces a 0.5 s span exactly one 24 fps frame apart, strictly increasing", () => {
		const timestamps = planReferenceSampling(0, 0.5, 1000);
		expect(timestamps.length).toBe(12);
		for (let i = 1; i < timestamps.length; i++) {
			const prev = timestamps[i - 1];
			const curr = timestamps[i];
			if (prev === undefined || curr === undefined) throw new Error("missing timestamp in plan");
			// Each grid point must match the plan formula exactly; subtracting two rounded points would not be (the points are rounded, their difference is not).
			expect(curr).toBe(i / REF_VIDEO_FPS);
			expect(curr).toBeGreaterThan(prev);
		}
	});

	it("rounds past float slop in the container duration", () => {
		// A container of 73 frames spans 73 / 24 s, whose float product can land at 73 minus epsilon; round must keep the final frame.
		const timestamps = planReferenceSampling(0, 73 / REF_VIDEO_FPS - 1e-9, 1000);
		expect(timestamps.length).toBe(73);
	});

	it("yields an empty plan for a zero, negative, or non-finite span", () => {
		for (const [first, end] of [[2, 2], [5, 1], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]] as const) {
			expect(planReferenceSampling(first, end, 100)).toEqual([]);
		}
	});

	it("reduces to a single timestamp when maxFrames is 1", () => {
		const timestamps = planReferenceSampling(0.5, 10.5, 1);
		expect(timestamps.length).toBe(1);
		expect(timestamps[0]).toBe(0.5);
	});

	it("stops a long source at the remaining combined budget passed as maxFrames", () => {
		// A 30 s source handed the full 360-frame combined budget: the plan stops at 15 s, and the caller's budget check on the uncapped referenceFrameCount is what errors the upload.
		const timestamps = planReferenceSampling(0, 30, 360);
		expect(timestamps.length).toBe(360);
		expect(timestamps[359]).toBe(359 / REF_VIDEO_FPS);
	});

	it("keeps every timestamp inside the audio-trim span [firstTimestamp, firstTimestamp + n / REF_VIDEO_FPS)", () => {
		const first = 0.4;
		const timestamps = planReferenceSampling(first, first + 5, 200);
		const n = timestamps.length;
		const last = timestamps[n - 1];
		expect(last !== undefined && last >= first).toBe(true);
		// Strict, with no epsilon slack: the last grid point is a full 1 / REF_VIDEO_FPS below that bound by construction.
		expect(last !== undefined && last < first + n / REF_VIDEO_FPS).toBe(true);
	});
});
