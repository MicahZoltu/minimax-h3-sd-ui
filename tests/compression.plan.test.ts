import { describe, expect, test } from "bun:test";
import { COMPRESSION_ORDER, candidatePlans, codecString, compressedFilename, decidePlan, planLabel, type DevCodecSupport } from "../app/ts/compression.plan.js";

function support(overrides: Partial<DevCodecSupport> = {}): DevCodecSupport {
	return { hasWebCodecs: true, canEncodeAac: true, canEncodeOpus: true, encodableVideo: ["avc", "vp9", "vp8", "av1"], ...overrides };
}

describe("decidePlan", () => {
	test("no WebCodecs yields no-webcodecs", () => {
		expect(decidePlan(support({ hasWebCodecs: false }))).toEqual({ plan: null, reason: "no-webcodecs" });
	});

	test("Chromium picks MP4/AVC/AAC", () => {
		const { plan, reason } = decidePlan(support());
		expect(reason).toBeNull();
		expect(plan).toEqual(COMPRESSION_ORDER[0]!);
	});

	test("AAC encodable but no AVC video falls back to VP9/Opus, not MP4", () => {
		const { plan, reason } = decidePlan(support({ encodableVideo: ["vp9"] }));
		expect(reason).toBeNull();
		expect(plan).not.toBeNull();
		expect(plan?.container).not.toBe("mp4");
		expect(plan?.container).toBe("webm");
		expect(plan?.videoCodec).toBe("vp9");
		expect(plan?.audioCodec).toBe("opus");
	});

	test("Firefox without AAC and AVC picks VP9/Opus WebM", () => {
		const { plan, reason } = decidePlan(support({ canEncodeAac: false, encodableVideo: ["vp9", "vp8", "av1"] }));
		expect(reason).toBeNull();
		expect(plan?.container).toBe("webm");
		expect(plan?.videoCodec).toBe("vp9");
		expect(plan?.audioCodec).toBe("opus");
	});

	test("VP8-only Firefox picks VP8/Opus WebM", () => {
		const { plan, reason } = decidePlan(support({ canEncodeAac: false, encodableVideo: ["vp8"] }));
		expect(reason).toBeNull();
		expect(plan?.videoCodec).toBe("vp8");
	});

	test("AVC present but AAC absent must NOT pick MP4", () => {
		const { plan, reason } = decidePlan(support({ canEncodeAac: false, encodableVideo: ["avc", "vp8"] }));
		expect(reason).toBeNull();
		expect(plan?.container).not.toBe("mp4");
		expect(plan?.videoCodec).toBe("vp8");
	});

	test("no audio encoder yields no-encodable-codec", () => {
		const { plan, reason } = decidePlan(support({ canEncodeAac: false, canEncodeOpus: false, encodableVideo: ["vp9"] }));
		expect(plan).toBeNull();
		expect(reason).toBe("no-encodable-codec");
	});

	test("no encodable video yields no-encodable-codec", () => {
		const { plan, reason } = decidePlan(support({ canEncodeAac: false, canEncodeOpus: true, encodableVideo: [] }));
		expect(plan).toBeNull();
		expect(reason).toBe("no-encodable-codec");
	});

	test("VP9 is preferred over VP8", () => {
		const { plan } = decidePlan(support({ canEncodeAac: false, encodableVideo: ["vp8", "vp9"] }));
		expect(plan?.videoCodec).toBe("vp9");
	});

	test("AV1 only when VP9 and VP8 are absent", () => {
		const { plan } = decidePlan(support({ canEncodeAac: false, encodableVideo: ["av1"] }));
		expect(plan?.videoCodec).toBe("av1");
		const none = decidePlan(support({ canEncodeAac: false, encodableVideo: ["vp9", "av1"] }));
		expect(none.plan?.videoCodec).toBe("vp9");
	});
});

describe("candidatePlans", () => {
	test("WebM/VP9 plan yields that plan first, then all four distinct plans exactly once", () => {
		const vp9 = COMPRESSION_ORDER[1]!;
		const plans = candidatePlans(vp9);
		expect(plans[0]).toEqual(vp9);
		expect(plans).toHaveLength(4);
		for (const p of COMPRESSION_ORDER) expect(plans).toContainEqual(p);
		expect(new Set(plans.map((p) => JSON.stringify(p))).size).toBe(4);
	});

	test("MP4 plan yields MP4 first, then the WebM plans", () => {
		const mp4 = COMPRESSION_ORDER[0]!;
		const plans = candidatePlans(mp4);
		expect(plans[0]).toEqual(mp4);
		expect(plans).toHaveLength(4);
		expect(plans.slice(1).every((p) => p.container === "webm")).toBe(true);
	});
});

describe("compressedFilename", () => {
	test("appends the plan extension", () => {
		expect(compressedFilename("my-video", COMPRESSION_ORDER[0]!)).toBe("my-video.mp4");
		expect(compressedFilename("my-video", COMPRESSION_ORDER[1]!)).toBe("my-video.webm");
	});
});

describe("planLabel", () => {
	test("labels all four combos", () => {
		expect(planLabel({ container: "mp4", videoCodec: "avc", audioCodec: "aac", extension: "mp4", mime: "video/mp4" })).toBe("H.264 + AAC (MP4)");
		expect(planLabel({ container: "webm", videoCodec: "vp9", audioCodec: "opus", extension: "webm", mime: "video/webm" })).toBe("VP9 + Opus (WebM)");
		expect(planLabel({ container: "webm", videoCodec: "vp8", audioCodec: "opus", extension: "webm", mime: "video/webm" })).toBe("VP8 + Opus (WebM)");
		expect(planLabel({ container: "webm", videoCodec: "av1", audioCodec: "opus", extension: "webm", mime: "video/webm" })).toBe("AV1 + Opus (WebM)");
	});
});

describe("codecString", () => {
	test("maps video and audio verbs to codec strings", () => {
		expect(codecString(COMPRESSION_ORDER[0]!)).toEqual({ video: "avc1", audio: "mp4a.40.2" });
		expect(codecString(COMPRESSION_ORDER[1]!)).toEqual({ video: "vp09", audio: "opus" });
		expect(codecString(COMPRESSION_ORDER[2]!)).toEqual({ video: "vp08", audio: "opus" });
		expect(codecString(COMPRESSION_ORDER[3]!)).toEqual({ video: "av01", audio: "opus" });
	});
});

describe("COMPRESSION_ORDER", () => {
	test("MP4 first, then WebM plans", () => {
		expect(COMPRESSION_ORDER.length).toBe(4);
		expect(COMPRESSION_ORDER[0]?.container).toBe("mp4");
		expect(COMPRESSION_ORDER.slice(1).every((p) => p.container === "webm")).toBe(true);
	});
});

describe("plan mime", () => {
	test("each plan carries its mime type", () => {
		expect(COMPRESSION_ORDER[0]?.mime).toBe("video/mp4");
		for (const plan of COMPRESSION_ORDER.slice(1)) expect(plan.mime).toBe("video/webm");
	});
});
