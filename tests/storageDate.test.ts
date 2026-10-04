import { describe, it, expect } from "bun:test";
import { dateCutoffCount, formatDateInput, parseDateInput, predatesCutoff } from "../app/ts/storageDate.js";

describe("parseDateInput", () => {
	it("yields local midnight for YYYY-MM-DD", () => {
		expect(parseDateInput("2026-09-01")).toBe(new Date(2026, 8, 1).getTime());
		expect(parseDateInput("2024-02-29")).toBe(new Date(2024, 1, 29).getTime());
	});

	it("returns null for an empty string", () => {
		expect(parseDateInput("")).toBeNull();
	});

	it("returns null for garbage and impossible dates", () => {
		expect(parseDateInput("garbage")).toBeNull();
		expect(parseDateInput("2026-9-1")).toBeNull();
		expect(parseDateInput("2026-13-01")).toBeNull();
		expect(parseDateInput("2026-02-31")).toBeNull();
	});
});

describe("dateCutoffCount", () => {
	it("matches the removeBefore predicate exactly", () => {
		const items = [{ createdAt: 999 }, { createdAt: 1000 }, { createdAt: 1001 }, { createdAt: Number.NaN }];
		// Strictly before: the boundary itself (1000) is preserved.
		expect(dateCutoffCount(items, 1000)).toBe(1);
		expect(dateCutoffCount(items, 1001)).toBe(2);
		expect(dateCutoffCount(items, 1002)).toBe(3);
		expect(dateCutoffCount([], 1000)).toBe(0);
	});

	it("never counts a non-finite createdAt", () => {
		expect(predatesCutoff(Number.NaN, Number.POSITIVE_INFINITY)).toBe(false);
		expect(dateCutoffCount([{ createdAt: Number.NaN }], Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("formatDateInput", () => {
	it("formats the local calendar day of an instant as zero-padded YYYY-MM-DD", () => {
		expect(formatDateInput(new Date(2026, 8, 1).getTime())).toBe("2026-09-01");
		expect(formatDateInput(new Date(2024, 0, 9).getTime())).toBe("2024-01-09");
		expect(formatDateInput(new Date(2026, 11, 31, 23, 59).getTime())).toBe("2026-12-31");
	});

	it("keeps a mid-day instant on its own local day and round-trips to that day's midnight", () => {
		const noon = new Date(2026, 8, 1, 12).getTime();
		expect(formatDateInput(noon)).toBe("2026-09-01");
		expect(parseDateInput(formatDateInput(noon))).toBe(new Date(2026, 8, 1).getTime());
	});
});
