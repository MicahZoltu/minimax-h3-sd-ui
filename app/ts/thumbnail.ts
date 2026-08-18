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
// A transferred ImageData arrives as a cloneable plain record ({width, height, data}); the decoded
// bytes are a Uint8ClampedArray whose length is already exactly width*height*4, so handing it straight
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

function createThumbnailWorker(): Worker | null {
	try {
		const w = new Worker(new URL("./thumbnail.worker.js", import.meta.url), { type: "module" });
		w.onmessage = (event) => {
			const data = event.data;
			const pending = pendingThumb;
			if (typeof data !== "object" || data === null || !pending) return;
			if (!("id" in data) || data.id !== pending.id) return;
			pendingThumb = null;
			if ("blob" in data && data.blob instanceof Blob) {
				pending.resolve(data.blob);
			} else {
				pending.reject(new Error("Thumbnail encode failed in the worker."));
			}
		};
		w.onerror = (event) => {
			const pending = pendingThumb;
			pendingThumb = null;
			thumbnailWorker?.terminate();
			thumbnailWorker = null;
			if (pending) pending.reject(new Error(event.message || "Thumbnail worker error."));
		};
		return w;
	} catch {
		return null;
	}
}

function encodeViaWorker(imageData: ImageData, maxWidth: number, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
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
			w.postMessage({ id, imageData, maxWidth, quality } satisfies ThumbnailRequest, [imageData.data.buffer]);
		} catch (err) {
			pendingThumb = null;
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
