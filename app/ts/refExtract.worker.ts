// Web Worker entry for referencing media extraction.
// Receives protocol messages from the main thread and derives the frame list / fps / soundtrack a video reference ingestion needs.
// Frames are sampled onto the 24 fps reference grid planned by refExtract.plan.js, so the reported fps always describes the delivered frames exactly.
// Delivered frames are never trimmed to a fixed cap or upscaled: the source is delivered whole (the caller bounds it with the remaining combined budget as maxFrames), and rendering applies only the server's own reference canvas downscale from refExtract.plan.js.
// Mirrors the message shapes defined locally in refExtract.ts (they are not exported there).
// Exports nothing; wiring self.onmessage on load is the whole point.

import { ALL_FORMATS } from "../vendor/mediabunny/src/input-format.js";
import { Conversion } from "../vendor/mediabunny/src/conversion.js";
import { type InputVideoTrack } from "../vendor/mediabunny/src/input-track.js";
import { Input } from "../vendor/mediabunny/src/input.js";
import { CanvasSink, type WrappedCanvas } from "../vendor/mediabunny/src/media-sink.js";
import { WavOutputFormat } from "../vendor/mediabunny/src/output-format.js";
import { Output } from "../vendor/mediabunny/src/output.js";
import { BlobSource } from "../vendor/mediabunny/src/source.js";
import { BufferTarget } from "../vendor/mediabunny/src/target.js";
import { REF_VIDEO_FPS, planReferenceSampling, refCanvasSize, referenceFrameCount } from "./refExtract.plan.js";

// The worker half of the protocol. Types are local to refExtract.ts, so they are mirrored verbatim here.
type RefWorkerRequest =
	| { type: "video"; id: number; blob: Blob; maxFrames: number; quality: number }
	| { type: "audio"; id: number; blob: Blob };

type RefWorkerReply =
	| { type: "video-result"; id: number; fps: number; frames: string[]; audio: string | null; sourceWidth: number; sourceHeight: number; sourceFrames: number }
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

async function renderToJpeg(wrapped: WrappedCanvas, quality: number): Promise<string | null> {
	const source = wrapped.canvas;
	// The frame is drawn at the server's reference canvas size: sources at or below the canvas are drawn 1:1 at their native pixel grid, and only a larger source is downscaled (never beyond the canvas, never upscaled).
	const dims = refCanvasSize(source.width, source.height);
	const canvas = new OffscreenCanvas(dims.width, dims.height);
	const context = canvas.getContext("2d");
	if (!context) return null;
	context.drawImage(source, 0, 0, dims.width, dims.height);
	const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
	return bufferToDataUrl(await blob.arrayBuffer(), "image/jpeg");
}

// Renders one JPEG data URL per planned sample timestamp, in presentation order.
// Each grid point shows the frame displayed at that instant, so the delivered count equals the plan's length unless the decoder falls short, and every delivered frame sits on the grid the reported fps describes.
async function extractFrames(videoTrack: InputVideoTrack, timestamps: number[], quality: number): Promise<string[]> {
	const sink = new CanvasSink(videoTrack);
	const frames: string[] = [];
	for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
		// A null entry means the decoder fell short of the requested timestamp, or the timestamp precedes the first frame, so there is no frame to render there.
		if (!wrapped) continue;
		const dataUrl = await renderToJpeg(wrapped, quality);
		if (dataUrl) frames.push(dataUrl);
	}
	if (frames.length === 0) throw new Error("The video produced no decodable frames.");
	return frames;
}

// Extracts the primary soundtrack of a video container as a WAV data URL trimmed to [start, end), or null when the container has no audio track.
// The trim keeps the soundtrack within the delivered frames' span, so it can never outgrow the video prefix on the server (the server's block timeline is max(video, audio)).
async function extractVideoAudio(blob: Blob, start: number, end: number): Promise<string | null> {
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
			trim: { start, end },
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
	const { id, blob, maxFrames, quality } = request;
	if (typeof globalThis.VideoDecoder !== "function") {
		scope.postMessage({ type: "error", id, message: "Video decoding requires WebCodecs VideoDecoder, which is unavailable in this browser." });
		return;
	}
	const target = Math.max(1, Math.floor(maxFrames));
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error("The video has no decodable video track.");
		// The source's display dimensions are what the user provided; they are reported back so the main thread can enforce the documented resolution range on the SOURCE, independent of the canvas downscale applied below.
		const sourceWidth = await videoTrack.getDisplayWidth();
		const sourceHeight = await videoTrack.getDisplayHeight();
		const firstTimestamp = Math.max(0, await videoTrack.getFirstTimestamp());
		// computeDuration returns the END timestamp of the last packet, not the container's nominal duration, so `end - firstTimestamp` is the true frame span the plan resamples onto the 24 fps grid.
		const end = await videoTrack.computeDuration({ skipLiveWait: true });
		const plan = planReferenceSampling(firstTimestamp, end, target);
		const frames = await extractFrames(videoTrack, plan, quality);
		// The soundtrack is trimmed to the span the delivered frames cover, so its length can never outgrow the video prefix on the server (the server's block timeline is max(video, audio)).
		// extractFrames throws before this line when nothing decoded, so `frames.length` is >= 1 here.
		const audio = await extractVideoAudio(blob, firstTimestamp, firstTimestamp + frames.length / REF_VIDEO_FPS);
		// The uncapped whole-source frame count is reported alongside the delivery so the main thread's combined-budget check can see a budget-capped extraction for what it is (an upload that must error) instead of silently accepting the trimmed prefix.
		scope.postMessage({ type: "video-result", id, fps: REF_VIDEO_FPS, frames, audio, sourceWidth, sourceHeight, sourceFrames: referenceFrameCount(firstTimestamp, end) });
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
