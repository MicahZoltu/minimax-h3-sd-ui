import { describe, expect, test } from "bun:test";
import { codecLabel } from "../app/ts/codecs.js";

describe("codecLabel", () => {
	test("maps known video codec ids", () => {
		expect(codecLabel("avc")).toBe("H.264 / AVC");
		expect(codecLabel("hevc")).toBe("H.265 / HEVC");
		expect(codecLabel("vp8")).toBe("VP8");
		expect(codecLabel("vp9")).toBe("VP9");
		expect(codecLabel("av1")).toBe("AV1");
		expect(codecLabel("prores")).toBe("ProRes");
	});

	test("maps known audio codec ids", () => {
		expect(codecLabel("aac")).toBe("AAC");
		expect(codecLabel("opus")).toBe("Opus");
		expect(codecLabel("mp3")).toBe("MP3");
		expect(codecLabel("vorbis")).toBe("Vorbis");
		expect(codecLabel("flac")).toBe("FLAC");
		expect(codecLabel("ac3")).toBe("AC-3");
		expect(codecLabel("eac3")).toBe("E-AC-3");
		expect(codecLabel("dts")).toBe("DTS");
	});

	test("maps the pcm family", () => {
		expect(codecLabel("pcm-s16")).toBe("PCM 16-bit little-endian");
		expect(codecLabel("pcm-s16be")).toBe("PCM 16-bit big-endian");
		expect(codecLabel("pcm-f32")).toBe("PCM 32-bit float");
		expect(codecLabel("pcm-u8")).toBe("PCM 8-bit");
		expect(codecLabel("ulaw")).toBe("μ-law");
		expect(codecLabel("alaw")).toBe("A-law");
	});

	test("returns unknown ids unchanged", () => {
		expect(codecLabel("theora")).toBe("theora");
		expect(codecLabel("")).toBe("");
	});
});
