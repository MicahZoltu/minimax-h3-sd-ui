import { describe, it, expect } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { analyzeZip, classifyName, classifyNames, buildSourceZip, crc32, MAX_FILE_BYTES } from "../app/ts/zip.js";
import { bytesToDataUrl } from "../app/ts/utils.js";

// 1x1 red PNG bytes.
const PNG_BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
	0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
	0x00, 0x00, 0x03, 0x00, 0x01, 0xfd, 0x21, 0x08, 0x93, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
]);

// The test runner has no DOM; polyfill Image so analyzeZip's decode check passes.
// naturalWidth/naturalHeight are read at construction so tests can fabricate a declared pixel grid.
const imgDims: { width: number; height: number } = { width: 1, height: 1 };
Object.assign(globalThis, {
	Image: class {
		onload: (() => void) | null = null;
		naturalWidth = imgDims.width;
		naturalHeight = imgDims.height;
		set src(v: string) {
			// Mirror a browser's empty-src abort: only a non-empty source triggers a load.
			if (!v) return;
			queueMicrotask(() => this.onload?.());
		}
		removeAttribute(_name: string): void {}
	},
});

function setImageDims(width: number, height: number): void {
	imgDims.width = width;
	imgDims.height = height;
}

describe("classifyName", () => {
	it("recognizes prompt.txt by suffix, case-insensitively", () => {
		expect(classifyName("prompt.txt").kind).toBe("prompt");
		expect(classifyName("PROMPT.TXT").kind).toBe("prompt");
		expect(classifyName("foo_prompt.txt").kind).toBe("prompt");
		expect(classifyName("SomePrompt.TXT").kind).toBe("prompt");
		expect(classifyName("prompt.rar").kind).toBe("other");
	});
	it("recognizes start/end by suffix from the end of the name", () => {
		expect(classifyName("start.png").kind).toBe("start");
		expect(classifyName("start").kind).toBe("start");
		expect(classifyName("END.jpg").kind).toBe("end");
		expect(classifyName("foo_start.png").kind).toBe("start");
		expect(classifyName("key.end.gif").kind).toBe("end");
	});
	it("recognizes numbered files", () => {
		expect({ kind: classifyName("frame1.png").kind, frame: classifyName("frame1.png").frame }).toEqual({ kind: "frame", frame: 1 });
		expect({ kind: classifyName("001.jpg").kind, frame: classifyName("001.jpg").frame }).toEqual({ kind: "frame", frame: 1 });
		expect({ kind: classifyName("a12.jpeg").kind, frame: classifyName("a12.jpeg").frame }).toEqual({ kind: "frame", frame: 12 });
	});
	it("rejects non-conforming names", () => {
		expect(classifyName("notes.txt").kind).toBe("other");
		expect(classifyName("frame1x.png").kind).toBe("other");
		expect(classifyName("start1.png").kind).toBe("frame");
	});
});

