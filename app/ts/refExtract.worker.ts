// Web Worker entry for referencing media extraction.
// Receives protocol messages from the main thread and derives the frame list / fps / soundtrack a video reference ingestion needs.
// Mirrors the message shapes defined locally in refExtract.ts (they are not exported there).
// Exports nothing; wiring self.onmessage on load is the whole point.

import { ALL_FORMATS } from "../vendor/mediabunny/src/input-format.js";
import { Conversion } from "../vendor/mediabunny/src/conversion.js";
import { type FrameRateMetrics, type InputVideoTrack } from "../vendor/mediabunny/src/input-track.js";
import { Input } from "../vendor/mediabunny/src/input.js";
import { CanvasSink, type WrappedCanvas } from "../vendor/mediabunny/src/media-sink.js";
import { WavOutputFormat } from "../vendor/mediabunny/src/output-format.js";
import { Output } from "../vendor/mediabunny/src/output.js";
import { BlobSource } from "../vendor/mediabunny/src/source.js";
import { BufferTarget } from "../vendor/mediabunny/src/target.js";

// The worker half of the protocol. Types are local to refExtract.ts, so they are mirrored verbatim here.
type RefWorkerRequest =
	| { type: "video"; id: number; blob: Blob; maxFrames: number; maxWidth: number; quality: number }
	| { type: "audio"; id: number; blob: Blob };

type RefWorkerReply =
	| { type: "video-result"; id: number; fps: number; frames: string[]; audio: string | null }
	| { type: "audio-result"; id: number; dataUrl: string }
	| { type: "error"; id: number; message: string };

type VideoRequest = Extract<RefWorkerRequest, { type: "video" }>;
type AudioRequest = Extract<RefWorkerRequest, { type: "audio" }>;

// The browser global for a dedicated module worker exposes the message surface we need.
// The default DOM lib types `self` as `Window`, so this narrows it to the tiny worker interface we use.
interface WorkerScope {
	onmessage: ((event: MessageEvent<RefWorkerRequest>) => void) | null;
	postMessage(message: RefWorkerReply): void;
}

const scope = self as unknown as WorkerScope;

function isRiffWav(buffer: ArrayBuffer): boolean {
	const view = new DataView(buffer);
	if (view.byteLength < 12) return false;
	return view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645;
}

function bufferToDataUrl(buffer: ArrayBuffer, mime: string): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	const chunks: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
	}
	return `data:${mime};base64,${btoa(chunks.join(""))}`;
}

function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function pickFrameRate(metrics: FrameRateMetrics): number {
	const candidates = [metrics.bestGuessFrameRate, metrics.averageFrameRate, metrics.medianFrameRate];
	for (const rate of candidates) {
		if (isPositiveFinite(rate)) return rate;
	}
	return 30;
}

function downscaled(trackWidth: number, trackHeight: number, maxWidth: number): { width: number; height: number } {
	const width = Math.max(1, Math.floor(maxWidth));
	if (trackWidth <= 0 || trackHeight <= 0) return { width, height: Math.max(1, Math.floor(maxWidth)) };
	const scale = Math.min(1, width / trackWidth);
	return { width: Math.max(1, Math.round(trackWidth * scale)), height: Math.max(1, Math.round(trackHeight * scale)) };
}

async function renderToJpeg(wrapped: WrappedCanvas, maxWidth: number, quality: number): Promise<string | null> {
	const source = wrapped.canvas;
	const dims = downscaled(source.width, source.height, maxWidth);
	const canvas = new OffscreenCanvas(dims.width, dims.height);
	const context = canvas.getContext("2d");
	if (!context) return null;
	context.drawImage(source, 0, 0, dims.width, dims.height);
	const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
	return bufferToDataUrl(await blob.arrayBuffer(), "image/jpeg");
}

