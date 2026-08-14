// Resolves the base URL of the native sdcpp API.
//
// The frontend may be served from a different origin (or path) than the API, so the API location is made explicit.
// Resolution priority:
//   1. A `?api=<base>` query-string override (session-scoped; survives reloads only while the parameter stays in the URL).
//   2. A user-configured value, persisted to localStorage when available and falling back to in-memory otherwise (set via the UI or setApiBase()).
//   3. The default http://localhost:1234 (the examples/server default port).

const DEFAULT_API_BASE = "http://localhost:1234";
const STORAGE_KEY = "sdcpp.video.apiBase";
const QUERY_KEY = "api";

let memoryBase: string | null = null;

/**
 * Trim and validate a user-supplied base URL.
 * Returns null if not http(s).
 */
export function normalizeBase(raw: string): string | null {
	const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\/[^/]+$/i.test(trimmed)) return null;
	return trimmed;
}

function readStorage(): string | null {
	try {
		const v = globalThis.localStorage?.getItem(STORAGE_KEY);
		return typeof v === "string" && v.length > 0 ? v : null;
	} catch {
		return null;
	}
}

function writeStorage(value: string | null): void {
	try {
		if (value == null) globalThis.localStorage?.removeItem(STORAGE_KEY);
		else globalThis.localStorage?.setItem(STORAGE_KEY, value);
	} catch {
		// Persistence unavailable (private browsing / quota): in-memory only.
	}
}

function readQueryBase(): string | null {
	try {
		const params = new URLSearchParams(globalThis.location?.search ?? "");
		const raw = params.get(QUERY_KEY);
		return raw ? normalizeBase(raw) : null;
	} catch {
		return null;
	}
}

/** The effective API base currently in use. */
export function getApiBase(): string {
	return readQueryBase() ?? readStoredBase() ?? memoryBase ?? DEFAULT_API_BASE;
}

/** The base that the UI should display (override, or the default). */
export function getConfigurableBase(): string {
	return readStoredBase() ?? memoryBase ?? DEFAULT_API_BASE;
}

/** The base assumed when no override is configured (localhost:server-port). */
export function getDefaultBase(): string {
	return DEFAULT_API_BASE;
}

function readStoredBase(): string | null {
	const raw = readStorage();
	return raw ? normalizeBase(raw) : null;
}

/**
 * Set a new API base and persist it.
 * Throws if the value is not an absolute http(s) address.
 * Returns the stored (normalized) value.
 */
export function setApiBase(value: string): string {
	const normalized = normalizeBase(value);
	if (!normalized) throw new Error("API URL must be an absolute http(s) address.");
	memoryBase = normalized;
	writeStorage(normalized);
	return normalized;
}

/** Clear any override, reverting to the default base. */
export function resetApiBase(): string {
	memoryBase = null;
	writeStorage(null);
	return DEFAULT_API_BASE;
}
