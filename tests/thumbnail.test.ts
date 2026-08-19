import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { encodeThumbnail, encodeThumbnailBlob, encodeViaWorker, resolveThumbnailRequest } from "../app/ts/thumbnail.js";

// Bun has no ImageData/OffscreenCanvas/document (they are browser-only DOM globals), so these functions
// cannot be exercised as-is. Polyfill the smallest surface the thumbnail encode path touches, with an
// ImageData whose constructor enforces the same width*height*4 byte invariant as the DOM one: it throws a
// RangeError whenever the data view's element count is anything other than exactly width*height*4. That is
// precisely the failure the old worker hit by building the view with an element count while treating the
// third argument as bytes.

class FakeImageData {
	readonly data: Uint8ClampedArray<ArrayBuffer>;
	readonly width: number;
	readonly height: number;
	readonly colorSpace: PredefinedColorSpace = "srgb";
	constructor(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
		if (!(data instanceof Uint8ClampedArray)) throw new TypeError("data must be a Uint8ClampedArray");
		if (width !== Math.trunc(width) || height !== Math.trunc(height) || width <= 0 || height <= 0) throw new RangeError("width/height must be positive integers");
		if (data.length !== width * height * 4) throw new RangeError("The source width/height do not match the pixel array length.");
		this.data = data;
		this.width = width;
		this.height = height;
	}
}

interface FakeCtx {
	putImageData(): void;
	drawImage(): void;
}

const makeFakeCtx = (): FakeCtx => ({
	putImageData() {},
	drawImage() {},
});

// Every OffscreenCanvas created via createCanvas (source then output) is recorded so a test can read the
// output's resolved dimensions and the { type, quality } encode options that convertToBlob received.
const offscreenCreated: FakeOffscreenCanvas[] = [];

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	blobOptions: { type: string; quality: number } | null = null;
	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		offscreenCreated.push(this);
	}
	getContext(): FakeCtx {
		return makeFakeCtx();
	}
	convertToBlob(options: { type: string; quality: number }): Promise<Blob> {
		this.blobOptions = options;
		return Promise.resolve(new Blob([new Uint8Array(this.width * this.height)], { type: options.type }));
	}
}

// Every element produced by the fallback document.createElement is recorded so a test can read the output
// element's dimensions and the { type, quality } options handed to its toBlob.
const createdElements: FakeHTMLCanvasElement[] = [];

class FakeHTMLCanvasElement {
	width = 0;
	height = 0;
	blobOptions: { type?: string | undefined; quality?: number | undefined } | null = null;
	constructor() {
		createdElements.push(this);
	}
	getContext(): FakeCtx {
		return makeFakeCtx();
	}
	toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void {
		this.blobOptions = { type, quality };
		callback(new Blob([new Uint8Array(this.width * this.height)], { type: type ?? "application/octet-stream" }));
	}
}

const installGlobals = (): void => {
	(globalThis as unknown as { ImageData: typeof ImageData }).ImageData = FakeImageData as unknown as typeof ImageData;
	(globalThis as unknown as { OffscreenCanvas: typeof OffscreenCanvas }).OffscreenCanvas = FakeOffscreenCanvas as unknown as typeof OffscreenCanvas;
};

const messageFor = (): unknown => {
	const width = 640;
	const height = 384;
	const pixels = new Uint8ClampedArray(width * height * 4);
	return {
		id: 7,
		imageData: { width, height, data: pixels },
		maxWidth: 320,
		quality: 0.7,
	};
};

