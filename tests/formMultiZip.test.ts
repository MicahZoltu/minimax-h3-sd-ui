import { describe, it, expect } from "bun:test";
import { createStore } from "../app/ts/state.js";
import { nextPending } from "../app/ts/queue.js";
import { dimsError, queueItemFromAnalysis, summarizeZipBatch } from "../app/ts/queueItem.js";
import { handleZipFiles, queueZipsFromFiles } from "../app/ts/form.js";
import { buildSourceZip } from "../app/ts/zip.js";
import { memoryQueueBackend } from "./support/queueBackend.js";
import type { QueueBackend } from "../app/ts/history.js";
import type { QueueItem, ZipAnalysis } from "../app/ts/types.js";

function analysis(prompt: string): ZipAnalysis {
	return { prompt, mode: "prompt", files: [], videos: [], audios: [] };
}

// A valid, prompt-only zip (stored entries) as a File, the shape the intake receives from the picker/dropzone.
function zipFile(name: string, prompt: string): File {
	return new File([buildSourceZip([], prompt)], name, { type: "application/zip" });
}

function store() {
	return createStore(memoryQueueBackend());
}

function queuedItem(id: string): QueueItem {
	return { id, status: "queued", prompt: "p", zipName: null, mode: "prompt", files: [], videos: [], audios: [], width: 512, height: 512, jobFrames: 1, steps: 1, error: null, serverId: null, startedAt: null };
}

describe("queueItemFromAnalysis", () => {
	it("builds one queued item from the analysis and the shared dims", () => {
		const item = queueItemFromAnalysis(analysis("a dog"), { width: 640, height: 384, frames: 49, steps: 20 }, "d.zip");
		expect(item.id.startsWith("q_")).toBe(true);
		expect(item.status).toBe("queued");
		expect(item.prompt).toBe("a dog");
		expect(item.zipName).toBe("d.zip");
		expect(item.mode).toBe("prompt");
		expect(item.width).toBe(640);
		expect(item.height).toBe(384);
		expect(item.jobFrames).toBe(49);
		expect(item.steps).toBe(20);
		expect(item.error).toBeNull();
		expect(item.serverId).toBeNull();
		expect(item.startedAt).toBeNull();
	});
});

describe("dimsError", () => {
	it("accepts usable dimensions", () => {
		expect(dimsError({ width: 512, height: 512, frames: 107, steps: 20 })).toBeNull();
	});
	it("keeps the add button's messages and check order", () => {
		expect(dimsError({ width: 512, height: 512, frames: 0, steps: 0 })).toBe("Frames must be at least 1.");
		expect(dimsError({ width: 512, height: 512, frames: 1, steps: 0 })).toBe("Steps must be at least 1.");
		expect(dimsError({ width: 0, height: 512, frames: 1, steps: 1 })).toBe("Width and height must be positive numbers.");
		expect(dimsError({ width: 512, height: Number.NaN, frames: 1, steps: 1 })).toBe("Width and height must be positive numbers.");
	});
});

describe("summarizeZipBatch", () => {
	const fail = (name: string, message: string) => ({ name, message });
	it("is null (so a stale form error is cleared) when every file queued", () => {
		expect(summarizeZipBatch(3, 3, [])).toBeNull();
	});
	// Fabricated messages carry their own trailing punctuation, like every real analyzeZip message does; the summary adds none.
	it("counts queued vs failed and keeps the failures in file order", () => {
		expect(summarizeZipBatch(3, 5, [fail("bad.zip", "no prompt file found."), fail("worse.zip", "not a zip payload.")])).toBe("Queued 3 of 5 files. Failed: bad.zip — no prompt file found.; worse.zip — not a zip payload.");
	});
	it("reports a zero count when every file failed", () => {
		expect(summarizeZipBatch(0, 2, [fail("a.zip", "boom."), fail("b.zip", "bang.")])).toBe("Queued 0 of 2 files. Failed: a.zip — boom.; b.zip — bang.");
	});
	it("keeps a single failure on one line", () => {
		expect(summarizeZipBatch(2, 3, [fail("only.zip", "boom.")])).toBe("Queued 2 of 3 files. Failed: only.zip — boom.");
	});
	it("repeats a shared file name across failure lines", () => {
		expect(summarizeZipBatch(0, 2, [fail("dup.zip", "boom."), fail("dup.zip", "bang.")])).toBe("Queued 0 of 2 files. Failed: dup.zip — boom.; dup.zip — bang.");
	});
});

