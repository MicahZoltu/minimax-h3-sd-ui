// Codec-support probing and DOM for the "Support" modal.
// The pure label mapping here is browser/DOM-free and unit-testable in Bun; the probe and the DOM builder are browser-only.

import { getEncodableAudioCodecs, getEncodableVideoCodecs } from "../vendor/mediabunny/src/encode.js";
import { h } from "./dom.js";

export interface CodecEntry {
	id: string;
	label: string;
}

export interface CodecSupport {
	video: CodecEntry[];
	audio: CodecEntry[];
	note: string | null;
}

const VIDEO_LABELS: Record<string, string> = { avc: "H.264 / AVC", hevc: "H.265 / HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1", prores: "ProRes" };
const AUDIO_LABELS: Record<string, string> = { aac: "AAC", opus: "Opus", mp3: "MP3", vorbis: "Vorbis", flac: "FLAC", ac3: "AC-3", eac3: "E-AC-3", dts: "DTS" };
const PCM_LABELS: Record<string, string> = {
	"pcm-s16": "PCM 16-bit little-endian",
	"pcm-s16be": "PCM 16-bit big-endian",
	"pcm-s24": "PCM 24-bit little-endian",
	"pcm-s24be": "PCM 24-bit big-endian",
	"pcm-s32": "PCM 32-bit little-endian",
	"pcm-s32be": "PCM 32-bit big-endian",
	"pcm-f32": "PCM 32-bit float",
	"pcm-f32be": "PCM 32-bit float big-endian",
	"pcm-f64": "PCM 64-bit float",
	"pcm-f64be": "PCM 64-bit float big-endian",
	"pcm-u8": "PCM 8-bit",
	"pcm-s8": "PCM 8-bit",
	ulaw: "μ-law",
	alaw: "A-law",
};

export function codecLabel(id: string): string {
	return VIDEO_LABELS[id] ?? AUDIO_LABELS[id] ?? PCM_LABELS[id] ?? id;
}

const hasWebCodecs = (): boolean => typeof globalThis.VideoEncoder === "function" && typeof globalThis.AudioEncoder === "function";

const toEntry = (id: string): CodecEntry => ({ id, label: codecLabel(id) });

export async function probeCodecSupport(): Promise<CodecSupport> {
	try {
		const [video, audio] = await Promise.all([getEncodableVideoCodecs(), getEncodableAudioCodecs()]);
		// Without WebCodecs there are still encodable codecs: the PCM family and any pure-JS encoders that Mediabunny ships.
		// Surface that so the lists are not mistaken for a broken core-codec setup.
		const note = hasWebCodecs() ? null : "This browser lacks WebCodecs, so only PCM and pure-JS codecs can be encoded.";
		return { video: video.map(toEntry), audio: audio.map(toEntry), note };
	} catch {
		return { video: [], audio: [], note: "Failed to probe codec support." };
	}
}

// Build the codec-support modal overlay, mirroring the storage modal's overlay+modal+modal-head structure.
export function buildCodecModal(support: CodecSupport): HTMLElement {
	const list = (entries: CodecEntry[]): HTMLElement =>
		h("ul", { class: "codec-list" }, entries.map((entry) => h("li", { id: entry.id, title: entry.id }, entry.label)));
	return h("div", { class: "overlay codec-overlay" }, [
		h("div", { class: "modal codec-modal" }, [
			h("div", { class: "modal-head" }, [
				h("h2", {}, "Supported codecs"),
				h("button", { class: "btn", "data-action": "close-codecs" }, "Close"),
			]),
			support.note ? h("p", { class: "codec-note" }, support.note) : null,
			h("h3", {}, "Video"),
			list(support.video),
			h("h3", {}, "Audio"),
			list(support.audio),
		]),
	]);
}
