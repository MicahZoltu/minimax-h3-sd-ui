// Sampling planner for reference-video extraction.
//
// The server treats `ref_videos[].frames` as sampled at `ref_videos[].fps`, resamples the prefix to 24 fps, and requires `fps` to be a JSON integer (a fractional rate like 29.97 silently reverts to 24).
// Extraction therefore plans its sample timestamps directly onto a 24 fps grid, so the delivered frames and the declared rate agree exactly and the server's resampling becomes the identity map: no fast-forward from rate mismatch, and no judder or frame repetition from fractional rates.
// The planner is pure and dependency-free (no DOM, no worker, no vendor imports) so it can be tested with bun directly.

// The fps the server normalizes reference timelines to, and the rate reference extraction always reports.
// The server requires `fps` to be a JSON integer; sampling the source onto this exact grid makes the delivered frames and the declared rate agree, which eliminates both fast-forward from rate mismatch and frame repetition from fractional rates.
export const REF_VIDEO_FPS = 24;

/**
 * Plan the sample timestamps for a reference video spanning `[firstTimestamp, endTimestamp]` seconds.
 * Returns one timestamp per delivered frame: each grid point shows the frame displayed at that instant, so sources above 24 fps have frames dropped and sources below it hold a frame across consecutive grid points — a standard 24 fps resample.
 * Delivers at most `maxFrames` timestamps starting at `firstTimestamp`.
 * A non-finite or inverted span yields an empty array, which callers treat as "no decodable frames".
 */
export function planReferenceSampling(firstTimestamp: number, endTimestamp: number, maxFrames: number): number[] {
	// Math.round, not floor: a container of n frames spans n / REF_VIDEO_FPS seconds, whose float product can land at n minus epsilon (e.g. 71.99999), and floor would systematically drop the final frame of every such file while round is robust to that slop.
	const span = endTimestamp - firstTimestamp;
	const count = Number.isFinite(span) && span > 0 ? Math.max(0, Math.min(Math.round(span * REF_VIDEO_FPS), maxFrames)) : 0;
	return Array.from({ length: count }, (_, i) => firstTimestamp + i / REF_VIDEO_FPS);
}
