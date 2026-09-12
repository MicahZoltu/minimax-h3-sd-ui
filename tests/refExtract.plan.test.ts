import { describe, it, expect } from "bun:test";
import { REF_VIDEO_FPS, planReferenceSampling } from "../app/ts/refExtract.plan.js";

describe("REF_VIDEO_FPS", () => {
	it("is the server's 24 fps reference grid", () => {
		expect(REF_VIDEO_FPS).toBe(24);
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
