import { describe, it, expect } from "bun:test";
import { resolveMoveIndices } from "../app/ts/dragReorder.js";
import type { QueueItem, QueueStatus } from "../app/ts/types.js";

function item(uid: string, status: QueueStatus = "queued"): QueueItem {
	return {
		id: uid,
		status,
		prompt: "a dog",
		zipName: "d.zip",
		mode: "prompt",
		files: [],
		videos: [],
		audios: [],
		width: 640,
		height: 384,
		jobFrames: 49,
		steps: 20,
		error: null,
		serverId: null,
		startedAt: null,
	};
}

describe("resolveMoveIndices", () => {
	it("moves a middle row before a later row in post-removal coordinates", () => {
		expect(resolveMoveIndices([item("a"), item("b"), item("c")], "a", "c")).toEqual({ from: 0, to: 1 });
	});

	it("moves a later row before an earlier row", () => {
		expect(resolveMoveIndices([item("a"), item("b"), item("c")], "c", "a")).toEqual({ from: 2, to: 0 });
	});

	it("appends to the end of the queued group when beforeId is null", () => {
		expect(resolveMoveIndices([item("a"), item("b"), item("c")], "a", null)).toEqual({ from: 0, to: 2 });
	});

	it("returns null when dropped onto itself", () => {
		expect(resolveMoveIndices([item("a"), item("b"), item("c")], "b", "b")).toBeNull();
	});

	it("returns null when dropped before the row directly below it", () => {
		expect(resolveMoveIndices([item("a"), item("b"), item("c")], "b", "c")).toBeNull();
	});

	it("returns null when the dragged item is not queued", () => {
		expect(resolveMoveIndices([item("a"), item("f", "failed"), item("c")], "f", "c")).toBeNull();
	});

	it("returns null when the target row is not queued", () => {
		expect(resolveMoveIndices([item("a"), item("f", "failed")], "a", "f")).toBeNull();
	});

	it("returns null when the dragged id is unknown", () => {
		expect(resolveMoveIndices([item("a"), item("b")], "nope", "b")).toBeNull();
	});

	it("treats an unknown beforeId as the end of the queued group", () => {
		expect(resolveMoveIndices([item("a"), item("b"), item("c")], "a", "nope")).toEqual({ from: 0, to: 2 });
	});

	it("returns null for a single-item queue", () => {
		expect(resolveMoveIndices([item("a")], "a", null)).toBeNull();
	});

	it("crosses a stuck row between queued rows without crossing into it", () => {
		expect(resolveMoveIndices([item("a"), item("f", "failed"), item("c")], "c", "a")).toEqual({ from: 2, to: 0 });
		expect(resolveMoveIndices([item("a"), item("f", "failed"), item("c")], "a", null)).toEqual({ from: 0, to: 2 });
		expect(resolveMoveIndices([item("a"), item("f", "failed"), item("c")], "a", "c")).toEqual({ from: 0, to: 1 });
	});

	it("returns null when the last queued item is dropped at the end with trailing stuck rows", () => {
		expect(resolveMoveIndices([item("f", "failed"), item("a")], "a", null)).toBeNull();
	});
});

