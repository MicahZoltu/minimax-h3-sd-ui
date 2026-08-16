// Client-side download helpers.
// Everything stays in the browser; no data is sent anywhere.
// Files are materialized as object URLs only for the moment of the download and revoked shortly after.

import { bytesToBlob, dataUrlToBytes } from "./utils.js";

function triggerDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Download an existing Blob (e.g. the resident media) under a chosen filename. */
export function downloadBlob(blob: Blob, filename: string): void {
	triggerDownload(blob, filename);
}

/** Download a raw data URL (e.g. media) under a chosen filename. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
	const comma = dataUrl.indexOf(",");
	const header = comma > 0 ? dataUrl.slice(0, comma) : "";
	const mime = header.startsWith("data:") ? (header.slice(5).split(";")[0] ?? "application/octet-stream") : "application/octet-stream";
	const blob = bytesToBlob(dataUrlToBytes(dataUrl), mime);
	triggerDownload(blob, filename);
}
