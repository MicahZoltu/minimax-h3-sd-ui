// Zip upload parsing and validation (browser-native, no third-party deps).
//
// Files are classified by case-insensitive, literal-suffix matching against the full entry name:
//   - any file whose (lowercased) name ends with `prompt.txt`   -> prompt
//   - a name equal to `start`, or ending in `start.<anything>`  -> start image
//   - a name equal to `end`,   or ending in `end.<anything>`    -> end image
//   - otherwise, a stem (name minus last extension) ending in a digit run (*1, *2, ...)  -> numbered reference, typed by extension:
//       a png/jpg/jpeg/webp/bmp image  -> reference frame ("frame")
//       a container video (mp4/mov/webm/m4v)  -> reference video ("video")
//       an audio file (wav/mp3/m4a/aac/flac/ogg)  -> reference audio ("audio")
//   - anything else                                            -> "other" (rejected)
// prompt.txt matching is checked before start/end/numbered files.
//
// A valid upload zip contains exactly one prompt file plus exactly one of:
//   - nothing else                          -> text-only generation (mode "prompt")
//   - a start and/or end image file          -> start/end frame generation (mode "start-end")
//   - numbered reference files               -> reference generation (mode "refs")
//
// Reference numbering is PER TYPE (images, videos and audio each number independently from 1), so `1.png`, `1.mp4` and `1.wav` coexist.
// Each numbered group must form a contiguous, gap-free sequence from 1 up to its cap.
// Operating limits are enforced on upload: at most 9 images, 3 videos and 3 audio clips, and 12 reference files total across all types.
// Start/end files cannot be mixed with any numbered reference, because Ref2VA references and first/last-frame conditioning are mutually exclusive.
// Any extra file, a missing prompt, conflicting input kinds, or a non-contiguous numbered group is reported as an error before the zip is accepted.
//
// Images are decoded to PNG/JPEG/WEBP/BMP data URLs here. Video and audio files are handed to the reference extraction worker (refExtract).
// A video becomes an ordered frame list, its real fps, and an optional WAV soundtrack; any audio is transcoded to WAV.
// The original container bytes are retained so a regenerated source zip reproduces the upload.
//
// The container format is parsed directly here using the local/central directory records; deflate entries are inflated with the native `DecompressionStream`, so no external zip library is required.

import { bytesToBlob, bytesToDataUrl } from "./utils.js";
import { extractRefVideo, transcodeAudioRef } from "./refExtract.js";
import type { RefAudioFile, RefVideoFile, ZipAnalysis, ZipFile } from "./types.js";

export interface ClassifiedEntry {
	kind: "prompt" | "start" | "end" | "frame" | "video" | "audio" | "other";
	/** Number within its own file type when kind is a numbered reference ("frame" | "video" | "audio"). */
	frame?: number;
	name: string;
}

export interface ClassifyResult {
	ok: boolean;
	promptName: string | null;
	mode: "start-end" | "refs" | "prompt" | null;
	/** Ordered image file names (start, then end; or numbered frame images 1..N). */
	orderedNames: string[];
	/** Ordered numbered-video file names (video 1..M). */
	videoNames: string[];
	/** Ordered numbered-audio file names (audio 1..K). */
	audioNames: string[];
	errors: string[];
}

// Upper bound on the total number of files a zip may carry, regardless of type.
// Numbered files are already capped per type (9 images / 3 videos / 3 audio), so this is a belt-and-suspenders sanity cap rather than the operating limit.
export const MAX_FILES = 20;
export const MAX_FRAME_NUMBER = 9;
export const MAX_REF_IMAGES = MAX_FRAME_NUMBER;
export const MAX_REF_VIDEOS = 3;
export const MAX_REF_AUDIOS = 3;
export const MAX_REF_TOTAL = 12;
// The extracted frame count to target per reference video.
// The server normalizes the count and requires at least 5; a target a bit above the app's default frame count keeps payloads bounded while still giving the model enough frames.
export const MAX_REF_VIDEO_FRAMES = 57;
// Frames are downscaled to at most this width when decoded, to keep the inline-base64 request body reasonable.
export const MAX_REF_FRAME_WIDTH = 512;
// JPEG quality applied to decoded reference-video frames.
export const REF_FRAME_QUALITY = 0.7;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
// Cap on a decoded image's pixel grid (naturalWidth * naturalHeight).
// The byte-based guard bounds size but not the decoded grid, which is what the repeated re-decode/re-encode paths actually materialize, so an 8K / pathological frame must be rejected up front.
export const MAX_IMAGE_PIXELS = 64_000_000;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_PROMPT_CHARS = 20000;

