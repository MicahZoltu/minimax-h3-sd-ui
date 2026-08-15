import { describe, it, expect } from "bun:test";
import { computeFaviconView } from "../app/ts/favicon.js";

describe("computeFaviconView", () => {
	it("establishes a baseline without marking anything unreviewed on first call", () => {
		expect(computeFaviconView(null, 5, 0, true)).toEqual({ historyCount: 5, active: 0, unreviewed: false });
	});

	it("marks a new completion unreviewed while the tab is hidden", () => {
		const prev = { historyCount: 5, active: 1, unreviewed: false };
		expect(computeFaviconView(prev, 6, 0, false)).toEqual({ historyCount: 6, active: 0, unreviewed: true });
	});

	it("treats a new completion as seen while the tab is visible", () => {
		const prev = { historyCount: 5, active: 1, unreviewed: false };
		expect(computeFaviconView(prev, 6, 0, true)).toEqual({ historyCount: 6, active: 0, unreviewed: false });
	});

	it("clears a pending unreviewed flag on returning to a visible tab", () => {
		const prev = { historyCount: 6, active: 0, unreviewed: true };
		expect(computeFaviconView(prev, 6, 0, true)).toEqual({ historyCount: 6, active: 0, unreviewed: false });
	});

	it("keeps the unreviewed flag while hidden", () => {
		const prev = { historyCount: 6, active: 0, unreviewed: true };
		expect(computeFaviconView(prev, 6, 0, false)).toEqual({ historyCount: 6, active: 0, unreviewed: true });
	});

	it("carries active and historyCount through unchanged on non-completion paths", () => {
		const prev = { historyCount: 4, active: 3, unreviewed: false };
		expect(computeFaviconView(prev, 4, 3, false)).toEqual({ historyCount: 4, active: 3, unreviewed: false });
	});
});