describe("classifyNames validation", () => {
	it("accepts a prompt-only zip", () => {
		const r = classifyNames(["prompt.txt"]);
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("prompt");
		expect(r.orderedNames).toEqual([]);
	});
	it("accepts start+end", () => {
		const r = classifyNames(["prompt.txt", "start.png", "end.jpg"]);
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("start-end");
		expect(r.orderedNames).toEqual(["start.png", "end.jpg"]);
	});
	it("accepts only a start or only an end", () => {
		expect(classifyNames(["prompt.txt", "start.webp"]).mode).toBe("start-end");
		expect(classifyNames(["prompt.txt", "end.png"]).mode).toBe("start-end");
	});
	it("accepts a suffix-named set end-to-end", () => {
		const r = classifyNames(["prefix_prompt.txt", "a_start.png"]);
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("start-end");
		expect(r.orderedNames).toEqual(["a_start.png"]);
	});
	it("accepts sequential numbered frames from 1", () => {
		const r = classifyNames(["prompt.txt", "f1.png", "f2.png", "f3.png"]);
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("refs");
		expect(r.orderedNames).toEqual(["f1.png", "f2.png", "f3.png"]);
	});
	it("accepts a single frame", () => {
		expect(classifyNames(["prompt.txt", "f1.png"]).mode).toBe("refs");
	});
	it("rejects gaps in numbering", () => {
		const r = classifyNames(["prompt.txt", "f1.png", "f3.png"]);
		expect(r.ok).toBe(false);
	});
	it("rejects numbering not starting at 1", () => {
		expect(classifyNames(["prompt.txt", "f2.png", "f3.png"]).ok).toBe(false);
	});
	it("rejects numbers beyond 9", () => {
		expect(classifyNames(["prompt.txt", "f1.png", "f10.png"]).ok).toBe(false);
	});
	it("rejects mixing start/end with numbered frames", () => {
		const r = classifyNames(["prompt.txt", "start.png", "f1.png"]);
		expect(r.ok).toBe(false);
		expect(r.errors.join(" ")).toMatch(/mixes/i);
	});
	it("rejects extraneous files", () => {
		const r = classifyNames(["prompt.txt", "readme.txt"]);
		expect(r.ok).toBe(false);
		expect(r.errors.join(" ")).toMatch(/unexpected/i);
	});
	it("rejects a missing prompt", () => {
		expect(classifyNames(["f1.png"]).ok).toBe(false);
	});
	it("rejects nested files in subfolders", () => {
		const r = classifyNames(["prompt.txt", "folder/f1.png"]);
		expect(r.ok).toBe(false);
		expect(r.errors.join(" ")).toMatch(/subfolders/i);
	});
	it("rejects duplicate frame numbers", () => {
		const r = classifyNames(["prompt.txt", "f1.png", "01.jpg"]);
		expect(r.ok).toBe(false);
	});
});