// Min frames a reference video must yield after extraction; the server rejects anything below this.
export const MIN_REF_VIDEO_FRAMES = 5;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	CRC_TABLE[n] = c;
}

/** Standard CRC-32 over a byte buffer (polynomial reflected, init 0xffffffff). */
export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		if (b === undefined) continue;
		const t = CRC_TABLE[(c ^ b) & 0xff];
		if (t !== undefined) c = t ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

// Reference-image extensions this server decodes for `ref_images[]` / video frames.
// The hosted-api doc narrows the safe set to PNG/JPEG/WEBP/BMP; HEIC/HEIF are not decodable here and are rejected as "other".
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp"];
// Video is never sent as a file: these extension names merely pick the container up to be decoded to an ordered frame list.
const VIDEO_EXTS = ["mp4", "mov", "webm", "m4v"];
// Audio is accepted in any decodable format and transcoded to WAV (WAV passes through unchanged).
const AUDIO_EXTS = ["wav", "mp3", "m4a", "aac", "flac", "ogg"];

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	avif: "image/avif",
};

const VIDEO_MIME: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	m4v: "video/mp4",
};

const AUDIO_MIME: Record<string, string> = {
	wav: "audio/wav",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	ogg: "audio/ogg",
};

function stemOf(name: string): string {
	return name.replace(/\.[^./]*$/, "");
}

function extensionOf(name: string): string {
	const m = /\.[^./]*$/.exec(name);
	return m ? m[0].toLowerCase() : "";
}

/**
 * Classify a single file name (top-level entry names only) by case-insensitive, literal-suffix matching.
 * Returns one of the known kinds or "other" for anything unrecognized.
 * prompt is checked before start/end/numbered files.
 * A numbered file's type is decided by extension; a numeric stem with an unsupported extension is "other".
 */
export function classifyName(name: string): ClassifiedEntry {
	const lower = name.toLowerCase();

	if (lower.endsWith("prompt.txt")) return { kind: "prompt", name };

	if (lower === "start" || /start\.[^/]*$/.test(lower)) return { kind: "start", name };
	if (lower === "end" || /end\.[^/]*$/.test(lower)) return { kind: "end", name };

	const m = /^(.*?)(\d+)$/.exec(stemOf(name));
	if (m) {
		const digits = m[2];
		const number = digits !== undefined ? parseInt(digits, 10) : NaN;
		const ext = extensionOf(name).replace(".", "");
		if (IMAGE_EXTS.includes(ext)) return { kind: "frame", frame: number, name };
		if (VIDEO_EXTS.includes(ext)) return { kind: "video", frame: number, name };
		if (AUDIO_EXTS.includes(ext)) return { kind: "audio", frame: number, name };
		return { kind: "other", name };
	}
	return { kind: "other", name };
}

/**
 * Order and validate one numbered reference group (images / videos / audio) by case-insensitive name.
 * Requires a contiguous, gap-free sequence from 1 up to `cap`, with no duplicate numbers.
 * Pushes user-facing errors and returns the ordered file names.
 */