describe("thumbnail worker decode+encode path", () => {
	installGlobals();

	it("resolveThumbnailRequest rebuilds a frame over the transferred pixels without a RangeError", () => {
		const parsed = resolveThumbnailRequest(messageFor());
		expect(parsed).not.toBeNull();
		expect(parsed?.id).toBe(7);
		expect(parsed?.frame.width).toBe(640);
		expect(parsed?.frame.height).toBe(384);
		expect(parsed?.frame.data.length).toBe(640 * 384 * 4);
		expect(parsed?.maxWidth).toBe(320);
		expect(parsed?.quality).toBe(0.7);
	});

	it("resolveThumbnailRequest returns null for a malformed message instead of throwing", () => {
		expect(resolveThumbnailRequest(null)).toBeNull();
		expect(resolveThumbnailRequest("nope")).toBeNull();
		expect(resolveThumbnailRequest({})).toBeNull();
		expect(resolveThumbnailRequest({ id: 1 })).toBeNull();
	});

	it("a view built with the element count as the third argument would throw, guarding the fix", () => {
		// This is the exact misuse the C1 fix removes: `new Uint8ClampedArray(buffer, width, height)`
		// treats the third argument as an element count, yielding a length of `height`, not width*height*4.
		const width = 4;
		const height = 3;
		const buffer = new ArrayBuffer(width * height * 4);
		const wronglySized = new Uint8ClampedArray(buffer, width, height);
		expect(() => new FakeImageData(wronglySized, width, height)).toThrow(RangeError);
	});

	it("encodeThumbnailBlob downscales the decoded frame to ≤320px JPEG at quality 0.7 (the encode actually runs)", async () => {
		offscreenCreated.length = 0;
		const parsed = resolveThumbnailRequest(messageFor());
		expect(parsed).not.toBeNull();
		if (!parsed) throw new Error("expected a parsed frame");
		const blob = await encodeThumbnailBlob(parsed.frame, parsed.maxWidth, parsed.quality);
		expect(blob.type).toBe("image/jpeg");
		expect(blob.size).toBeGreaterThan(0);
		const output = offscreenCreated[offscreenCreated.length - 1];
		if (!output) throw new Error("expected an output canvas");
		// Output dimensions resolve from the 640x384 source at maxWidth 320 and are clamped to at most 320.
		expect(output.width).toBe(320);
		expect(output.height).toBe(192);
		expect(output.width).toBeLessThanOrEqual(320);
		expect(output.height).toBeLessThanOrEqual(320);
		// The encode options reach convertToBlob truthfully (not a hardcoded placeholder).
		expect(output.blobOptions).toEqual({ type: "image/jpeg", quality: 0.7 });
	});

	it("clamps a tiny scaled output dimension to at least 1px via Math.max(1, …)", async () => {
		offscreenCreated.length = 0;
		// A wide-but-short source: scale = min(1, 1/100) = 0.01, so height 10 scales to 0.1 which rounds to 0.
		const frame = new FakeImageData(new Uint8ClampedArray(100 * 10 * 4), 100, 10);
		await encodeThumbnailBlob(frame, 1, 0.7);
		const output = offscreenCreated[offscreenCreated.length - 1];
		if (!output) throw new Error("expected an output canvas");
		expect(output.width).toBe(1);
		expect(output.height).toBe(1);
	});
});

