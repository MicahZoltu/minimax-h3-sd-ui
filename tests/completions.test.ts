import { describe, it, expect } from "bun:test";
import { buildCompletion } from "../app/ts/completions.js";
import { GENERATION_PRESET } from "../app/ts/request.js";
import type { Job } from "../app/ts/api.js";
import type { QueueItem } from "../app/ts/types.js";
import { bytesToDataUrl } from "../app/ts/utils.js";

const PNG = bytesToDataUrl(new Uint8Array([1, 2, 3, 4]), "image/png");

function queueItem(over: Partial<QueueItem> = {}): QueueItem {
	return {
		id: "q1",
		status: "generating",
		prompt: "a cat",
		zipName: "cat.zip",
		mode: "refs",
		files: [{ name: "f1.png", dataUrl: PNG }],
		width: 512,
		height: 512,
		jobFrames: 49,
		steps: 20,
		error: null,
		serverId: "srv",
		startedAt: 1700000000000,
		...over,
	};
}

function job(over: Partial<Job> = {}): Job {
	return {
		id: "srv",
		status: "completed",
		started: 1700000000,
		completed: 1700000002,
		result: { output_format: "webm", b64_json: "QUJD", frame_count: 49, fps: 30 },
		...over,
	};
}

function artifacts() {
	return { videoBlob: new Blob(["video"]), thumbBlob: new Blob(["thumb"]), format: "webm", mime: "video/webm" };
}

describe("buildCompletion", () => {
	it("assembles a HistoryItem matching the queue's prior output", () => {
		const rec = buildCompletion(queueItem(), job(), artifacts());
		const item = rec.historyItem;
		expect(item.prompt).toBe("a cat");
		expect(item.zipName).toBe("cat.zip");
		expect(item.mode).toBe("refs");
		expect(item.width).toBe(512);
		expect(item.height).toBe(512);
		expect(item.frameCount).toBe(49);
		expect(item.fps).toBe(30);
		expect(item.elapsedMs).toBe(2000);
		expect(item.startedAt).toBe(1700000000 * 1000);
		expect(item.completedAt).toBe(1700000002 * 1000);
		expect(item.video).toEqual({ mime: "video/webm", format: "webm", byteSize: 5 });
		expect(item.thumbBytes).toBe(5);
		expect(item.persisted).toBe(false);
		expect(item.viewed).toBe(false);
		expect(item.files[0]?.key).toBe(`${item.id}:file:0`);
		expect(item.files[0]?.name).toBe("f1.png");
		expect(item.files[0]?.bytes).toBe(4);
	});

	it("returns the artifacts unchanged and the converted file Blobs", () => {
		const arts = artifacts();
		const rec = buildCompletion(queueItem(), job(), arts);
		expect(rec.videoBlob).toBe(arts.videoBlob);
		expect(rec.thumbBlob).toBe(arts.thumbBlob);
		expect(rec.fileBlobs).toHaveLength(1);
		expect(rec.fileBlobs[0]?.size).toBe(4);
	});

	it("falls back to item.jobFrames and the generation fps when the result omits them", () => {
		const rec = buildCompletion(queueItem({ jobFrames: 33 }), job({ result: { output_format: "webm", b64_json: "QUJD" } }), artifacts());
		expect(rec.historyItem.frameCount).toBe(33);
		expect(rec.historyItem.fps).toBe(GENERATION_PRESET.fps);
	});

	it("computes zero elapsed time when the job reports no started/completed timestamps", () => {
		const rec = buildCompletion(queueItem(), job({ started: null, completed: null }), artifacts());
		expect(rec.historyItem.elapsedMs).toBe(0);
	});

	it("falls back to completed as started when only completed is present", () => {
		const rec = buildCompletion(queueItem(), job({ started: null, completed: 1700000009 }), artifacts());
		expect(rec.historyItem.startedAt).toBe(1700000009 * 1000);
		expect(rec.historyItem.completedAt).toBe(1700000009 * 1000);
		expect(rec.historyItem.elapsedMs).toBe(0);
	});

	it("coerces malformed/NaN timestamps to finite elapsedMs and a NaN-free HistoryItem", () => {
		const rec = buildCompletion(queueItem(), job({ started: NaN, completed: NaN }), artifacts());
		expect(Number.isFinite(rec.historyItem.elapsedMs)).toBe(true);
		expect(Number.isFinite(rec.historyItem.startedAt)).toBe(true);
		expect(Number.isFinite(rec.historyItem.completedAt)).toBe(true);
		expect(rec.historyItem.elapsedMs).toBe(0);
		expect(rec.historyItem.startedAt).toBe(0);
		expect(rec.historyItem.completedAt).toBe(0);
	});

	it("coerces a malformed completed timestamp to the finite start without NaN", () => {
		const rec = buildCompletion(queueItem(), job({ started: 1700000000, completed: NaN }), artifacts());
		expect(Number.isFinite(rec.historyItem.elapsedMs)).toBe(true);
		expect(rec.historyItem.elapsedMs).toBe(0);
		expect(Number.isFinite(rec.historyItem.startedAt)).toBe(true);
		expect(rec.historyItem.startedAt).toBe(1700000000 * 1000);
		expect(Number.isFinite(rec.historyItem.completedAt)).toBe(true);
	});

	it("degrades a malformed file dataUrl to an empty Blob and zero bytes without stranding the item", () => {
		const similar = queueItem({ files: [{ name: "bad.png", dataUrl: "data:image/png;base64,@@@@not-b64" }] });
		const rec = buildCompletion(similar, job(), artifacts());
		expect(rec.fileBlobs[0]?.size).toBe(0);
		expect(rec.historyItem.files[0]?.bytes).toBe(0);
	});
});