function orderGroup(entries: ClassifiedEntry[], kind: "frame" | "video" | "audio", cap: number, errors: string[]): string[] {
	const byNumber = new Map<number, string>();
	for (const c of entries) {
		if (c.frame === undefined) continue;
		const n = c.frame;
		const prev = byNumber.get(n);
		if (prev !== undefined) {
			errors.push(`More than one ${kind} is numbered "${n}" (${prev} and ${c.name}).`);
		} else {
			byNumber.set(n, c.name);
		}
	}
	const nums = Array.from(byNumber.keys()).sort((a, b) => a - b);
	const count = nums.length;
	if (count > cap) {
		errors.push(`Up to ${cap} numbered ${kind === "frame" ? "images" : kind + "s"} are supported.`);
	}
	if (nums.some((n) => n > cap)) {
		errors.push(`Numbered ${kind === "frame" ? "images" : kind + "s"} beyond ${cap} are not supported.`);
	}
	const expected = Array.from({ length: count }, (_, i) => i + 1);
	if (nums.length && !expected.every((v, i) => v === nums[i])) {
		errors.push(`Numbered ${kind === "frame" ? "images" : kind + "s"} must be sequential from 1 to ${count}. Found: ${nums.join(", ")}.`);
	}
	const ordered: string[] = [];
	for (const n of expected) {
		const name = byNumber.get(n);
		if (name !== undefined) ordered.push(name);
	}
	return ordered;
}

/**
 * Structurally validate a zip file list.
 * Pure function (no read of content).
 * @param names full entry names; directory entries should already be filtered.
 */
export function classifyNames(names: string[]): ClassifyResult {
	const errors: string[] = [];

	// Allowed files live only at the top level.
	// Any nested path is rejected so the "nothing else" rule cannot be bypassed by wrapping a folder.
	const nested = names.filter((n) => n.includes("/"));
	if (nested.length > 0) {
		errors.push(`Files inside subfolders are not supported; place every file at the top level (${nested[0]}).`);
	}

	const classified = names.map(classifyName);

	const promptNames = classified.filter((c) => c.kind === "prompt").map((c) => c.name);
	if (promptNames.length === 0) {
		errors.push("The zip is missing a required prompt.txt file.");
	} else if (promptNames.length > 1) {
		errors.push("The zip contains more than one prompt.txt file.");
	}

	const extras = classified.filter((c) => c.kind === "other").map((c) => c.name);
	if (extras.length > 0) {
		errors.push(`The zip contains unexpected files: ${extras.join(", ")}.`);
	}

	const startCount = classified.filter((c) => c.kind === "start").length;
	const endCount = classified.filter((c) => c.kind === "end").length;
	if (startCount > 1) errors.push("The zip contains more than one start file.");
	if (endCount > 1) errors.push("The zip contains more than one end file.");

	const frames = classified.filter((c) => c.kind === "frame");
	const videos = classified.filter((c) => c.kind === "video");
	const audios = classified.filter((c) => c.kind === "audio");
	const anyNumbered = frames.length > 0 || videos.length > 0 || audios.length > 0;
	const startEndPresent = startCount > 0 || endCount > 0;
	if (startEndPresent && anyNumbered) {
		errors.push("The zip mixes start/end files with numbered references; please include one or the other (references cannot be combined with start/end frames).");
	}

	const frameNames = orderGroup(frames, "frame", MAX_REF_IMAGES, errors);
	const videoNames = orderGroup(videos, "video", MAX_REF_VIDEOS, errors);
	const audioNames = orderGroup(audios, "audio", MAX_REF_AUDIOS, errors);

	const totalRefs = frameNames.length + videoNames.length + audioNames.length;
	if (totalRefs > MAX_REF_TOTAL) {
		errors.push(`Too many reference files (max ${MAX_REF_TOTAL} total across images, videos and audio).`);
	}

	let orderedNames: string[] = [];
	let mode: "start-end" | "refs" | "prompt" | null = null;

	if (startEndPresent) {
		orderedNames = [
			...classified.filter((c) => c.kind === "start").map((c) => c.name),
			...classified.filter((c) => c.kind === "end").map((c) => c.name),
		];
		mode = "start-end";
	} else if (anyNumbered) {
		orderedNames = frameNames;
		mode = "refs";
	} else if (promptNames.length === 1) {
		mode = "prompt";
	}

	const firstPrompt = promptNames[0];
	return {
		ok: errors.length === 0,
		promptName: firstPrompt !== undefined && promptNames.length === 1 ? firstPrompt : null,
		mode: errors.length === 0 ? mode : null,
		orderedNames,
		videoNames,
		audioNames,
		errors,
	};
}

