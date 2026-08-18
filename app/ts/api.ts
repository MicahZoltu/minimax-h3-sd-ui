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
		clearTimeout(timer);
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
	}
}

function isCapabilities(value: unknown): value is Capabilities {
	return value !== null && typeof value === "object";
}

function isJob(value: unknown): value is Job {
	if (value === null || typeof value !== "object") return false;
	if (!("id" in value) || !("status" in value)) return false;
	return typeof value.id === "string" && typeof value.status === "string";
}

export function isJobProgress(value: unknown): value is JobProgress {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v["step"] === "number" && typeof v["steps"] === "number" && typeof v["time"] === "number";
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
