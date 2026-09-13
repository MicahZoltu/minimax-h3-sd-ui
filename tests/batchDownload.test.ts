// Raw-variant orchestration tests for the batch download manager (the compressed cases land with that variant).
// The manager runs headless here: barEl/rowsEl are null so paint() is a no-op and only the sequencing state machine is exercised.

import { describe, expect, it } from "bun:test";
import { batchZipName, createBatchDownload, type BatchDownloadHandle, type BatchPhase, type BatchPorts, type BatchSnapshot } from "../app/ts/batchDownload.js";
import type { HistoryMedia } from "../app/ts/history.js";
import { createStore, type Store } from "../app/ts/state.js";
import type { HistoryItem } from "../app/ts/types.js";
import { ZipStreamWriter } from "../app/ts/zipWrite.js";
import { readZipEntries } from "./support/zipRead.js";

// Fixed local wall-clock instant (2026-09-13 14:25:30 local): batchZipName must render it zero-padded.
const NOW = new Date(2026, 8, 13, 14, 25, 30).getTime();
const NOW_NAME = "videos-2026-09-13-142530.zip";

function makeItem(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id,
		createdAt: 0,
		prompt: "a cat",
		zipName: null,
		mode: "prompt",
		files: [],
		videos: [],
		audios: [],
		width: 512,
		height: 512,
		frameCount: 33,
		fps: 24,
		elapsedMs: 1000,
		startedAt: 0,
		completedAt: 0,
		thumbnailKey: "",
		thumbBytes: 0,
		video: { mime: "video/webm", format: "webm", byteSize: 3 },
		persisted: false,
		viewed: false,
		...overrides,
	};
}

function mediaFor(id: string): HistoryMedia {
	return { video: new Blob([`video-${id}`]), thumbnail: new Blob(["t"]), files: [], videoThumbs: [], videoAudios: [], videoSources: [], audioSources: [] };
}

type PortsStub = BatchPorts & { log: string[]; downloads: { blob: Blob; filename: string }[] };

// Fakes for every side effect: loadVideo logs then defers to the real cache-backed store load unless overridden,
// probe/run are never reached by the raw pipeline (a throw proves it), download records instead of clicking.
function fakePorts(store: Store, overrides: { now?: number; load?: (id: string) => Promise<Blob | null>; writer?: () => ZipStreamWriter } = {}): PortsStub {
	const log: string[] = [];
	const downloads: { blob: Blob; filename: string }[] = [];
	return {
		log,
		downloads,
		loadVideo: async (id) => {
			log.push(`load:${id}`);
			return overrides.load ? overrides.load(id) : store.history.loadVideo(id);
		},
		probe: async () => ({ plan: null, reason: null }),
		run: () => {
			throw new Error("the raw pipeline never runs compression");
		},
		download: (blob, filename) => {
			log.push(`download:${filename}`);
			downloads.push({ blob, filename });
		},
		now: () => overrides.now ?? NOW,
		createWriter: overrides.writer ?? ((): ZipStreamWriter => new ZipStreamWriter()),
	};
}