/** Guess the MIME type of an image file from its extension. */
export function guessImageMime(name: string): string {
	const ext = extensionOf(name).replace(".", "");
	return IMAGE_MIME[ext] ?? "application/octet-stream";
}

/** Guess the MIME type of any media file (image, video container, or audio) from its extension. */
export function guessMediaMime(name: string): string {
	const ext = extensionOf(name).replace(".", "");
	return IMAGE_MIME[ext] ?? VIDEO_MIME[ext] ?? AUDIO_MIME[ext] ?? "application/octet-stream";
}

/**
 * Validate that a data URL actually decodes as an image in this browser within the allowed pixel budget.
 * Used to reject corrupt, non-image, or pathologically oversized frame files up front.
 */
export function imageDecodes(dataUrl: string): Promise<boolean> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			// Drop the source so an oversized decoded frame is not retained in memory.
			// Never assign src = "" here: per the HTML spec an empty-but-present src fires an error event on the img, which in Firefox re-enters this handler and spins an infinite error-event loop that starves the tab's favicon updates.
			img.removeAttribute("src");
			// The byte-based zip-bomb guard bounds size but not the decoded pixel grid, which is what the repeated re-decode/re-encode paths materialize; reject a frame whose grid exceeds the budget.
			resolve(Number.isFinite(img.naturalWidth) && Number.isFinite(img.naturalHeight) ? img.naturalWidth * img.naturalHeight <= MAX_IMAGE_PIXELS : false);
		};
		img.onerror = () => {
			// See the note in onload: never assign src = "" here either.
			img.removeAttribute("src");
			resolve(false);
		};
		img.src = dataUrl;
	});
}

/**
 * Build a valid zip archive using STORED (uncompressed) entries.
 * The caller-provided prompt becomes the leading `prompt.txt` entry.
 * Used to regenerate a source zip from decoded upload data.
 */
export function buildSourceZip(
	source: { name: string; bytes: Uint8Array }[],
	prompt: string,
): Blob {
	const encoder = new TextEncoder();
	const promptBytes = encoder.encode(prompt);
	const entries: { name: string; bytes: Uint8Array }[] = [
		{ name: "prompt.txt", bytes: promptBytes },
		...source,
	];

	const nameByteCache = new Map<string, Uint8Array>();
	const nameBytes = (name: string): Uint8Array => {
		let cached = nameByteCache.get(name);
		if (!cached) {
			cached = encoder.encode(name);
			nameByteCache.set(name, cached);
		}
		return cached;
	};

	let total = 0;
	for (const e of entries) {
		const nb = nameBytes(e.name);
		if (nb.length > 0xffff) {
			throw new Error("A file name in the zip is too long.");
		}
		if (e.bytes.length >= 0x100000000 || e.bytes.length > 0xffffffff) {
			throw new Error("An entry in the zip is too large.");
		}
		total += 30 + nb.length + e.bytes.length + 46 + nb.length;
	}
	if (total >= 0x100000000 || total > 0xffffffff) {
		throw new Error("The resulting zip would be too large.");
	}
	total += 22; // EOCD record

	const buffer = new ArrayBuffer(total);
	const view = new DataView(buffer);
	const out = new Uint8Array(buffer);
	let p = 0;
	const centralRecords: {
		name: Uint8Array;
		localOffset: number;
		crc: number;
		compressed: number;
		uncompressed: number;
	}[] = [];

	for (const e of entries) {
		const nb = nameBytes(e.name);
		const crc = crc32(e.bytes);
		const localOffset = p;

		view.setUint32(p, 0x04034b50, true);
		view.setUint16(p + 4, 20, true);
		view.setUint16(p + 6, 0, true);
		view.setUint16(p + 8, 0, true);
		view.setUint16(p + 10, 0, true);
		view.setUint16(p + 12, 0, true);
		view.setUint32(p + 14, crc, true);
		view.setUint32(p + 18, e.bytes.length, true);
		view.setUint32(p + 22, e.bytes.length, true);
		view.setUint16(p + 26, nb.length, true);
		view.setUint16(p + 28, 0, true);
		p += 30;
		out.set(nb, p);
		p += nb.length;
		out.set(e.bytes, p);
		p += e.bytes.length;

		centralRecords.push({
			name: nb,
			localOffset,
			crc,
			compressed: e.bytes.length,
			uncompressed: e.bytes.length,
		});
	}

	const cdOffset = p;
	let cdSize = 0;
	for (const rec of centralRecords) {
		const nb = rec.name;
		cdSize += 46 + nb.length;
		view.setUint32(p, 0x02014b50, true);
		view.setUint16(p + 4, 20, true);
		view.setUint16(p + 6, 20, true);
		view.setUint16(p + 8, 0, true);
		view.setUint16(p + 10, 0, true);
		view.setUint16(p + 12, 0, true);
		view.setUint16(p + 14, 0, true);
		view.setUint32(p + 16, rec.crc, true);
		view.setUint32(p + 20, rec.compressed, true);
		view.setUint32(p + 24, rec.uncompressed, true);
		view.setUint16(p + 28, nb.length, true);
		view.setUint16(p + 30, 0, true);
		view.setUint16(p + 32, 0, true);
		view.setUint16(p + 34, 0, true);
		view.setUint16(p + 36, 0, true);
		view.setUint32(p + 38, 0, true);
		view.setUint32(p + 42, rec.localOffset, true);
		p += 46;
		out.set(nb, p);
		p += nb.length;
	}
	view.setUint32(p, 0x06054b50, true);
	view.setUint16(p + 4, 0, true);
	view.setUint16(p + 6, 0, true);
	view.setUint16(p + 8, entries.length, true);
	view.setUint16(p + 10, entries.length, true);
	view.setUint32(p + 12, cdSize, true);
	view.setUint32(p + 16, cdOffset, true);
	view.setUint16(p + 20, 0, true);

	return new Blob([buffer], { type: "application/zip" });
}

