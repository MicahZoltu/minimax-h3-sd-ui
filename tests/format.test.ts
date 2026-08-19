import { describe, it, expect } from "bun:test";
import type { JobProgress } from "../app/ts/api.js";
import { formatBytes, progressLabel, progressPercent, frameDurationLabel, zipStem, itemTitle, truncate, statusLabel } from "../app/ts/format.js";
import type { QueueItem } from "../app/ts/types.js";

function progress(partial: Partial<JobProgress> = {}): JobProgress {
	return { step: 5, steps: 10, time: 0.25, ...partial };
}

function item(partial: Partial<QueueItem> = {}): QueueItem {
	return {
		id: "q_1",
		status: "queued",
		prompt: "a dog",
		zipName: null,
		mode: "prompt",
		files: [],
		width: 640,
		height: 384,
		jobFrames: 49,
		steps: 20,
		error: null,
		serverId: null,
		startedAt: null,
		...partial,
	};
}

describe("formatBytes", () => {
	it("renders zero and invalid inputs as 0 B", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(-5)).toBe("0 B");
		expect(formatBytes(NaN)).toBe("0 B");
		expect(formatBytes(Infinity)).toBe("0 B");
	});

	it("renders bytes below 1024 without an abbreviation", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1)).toBe("1 B");
		expect(formatBytes(900)).toBe("900 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("picks the right unit and rounds large values", () => {
		expect(formatBytes(1024)).toBe("1 KB");
		expect(formatBytes(1024 * 1024)).toBe("1 MB");
		expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
		expect(formatBytes(5.5 * 1024 * 1024 * 1024)).toBe("5.5 GB");
	});
});

describe("progressPercent", () => {
	it("clamps step/steps to a 0-100 percentage", () => {
		expect(progressPercent(progress({ step: 5, steps: 10 }))).toBe(50);
		expect(progressPercent(progress({ step: 0, steps: 10 }))).toBe(0);
		expect(progressPercent(progress({ step: 10, steps: 10 }))).toBe(100);
	});

	it("returns 0 for a malformed or empty denominator", () => {
		expect(progressPercent(progress({ steps: 0 }))).toBe(0);
		expect(progressPercent(progress({ step: NaN, steps: 10 }))).toBe(0);
		expect(progressPercent(progress({ steps: NaN }))).toBe(0);
	});
});

describe("progressLabel", () => {
	it("reports the current step over the total", () => {
		expect(progressLabel(progress({ step: 3, steps: 10, time: 0 }))).toBe("Step 3 of 10");
	});

	it("appends a per-step speed when one is available", () => {
		expect(progressLabel(progress({ step: 3, steps: 10, time: 0.25 }))).toBe("Step 3 of 10 · 0.25 s/step");
	});

	it("omits the speed when the timing is unknown", () => {
		expect(progressLabel(progress({ step: 3, steps: 10, time: 0 }))).toBe("Step 3 of 10");
	});
});

describe("frameDurationLabel", () => {
	it("derives seconds from the fps preset", () => {
		expect(frameDurationLabel(24)).toBe("≈ 1.0 seconds");
	});
});

describe("zipStem / itemTitle", () => {
	it("strips a trailing .zip extension", () => {
		expect(zipStem("intro.zip")).toBe("intro");
		expect(zipStem("folder.zip")).toBe("folder");
		expect(zipStem(null)).toBe("");
	});

	it("falls back from the zip name to the prompt to the id", () => {
		expect(itemTitle({ prompt: "p", id: "q_1", zipName: "intro.zip" })).toBe("intro");
		expect(itemTitle({ prompt: "p", id: "q_1", zipName: null })).toBe("p");
		expect(itemTitle({ prompt: "", id: "q_1", zipName: null })).toBe("q_1");
	});
});

describe("truncate", () => {
	it("appends an ellipsis only when over the limit", () => {
		expect(truncate("short", 10)).toBe("short");
		expect(truncate("a very long title", 8)).toBe("a very l…");
	});
});

describe("statusLabel", () => {
	it("maps the queue statuses to friendly labels", () => {
		expect(statusLabel(item({ status: "queued" }))).toBe("Queued");
		expect(statusLabel(item({ status: "generating" }))).toBe("Generating");
		expect(statusLabel(item({ status: "completed" }))).toBe("Done");
		expect(statusLabel(item({ status: "failed" }))).toBe("Failed");
	});
});