// Renders the video's frames as downscaled JPEG data URLs in playback order.
// When the native frame count exceeds the target, frames are sampled evenly by taking every step-th frame in order.
async function extractFrames(videoTrack: InputVideoTrack, target: number, maxWidth: number, quality: number, nativeCount: number, start: number, end: number): Promise<string[]> {
	const step = nativeCount > 0 ? Math.max(1, Math.ceil(nativeCount / target)) : 1;
	const sink = new CanvasSink(videoTrack);
	const frames: string[] = [];
	let index = 0;
	for await (const wrapped of sink.canvases(start, end)) {
		if (frames.length >= target) break;
		if (index++ % step !== 0) continue;
		const dataUrl = await renderToJpeg(wrapped, maxWidth, quality);
		if (dataUrl) frames.push(dataUrl);
	}
	if (frames.length === 0) throw new Error("The video produced no decodable frames.");
	return frames;
}

// Extracts the primary soundtrack of a video container as a WAV data URL, or null when it has none or cannot be decoded.
async function extractVideoAudio(blob: Blob): Promise<string | null> {
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		if (!(await input.canRead())) return null;
		const audioTrack = await input.getPrimaryAudioTrack();
		// A video with no soundtrack is handled as `audio: null`.
		// A soundtrack that IS present but cannot be decoded/transcoded must propagate as an error (reply `{ type: "error" }` via the caller), so the user is told the reference audio failed rather than the video being silently treated as silent.
		if (!audioTrack) return null;
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			audio: { codec: "pcm-s16", sampleFormat: "s16" },
			tracks: "primary",
		});
		if (!conversion.isValid) throw new Error("The video's soundtrack could not be decoded.");
		await conversion.execute();
		const buffer = output.target.buffer;
		if (!buffer) throw new Error("The video's soundtrack produced no audio.");
		return bufferToDataUrl(buffer, "audio/wav");
	} finally {
		input.dispose();
	}
}

async function handleVideo(request: VideoRequest): Promise<void> {
	const { id, blob, maxFrames, maxWidth, quality } = request;
	if (typeof globalThis.VideoDecoder !== "function") {
		scope.postMessage({ type: "error", id, message: "Video decoding requires WebCodecs VideoDecoder, which is unavailable in this browser." });
		return;
	}
	const target = Math.max(1, Math.floor(maxFrames));
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error("The video has no decodable video track.");
		const metrics = await videoTrack.computeFrameRateMetrics();
		const fps = pickFrameRate(metrics);
		const end = await videoTrack.computeDuration({ skipLiveWait: true });
		const start = Math.max(0, await videoTrack.getFirstTimestamp());
		const nativeCount = Math.round(Math.max(0, end - start) * fps);
		const frames = await extractFrames(videoTrack, target, maxWidth, quality, nativeCount, start, end);
		const audio = await extractVideoAudio(blob);
		scope.postMessage({ type: "video-result", id, fps, frames, audio });
	} finally {
		input.dispose();
	}
}

async function transcodeAudio(blob: Blob): Promise<string> {
	if (isRiffWav(await blob.slice(0, 12).arrayBuffer())) {
		return bufferToDataUrl(await blob.arrayBuffer(), "audio/wav");
	}
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		if (!(await input.canRead())) throw new Error("The audio file could not be read (unsupported or corrupt).");
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			audio: { codec: "pcm-s16", sampleFormat: "s16" },
			tracks: "primary",
		});
		if (!conversion.isValid) throw new Error("The audio track could not be decoded in this browser.");
		await conversion.execute();
		const buffer = output.target.buffer;
		if (!buffer) throw new Error("The audio track could not be decoded in this browser.");
		return bufferToDataUrl(buffer, "audio/wav");
	} finally {
		input.dispose();
	}
}

async function handleAudio(request: AudioRequest): Promise<void> {
	const { id, blob } = request;
	const dataUrl = await transcodeAudio(blob);
	scope.postMessage({ type: "audio-result", id, dataUrl });
}

scope.onmessage = (event) => {
	const request = event.data;
	void (async () => {
		try {
			if (request.type === "video") {
				await handleVideo(request);
			} else if (request.type === "audio") {
				await handleAudio(request);
			}
		} catch (err) {
			scope.postMessage({ type: "error", id: request.id, message: err instanceof Error ? err.message : String(err) });
		}
	})();
};
