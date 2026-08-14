// Client-side download helpers.
// Everything stays in the browser; no data is sent anywhere.
// Files are materialized as object URLs only for the moment of the download and revoked shortly after.

import type { Store } from "./state.js";
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

function extFor(format: string): string {
	switch (format) {
		case "webp":
		case "webm":
		case "avi":
			return format;
		default:
			return "bin";
	}
}

/** Download the generated video for a history item. */
export function downloadVideo(store: Store, id: string): void {
	const item = store.history.items().find((i) => i.id === id);
	if (!item?.video?.b64) return;
	const bytes = dataUrlToBytes(`data:${item.video.mime};base64,${item.video.b64}`);
	const blob = bytesToBlob(bytes, item.video.mime);
	triggerDownload(blob, `${id}.${extFor(item.video.format)}`);
}

/** Download a single input image file by name for a history item. */
export function downloadFile(store: Store, id: string, index: number): void {
	const item = store.history.items().find((i) => i.id === id);
	const file = item?.files?.[index];
	if (!item || !file) return;
	const blob = bytesToBlob(dataUrlToBytes(file.dataUrl), "application/octet-stream");
	triggerDownload(blob, file.name);
}
