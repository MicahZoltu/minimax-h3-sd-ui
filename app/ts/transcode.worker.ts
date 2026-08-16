// Web Worker entry for in-browser video compression.
// Receives protocol messages from the main thread, transcodes the resident WebM blob through Mediabunny + WebCodecs, and posts results/progress/errors back.
// Exports nothing; wiring self.onmessage on load is the whole point.

import { ALL_FORMATS } from "../vendor/mediabunny/src/input-format.js";
import { Conversion } from "../vendor/mediabunny/src/conversion.js";
import { Quality, getEncodableAudioCodecs, getEncodableVideoCodecs } from "../vendor/mediabunny/src/encode.js";
import { Input } from "../vendor/mediabunny/src/input.js";
import { Mp4OutputFormat, WebMOutputFormat } from "../vendor/mediabunny/src/output-format.js";
import { Output } from "../vendor/mediabunny/src/output.js";
import { BlobSource } from "../vendor/mediabunny/src/source.js";
import { BufferTarget } from "../vendor/mediabunny/src/target.js";
import { candidatePlans, codecString, compressedFilename, decidePlan, planLabel, type DevCodecSupport } from "./compression.plan.js";
import type { CompressionPlan, VideoCodecVerb, WorkerRequest, WorkerResponse } from "./compression.types.js";

// The browser global for a dedicated module worker exposes the message surface we need.
// The default DOM lib types `self` as `Window`, so this narrows it to the tiny worker interface we use.
interface WorkerScope {
	onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
	postMessage(message: WorkerResponse): void;
}

const scope = self as unknown as WorkerScope;

const hasWebCodecs = (): boolean =>
	typeof globalThis.VideoEncoder === "function" && typeof globalThis.AudioEncoder === "function" && typeof globalThis.VideoDecoder === "function";

function isVideoVerb(codec: string): codec is VideoCodecVerb {
	return codec === "avc" || codec === "vp9" || codec === "vp8" || codec === "av1";
}

// Confirms the input blob can actually be read and its primary video track decoded by the browser.
// This guards against selecting a plan for a file that WebCodecs cannot fully read in practice (e.g. a misaligned VP8 stream).
// The audio track's decodability is deliberately not checked: Mediabunny decodes PCM/ALAW (e.g. `araw`) in pure JS, but its `InputTrack.canDecode()` reports those codecs unsupported via `AudioDecoder.isConfigSupported`, so gating on it would wrongly disable compression for otherwise-encodable input.
async function probeInputDecodable(blob: Blob): Promise<boolean> {
	try {
		const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
		try {
			if (!(await input.canRead())) return false;
			const video = await input.getPrimaryVideoTrack();
			const audio = await input.getPrimaryAudioTrack();
			// Require both a primary video and audio track to exist so the conversion has audio to encode.
			if (!video || !audio) return false;
			return await video.canDecode();
		} finally {
			input.dispose();
		}
	} catch {
		return false;
	}
}

async function detectDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
	try {
		const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
		try {
			const video = await input.getPrimaryVideoTrack();
			if (!video) return null;
			const width = await video.getSquarePixelWidth();
			const height = await video.getSquarePixelHeight();
			if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
			return { width, height };
		} finally {
			input.dispose();
		}
	} catch {
		return null;
	}
}

async function handleProbe(blob: Blob): Promise<void> {
	if (!hasWebCodecs()) {
		scope.postMessage({ type: "probe-result", plan: null, reason: "no-webcodecs" });
		return;
	}
	const dims = await detectDimensions(blob);
	const video = await getEncodableVideoCodecs(["avc", "vp9", "vp8", "av1"], dims ? { width: dims.width, height: dims.height } : undefined);
	const audio = await getEncodableAudioCodecs(["aac", "opus"]);
	const support: DevCodecSupport = {
		hasWebCodecs: true,
		canEncodeAac: audio.includes("aac"),
		canEncodeOpus: audio.includes("opus"),
		encodableVideo: video.filter((v): v is VideoCodecVerb => isVideoVerb(v)),
	};
	const { plan, reason } = decidePlan(support);
	if (plan && !(await probeInputDecodable(blob))) {
		scope.postMessage({ type: "probe-result", plan: null, reason: "no-encodable-codec" });
		return;
	}
	scope.postMessage({ type: "probe-result", plan, reason });
}

function boxFormat(format: CompressionPlan): Mp4OutputFormat | WebMOutputFormat {
	return format.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat();
}

async function handleConvert(request: { blob: Blob; plan: CompressionPlan; quality: "low" | "medium" | "high"; stem: string }): Promise<void> {
	const { blob, plan, quality, stem } = request;
	// Try the requested plan first, then any other distinct plan as a fallback.
	// The final filename is derived from the winning candidate so it always matches the actual container/codec.
	const candidates = candidatePlans(plan);
	for (const candidate of candidates) {
		const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
		const output = new Output({ format: boxFormat(candidate), target: new BufferTarget() });
		try {
			const conversion = await Conversion.init({
				input,
				output,
				video: { codec: candidate.videoCodec, quality: new Quality(quality) },
				audio: { codec: candidate.audioCodec },
				tracks: "primary",
			});
			conversion.onProgress = (p) => scope.postMessage({ type: "progress", percent: p });
			if (!conversion.isValid) continue;
			await conversion.execute();
			const buffer = output.target.buffer;
			if (!buffer) continue;
			scope.postMessage({
				type: "result",
				blob: new Blob([buffer], { type: candidate.mime }),
				codecUsed: codecString(candidate).video,
				filename: compressedFilename(stem, candidate),
				label: planLabel(candidate),
				size: buffer.byteLength,
			});
			return;
		} catch {
			// Fall through to the next candidate.
		} finally {
			// Always release this attempt's input/source before trying the next candidate or giving up.
			input.dispose();
		}
	}
	scope.postMessage({ type: "error", message: "No compilable codec in this browser." });
}

scope.onmessage = (event) => {
	const request = event.data;
	if (request.type === "probe") {
		void handleProbe(request.blob);
	} else if (request.type === "convert") {
		void (async () => {
			try {
				await handleConvert(request);
			} catch (err) {
				scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
			}
		})();
	}
};
