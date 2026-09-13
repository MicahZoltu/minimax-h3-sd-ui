// Orchestration tests for the batch download manager, covering both the raw and the compressed variant.
// The manager runs headless here: barEl/rowsEl are null so paint() is a no-op and only the sequencing state machine is exercised.

import { describe, expect, it } from "bun:test";
import { CompressionCanceledError, type CompressionResult, type CompressionRun } from "../app/ts/compression.js";
import type { CompressionPlan, UnsupportedReason } from "../app/ts/compression.types.js";
import { batchZipName, createBatchDownload, type BatchDownloadHandle, type BatchPhase, type BatchPorts, type BatchSnapshot } from "../app/ts/batchDownload.js";
import type { HistoryMedia } from "../app/ts/history.js";
import { createStore, type Store } from "../app/ts/state.js";
import type { HistoryItem } from "../app/ts/types.js";
import { ZipStreamWriter, type ZipEntryInput } from "../app/ts/zipWrite.js";
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

// Fakes for every side effect: loadVideo logs then defers to the real cache-backed store load unless overridden, download records instead of clicking, and every port can be swapped for a recording fake.
// All ports log into the one shared `log` array (the caller's array when provided), so cross-port ordering assertions stay exact.
function fakePorts(store: Store, overrides: { now?: number; log?: string[]; load?: (id: string) => Promise<Blob | null>; probe?: (blob: Blob) => Promise<{ plan: CompressionPlan | null; reason: UnsupportedReason | null }>; run?: (blob: Blob, plan: CompressionPlan, opts: { quality: "medium"; stem: string }) => CompressionRun; writer?: () => ZipStreamWriter; compressionBlocked?: () => string | null } = {}): PortsStub {
	const log = overrides.log ?? [];
	const downloads: { blob: Blob; filename: string }[] = [];
	return {
		log,
		downloads,
		loadVideo: async (id) => {
			log.push(`load:${id}`);
			return overrides.load ? overrides.load(id) : store.history.loadVideo(id);
		},
		probe: overrides.probe ?? (async () => ({ plan: null, reason: null })),
		run: overrides.run ?? (() => {
			throw new Error("the raw pipeline never runs compression");
		}),
		download: (blob, filename) => {
			log.push(`download:${filename}`);
			downloads.push({ blob, filename });
		},
		now: () => overrides.now ?? NOW,
		createWriter: overrides.writer ?? ((): ZipStreamWriter => new ZipStreamWriter()),
		...(overrides.compressionBlocked ? { compressionBlocked: overrides.compressionBlocked } : {}),
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

// Stands in for the real writer's capacity guard (zipWrite.test.ts pins the limits themselves) so the batch's abort-on-add-throw path is reachable without 4 GiB of real bytes.
class ExplodingAddWriter extends ZipStreamWriter {
	override async add(_entry: ZipEntryInput): Promise<void> {
		throw new Error("A file in the zip is too large.");
	}
}

const MP4_PLAN: CompressionPlan = { container: "mp4", videoCodec: "avc", audioCodec: "aac", extension: "mp4", mime: "video/mp4" };

function fakeResult(id: string): CompressionResult {
	return { blob: new Blob([`compressed-${id}`]), codecUsed: "avc", filename: `${id}-ignored.mp4`, label: "MP4" };
}

function immediateRun(result: CompressionResult): CompressionRun {
	return { done: Promise.resolve(result), onProgress: () => {}, cancel: () => {} };
}

// A controllable run: the test drives progress, resolution, rejection, and cancel behavior.
function gatedRun(): CompressionRun & { emit(pct: number): void; release(result: CompressionResult): void; reject(err: Error): void } {
	let settle!: (result: CompressionResult) => void;
	let fail!: (err: Error) => void;
	let progress: ((pct: number) => void) | null = null;
	return {
		done: new Promise<CompressionResult>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		}),
		onProgress: (cb) => {
			progress = cb;
		},
		// The manager routes user cancels through this, so it rejects exactly like a terminated worker would.
		cancel: () => {
			fail(new CompressionCanceledError());
		},
		emit: (pct) => {
			progress?.(pct);
		},
		release: (result) => {
			settle(result);
		},
		reject: (err) => {
			fail(err);
		},
	};
}

