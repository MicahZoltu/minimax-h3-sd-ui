import { describe, it, expect } from "bun:test";
import { computeFaviconView } from "../app/ts/favicon.js";

describe("computeFaviconView", () => {
	it("is unreviewed (green) when at least one item is unviewed", () => {
		expect(computeFaviconView(1, true)).toEqual({ active: 1, unreviewed: true });
	});

	it("is reviewed (blue) when every item is viewed", () => {
		expect(computeFaviconView(0, false)).toEqual({ active: 0, unreviewed: false });
	});

	it("carries the active in-flight count through regardless of reviewed state", () => {
		expect(computeFaviconView(3, false)).toEqual({ active: 3, unreviewed: false });
		expect(computeFaviconView(9, true)).toEqual({ active: 9, unreviewed: true });
	});
});
