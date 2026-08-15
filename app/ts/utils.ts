// Small framework-free helpers.
// No external dependencies.

/** Generate a reasonably unique id string. */
export function uid(prefix: string): string {
	const rand = typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function" ? randomBase36() : Math.random().toString(36).slice(2);
	return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function randomBase36(): string {
	const arr = new Uint8Array(6);
	globalThis.crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(36).padStart(2, "0")).join("");
}

export function formatElapsed(elapsedMs: number): string {
	const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Build a data URL from a byte buffer. */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

/** Decode a base64 data URL back into bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
	const comma = dataUrl.indexOf(",");
	const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
	const binary = atob(base64.trim());
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Materialize bytes into a Blob (exact-size ArrayBuffer). */
export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
	const buffer = new ArrayBuffer(bytes.length);
	new Uint8Array(buffer).set(bytes);
	return new Blob([buffer], { type });
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Safely derive a filesystem-friendly basename (no path separators or illegal chars, trimmed, length-capped). */
export function sanitizeBasename(value: string): string {
	const cleaned = value
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+|\.+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 60) : "";
}
