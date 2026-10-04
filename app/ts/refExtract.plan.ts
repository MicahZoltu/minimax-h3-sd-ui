// Sampling planner and canvas geometry for reference-video extraction.
//
// The server treats `ref_videos[].frames` as sampled at `ref_videos[].fps`, resamples the prefix to 24 fps, and requires `fps` to be a JSON integer (a fractional rate like 29.97 silently reverts to 24).
// Extraction therefore plans its sample timestamps directly onto a 24 fps grid, so the delivered frames and the declared rate agree exactly and the server's resampling becomes the identity map: no fast-forward from rate mismatch, and no judder or frame repetition from fractional rates.
// The planner is pure and dependency-free (no DOM, no worker, no vendor imports) so it can be tested with bun directly.

// The fps the server normalizes reference timelines to, and the rate reference extraction always reports.
// The server requires `fps` to be a JSON integer; sampling the source onto this exact grid makes the delivered frames and the declared rate agree, which eliminates both fast-forward from rate mismatch and frame repetition from fractional rates.
export const REF_VIDEO_FPS = 24;

// The reference-frame canvas the server's own pipeline resizes toward (the local sdcpp pipeline resizes reference frames to a 768 px short edge within a maximum 768×1344 px frame area).
// Sources at or below this canvas keep their native size; only larger sources are downscaled, and never beyond this canvas.
export const REF_SHORT_EDGE = 768;
export const REF_MAX_AREA = 768 * 1344;

/**
 * The uniform scale a source frame of `width` × `height` pixels is multiplied by to land on the server's reference canvas.
 * The scale is the minimum of 1 (never upscale) and the two canvas constraints — short edge ≤ REF_SHORT_EDGE and frame area ≤ REF_MAX_AREA — so a source at or below the canvas scales by exactly 1 and keeps its native pixel grid.
 * Degenerate (non-finite or non-positive) dimensions scale by 1 and are the caller's problem to reject.
 */
export function refCanvasScale(width: number, height: number): number {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
	const shortEdgeScale = REF_SHORT_EDGE / Math.min(width, height);
	const areaScale = Math.sqrt(REF_MAX_AREA / (width * height));
	return Math.min(1, shortEdgeScale, areaScale);
}

/**
 * The pixel dimensions a source frame is rendered at: `refCanvasScale` applied and rounded to whole pixels (at least 1 px per side).
 * Rounding can land at most one pixel over a continuous constraint, which matches the server's own toward-the-canvas resize; the server accepts arbitrary frame dimensions and re-normalizes them regardless.
 */
export function refCanvasSize(width: number, height: number): { width: number; height: number } {
	const scale = refCanvasScale(width, height);
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The source's full span `[firstTimestamp, endTimestamp]` expressed in 24 fps reference frames, with no cap applied.
 * This is the count the combined reference-video budget is judged on: it is the whole of what the user provided, and comparing it against the budget (rather than a capped delivery) is what makes a budget-capped extraction impossible to accept silently.
 * A non-finite or inverted span yields 0.
 */
export function referenceFrameCount(firstTimestamp: number, endTimestamp: number): number {
	const span = endTimestamp - firstTimestamp;
	return Number.isFinite(span) && span > 0 ? Math.round(span * REF_VIDEO_FPS) : 0;
}

/**
 * Plan the sample timestamps for a reference video spanning `[firstTimestamp, endTimestamp]` seconds.
 * Returns one timestamp per delivered frame: each grid point shows the frame displayed at that instant, so sources above 24 fps have frames dropped and sources below it hold a frame across consecutive grid points — a standard 24 fps resample.
 * Delivers at most `maxFrames` timestamps starting at `firstTimestamp`.
 * Callers pass the REMAINING combined reference-video budget as `maxFrames`, so an oversized source stops at the budget instead of decoding unbounded; that stop is itself a trim, and the caller's budget check against the uncapped `referenceFrameCount` is what makes it unreachable in accepted uploads.
 * A non-finite or inverted span yields an empty array, which callers treat as "no decodable frames".
 */
export function planReferenceSampling(firstTimestamp: number, endTimestamp: number, maxFrames: number): number[] {
	// Math.round, not floor: a container of n frames spans n / REF_VIDEO_FPS seconds, whose float product can land at n minus epsilon (e.g. 71.99999), and floor would systematically drop the final frame of every such file while round is robust to that slop.
	const count = Math.max(0, Math.min(referenceFrameCount(firstTimestamp, endTimestamp), maxFrames));
	return Array.from({ length: count }, (_, i) => firstTimestamp + i / REF_VIDEO_FPS);
}