describe("analyzeZip end to end", () => {
	function buildStoredZip(files: Record<string, Uint8Array | string>): Blob {
		const source = Object.entries(files)
			.filter(([name]) => name !== "prompt.txt")
			.map(([name, content]) => ({
				name,
				bytes: typeof content === "string" ? encoder(content) : content,
			}));
		const promptEntry = files["prompt.txt"];
		const prompt = typeof promptEntry === "string" ? promptEntry : "";
		return buildSourceZip(source, prompt);
	}

	interface RawEntry {
		name: string;
		data: Uint8Array;
		method: number;
		declaredUncompressedSize?: number;
	}

	// Assemble a real, well-formed zip while letting tests override the stored (local) method and the central-directory declared sizes so the parser's edge-case handling can be exercised.
	// Method 8 entries are genuinely deflated so the native inflate path is tested.
	function assembleZip(entries: RawEntry[]): Blob {
		const encoder = new TextEncoder();
		const locals: Uint8Array[] = [];
		const centrals: Uint8Array[] = [];
		let offset = 0;
		const perEntry: { crc: number; csize: number; usize: number; nameBytes: Uint8Array; localOffset: number }[] = [];

		for (const e of entries) {
			const nameBytes = encoder.encode(e.name);
			const data = e.method === 8 ? deflateRawSync(e.data) : e.data;
			const crc = crc32(e.data);
			const usize = e.declaredUncompressedSize ?? e.data.length;

			const lh = new ArrayBuffer(30);
			const lv = new DataView(lh);
			lv.setUint32(0, 0x04034b50, true);
			lv.setUint16(4, 20, true);
			lv.setUint16(6, 0, true);
			lv.setUint16(8, e.method, true);
			lv.setUint16(10, 0, true);
			lv.setUint16(12, 0, true);
			lv.setUint32(14, crc, true);
			lv.setUint32(18, data.length, true);
			lv.setUint32(22, usize, true);
			lv.setUint16(26, nameBytes.length, true);
			lv.setUint16(28, 0, true);
			locals.push(new Uint8Array(lh), nameBytes, data);

			perEntry.push({
				crc,
				csize: data.length,
				usize,
				nameBytes,
				localOffset: offset,
			});
			offset += 30 + nameBytes.length + data.length;

			const ch = new ArrayBuffer(46);
			const cv = new DataView(ch);
			cv.setUint32(0, 0x02014b50, true);
			cv.setUint16(4, 20, true);
			cv.setUint16(6, 20, true);
			cv.setUint16(8, 0, true);
			cv.setUint16(10, e.method, true);
			cv.setUint16(12, 0, true);
			cv.setUint16(14, 0, true);
			cv.setUint32(16, crc, true);
			cv.setUint32(20, data.length, true);
			cv.setUint32(24, usize, true);
			cv.setUint16(28, nameBytes.length, true);
			cv.setUint16(30, 0, true);
			cv.setUint16(32, 0, true);
			cv.setUint16(34, 0, true);
			cv.setUint16(36, 0, true);
			cv.setUint32(38, 0, true);
			const currentRecord = perEntry[perEntry.length - 1];
			cv.setUint32(42, currentRecord ? currentRecord.localOffset : 0, true);
			centrals.push(new Uint8Array(ch), nameBytes);
		}

		const cdOffset = offset;
		const cdSize = centrals.reduce((a, b) => a + b.length, 0);
		const eocdBytes = new ArrayBuffer(22);
		const ev = new DataView(eocdBytes);
		ev.setUint32(0, 0x06054b50, true);
		ev.setUint16(4, 0, true);
		ev.setUint16(6, 0, true);
		ev.setUint16(8, entries.length, true);
		ev.setUint16(10, entries.length, true);
		ev.setUint32(12, cdSize, true);
		ev.setUint32(16, cdOffset, true);
		ev.setUint16(20, 0, true);

		const parts = [...locals, ...centrals, new Uint8Array(eocdBytes)];
		const total = parts.reduce((a, b) => a + b.length, 0);
		const out = new Uint8Array(total);
		let p = 0;
		for (const part of parts) {
			out.set(part, p);
			p += part.length;
		}
		return new Blob([out.buffer], { type: "application/zip" });
	}

	function encoder(s: string): Uint8Array {
		return new TextEncoder().encode(s);
	}

	it("parses a prompt-only zip", async () => {
		const blob = buildStoredZip({ "prompt.txt": "a sunset" });
		const a = await analyzeZip(blob, "input.zip");
		expect(a.prompt).toBe("a sunset");
		expect(a.mode).toBe("prompt");
		expect(a.files).toEqual([]);
	});

	it("parses numbered reference frames in order", async () => {
		const d1 = bytesToDataUrl(PNG_BYTES, "image/png");
		const blob = buildStoredZip({
			"prompt.txt": "a cat",
			"f1.png": PNG_BYTES,
			"f2.png": PNG_BYTES,
		});
		const a = await analyzeZip(blob, "input.zip");
		expect(a.mode).toBe("refs");
		expect(a.files.map((f) => f.name)).toEqual(["f1.png", "f2.png"]);
		expect(a.files[0]?.dataUrl).toBe(d1);
	});

	it("rejects extraneous files", async () => {
		const blob = buildStoredZip({ "prompt.txt": "x", "readme.txt": "hi" });
		await expect(analyzeZip(blob, "input.zip")).rejects.toThrow(/unexpected/i);
	});

	it("rejects non-zip payloads", async () => {
		const blob = new Blob(["not a zip"], { type: "application/zip" });
		await expect(analyzeZip(blob, "input.zip")).rejects.toThrow(/zip archive/i);
	});

	it("rejects a bad extension", async () => {
		const blob = new Blob(["x"]);
		await expect(analyzeZip(blob, "input.tar")).rejects.toThrow(/\.zip/);
	});

	it("parses a real deflated zip with stored and deflate entries", async () => {
		const blob = assembleZip([
			{ name: "prompt.txt", data: encoder("a dog"), method: 0 },
			{ name: "start.png", data: PNG_BYTES, method: 8 },
			{ name: "end.png", data: PNG_BYTES, method: 8 },
		]);
		const a = await analyzeZip(blob, "input.zip");
		expect(a.mode).toBe("start-end");
		expect(a.prompt).toBe("a dog");
		expect(a.files.map((f) => f.name)).toEqual(["start.png", "end.png"]);
		expect(a.files[0]?.dataUrl).toBe(bytesToDataUrl(PNG_BYTES, "image/png"));
		expect(a.files[1]?.dataUrl).toBe(bytesToDataUrl(PNG_BYTES, "image/png"));
	});

	it("throws a friendly error on a truncated/corrupt zip", async () => {
		const whole = assembleZip([
			{ name: "prompt.txt", data: encoder("x"), method: 0 },
			{ name: "start.png", data: PNG_BYTES, method: 0 },
		]);
		const truncated = whole.slice(0, 20);
		const empty = new Blob([], { type: "application/zip" });
		await expect(analyzeZip(truncated, "input.zip")).rejects.toThrow(/zip archive/i);
		await expect(analyzeZip(empty, "input.zip")).rejects.toThrow(/zip archive/i);
	});

	it("rejects an unsupported compression method with a friendly error", async () => {
		const blob = assembleZip([
			{ name: "prompt.txt", data: encoder("x"), method: 0 },
			{ name: "start.png", data: PNG_BYTES, method: 12 },
		]);
		await expect(analyzeZip(blob, "input.zip")).rejects.toThrow(/method/i);
	});

	it("rejects an entry whose declared uncompressed size exceeds the cap before inflating", async () => {
		const blob = assembleZip([
			{ name: "prompt.txt", data: encoder("x"), method: 0 },
			{ name: "start.png", data: PNG_BYTES, method: 8, declaredUncompressedSize: MAX_FILE_BYTES + 1 },
		]);
		await expect(analyzeZip(blob, "input.zip")).rejects.toThrow(/size limit/i);
	});

	it("round-trips a stored source zip: buildSourceZip -> analyzeZip", async () => {
		const source = [
			{ name: "start.png", bytes: PNG_BYTES },
			{ name: "end.png", bytes: PNG_BYTES },
		];
		const prompt = "a round-trip prompt";
		const blob = buildSourceZip(source, prompt);
		const a = await analyzeZip(blob, "input.zip");
		expect(a.mode).toBe("start-end");
		expect(a.prompt).toBe(prompt);
		expect(a.files.map((f) => f.name)).toEqual(["start.png", "end.png"]);
		expect(a.files[0]?.dataUrl).toBe(bytesToDataUrl(PNG_BYTES, "image/png"));
	});

	it("round-trips a source zip with suffix-named start/end files", async () => {
		const source = [
			{ name: "foo_start.png", bytes: PNG_BYTES },
			{ name: "bar_end.png", bytes: PNG_BYTES },
		];
		const prompt = "a suffix prompt";
		const blob = buildSourceZip(source, prompt);
		const a = await analyzeZip(blob, "input.zip");
		expect(a.mode).toBe("start-end");
		expect(a.files.map((f) => f.name)).toEqual(["foo_start.png", "bar_end.png"]);
		expect(a.files[0]?.dataUrl).toBe(bytesToDataUrl(PNG_BYTES, "image/png"));
	});

	// Regression: the native inflate path must NOT deadlock on backpressure when an entry inflates to more than the stream's high-water mark.
	// The old write-then-close-then-read implementation hung forever here.
	it("inflates a large deflated entry without deadlocking", async () => {
		const big = new Uint8Array(700 * 1024).map((_, i) => i % 251); // large, deterministic
		const blob = assembleZip([
			{ name: "prompt.txt", data: encoder("large deflate"), method: 0 },
			{ name: "f1.png", data: big, method: 8 },
		]);
		const a = await analyzeZip(blob, "input.zip");
		expect(a.mode).toBe("refs");
		expect(a.prompt).toBe("large deflate");
		expect(a.files.length).toBe(1);
	});

	it("accepts a frame whose decoded pixel grid is within the budget", async () => {
		setImageDims(4096, 4096);
		const blob = assembleZip([
			{ name: "prompt.txt", data: encoder("grid"), method: 0 },
			{ name: "start.png", data: PNG_BYTES, method: 0 },
		]);
		const a = await analyzeZip(blob, "input.zip");
		expect(a.mode).toBe("start-end");
	});

	it("rejects a frame whose declared pixel grid exceeds the image pixel cap", async () => {
		setImageDims(1_000_000, 1_000_000);
		const blob = assembleZip([
			{ name: "prompt.txt", data: encoder("huge grid"), method: 0 },
			{ name: "start.png", data: PNG_BYTES, method: 0 },
		]);
		await expect(analyzeZip(blob, "input.zip")).rejects.toThrow(/not a valid image/i);
		setImageDims(1, 1);
	});
});