async function untilSettled(batch: BatchDownloadHandle): Promise<BatchSnapshot> {
	for (;;) {
		const s = batch.snapshot();
		if (s.phase === "done" || s.phase === "canceled" || s.phase === "failed") return s;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

async function untilPhase(batch: BatchDownloadHandle, target: BatchPhase): Promise<void> {
	for (;;) {
		if (batch.snapshot().phase === target) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

function selectIds(batch: BatchDownloadHandle, ...ids: string[]): void {
	batch.setSelecting(true);
	for (const id of ids) batch.toggle(id);
}

// A real writer whose finish() stalls on a gate, so a cancel can land inside the packing phase deterministically.
class SlowFinishWriter extends ZipStreamWriter {
	private gate: Promise<void>;
	constructor(gate: Promise<void>) {
		super();
		this.gate = gate;
	}
	override async finish(): Promise<Blob> {
		await this.gate;
		return super.finish();
	}
}

describe("batchZipName", () => {
	it("formats videos-yyyy-mm-dd-HHMMSS.zip from local time with zero padding", () => {
		expect(batchZipName(NOW)).toBe(NOW_NAME);
	});

	it("pads every field and rolls over month/day/hour boundaries", () => {
		expect(batchZipName(new Date(2026, 9, 1, 0, 0, 0).getTime())).toBe("videos-2026-10-01-000000.zip");
		expect(batchZipName(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("videos-2026-01-02-030405.zip");
		expect(batchZipName(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe("videos-2026-12-31-235959.zip");
	});
});

describe("batch download manager (raw)", () => {
	it("zips the selection in display order and downloads exactly once", async () => {
		const a = makeItem("a", { zipName: "clip-a.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "clip-b.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const ports = fakePorts(store);
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("raw");

		const s = await untilSettled(batch);
		expect(s.phase).toBe("done");
		expect(s.total).toBe(2);
		expect(s.done).toBe(2);
		expect(s.skipped).toBe(0);
		expect(s.zipName).toBe(NOW_NAME);
		// Display order is newest-first, so the loads (and the zip's entries) run b then a, then exactly one download.
		expect(ports.log).toEqual(["load:b", "load:a", `download:${NOW_NAME}`]);
		expect(ports.downloads).toHaveLength(1);
		const zip = ports.downloads[0]?.blob ?? new Blob();
		expect(zip.type).toBe("application/zip");
		const entries = readZipEntries(new Uint8Array(await zip.arrayBuffer()));
		expect(entries.map((e) => e.name)).toEqual(["clip-b.webm", "clip-a.webm"]);
		expect(new TextDecoder().decode(entries[0]?.data ?? new Uint8Array())).toBe("video-b");
		expect(new TextDecoder().decode(entries[1]?.data ?? new Uint8Array())).toBe("video-a");
	});

	it("derives entry names from the item stem and video.format, de-duplicating collisions", async () => {
		const a = makeItem("a", { zipName: "foo.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "foo.zip", createdAt: 2000 });
		const c = makeItem("c", { zipName: null, prompt: "Beach day", video: { mime: "video/mp4", format: "mp4", byteSize: 3 }, createdAt: 3000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		store.addHistory(c, mediaFor("c"));
		const ports = fakePorts(store);
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id, c.id);
		batch.start("raw");

		await untilSettled(batch);
		expect(ports.downloads).toHaveLength(1);
		const zip = ports.downloads[0]?.blob ?? new Blob();
		const entries = readZipEntries(new Uint8Array(await zip.arrayBuffer()));
		// Display order is newest-first, so c is added before the two "foo" items.
		expect(entries.map((e) => e.name)).toEqual(["Beach day.mp4", "foo.webm", "foo (2).webm"]);
	});

	it("treats stem collisions case-insensitively across items", async () => {
		// "Beach" is newer, so it is processed (and named) first; "beach" must then suffix, never overwrite.
		const upper = makeItem("up", { zipName: "Beach.zip", createdAt: 2000 });
		const lower = makeItem("low", { zipName: "beach.zip", createdAt: 1000 });
		const store = createStore();
		store.addHistory(lower, mediaFor("low"));
		store.addHistory(upper, mediaFor("up"));
		const ports = fakePorts(store);
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, upper.id, lower.id);
		batch.start("raw");

		await untilSettled(batch);
		expect(ports.downloads).toHaveLength(1);
		const zip = ports.downloads[0]?.blob ?? new Blob();
		const entries = readZipEntries(new Uint8Array(await zip.arrayBuffer()));
		expect(entries.map((e) => e.name)).toEqual(["Beach.webm", "beach (2).webm"]);
	});

	it("isolates a missing blob: the rest still lands in the zip and the skip is reported", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const c = makeItem("c", { zipName: "three.zip", createdAt: 3000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		store.addHistory(c, mediaFor("c"));
		const ports = fakePorts(store, { load: async (id) => (id === b.id ? null : store.history.loadVideo(id)) });
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id, c.id);
		batch.start("raw");

		const s = await untilSettled(batch);
		expect(s.phase).toBe("done");
		expect(s.done).toBe(2);
		expect(s.skipped).toBe(1);
		expect(s.failures).toEqual([{ title: "two", reason: "video data unavailable" }]);
		expect(ports.downloads).toHaveLength(1);
		const zip = ports.downloads[0]?.blob ?? new Blob();
		const entries = readZipEntries(new Uint8Array(await zip.arrayBuffer()));
		expect(entries.map((e) => e.name)).toEqual(["three.webm", "one.webm"]);
	});

	it("isolates a rejecting loadVideo like a missing blob and continues", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const c = makeItem("c", { zipName: "three.zip", createdAt: 3000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		store.addHistory(c, mediaFor("c"));
		const ports = fakePorts(store, { load: async (id) => {
			if (id === b.id) throw new Error("load boom");
			return store.history.loadVideo(id);
		} });
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id, c.id);
		batch.start("raw");

		const s = await untilSettled(batch);
		expect(s.phase).toBe("done");
		expect(s.done).toBe(2);
		expect(s.skipped).toBe(1);
		expect(s.failures).toEqual([{ title: "two", reason: "video data unavailable" }]);
		expect(ports.downloads).toHaveLength(1);
		const zip = ports.downloads[0]?.blob ?? new Blob();
		const entries = readZipEntries(new Uint8Array(await zip.arrayBuffer()));
		expect(entries.map((e) => e.name)).toEqual(["three.webm", "one.webm"]);
	});

	it("fails without downloading when every item is unavailable", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const ports = fakePorts(store, { load: async () => null });
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("raw");

		const s = await untilSettled(batch);
		expect(s.phase).toBe("failed");
		expect(s.done).toBe(0);
		expect(s.skipped).toBe(2);
		expect(s.failures).toHaveLength(2);
		expect(ports.downloads).toHaveLength(0);
	});

	it("cancel stops the loop, downloads nothing, and never loads later ids", async () => {
		const a = makeItem("a", { createdAt: 1000 });
		const b = makeItem("b", { createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const ports = fakePorts(store);
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		// cancel() lands synchronously before the loop's first await resumes, so the run must abort after (at most) the first load.
		batch.start("raw");
		batch.cancel();

		const s = await untilSettled(batch);
		expect(s.phase).toBe("canceled");
		expect(ports.downloads).toHaveLength(0);
		const loads = ports.log.filter((l) => l.startsWith("load:"));
		expect(loads.length).toBeLessThan(2);
		expect(loads).not.toContain(`load:${a.id}`);
	});

	it("cancel during packing settles canceled and downloads nothing", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		// finish() stalls until released, so the cancel below lands strictly inside the packing phase.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ports = fakePorts(store, { writer: () => new SlowFinishWriter(gate) });
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("raw");
		await untilPhase(batch, "packing");
		batch.cancel();
		release();

		const s = await untilSettled(batch);
		expect(s.phase).toBe("canceled");
		expect(ports.downloads).toHaveLength(0);
	});

	it("aborts before loading anything when the recorded sizes breach the zip guard", () => {
		const huge = makeItem("huge", { video: { mime: "video/webm", format: "webm", byteSize: 0x200000000 } });
		const store = createStore();
		store.addHistory(huge, mediaFor("huge"));
		const ports = fakePorts(store);
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, huge.id);
		batch.start("raw");

		const s = batch.snapshot();
		expect(s.phase).toBe("failed");
		expect(ports.log).toEqual([]);
		expect(ports.downloads).toHaveLength(0);
		expect(s.failures[0]?.reason).toMatch(/too large/);
	});

	it("prunes selection of removed ids and exits selecting mode when history empties", () => {
		const a = makeItem("a", { createdAt: 1000 });
		const b = makeItem("b", { createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const batch = createBatchDownload(store, null, null);
		selectIds(batch, a.id, b.id);
		expect(batch.selection.ids()).toEqual([a.id, b.id]);
		expect(batch.isSelecting()).toBe(true);

		store.removeHistory(a.id);
		expect(batch.selection.ids()).toEqual([b.id]);
		expect(batch.isSelecting()).toBe(true);

		store.clearHistory();
		expect(batch.selection.ids()).toEqual([]);
		expect(batch.isSelecting()).toBe(false);
	});
});