describe("queueZipsFromFiles", () => {
	it("queues valid zips in selection order with the shared dims and isolates per-file failures", async () => {
		const s = store();
		const dims = { width: 768, height: 320, frames: 49, steps: 12 };
		const good1 = zipFile("good1.zip", "first");
		const bad = new File(["not a zip"], "bad.zip", { type: "application/zip" });
		const good2 = zipFile("good2.zip", "second");
		const { queued, failures } = await queueZipsFromFiles(s, [good1, bad, good2], dims);
		expect(queued).toBe(2);
		expect(failures.map((f) => f.name)).toEqual(["bad.zip"]);
		expect(failures[0]?.message).toMatch(/zip archive/i);
		// pushQueueMany unshifts each item in order, so the in-memory array is newest-first: the last valid file sits on top and the first picked file runs first (FIFO), matching how single adds behave.
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["good2.zip", "good1.zip"]);
		expect(s.state.queue.map((i) => i.prompt)).toEqual(["second", "first"]);
		for (const item of s.state.queue) {
			expect(item.status).toBe("queued");
			expect(item.width).toBe(768);
			expect(item.height).toBe(320);
			expect(item.jobFrames).toBe(49);
			expect(item.steps).toBe(12);
		}
		// FIFO: the first picked valid file is the next to run.
		expect(nextPending(s)?.zipName).toBe("good1.zip");
	});

	it("keeps FIFO from the surviving files when the FIRST file fails", async () => {
		const s = store();
		const bad = new File(["nope"], "bad.zip", { type: "application/zip" });
		const { queued, failures } = await queueZipsFromFiles(s, [bad, zipFile("good1.zip", "first"), zipFile("good2.zip", "second")], { width: 512, height: 512, frames: 107, steps: 20 });
		expect(queued).toBe(2);
		expect(failures.map((f) => f.name)).toEqual(["bad.zip"]);
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["good2.zip", "good1.zip"]);
		expect(nextPending(s)?.zipName).toBe("good1.zip");
	});

	it("queues a mixed batch of a zip and a plain .txt prompt file in selection order", async () => {
		const s = store();
		const dims = { width: 768, height: 320, frames: 49, steps: 12 };
		const { queued, failures } = await queueZipsFromFiles(s, [zipFile("good.zip", "one"), new File(["a sunset"], "notes.txt")], dims);
		expect(queued).toBe(2);
		expect(failures).toEqual([]);
		// pushQueueMany lands newest-first, so the .txt sits on top while the first picked file still runs first (FIFO).
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["notes.txt", "good.zip"]);
		expect(nextPending(s)?.zipName).toBe("good.zip");
		const txtItem = s.state.queue.find((i) => i.zipName === "notes.txt");
		expect(txtItem?.mode).toBe("prompt");
		expect(txtItem?.prompt).toBe("a sunset");
		expect(txtItem?.files).toEqual([]);
		expect(txtItem?.videos).toEqual([]);
		expect(txtItem?.audios).toEqual([]);
	});

	it("queues two different zips sharing one file name as independent items with distinct ids", async () => {
		const s = store();
		const { queued, failures } = await queueZipsFromFiles(s, [zipFile("same.zip", "one"), zipFile("same.zip", "two")], { width: 512, height: 512, frames: 107, steps: 20 });
		expect(queued).toBe(2);
		expect(failures).toEqual([]);
		expect(new Set(s.state.queue.map((i) => i.id)).size).toBe(2);
		expect(s.state.queue.map((i) => i.prompt)).toEqual(["two", "one"]);
		expect(nextPending(s)?.prompt).toBe("one");
	});

	it("queues nothing when every file fails, reporting each failure in order", async () => {
		const s = store();
		const notes = new File(["hello"], "notes.md");
		const corrupt = new File(["not a zip"], "corrupt.zip", { type: "application/zip" });
		const { queued, failures } = await queueZipsFromFiles(s, [notes, corrupt], { width: 512, height: 512, frames: 107, steps: 20 });
		expect(queued).toBe(0);
		expect(s.state.queue).toEqual([]);
		expect(failures.map((f) => f.name)).toEqual(["notes.md", "corrupt.zip"]);
		// A non-zip, non-txt file in a multi-selection is a per-file failure line, not an unhandled error.
		expect(failures[0]?.message).toBe("Please choose a .zip file.");
		expect(failures[1]?.message).toBe("The file could not be read as a zip archive.");
	});
});

