// Main-thread coordinator for the thumbnail-encode worker.
// Capturing a video frame on the main thread is cheap (the frame is already decoded); the JPEG encode and the ≤320px
// downscale run off-thread so a completion never stalls on the encode.
// Falls back to an on-main-thread encode when no worker surface is available.

// Protocol messages shuttled between the coordinator and the worker.
export interface ThumbnailRequest {
	id: number;
	imageData: ImageData;
	maxWidth: number;
	quality: number;
}

export interface ThumbnailResult {
	id: number;
	blob: Blob;
}

export interface ThumbnailError {
	id: number;
	message: string;
}

export interface ParsedThumbnailRequest {
	id: number;
	frame: ImageData;
	maxWidth: number;
	quality: number;
}

const MAX_THUMB_WIDTH = 320;
const THUMB_QUALITY = 0.7;
const THUMB_TYPE = "image/jpeg";

// Decode a worker message back into an ImageData frame, pulling the encode knobs with safe defaults.
// The frame is read through plain property access: it arrives either structured-cloned (a real ImageData, exposing
// width/height/data) or transferred (a cloneable {width, height, data} record), and both shapes expose the same three fields.
// The decoded bytes are a Uint8ClampedArray whose length is already exactly width*height*4, so handing it straight
// back to the ImageData constructor (rather than re-viewing the buffer with an element-count length)
// is what keeps a real frame from throwing a RangeError.
export function resolveThumbnailRequest(data: unknown): ParsedThumbnailRequest | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	const id = record["id"];
	const imageDataValue = record["imageData"];
	if (typeof id !== "number" || typeof imageDataValue !== "object" || imageDataValue === null) return null;
	const fields = imageDataValue as Record<string, unknown>;
	const width = fields["width"];
	const height = fields["height"];
	const pixels = fields["data"];
	if (typeof width !== "number" || typeof height !== "number" || !(pixels instanceof Uint8ClampedArray)) return null;
	if (!(pixels.buffer instanceof ArrayBuffer)) return null;
	// Re-view the buffer over the pixel view's offset with the element count as the THIRD argument (not bytes),
	// so the ImageData frame is built over exactly width*height*4 bytes and never throws a RangeError.
	const view = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, width * height * 4);
	const frame = new ImageData(view, width, height);
	const maxWidth = typeof record["maxWidth"] === "number" ? record["maxWidth"] : MAX_THUMB_WIDTH;
	const quality = typeof record["quality"] === "number" ? record["quality"] : THUMB_QUALITY;
	return { id, frame, maxWidth, quality };
}

let thumbnailWorker: Worker | null = null;
let nextThumbId = 0;
let pendingThumb: { id: number; resolve: (blob: Blob) => void; reject: (err: Error) => void } | null = null;
// A worker encode that never posts a terminal reply must not hold its caller forever.
// After this long the coordinator rejects the pending encode, so encodeThumbnail falls back to the main-thread encode.
const THUMB_WATCHDOG_MS = 5000;
// Watchdog for whichever encode currently owns the pending slot.
let thumbWatchdog: ReturnType<typeof setTimeout> | null = null;

// Clears the watchdog on any settle.
// An encode that legitimately finished must never be disturbed by a stale timer.
function clearThumbWatchdog(): void {
	if (thumbWatchdog != null) {
		clearTimeout(thumbWatchdog);
		thumbWatchdog = null;
	}
}

// Rejects the stalled encode (so encodeThumbnail falls back to the main thread) and tears down the worker so the next encode starts fresh.
function terminateThumbWorker(): void {
	const pending = pendingThumb;
	pendingThumb = null;
	clearThumbWatchdog();
	if (pending) pending.reject(new Error("Thumbnail worker stalled; falling back to main-thread encode."));
	if (thumbnailWorker) {
		thumbnailWorker.terminate();
		thumbnailWorker = null;
	}
}

// Arms the watchdog for the in-flight encode.
// On expiry the stalled encode is rejected so the caller falls back to a main-thread encode.
function armThumbWatchdog(): void {
	clearThumbWatchdog();
	thumbWatchdog = setTimeout(() => terminateThumbWorker(), THUMB_WATCHDOG_MS);
}

