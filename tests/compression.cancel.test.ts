import { describe, expect, it } from "bun:test";
import { CompressionCanceledError } from "../app/ts/compression.js";

// The compression coordinator spins up a real Worker against the built transpiled worker module, which
// does not exist under `bun test`, so the coordinator's worker-dependent cancel path is not exercised
// here. These assertions pin the exported cancellation sentinel itself: it must be a distinct Error type
// the lightbox detects by `instanceof` (never by comparing a human-readable message), so a reword of the
// message can never turn a clean cancel into a spurious "Compression failed" toast.
describe("CompressionCanceledError sentinel", () => {
	it("is a distinct Error subtype used as the cancellation sentinel", () => {
		const err = new CompressionCanceledError();
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(CompressionCanceledError);
		expect(err.name).toBe("CompressionCanceledError");
	});

	it("keeps the human-readable message while being detected by type, not by that text", () => {
		const err = new CompressionCanceledError();
		expect(err.message).toBe("Compression canceled.");
		expect(err instanceof CompressionCanceledError).toBe(true);
	});

	it("is distinguishable from a generic Error carrying the same wording", () => {
		expect(new Error("Compression canceled.") instanceof CompressionCanceledError).toBe(false);
	});
});
