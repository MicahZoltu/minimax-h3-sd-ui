// Main-thread coordinator for the transcode worker.
// Owns the worker lifecycle, serializes requests to a single worker, and exposes promise-based probe/convert APIs to the UI.
// Compression requests are mutually exclusive: only one conversion may run at a time.

import type { CompressionPlan, CompressionQuality, UnsupportedReason, WorkerResponse } from "./compression.types.js";

// A request that never posts a terminal message (or whose postMessage throws) must not hold the slot forever.
// After this long the coordinator force-terminates the worker and rejects the stalled run.
// The same single-slot forwarding is shared by probes and converts, so a hung request of either kind must be recovered.
const CONVERT_WATCHDOG_MS = 10 * 60 * 1000;
// Probing is a lightweight metadata read that should return far sooner than a full transcode.
// A much shorter window than CONVERT_WATCHDOG_MS keeps a hung probe from pinning the single slot for ten minutes.
const PROBE_WATCHDOG_MS = 30 * 1000;

export interface CompressionResult {
	blob: Blob;
	codecUsed: string;
	filename: string;
	label: string;
}

export interface CompressionRun {
	done: Promise<CompressionResult>;
	onProgress(cb: (pct: number) => void): void;
	cancel(reason?: string): void;
}

/**
 * Rejection sentinel for a cancelled compression run (Cancel button or the stall watchdog).
 * The lightbox detects cancellation by `instanceof`, never by comparing a human-readable message,
 * so a reword of the message can never turn a clean cancel into a spurious "Compression failed" toast.
 */
export class CompressionCanceledError extends Error {
	readonly canceled = true;
	constructor() {
		super("Compression canceled.");
		this.name = "CompressionCanceledError";
	}
}

type ProbeOutcome = { plan: CompressionPlan | null; reason: UnsupportedReason | null };

interface Pending {
	mode: "probe" | "convert";
	onProbeResult?: (outcome: ProbeOutcome) => void;
	onConvertResult?: (result: CompressionResult) => void;
	onError: (err: Error) => void;
	onProgress?: (pct: number) => void;
}

let worker: Worker | null = null;
// Only one request is outstanding at a time; this is the single pending slot it maps to.
let current: Pending | null = null;
// Watchdog for whichever request currently owns the slot (probe or convert).
let watchdog: ReturnType<typeof setTimeout> | null = null;
let conversionActive = false;
// Requests are chained so each one fully completes before the next is posted.
let requestTail: Promise<void> = Promise.resolve();

function maybeWorkerResponse(value: unknown): value is WorkerResponse {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function getWorker(): Worker {
	if (worker) return worker;
	const w = new Worker(new URL("./transcode.worker.js", import.meta.url), { type: "module" });
	w.onmessage = (event) => {
		if (!maybeWorkerResponse(event.data)) return;
		const message = event.data;
		const cur = current;
		if (!cur) return;
		switch (message.type) {
			case "probe-result":
				if (cur.mode === "probe" && cur.onProbeResult) cur.onProbeResult({ plan: message.plan, reason: message.reason });
				finalize();
				break;
			case "result":
				if (cur.mode === "convert" && cur.onConvertResult) {
					cur.onConvertResult({ blob: message.blob, codecUsed: message.codecUsed, filename: message.filename, label: message.label });
				}
				finalize();
				break;
			case "progress":
				if (cur.onProgress) cur.onProgress(message.percent);
				break;
			case "error":
				cur.onError(new Error(message.message));
				finalize();
				break;
		}
	};
	w.onerror = (event) => {
		// Reject the active run and reset the slot; the worker is gone, so recreate it on the next request.
		const cur = current;
		if (cur) cur.onError(new Error(event.message || "Transcode worker error."));
		finalize();
		w.terminate();
		worker = null;
	};
	worker = w;
	return w;
}

// Clears the watchdog on any settle.
// A request that legitimately finished must never be disturbed by a stale timer.
function clearWatchdog(): void {
	if (watchdog != null) {
		clearTimeout(watchdog);
		watchdog = null;
	}
}

// Arms the watchdog for the request currently in the slot, keyed off its mode.
// On expiry the worker is force-terminated and the stalled run rejected, for both probes and converts.
function armWatchdog(): void {
	clearWatchdog();
	if (current?.mode === "probe") {
		watchdog = setTimeout(() => terminateWorker(), PROBE_WATCHDOG_MS);
	} else if (current?.mode === "convert") {
		watchdog = setTimeout(() => terminateWorker(), CONVERT_WATCHDOG_MS);
	}
}

// Clears the pending slot and frees the request chain to advance.
function finalize(): void {
	clearWatchdog();
	current = null;
	conversionActive = false;
}

// Rejects the active run, releases the slot, and tears down the worker.
// Used by both the Cancel button and the stall watchdog.
function terminateWorker(): void {
	const cur = current;
	if (cur) cur.onError(new CompressionCanceledError());
	finalize();
	if (worker) {
		worker.terminate();
		worker = null;
	}
}

// Chains a task onto the tail; the chain only advances once the task resolves.
function schedule(task: () => Promise<void>): void {
	requestTail = requestTail.then(task).catch(() => {});
}

export function probeCompression(blob: Blob): Promise<ProbeOutcome> {
	return new Promise<ProbeOutcome>((resolve, reject) => {
		schedule(() =>
			new Promise<void>((taskDone) => {
				current = {
					mode: "probe",
					onProbeResult: (outcome) => {
						resolve(outcome);
						taskDone();
					},
					onError: (err) => {
						reject(err);
						taskDone();
					},
				};
				armWatchdog();
				let posted = false;
				try {
					getWorker().postMessage({ type: "probe", blob });
					posted = true;
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
					finalize();
				} finally {
					// A synchronous postMessage failure must still release the slot and advance the chain.
					if (!posted) taskDone();
				}
			}),
		);
	});
}

export function runCompression(blob: Blob, plan: CompressionPlan, opts: { quality: CompressionQuality; stem: string }): CompressionRun {
	if (conversionActive) {
		const busy = new Error("Another compression is already in progress. Wait for it to finish before starting a new one.");
		return {
			done: Promise.reject(busy),
			onProgress: () => {},
			cancel: () => {},
		};
	}
	let onProgressCb: ((pct: number) => void) | null = null;
	let settled = false;
	conversionActive = true;
	const done = new Promise<CompressionResult>((resolve, reject) => {
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			fn();
		};
		schedule(() =>
			new Promise<void>((taskDone) => {
				current = {
					mode: "convert",
					onConvertResult: (result) => {
						settle(() => resolve(result));
						taskDone();
					},
					onError: (err) => {
						settle(() => reject(err));
						taskDone();
					},
					onProgress: (pct) => {
						if (onProgressCb) onProgressCb(pct);
					},
				};
				armWatchdog();
				let posted = false;
				try {
					getWorker().postMessage({ type: "convert", blob, plan, quality: opts.quality, stem: opts.stem });
					posted = true;
				} catch (err) {
					settle(() => reject(err instanceof Error ? err : new Error(String(err))));
					finalize();
				} finally {
					// A synchronous postMessage failure must still release the slot and advance the chain.
					if (!posted) taskDone();
				}
			}),
		);
	});
	return {
		done,
		onProgress: (cb) => {
			onProgressCb = cb;
		},
		cancel: () => {
			terminateWorker();
		},
	};
}