describe("handleZipFiles", () => {
	// Neutralize the pump the batch kicks off: a non-null progressError fails items instantly without touching the network, so the batch's own form/queue writes are the only thing under test.
	const stallPump = (s: ReturnType<typeof createStore>): void => {
		s.state.progressError = "progress-unavailable-in-test";
	};

	it("keeps the single-file preview flow untouched", async () => {
		const s = store();
		await handleZipFiles(s, [zipFile("solo.zip", "a cat")]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBeNull();
		expect(s.state.form.analysis?.prompt).toBe("a cat");
		expect(s.state.form.zipName).toBe("solo.zip");
	});

	it("keeps the single-file preview flow for a lone .txt prompt file", async () => {
		const s = store();
		await handleZipFiles(s, [new File(["a cat"], "prompt.txt")]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBeNull();
		expect(s.state.form.analysis?.mode).toBe("prompt");
		expect(s.state.form.analysis?.prompt).toBe("a cat");
		expect(s.state.form.zipName).toBe("prompt.txt");
	});

	it("routes a single empty .txt through the form error (nothing queued)", async () => {
		const s = store();
		await handleZipFiles(s, [new File(["  "], "empty.txt")]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBe("prompt.txt is empty; please include a prompt.");
	});

	it("routes single-file failures through the same door (form error, nothing queued)", async () => {
		const s = store();
		await handleZipFiles(s, [new File(["hello"], "notes.md")]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBe("Please choose a .zip file.");
	});

	it("does nothing on an empty selection", async () => {
		const s = store();
		await handleZipFiles(s, []);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.analysis).toBeNull();
		expect(s.state.form.parsing).toBe(false);
	});

	it("queues a multi-selection of only .txt prompt files via the batch path, skipping the preview", async () => {
		const s = store();
		stallPump(s);
		await handleZipFiles(s, [new File(["one"], "a.txt"), new File(["two"], "b.txt"), new File(["three"], "c.txt")]);
		// The batch path skips the preview and clears the form back to the empty/ready state.
		expect(s.state.form.analysis).toBeNull();
		expect(s.state.form.zipName).toBeNull();
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBeNull();
		// pushQueueMany lands newest-first, so the array reads [c, b, a] while the first picked file still runs first (FIFO).
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["c.txt", "b.txt", "a.txt"]);
		expect(s.state.queue.map((i) => i.mode)).toEqual(["prompt", "prompt", "prompt"]);
		expect(s.state.queue.map((i) => i.prompt)).toEqual(["three", "two", "one"]);
	});

	it("queues a multi-selection, skips the preview, and clears the form back to ready", async () => {
		const s = store();
		stallPump(s);
		s.setForm({ width: 640, height: 384, frames: 49, steps: 12 });
		await handleZipFiles(s, [zipFile("first.zip", "one"), zipFile("second.zip", "two")]);
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["second.zip", "first.zip"]);
		expect(s.state.form.analysis).toBeNull();
		expect(s.state.form.zipName).toBeNull();
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBeNull();
	});

	it("queues the valid zips and summarizes the failures in the form error", async () => {
		const s = store();
		stallPump(s);
		await handleZipFiles(s, [zipFile("good.zip", "yay"), new File(["nope"], "bad.zip", { type: "application/zip" }), new File(["x"], "notes.md")]);
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["good.zip"]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.analysis).toBeNull();
		expect(s.state.form.error).toBe("Queued 1 of 3 files. Failed: bad.zip — The file could not be read as a zip archive.; notes.md — Please choose a .zip file.");
	});

	it("summarizes a batch where every zip failed", async () => {
		const s = store();
		await handleZipFiles(s, [new File(["nope"], "bad.zip", { type: "application/zip" }), new File(["nope"], "worse.zip", { type: "application/zip" })]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBe("Queued 0 of 2 files. Failed: bad.zip — The file could not be read as a zip archive.; worse.zip — The file could not be read as a zip archive.");
	});

	it("summarizes count and order when the FIRST file fails and later ones queue", async () => {
		const s = store();
		stallPump(s);
		await handleZipFiles(s, [new File(["nope"], "bad.zip", { type: "application/zip" }), zipFile("good1.zip", "first"), zipFile("good2.zip", "second")]);
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["good2.zip", "good1.zip"]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBe("Queued 2 of 3 files. Failed: bad.zip — The file could not be read as a zip archive.");
	});

	it("surfaces an empty-prompt zip's message as its failure line while other files still queue", async () => {
		const s = store();
		stallPump(s);
		await handleZipFiles(s, [zipFile("empty.zip", ""), zipFile("good.zip", "yay")]);
		expect(s.state.queue.map((i) => i.zipName)).toEqual(["good.zip"]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBe("Queued 1 of 2 files. Failed: empty.zip — prompt.txt is empty; please include a prompt.");
	});

	it("refuses the whole batch when the form's dimensions are unusable", async () => {
		const s = store();
		s.setForm({ frames: 0 });
		await handleZipFiles(s, [zipFile("a.zip", "one"), zipFile("b.zip", "two")]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.parsing).toBe(false);
		expect(s.state.form.error).toBe("Frames must be at least 1.");
	});

	it("ignores a selection while another intake is still parsing", async () => {
		const s = store();
		s.setForm({ parsing: true });
		await handleZipFiles(s, [zipFile("late.zip", "late")]);
		expect(s.state.queue).toEqual([]);
		expect(s.state.form.analysis).toBeNull();
		expect(s.state.form.parsing).toBe(true);
	});
});

describe("pushQueueMany", () => {
	it("lands input [a, b, c] newest-first as [c, b, a] with the first item running next, exactly like sequential pushQueue calls", () => {
		const sequential = store();
		const batched = store();
		const items = [queuedItem("a"), queuedItem("b"), queuedItem("c")];
		for (const item of items) sequential.pushQueue(item);
		batched.pushQueueMany(items);
		expect(batched.state.queue.map((i) => i.id)).toEqual(sequential.state.queue.map((i) => i.id));
		expect(batched.state.queue.map((i) => i.id)).toEqual(["c", "b", "a"]);
		expect(nextPending(batched)?.id).toBe("a");
	});

	it("emits the queue domain exactly once for the whole batch", () => {
		const s = store();
		let emissions = 0;
		s.subscribe(() => { emissions += 1; }, ["queue"]);
		s.pushQueueMany([queuedItem("a"), queuedItem("b"), queuedItem("c")]);
		expect(emissions).toBe(1);
	});

	it("is a no-op for an empty list (no emit, no persist, no revision bump)", () => {
		let saves = 0;
		const base = memoryQueueBackend();
		const backend: QueueBackend = { load: () => base.load(), save: (next) => { saves += 1; return base.save(next); } };
		const s = createStore(backend);
		let emissions = 0;
		s.subscribe(() => { emissions += 1; }, ["queue"]);
		const revBefore = s.revs.queue;
		s.pushQueueMany([]);
		// persistQueue reaches the backend synchronously, so a wrongly-scheduled save would already have counted.
		expect(saves).toBe(0);
		expect(emissions).toBe(0);
		expect(s.revs.queue).toBe(revBefore);
	});
});
