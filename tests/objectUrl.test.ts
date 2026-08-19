import { describe, it, expect, beforeEach } from "bun:test";
import { getOrCreate, revoke, revokeById, revokeRowMedia } from "../app/ts/objectUrl.js";
import { fileKey, thumbnailKey, videoKey } from "../app/ts/media.js";

let urlCounter = 0;
const revoked: string[] = [];

beforeEach(() => {
	urlCounter = 0;
	revoked.length = 0;
	(globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = (() => `blob:test/${++urlCounter}`) as typeof URL.createObjectURL;
	(globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
});

describe("objectUrl registry", () => {
	it("creates one stable URL per key and reuses it (idempotent)", () => {
		const k = videoKey("h_a");
		const blob = new Blob(["video"]);
		const first = getOrCreate(k, blob);
		const second = getOrCreate(k, new Blob(["other"]));
		expect(second).toBe(first);
		expect(urlCounter).toBe(1);
		revoke(k);
	});

	it("revokes and forgets a single key; revoking a missing key is a no-op", () => {
		const k = videoKey("h_b");
		const url = getOrCreate(k, new Blob(["v"]));
		revoke(k);
		expect(revoked).toContain(url);
		expect([...revoked]).toHaveLength(1);
		revoke(k);
		expect([...revoked]).toHaveLength(1);
		// A fresh getOrCreate for the same key creates a new URL.
		const again = getOrCreate(k, new Blob(["v"]));
		expect(again).not.toBe(url);
		revoke(k);
	});

	it("revokeById revokes the video, thumbnail, and file keys for an id only", () => {
		const id = "h_xyz";
		const videoUrl = getOrCreate(videoKey(id), new Blob(["v"]));
		const thumbUrl = getOrCreate(thumbnailKey(id), new Blob(["t"]));
		const file0Url = getOrCreate(fileKey(id, 0), new Blob(["f0"]));
		const file1Url = getOrCreate(fileKey(id, 1), new Blob(["f1"]));
		// A neighbouring id's key must survive.
		const otherUrl = getOrCreate(videoKey("h_other"), new Blob(["o"]));

		revokeById(id);
		expect(revoked).toContain(videoUrl);
		expect(revoked).toContain(thumbUrl);
		expect(revoked).toContain(file0Url);
		expect(revoked).toContain(file1Url);
		expect(revoked).not.toContain(otherUrl);
		revokeById("h_other");
	});

	it("revokeRowMedia revokes only the row thumb/file keys, never the bare resident video key", () => {
		const id = "h_row";
		const videoUrl = getOrCreate(videoKey(id), new Blob(["v"]));
		const thumbUrl = getOrCreate(thumbnailKey(id), new Blob(["t"]));
		const file0Url = getOrCreate(fileKey(id, 0), new Blob(["f0"]));

		revokeRowMedia(id);
		expect(revoked).toContain(thumbUrl);
		expect(revoked).toContain(file0Url);
		// The resident video key stays alive so a row leaving the DOM cannot drop state.ts's resident.
		expect(revoked).not.toContain(videoUrl);
		expect(getOrCreate(videoKey(id), new Blob(["v"]))).toBe(videoUrl);
		revoke(videoKey(id));
	});
});