// --- Internal helpers -------------------------------------------------------

/** A central-directory entry describing a single file in the archive. */
interface CentralEntry {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	crc: number;
	localOffset: number;
}

const ZIP_CONTAINER_ERROR = "The file could not be read as a zip archive.";

function viewOf(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sliceOf(bytes: Uint8Array, offset: number, length: number): Uint8Array {
	return new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length);
}

/** Locate the End Of Central Directory record (scan backwards, last 65557 bytes). */
function findEOCD(bytes: Uint8Array): number {
	const min = 22;
	const start = Math.max(0, bytes.length - 65557);
	// The signature 0x06054b50 is stored as bytes 50 4b 05 06 in little-endian.
	for (let i = bytes.length - min; i >= start; i--) {
		if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
			return i;
		}
	}
	return -1;
}

/** Parse the central directory into a list of file entries. */
function parseCentralDirectory(bytes: Uint8Array): CentralEntry[] {
	if (bytes.length < 22) throw new Error(ZIP_CONTAINER_ERROR);
	const eocd = findEOCD(bytes);
	if (eocd < 0) throw new Error(ZIP_CONTAINER_ERROR);

	const view = viewOf(bytes);
	const countOnDisk = view.getUint16(eocd + 8, true);
	const countTotal = view.getUint16(eocd + 10, true);
	const cdSize = view.getUint32(eocd + 12, true);
	const cdOffset = view.getUint32(eocd + 16, true);

	// Reject ZIP64 sentinels and the forms they imply.
	// The 16-bit counts cannot express more than 65535 entries except via ZIP64, which we do not support.
	if (countOnDisk === 0xffff || countTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		throw new Error("Unsupported zip format (the archive uses ZIP64 features).");
	}

	if (cdOffset > bytes.length || cdOffset + cdSize > bytes.length) {
		throw new Error(ZIP_CONTAINER_ERROR);
	}

	const entries: CentralEntry[] = [];
	const decoder = new TextDecoder();
	const cdEnd = cdOffset + cdSize;
	let p = cdOffset;
	for (let n = 0; n < countTotal; n++) {
		if (p + 46 > cdEnd || view.getUint32(p, true) !== 0x02014b50) {
			throw new Error(ZIP_CONTAINER_ERROR);
		}
		const method = view.getUint16(p + 10, true);
		const crc = view.getUint32(p + 16, true);
		const compressedSize = view.getUint32(p + 20, true);
		const uncompressedSize = view.getUint32(p + 24, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localOffset = view.getUint32(p + 42, true);
		const recordLen = 46 + nameLen + extraLen + commentLen;
		if (p + recordLen > cdEnd) throw new Error(ZIP_CONTAINER_ERROR);

		const nameBytes = sliceOf(bytes, p + 46, nameLen);
		const name = decoder.decode(nameBytes);
		entries.push({
			name,
			method,
			compressedSize,
			uncompressedSize,
			crc,
			localOffset,
		});
		p += recordLen;
	}
	return entries;
}

/** Offset of an entry's compressed data in the buffer, or -1 if the header is corrupt. */
function localDataOffset(bytes: Uint8Array, entry: CentralEntry, view: DataView): number {
	const off = entry.localOffset;
	if (off > bytes.length || off + 30 > bytes.length || view.getUint32(off, true) !== 0x04034b50) {
		return -1;
	}
	const nameLen = view.getUint16(off + 26, true);
	const extraLen = view.getUint16(off + 28, true);
	return off + 30 + nameLen + extraLen;
}

/**
 * Inflate raw deflate to a Uint8Array via the native DecompressionStream.
 *
 * We feed the compressed bytes through `pipeThrough` rather than manually writing-then-closing-then-reading: the manual sequence deadlocks on `writer.close()` once the inflated output exceeds the stream's high-water mark (backpressure), which would leave generation stuck forever.
 * Piping lets the stream machinery apply backpressure correctly.
 */
async function inflateRaw(name: string, data: Uint8Array, limit: number): Promise<Uint8Array> {
	// The Compression Streams API only accepts ArrayBuffer-backed views, so copy the (possibly SharedArrayBuffer-backed) input into a fresh ArrayBuffer.
	const input = new Uint8Array(data);
	const source = new ReadableStream<BufferSource>({
		start(controller) {
			controller.enqueue(input);
			controller.close();
		},
	});
	const output = source.pipeThrough(new DecompressionStream("deflate-raw"));
	const reader = output.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				throw new Error(`File ${name} exceeds the size limit.`);
			}
			chunks.push(value);
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes("exceeds the size limit")) throw err;
		throw new Error(`${name} could not be decompressed (the zip archive is corrupt).`);
	}

	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

