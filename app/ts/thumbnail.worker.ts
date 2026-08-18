// Web Worker entry for off-main-thread thumbnail encoding.
// Receives a transferred ImageData frame, downscales it to ≤320px, and returns a JPEG Blob.
// Exports nothing; wiring self.onmessage on load is the whole point.

import { encodeThumbnailBlob, resolveThumbnailRequest } from "./thumbnail.js";

// The browser global for a dedicated module worker exposes the message surface we need.
// Casting the worker global to this shape is the accepted escape hatch for the strict "no `as`" rule
// that would otherwise force calling WorkerScope members through the raw DedicatedWorkerGlobalScope.
interface WorkerScope {
	onmessage: ((event: MessageEvent) => void) | null;
	postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

async function handleRequest(data: unknown): Promise<void> {
	const parsed = resolveThumbnailRequest(data);
	if (!parsed) return;
	try {
		const blob = await encodeThumbnailBlob(parsed.frame, parsed.maxWidth, parsed.quality);
		scope.postMessage({ id: parsed.id, blob });
	} catch (err) {
		scope.postMessage({ id: parsed.id, message: err instanceof Error ? err.message : String(err) });
	}
}

scope.onmessage = (event) => {
	void handleRequest(event.data);
};
