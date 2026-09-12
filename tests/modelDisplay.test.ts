import { describe, it, expect } from "bun:test";
import { modelDisplay } from "../app/ts/api.js";
import type { Capabilities } from "../app/ts/api.js";

// The header's loaded-model indicator is driven by modelDisplay().
// These cases pin the field precedence (stem, then name, then path), the tooltip rule (the path only when it differs from the label), and the strict skip of empty or non-string values.

// Writes an untrusted (possibly mistyped) `model` value into a Capabilities fixture without a type assertion.
// The runtime helper must validate the shape itself, so the tests exercise it with raw JSON-like values.
function capsFromModel(model: unknown): Capabilities {
	const caps: Capabilities = {};
	Object.assign(caps, { model });
	return caps;
}

describe("modelDisplay", () => {
	it("prefers the stem for the label and uses the path as the tooltip", () => {
		const caps: Capabilities = { model: { stem: "checkpoint-Q4_K", name: "checkpoint-Q4_K.gguf", path: "/models/checkpoint-Q4_K.gguf" } };
		expect(modelDisplay(caps)).toEqual({ label: "checkpoint-Q4_K", title: "/models/checkpoint-Q4_K.gguf" });
	});

	it("falls back to the name when no stem is present", () => {
		const caps: Capabilities = { model: { name: "checkpoint-Q4_K.gguf", path: "/models/checkpoint-Q4_K.gguf" } };
		expect(modelDisplay(caps)).toEqual({ label: "checkpoint-Q4_K.gguf", title: "/models/checkpoint-Q4_K.gguf" });
	});

	it("uses the path as the label when it is the only field, with no tooltip", () => {
		const caps: Capabilities = { model: { path: "/models/checkpoint-Q4_K.gguf" } };
		expect(modelDisplay(caps)).toEqual({ label: "/models/checkpoint-Q4_K.gguf", title: null });
	});

	it("omits the tooltip when the path equals the chosen label", () => {
		const caps: Capabilities = { model: { stem: "/models/checkpoint-Q4_K.gguf", path: "/models/checkpoint-Q4_K.gguf" } };
		expect(modelDisplay(caps)).toEqual({ label: "/models/checkpoint-Q4_K.gguf", title: null });
	});

	it("returns null when the model field is missing", () => {
		const caps: Capabilities = { supported_modes: ["vid_gen"] };
		expect(modelDisplay(caps)).toBeNull();
	});

	it("returns null for an empty model object", () => {
		expect(modelDisplay({ model: {} })).toBeNull();
	});

	it("returns null for a null model", () => {
		expect(modelDisplay(capsFromModel(null))).toBeNull();
	});

	it("returns null for truthy non-object model values", () => {
		expect(modelDisplay(capsFromModel("not-an-object"))).toBeNull();
		expect(modelDisplay(capsFromModel(42))).toBeNull();
		expect(modelDisplay(capsFromModel([]))).toBeNull();
	});

	it("skips empty-string fields and falls through to the next candidate", () => {
		const caps: Capabilities = { model: { stem: "", name: "checkpoint-Q4_K.gguf", path: "/models/checkpoint-Q4_K.gguf" } };
		expect(modelDisplay(caps)).toEqual({ label: "checkpoint-Q4_K.gguf", title: "/models/checkpoint-Q4_K.gguf" });
	});

	it("returns null when every field is an empty string", () => {
		const caps: Capabilities = { model: { stem: "", name: "", path: "" } };
		expect(modelDisplay(caps)).toBeNull();
	});

	it("falls through a whitespace-only stem to the name", () => {
		const caps: Capabilities = { model: { stem: "  ", name: "checkpoint.gguf", path: "/models/checkpoint.gguf" } };
		expect(modelDisplay(caps)).toEqual({ label: "checkpoint.gguf", title: "/models/checkpoint.gguf" });
	});

	it("falls through non-string field values to the first valid string", () => {
		const caps = capsFromModel({ stem: 123, name: "checkpoint-Q4_K.gguf", path: "/models/checkpoint-Q4_K.gguf" });
		expect(modelDisplay(caps)).toEqual({ label: "checkpoint-Q4_K.gguf", title: "/models/checkpoint-Q4_K.gguf" });
	});

	it("returns null when all fields are non-strings", () => {
		expect(modelDisplay(capsFromModel({ stem: 123, name: true, path: null }))).toBeNull();
	});

	it("matches the documented server payload", () => {
		const caps: Capabilities = { model: { name: "minimax_h3_ref2va_pruned-Q4_K.gguf", path: "/models/minimax_h3_ref2va_pruned-Q4_K.gguf", stem: "minimax_h3_ref2va_pruned-Q4_K" } };
		expect(modelDisplay(caps)).toEqual({ label: "minimax_h3_ref2va_pruned-Q4_K", title: "/models/minimax_h3_ref2va_pruned-Q4_K.gguf" });
	});
});