/**
 * Read a single entry from the buffer, inflating and CRC-verifying it.
 * Enforces the per-file size cap before and while decompressing (zip-bomb guard).
 */
async function readEntry(bytes: Uint8Array, entry: CentralEntry): Promise<Uint8Array> {
	if (entry.uncompressedSize > MAX_FILE_BYTES) {
		throw new Error(`File ${entry.name} exceeds the size limit.`);
	}
	const view = viewOf(bytes);
	const dataOffset = localDataOffset(bytes, entry, view);
	if (dataOffset < 0 || dataOffset + entry.compressedSize > bytes.length) {
		throw new Error(`${entry.name} could not be read (the zip archive is corrupt).`);
	}

	const raw = sliceOf(bytes, dataOffset, entry.compressedSize);
	let decoded: Uint8Array;
	if (entry.method === 0) {
		decoded = raw;
	} else if (entry.method === 8) {
		decoded = await inflateRaw(entry.name, raw, MAX_FILE_BYTES);
	} else {
		throw new Error(`File ${entry.name} uses an unsupported compression method (${entry.method}).`);
	}

	if (entry.crc !== 0) {
		const actual = crc32(decoded);
		if (actual !== entry.crc) {
			throw new Error(`File ${entry.name} is corrupt (CRC mismatch).`);
		}
	}
	return decoded;
}

/**
 * Parse and fully validate an uploaded zip blob.
 * Returns a ZipAnalysis on success or throws an Error with a user-facing message.
 */
