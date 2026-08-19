// Thin, typed client for the native sdcpp API.
// Requests target the API base resolved by config.ts (explicit ?api= override, user setting, or the default localhost:1234).
// The scheduled server broadcasts CORS headers so a client served from a different origin can call it directly.

export interface Capabilities {
	model?: { stem?: string; name?: string; path?: string };
	supported_modes?: string[];
	defaults_by_mode?: {
		vid_gen?: {
			width?: number;
			height?: number;
			video_frames?: number;
			fps?: number;
			output_format?: string;
			output_compression?: number;
		};
	};
	features_by_mode?: {
		img_gen?: { progress?: boolean };
		vid_gen?: { progress?: boolean };
	};
}

/**
 * Generation progress reported by the server while a job is `generating`.
 * `step`/`steps` describe the current diffusion call, not a monotonic overall percentage:
 * hires/tiling and per-frame (AnimateDiff) jobs reset the counter, and post-processing runs
 * after the final sampling call, so the bar is an indication of activity more than exact completion.
 */
export interface JobProgress {
	/** Current step of the running generation call, 1-based. */
	step: number;
	/** Total steps in the current generation call. */
	steps: number;
	/** Seconds per iteration (elapsed time of the most recent step, not total elapsed). */
	time: number;
}

export interface Job {
	id: string;
	kind?: string;
	status: string;
	queue_position?: number;
	created?: number;
	started?: number | null;
	completed?: number | null;
	result?: {
		output_format?: string;
		mime_type?: string;
		fps?: number;
		frame_count?: number;
		b64_json?: string;
		images?: { index: number; b64_json: string }[];
	} | null;
	error?: { code?: string; message?: string } | null;
	poll_url?: string;
	/** Present only while `status === "generating"`; null otherwise. */
	progress?: JobProgress | null;
}

import { getApiBase } from "./config.js";

export class ApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

const DEFAULT_TIMEOUT_MS = 30000;

/** Join the resolved API base to a server-relative path. */
function apiUrl(path: string): string {
	return `${getApiBase()}${path}`;
}

interface ErrorShape {
	error?: { message?: string; code?: string };
	message?: string;
}

function isErrorShape(value: unknown): value is ErrorShape {
	return value !== null && typeof value === "object";
}

async function request(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(path, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...(init.headers || {}) } });
		let payload: unknown = null;
		try {
			payload = await response.json();
		} catch {
			payload = null;
		}
		if (!response.ok) {
			const errObj = isErrorShape(payload) ? payload : {};
			const message = errObj.error?.message || errObj.message || (response.statusText ? response.statusText : `Server error (HTTP ${response.status})`);
			throw new ApiError(message, response.status, errObj.error?.code);
		}
		return payload;
	} catch (err) {
		if (err instanceof ApiError) throw err;
		// AbortError or network failure.
		const msg = err instanceof DOMException && err.name === "AbortError" ? "Request timed out." : "Could not reach the server.";
		throw new ApiError(msg, 0, "network");
	} finally {
		// Clear the abort timer on every path (success, HTTP error, and a rejected fetch): a timer left
		// armed after the request settled would later abort() a controller nobody is listening to.
		clearTimeout(timer);
	}
}

function isCapabilities(value: unknown): value is Capabilities {
	return value !== null && typeof value === "object";
}

// The only job statuses the runner understands.
// Every other string must be treated as an unrecognized status so the poll loop never spins on it.
const JOB_STATUSES: readonly string[] = ["queued", "generating", "completed", "failed", "cancelled"];

function isJob(value: unknown): value is Job {
	if (value === null || typeof value !== "object") return false;
	if (!("id" in value) || !("status" in value)) return false;
	if (typeof value.id !== "string" || typeof value.status !== "string") return false;
	// A status outside the known set would make the poll loop spin forever; reject it at the boundary.
	if (!JOB_STATUSES.includes(value.status)) return false;
	// When `started`/`completed` are present they must be finite numbers, or the elapsed-time math downstream
	// would yield NaN that a persisted HistoryItem could never render. Reject a malformed value outright.
	if ("started" in value) {
		const started = value.started;
		if (started !== null && (typeof started !== "number" || !Number.isFinite(started))) return false;
	}
	if ("completed" in value) {
		const completed = value.completed;
		if (completed !== null && (typeof completed !== "number" || !Number.isFinite(completed))) return false;
	}
	return true;
}

export function isJobProgress(value: unknown): value is JobProgress {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	// Each numeric field must be a finite number to match isJob's rigor, or an overflowing server value (parsing to Infinity) would later render as "Infinity of N".
	return Number.isFinite(v["step"]) && Number.isFinite(v["steps"]) && Number.isFinite(v["time"]);
}

/** True when the server advertises generation progress for the video (vid_gen) mode. */
export function supportsVideoProgress(caps: Capabilities): boolean {
	return Boolean(caps.features_by_mode?.vid_gen?.progress);
}

export async function getCapabilities(): Promise<Capabilities> {
	const payload = await request(apiUrl("/sdcpp/v1/capabilities"));
	if (!isCapabilities(payload)) {
		throw new ApiError("Invalid capabilities response.", 0, "service");
	}
	return payload;
}

export async function submitVideoJob(body: unknown): Promise<Job> {
	const payload = await request(apiUrl("/sdcpp/v1/vid_gen"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	if (!isJob(payload)) {
		throw new ApiError("Invalid job response.", 0, "service");
	}
	return payload;
}

export async function getJob(id: string): Promise<Job> {
	const payload = await request(apiUrl(`/sdcpp/v1/jobs/${encodeURIComponent(id)}`), {}, 20000);
	if (!isJob(payload)) {
		throw new ApiError("Invalid job response.", 0, "service");
	}
	return payload;
}

export async function cancelJob(id: string): Promise<Job> {
	const payload = await request(apiUrl(`/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`), { method: "POST" });
	if (!isJob(payload)) {
		throw new ApiError("Invalid job response.", 0, "service");
	}
	return payload;
}
