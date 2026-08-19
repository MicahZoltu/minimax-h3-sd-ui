import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getApiBase, getConfigurableBase, getDefaultBase } from "../app/ts/config.js";

// The header displays getApiBase() (the effective base, honoring a ?api= override) as the truth,
// while the inline editor configures getConfigurableBase() (the stored value).
// These two paths must therefore disagree in the presence of a query override, and agree otherwise.

const STORAGE_KEY = "sdcpp.video.apiBase";

function memoryLocalStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		key: (i: number) => [...map.keys()][i] ?? null,
		clear: () => map.clear(),
		get length() { return map.size; },
	} as Storage;
}

function setQuery(raw: string | undefined): void {
	if (raw === undefined) {
		delete (globalThis as { location?: unknown }).location;
	} else {
		(globalThis as { location: unknown }).location = { search: raw };
	}
}

let ls: Storage;

beforeEach(() => {
	ls = memoryLocalStorage();
	(globalThis as { localStorage: Storage }).localStorage = ls;
	setQuery(undefined);
});

afterEach(() => {
	setQuery(undefined);
	delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("config base precedence (as consumed by the header display)", () => {
	it("defaults to the localhost default when nothing is configured", () => {
		expect(getApiBase()).toBe(getDefaultBase());
		expect(getConfigurableBase()).toBe(getDefaultBase());
	});

	it("reflects a stored (UI-configured) base in both the effective and configurable views", () => {
		ls.setItem(STORAGE_KEY, "http://192.168.1.10:1234");
		expect(getApiBase()).toBe("http://192.168.1.10:1234");
		expect(getConfigurableBase()).toBe("http://192.168.1.10:1234");
	});

	it("lets a ?api= override outrank a stored base, so effective differs from configurable (header must show the override)", () => {
		setQuery("?api=http://override.example:9999");
		ls.setItem(STORAGE_KEY, "http://192.168.1.10:1234");
		// getApiBase() is what the header displays and what requests use: the effective override.
		expect(getApiBase()).toBe("http://override.example:9999");
		// getConfigurableBase() is what the inline editor edits: the underlying stored value.
		expect(getConfigurableBase()).toBe("http://192.168.1.10:1234");
		expect(getConfigurableBase()).not.toBe(getApiBase());
	});
});
