import { describe, it, expect } from "bun:test";
import { dataUrlToBlob, fileKey, thumbnailKey, videoKey } from "../app/ts/media.js";

describe("media key derivation", () => {
	it("keeps the video key equal to the id for loadVideoBlob compatibility", () => {
		expect(videoKey("h_123")).toBe("h_123");
	});

	it("derives a thumbnail key by id", () => {
		expect(thumbnailKey("h_123")).toBe("h_123:thumb");
	});

	it("derives per-file keys by id and index", () => {
		expect(fileKey("h_123", 0)).toBe("h_123:file:0");
		expect(fileKey("h_123", 5)).toBe("h_123:file:5");
		expect(fileKey("h_other", 1)).toBe("h_other:file:1");
	});
});

describe("dataUrlToBlob", () => {
	it("decodes a base64 data URL into a correctly typed Blob", () => {
		const blob = dataUrlToBlob("data:image/png;base64,QUFBQg==");
		expect(blob.type).toBe("image/png");
		expect(blob.size).toBe(4);
	});

	it("preserves the declared MIME type", () => {
		const blob = dataUrlToBlob("data:image/webp;base64,aGVsbG8=");
		expect(blob.type).toBe("image/webp");
		expect(blob.size).toBe(5);
	});

	it("decodes the underlying bytes", async () => {
		const blob = dataUrlToBlob("data:text/plain;base64,aGVsbG8=");
		expect(await blob.text()).toBe("hello");
	});

	it("falls back to application/octet-stream when the data: prefix is missing", () => {
		const blob = dataUrlToBlob("aGVsbG8=");
		expect(blob.type).toBe("application/octet-stream");
		expect(blob.size).toBe(5);
	});

	it("falls back to application/octet-stream when the MIME is empty (data:;base64,)", () => {
		const blob = dataUrlToBlob("data:;base64,aGVsbG8=");
		expect(blob.type).toBe("application/octet-stream");
	});

	it("throws on malformed base64", () => {
		expect(() => dataUrlToBlob("data:x;base64,@@@@")).toThrow();
	});
});