export async function analyzeZip(blob: Blob, zipName: string): Promise<ZipAnalysis> {
	if (!/\.zip$/i.test(zipName)) {
		throw new Error("Please choose a .zip file.");
	}
	if (blob.size > MAX_ZIP_BYTES) {
		throw new Error("The zip file is too large.");
	}
	if (blob.size < 22) {
		throw new Error(ZIP_CONTAINER_ERROR);
	}

	let bytes: Uint8Array;
	let entries: CentralEntry[];
	try {
		const buffer = await blob.arrayBuffer();
		bytes = new Uint8Array(buffer);
		entries = parseCentralDirectory(bytes);
	} catch {
		throw new Error(ZIP_CONTAINER_ERROR);
	}

	const fileEntries = entries.filter((e) => !e.name.endsWith("/"));
	if (fileEntries.length === 0) {
		throw new Error("The zip is empty.");
	}

	const names = fileEntries.map((e) => e.name);
	const result = classifyNames(names);
	if (!result.ok) {
		throw new Error(result.errors.join(" "));
	}

	const promptEntry = fileEntries.find((e) => e.name === result.promptName);
	let prompt: string;
	if (promptEntry) {
		if (promptEntry.uncompressedSize > MAX_PROMPT_BYTES) {
			throw new Error("prompt.txt is too large.");
		}
		let promptRaw: Uint8Array;
		try {
			promptRaw = await readEntry(bytes, promptEntry);
		} catch {
			throw new Error("The prompt.txt file could not be read.");
		}
		prompt = new TextDecoder().decode(promptRaw).trim();
	} else {
		prompt = "";
	}
	if (!prompt) {
		throw new Error("prompt.txt is empty; please include a prompt.");
	}
	if (prompt.length > MAX_PROMPT_CHARS) {
		throw new Error("The prompt is too long.");
	}

	const files: ZipFile[] = [];
	for (const name of result.orderedNames) {
		const entry = fileEntries.find((e) => e.name === name);
		if (!entry) continue;
		let dataUrl: string;
		try {
			const decoded = await readEntry(bytes, entry);
			dataUrl = bytesToDataUrl(decoded, guessImageMime(name));
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}
		if (!(await imageDecodes(dataUrl))) {
			throw new Error(`${name} is not a valid image.`);
		}
		files.push({ name, dataUrl });
	}

	// Very large file sets would be wasteful; keep a sanity cap across every type.
	if (files.length + result.videoNames.length + result.audioNames.length > MAX_FILES) {
		throw new Error(`Too many files in the zip (max ${MAX_FILES}).`);
	}

	const videos: RefVideoFile[] = [];
	for (const name of result.videoNames) {
		const entry = fileEntries.find((e) => e.name === name);
		if (!entry) continue;
		let decoded: Uint8Array;
		try {
			decoded = await readEntry(bytes, entry);
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}
		try {
			const container = decoded.slice();
			const sourceDataUrl = bytesToDataUrl(decoded, guessMediaMime(name));
			const extracted = await extractRefVideo(bytesToBlob(container, guessMediaMime(name)), MAX_REF_VIDEO_FRAMES, MAX_REF_FRAME_WIDTH, REF_FRAME_QUALITY);
			if (extracted.frames.length < MIN_REF_VIDEO_FRAMES) {
				throw new Error(`${name} is too short for a reference video; it needs at least ${MIN_REF_VIDEO_FRAMES} frames.`);
			}
			videos.push({ name, fps: extracted.fps, frames: extracted.frames, audio: extracted.audio, sourceDataUrl });
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}
	}

	const audios: RefAudioFile[] = [];
	for (const name of result.audioNames) {
		const entry = fileEntries.find((e) => e.name === name);
		if (!entry) continue;
		let decoded: Uint8Array;
		try {
			decoded = await readEntry(bytes, entry);
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}
		try {
			const container = decoded.slice();
			const sourceDataUrl = bytesToDataUrl(decoded, guessMediaMime(name));
			const dataUrl = await transcodeAudioRef(bytesToBlob(container, guessMediaMime(name)));
			audios.push({ name, dataUrl, sourceDataUrl });
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : String(err));
		}
	}

	if (result.mode === null) {
		throw new Error("The zip is missing a required prompt.txt file.");
	}
	return { prompt, mode: result.mode, files, videos, audios };
}