function createThumbnailWorker(): Worker | null {
	try {
		const w = new Worker(new URL("./thumbnail.worker.js", import.meta.url), { type: "module" });
		w.onmessage = (event) => {
			const data = event.data;
			const pending = pendingThumb;
			if (typeof data !== "object" || data === null || !pending) return;
			if (!("id" in data) || data.id !== pending.id) return;
			pendingThumb = null;
			clearThumbWatchdog();
			if ("blob" in data && data.blob instanceof Blob) {
				pending.resolve(data.blob);
			} else {
				pending.reject(new Error("Thumbnail encode failed in the worker."));
			}
		};
		w.onerror = (event) => {
			const pending = pendingThumb;
			pendingThumb = null;
			clearThumbWatchdog();
			thumbnailWorker?.terminate();
			thumbnailWorker = null;
			if (pending) pending.reject(new Error(event.message || "Thumbnail worker error."));
		};
		return w;
	} catch {
		return null;
	}
}

export function encodeViaWorker(imageData: ImageData, maxWidth: number, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		// Only one encode is in flight at a time: the worker replies to the latest posted id, so a second
		// caller must never overwrite the pending slot or the first caller would never resolve. Reject the
		// concurrent call with a clear error instead of stranding anyone.
		if (pendingThumb) {
			reject(new Error("A thumbnail encode is already in flight; concurrent encodes are not supported."));
			return;
		}
		let w = thumbnailWorker;
		if (!w) {
			w = createThumbnailWorker();
			if (!w) {
				reject(new Error("No thumbnail worker available."));
				return;
			}
			thumbnailWorker = w;
		}
		const id = nextThumbId++;
		pendingThumb = { id, resolve, reject };
		try {
			// No transfer list: the worker gets a structured clone and the main thread keeps a usable copy of the
			// pixel buffer. If the worker then stalls, the watchdog rejects and encodeThumbnail falls back to the
			// main-thread encodeThumbnailBlob, which needs imageData.data intact. Transferring the buffer here would
			// detach it, so the fallback putImageData would throw and the stall->fallback behavior would be defeated.
			w.postMessage({ id, imageData, maxWidth, quality } satisfies ThumbnailRequest);
			armThumbWatchdog();
		} catch (err) {
			pendingThumb = null;
			clearThumbWatchdog();
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

export async function encodeThumbnail(imageData: ImageData, maxWidth = MAX_THUMB_WIDTH, quality = THUMB_QUALITY): Promise<Blob> {
	if (typeof Worker !== "undefined") {
		try {
			return await encodeViaWorker(imageData, maxWidth, quality);
		} catch {
			// Fall through to the main-thread encoder when the worker is unavailable or stalls.
		}
	}
	return await encodeThumbnailBlob(imageData, maxWidth, quality);
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
	if (typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(width, height);
	}
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

// Window can run without OffscreenCanvas (older browsers / minimal test envs); referencing it then would throw, so the instanceof is gated on its existence first.
function isOffscreenCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): canvas is OffscreenCanvas {
	return typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas;
}

async function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality: number): Promise<Blob> {
	if (isOffscreenCanvas(canvas)) {
		return await canvas.convertToBlob({ type, quality });
	}
	return await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error("Thumbnail encode failed."));
		}, type, quality);
	});
}

/** Encode an ImageData frame to a ≤maxWidth JPEG Blob. Runs on either thread. */
export async function encodeThumbnailBlob(imageData: ImageData, maxWidth = MAX_THUMB_WIDTH, quality = THUMB_QUALITY): Promise<Blob> {
	const srcWidth = imageData.width;
	const srcHeight = imageData.height;
	const scale = Math.min(1, maxWidth / srcWidth);
	const outWidth = Math.max(1, Math.round(srcWidth * scale));
	const outHeight = Math.max(1, Math.round(srcHeight * scale));
	const source = createCanvas(srcWidth, srcHeight);
	const sourceCtx = source.getContext("2d");
	if (!sourceCtx) throw new Error("Thumbnail canvas unavailable.");
	sourceCtx.putImageData(imageData, 0, 0);
	const output = createCanvas(outWidth, outHeight);
	const outputCtx = output.getContext("2d");
	if (!outputCtx) throw new Error("Thumbnail canvas unavailable.");
	outputCtx.drawImage(source, 0, 0, outWidth, outHeight);
	return await canvasToBlob(output, THUMB_TYPE, quality);
}
