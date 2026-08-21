// Main-thread coordinator for the reference-media extraction worker.
//
// The server accepts reference video only as an ordered frame list (plus a real fps and an optional WAV soundtrack), and reference audio only as WAV.
// A raw uploaded video/audio file must therefore be decoded in the browser before it can be attached to a request.
// This module is the thin main-thread half of that: it spawns the dedicated worker (refExtract.worker.ts), posts a single job, and resolves with the derived resources.
// Reference ingestion is rare (one per zip upload), so a fresh worker is spawned per operation instead of maintaining a shared worker with in-flight coordination.

export interface ExtractedRefVideo {
	/** Real source frame rate of the video. */
	fps: number;
	/** Ordered JPEG data URLs, one per frame, in playback order. */
	frames: string[];
	/** WAV soundtrack data URL, or null when the source container carried no audio. */
	audio: string | null;
}

type RefWorkerRequest =
	| { type: "video"; id: number; blob: Blob; maxFrames: number; maxWidth: number; quality: number }
	| { type: "audio"; id: number; blob: Blob };

type RefWorkerReply =
	| { type: "video-result"; id: number; fps: number; frames: string[]; audio: string | null }
	| { type: "audio-result"; id: number; dataUrl: string }
	| { type: "error"; id: number; message: string };

// A reference decode must never hold its caller forever; after this the coordinator rejects and tears the worker down.
const EXTRACT_WATCHDOG_MS = 120000;

let nextRefId = 0;

function createRefWorker(): Worker | null {
	try {
		return new Worker(new URL("./refExtract.worker.js", import.meta.url), { type: "module" });
	} catch {
		return null;
	}
}

function send(request: RefWorkerRequest): Promise<RefWorkerReply> {
	return new Promise((resolve, reject) => {
		const worker = createRefWorker();
		if (!worker) {
			reject(new Error("Reference decoding is unavailable in this browser."));
			return;
		}
		const watchdog = setTimeout(() => {
			worker.terminate();
			reject(new Error("Reference decoding timed out."));
		}, EXTRACT_WATCHDOG_MS);
		worker.onmessage = (event) => {
			const packet: RefWorkerReply = event.data;
			if (!("id" in packet) || packet.id !== request.id) return;
			clearTimeout(watchdog);
			worker.terminate();
			if (packet.type === "error") {
				reject(new Error(typeof packet.message === "string" ? packet.message : "Reference decoding failed."));
				return;
			}
			resolve(packet);
		};
		worker.onerror = (event) => {
			clearTimeout(watchdog);
			worker.terminate();
			reject(new Error(event.message || "Reference decoding failed."));
		};
		worker.postMessage(request);
	});
}

/** Decode an uploaded video file into the ordered frame list + fps + soundtrack the request needs. */
export async function extractRefVideo(blob: Blob, maxFrames: number, maxWidth: number, quality: number): Promise<ExtractedRefVideo> {
	const reply = await send({ type: "video", id: nextRefId++, blob, maxFrames, maxWidth, quality });
	if (!("type" in reply) || reply.type !== "video-result") throw new Error("Reference video decoding returned an unrecognized response.");
	if (typeof reply.fps !== "number" || !Number.isFinite(reply.fps) || reply.fps <= 0) throw new Error("Reference video reporting an invalid frame rate.");
	if (!Array.isArray(reply.frames) || reply.frames.some((f) => typeof f !== "string") || reply.frames.length < 1) throw new Error("Reference video produced no decodable frames.");
	const audio = typeof reply.audio === "string" ? reply.audio : null;
	return { fps: reply.fps, frames: reply.frames, audio };
}

/** Decode an uploaded audio file into a WAV data URL (passed through unmodified when it is already WAV). */
export async function transcodeAudioRef(blob: Blob): Promise<string> {
	const reply = await send({ type: "audio", id: nextRefId++, blob });
	if (!("type" in reply) || reply.type !== "audio-result") throw new Error("Reference audio decoding returned an unrecognized response.");
	if (typeof reply.dataUrl !== "string" || !reply.dataUrl.startsWith("data:audio/wav")) throw new Error("Reference audio did not decode to a WAV file.");
	return reply.dataUrl;
}
