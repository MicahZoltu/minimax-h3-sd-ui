// Client-side download helpers.
// Everything stays in the browser; no data is sent anywhere.
// Files are materialized as object URLs only for the moment of the download and revoked shortly after.

import { bytesToBlob, dataUrlToBytes, mimeOfDataUrl } from "./utils.js";

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
	const blob = bytesToBlob(dataUrlToBytes(dataUrl), mimeOfDataUrl(dataUrl));
	triggerDownload(blob, filename);
}