async function untilEvent(events: string[], target: string): Promise<void> {
	for (;;) {
		if (events.includes(target)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

describe("batch download manager (compressed)", () => {
	it("runs probe → run per item in display order, passes the medium quality and lightbox-identical stem, and zips results under the plan's extension", async () => {
		const a = makeItem("a", { zipName: "clip-a.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "clip-b.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const events: string[] = [];
		const runOpts: { stem: string; quality: string }[] = [];
		const runs = new Map<string, CompressionRun>([["clip-b", immediateRun(fakeResult("b"))], ["clip-a", immediateRun(fakeResult("a"))]]);
		const ports = fakePorts(store, {
			log: events,
			probe: async (blob) => {
				events.push(`probe:${(await blob.text()).replace("video-", "")}`);
				return { plan: MP4_PLAN, reason: null };
			},
			run: (_blob, _plan, opts) => {
				events.push(`run:${opts.stem}`);
				runOpts.push({ stem: opts.stem, quality: opts.quality });
				const run = runs.get(opts.stem);
				if (!run) throw new Error("no fake run was prepared");
				return run;
			},
		});
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("compressed");

		const s = await untilSettled(batch);
		// Strictly sequential per item, items in display order (newest-first), then exactly one download.
		expect(events).toEqual(["load:b", "probe:b", "run:clip-b", "load:a", "probe:a", "run:clip-a", `download:${NOW_NAME}`]);
		expect(runOpts).toEqual([{ stem: "clip-b", quality: "medium" }, { stem: "clip-a", quality: "medium" }]);
		expect(s.phase).toBe("done");
		expect(s.done).toBe(2);
		expect(s.skipped).toBe(0);
		expect(ports.downloads).toHaveLength(1);
		const zip = ports.downloads[0]?.blob ?? new Blob();
		expect(zip.type).toBe("application/zip");
		const entries = readZipEntries(new Uint8Array(await zip.arrayBuffer()));
		expect(entries.map((e) => e.name)).toEqual(["clip-b.mp4", "clip-a.mp4"]);
		// The compressed result blob (not the source video) lands in the zip; the worker's filename is ignored.
		expect(new TextDecoder().decode(entries[0]?.data ?? new Uint8Array())).toBe("compressed-b");
		expect(new TextDecoder().decode(entries[1]?.data ?? new Uint8Array())).toBe("compressed-a");
	});

	it("isolates probe throws, unsupported probes, and failed converts, then completes", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const c = makeItem("c", { zipName: "three.zip", createdAt: 3000 });
		const d = makeItem("d", { zipName: "four.zip", createdAt: 4000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		store.addHistory(c, mediaFor("c"));
		store.addHistory(d, mediaFor("d"));
		const events: string[] = [];
		// The rejected run is constructed lazily inside the factory so the rejection is always awaited by the manager, never unhandled.
		const runs = new Map<string, () => CompressionRun>([["two", () => ({ done: Promise.reject(new Error("convert exploded")), onProgress: () => {}, cancel: () => {} })], ["one", () => immediateRun(fakeResult("a"))]]);
		const ports = fakePorts(store, {
			log: events,
			probe: async (blob) => {
				const id = (await blob.text()).replace("video-", "");
				events.push(`probe:${id}`);
				if (id === "d") throw new Error("probe exploded");
				if (id === "c") return { plan: null, reason: "no-encodable-codec" };
				return { plan: MP4_PLAN, reason: null };
			},
			run: (_blob, _plan, opts) => {
				events.push(`run:${opts.stem}`);
				const factory = runs.get(opts.stem);
				if (!factory) throw new Error("no fake run was prepared");
				return factory();
			},
		});
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id, c.id, d.id);
		batch.start("compressed");

		const s = await untilSettled(batch);
		expect(s.phase).toBe("done");
		expect(s.done).toBe(1);
		expect(s.skipped).toBe(3);
		expect(s.failures).toEqual([
			{ title: "four", reason: "compression probe failed" },
			{ title: "three", reason: "no-encodable-codec" },
			{ title: "two", reason: "convert exploded" },
		]);
		expect(ports.downloads).toHaveLength(1);
		const zip = ports.downloads[0]?.blob ?? new Blob();
		const entries = readZipEntries(new Uint8Array(await zip.arrayBuffer()));
		expect(entries.map((e) => e.name)).toEqual(["one.mp4"]);
	});

	it("cancel during a convert aborts to canceled without downloading or loading later ids", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const events: string[] = [];
		const runB = gatedRun();
		const ports = fakePorts(store, {
			log: events,
			probe: async () => ({ plan: MP4_PLAN, reason: null }),
			run: () => {
				events.push("run:clip-b");
				return runB;
			},
		});
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("compressed");
		await untilEvent(events, "run:clip-b");
		// The manager routes the cancel through currentRun.cancel(), whose rejection carries the cancel flag.
		batch.cancel();

		const s = await untilSettled(batch);
		expect(s.phase).toBe("canceled");
		expect(ports.downloads).toHaveLength(0);
		expect(events).not.toContain("load:a");
	});

	it("cancel during a probe aborts to canceled without running any convert", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const events: string[] = [];
		let releaseProbe!: () => void;
		const probeGate = new Promise<{ plan: CompressionPlan | null; reason: UnsupportedReason | null }>((resolve) => {
			releaseProbe = () => resolve({ plan: MP4_PLAN, reason: null });
		});
		const ports = fakePorts(store, {
			log: events,
			probe: () => {
				events.push("probe:b");
				return probeGate;
			},
			run: (_blob, _plan, opts) => {
				events.push(`run:${opts.stem}`);
				return immediateRun(fakeResult("b"));
			},
		});
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("compressed");
		await untilEvent(events, "probe:b");
		batch.cancel();
		releaseProbe();

		const s = await untilSettled(batch);
		expect(s.phase).toBe("canceled");
		expect(ports.downloads).toHaveLength(0);
		expect(events).not.toContain("run:clip-b");
	});

	it("a fresh start after dismiss runs from clean state with no stale totals or failures", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const c = makeItem("c", { zipName: "three.zip", createdAt: 3000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		store.addHistory(c, mediaFor("c"));
		const events: string[] = [];
		const ports = fakePorts(store, {
			log: events,
			probe: async (blob) => {
				events.push(`probe:${(await blob.text()).replace("video-", "")}`);
				return { plan: MP4_PLAN, reason: null };
			},
			run: (_blob, _plan, opts) => {
				events.push(`run:${opts.stem}`);
				return immediateRun(fakeResult("c"));
			},
		});
		const batch = createBatchDownload(store, null, null, ports);
		// First run: a raw batch over a and b, settled done, then dismissed.
		selectIds(batch, a.id, b.id);
		batch.start("raw");
		const first = await untilSettled(batch);
		expect(first.phase).toBe("done");
		expect(first.done).toBe(2);
		batch.dismiss();

		// Second run: a compressed batch over ONLY c; every snapshot field and the port log must show clean state.
		selectIds(batch, c.id);
		batch.start("compressed");
		const second = await untilSettled(batch);
		expect(second.phase).toBe("done");
		expect(second.variant).toBe("compressed");
		expect(second.total).toBe(1);
		expect(second.done).toBe(1);
		expect(second.skipped).toBe(0);
		expect(second.failures).toEqual([]);
		expect(second.zipName).toBe(NOW_NAME);
		expect(events).toEqual(["load:b", "load:a", `download:${NOW_NAME}`, "load:c", "probe:c", "run:three", `download:${NOW_NAME}`]);
		expect(ports.downloads).toHaveLength(2);
	});

	it("a watchdog-style CompressionCanceledError without a requested cancel skips the item and completes", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const events: string[] = [];
		// The rejected run is constructed lazily inside the factory so the rejection is always awaited by the manager, never unhandled.
		const runs = new Map<string, () => CompressionRun>([["two", () => ({ done: Promise.reject(new CompressionCanceledError()), onProgress: () => {}, cancel: () => {} })], ["one", () => immediateRun(fakeResult("a"))]]);
		const ports = fakePorts(store, {
			log: events,
			probe: async () => ({ plan: MP4_PLAN, reason: null }),
			run: (_blob, _plan, opts) => {
				const factory = runs.get(opts.stem);
				if (!factory) throw new Error("no fake run was prepared");
				return factory();
			},
		});
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("compressed");

		const s = await untilSettled(batch);
		expect(s.phase).toBe("done");
		expect(s.done).toBe(1);
		expect(s.skipped).toBe(1);
		expect(s.failures).toEqual([{ title: "two", reason: "compression stalled" }]);
		expect(ports.downloads).toHaveLength(1);
	});

	it("an add-time capacity throw aborts the batch to failed without downloading", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const ports = fakePorts(store, {
			probe: async () => ({ plan: MP4_PLAN, reason: null }),
			run: () => immediateRun(fakeResult("b")),
			writer: () => new ExplodingAddWriter(),
		});
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("compressed");

		const s = await untilSettled(batch);
		expect(s.phase).toBe("failed");
		expect(s.failures).toEqual([{ title: "two", reason: "A file in the zip is too large." }]);
		expect(ports.downloads).toHaveLength(0);
	});

	it("blends the in-flight item's percent into the snapshot while compressed-running", async () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const b = makeItem("b", { zipName: "two.zip", createdAt: 2000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		store.addHistory(b, mediaFor("b"));
		const events: string[] = [];
		const runB = gatedRun();
		const runA = gatedRun();
		const runs = new Map<string, CompressionRun>([["two", runB], ["one", runA]]);
		const ports = fakePorts(store, {
			log: events,
			probe: async () => ({ plan: MP4_PLAN, reason: null }),
			run: (_blob, _plan, opts) => {
				events.push(`run:${opts.stem}`);
				const run = runs.get(opts.stem);
				if (!run) throw new Error("no fake run was prepared");
				return run;
			},
		});
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id, b.id);
		batch.start("compressed");

		// While item b converts with 50% reported and nothing zipped yet, the blended bar sits at (0 + 0.5) / 2.
		await untilEvent(events, "run:two");
		runB.emit(0.5);
		const early = batch.snapshot();
		expect(early.currentPct).toBe(0.5);
		expect(early.done).toBe(0);
		expect((early.done + (early.currentPct ?? 0)) / early.total).toBe(0.25);
		runB.release(fakeResult("b"));

		// Once a is the in-flight item, the blend becomes (1 + 0.25) / 2.
		await untilEvent(events, "run:one");
		runA.emit(0.25);
		const mid = batch.snapshot();
		expect(mid.done).toBe(1);
		expect(mid.currentPct).toBe(0.25);
		expect((mid.done + (mid.currentPct ?? 0)) / mid.total).toBe(0.625);
		runA.release(fakeResult("a"));

		const s = await untilSettled(batch);
		expect(s.phase).toBe("done");
		expect(s.done).toBe(2);
		expect(s.currentPct).toBeNull();
		expect(ports.downloads).toHaveLength(1);
	});

	it("refuses a compressed start while a lightbox compression owns the worker", () => {
		const a = makeItem("a", { zipName: "one.zip", createdAt: 1000 });
		const store = createStore();
		store.addHistory(a, mediaFor("a"));
		const ports = fakePorts(store, { compressionBlocked: () => "A compression is already running in the viewer." });
		const batch = createBatchDownload(store, null, null, ports);
		selectIds(batch, a.id);
		batch.start("compressed");

		const s = batch.snapshot();
		expect(s.phase).toBe("failed");
		expect(s.failures).toEqual([{ title: "Batch download", reason: "A compression is already running in the viewer." }]);
		expect(ports.log).toEqual([]);
		expect(ports.downloads).toHaveLength(0);
	});
});