describe("thumbnail worker concurrency guard", () => {
	installGlobals();
	let worker: ControlledWorker | null = null;
	let realWorker: unknown;

	// A controllable stand-in for the real Web Worker: it captures posted messages and lets the test
	// deliver a reply to the pending id manually, so the coordinator's concurrency path is exercised
	// without spinning up a real worker thread.
	class ControlledWorker {
		onmessage: ((event: { data: unknown }) => void) | null = null;
		onerror: unknown = null;
		readonly posted: unknown[] = [];
		constructor() {
			worker = this;
		}
		postMessage(msg: unknown): void {
			this.posted.push(msg);
		}
		terminate(): void {}
	}

	beforeEach(() => {
		worker = null;
		realWorker = (globalThis as { Worker?: unknown }).Worker;
		(globalThis as { Worker: unknown }).Worker = ControlledWorker as unknown as typeof Worker;
	});

	afterEach(() => {
		if (realWorker === undefined) {
			delete (globalThis as { Worker?: unknown }).Worker;
		} else {
			(globalThis as { Worker: unknown }).Worker = realWorker;
		}
	});

	it("rejects a second concurrent encode while the first is still in flight", async () => {
		const frame = new FakeImageData(new Uint8ClampedArray(2 * 2 * 4), 2, 2);
		const first = encodeViaWorker(frame, 2, 0.7);
		expect(worker).not.toBeNull();
		expect(worker?.posted).toHaveLength(1);

		// The concurrent call must reject instead of overwriting the pending slot.
		const second = encodeViaWorker(frame, 2, 0.7);
		await expect(second).rejects.toThrow(/already in flight/i);

		// The first call is still owned: delivering its matching worker reply resolves it, so it never hangs.
		worker?.onmessage?.({ data: { id: 0, blob: new Blob(["thumb"]) } });
		const blob = await first;
		expect(blob instanceof Blob).toBe(true);
		expect(blob.size).toBeGreaterThan(0);
	});

	it("settles within a bounded time when a worker that never replies is given the encode (stall watchdog)", async () => {
		// A worker that accepts the message but never posts a terminal reply must not hang the encoder:
		// the watchdog rejects the stalled encode so encodeThumbnail falls back to the main-thread canvas encode.
		offscreenCreated.length = 0;
		const frame = new FakeImageData(new Uint8ClampedArray(2 * 2 * 4), 2, 2);
		const started = Date.now();
		const blob = await encodeThumbnail(frame, 2, 0.7);
		const elapsed = Date.now() - started;
		expect(blob instanceof Blob).toBe(true);
		expect(blob.type).toBe("image/jpeg");
		expect(blob.size).toBeGreaterThan(0);
		// The worker never replied, so the encode had to out-wait the watchdog before the fallback ran.
		expect(elapsed).toBeGreaterThanOrEqual(4000);
		expect(elapsed).toBeLessThan(8000);
		// The fallback actually produced the blob via a fresh canvas encode.
		const output = offscreenCreated[offscreenCreated.length - 1];
		expect(output).toBeDefined();
		// The main thread kept its own copy of the pixels (no transfer): had the buffer been detached, the
		// fallback's putImageData would have thrown on a zero-length buffer and the encode would have failed.
		expect(frame.data.length).toBe(2 * 2 * 4);
	}, 12000);
});

describe("main-thread toBlob fallback", () => {
	installGlobals();
	const realDoc = (globalThis as { document?: unknown }).document;

	afterEach(() => {
		(globalThis as unknown as { OffscreenCanvas: typeof OffscreenCanvas }).OffscreenCanvas = FakeOffscreenCanvas as unknown as typeof OffscreenCanvas;
		if (realDoc === undefined) {
			delete (globalThis as { document?: unknown }).document;
		} else {
			(globalThis as { document?: unknown }).document = realDoc;
		}
	});

	it("encodes through a document canvas + toBlob when OffscreenCanvas is unavailable", async () => {
		createdElements.length = 0;
		// Make createCanvas take the document.createElement path by removing OffscreenCanvas from the global scope.
		(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = undefined;
		(globalThis as { document?: unknown }).document = { createElement: () => new FakeHTMLCanvasElement() };
		const width = 640;
		const height = 384;
		const frame = new FakeImageData(new Uint8ClampedArray(width * height * 4), width, height);
		const blob = await encodeThumbnailBlob(frame, 320, 0.7);
		expect(blob.type).toBe("image/jpeg");
		expect(blob.size).toBeGreaterThan(0);
		const output = createdElements[createdElements.length - 1];
		if (!output) throw new Error("expected an output canvas element");
		expect(output.width).toBe(320);
		expect(output.height).toBe(192);
		expect(output.width).toBeLessThanOrEqual(320);
		expect(output.height).toBeLessThanOrEqual(320);
		// The { type, quality } knobs reach the fallback toBlob truthfully too.
		expect(output.blobOptions).toEqual({ type: "image/jpeg", quality: 0.7 });
	});
});
