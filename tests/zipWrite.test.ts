import { describe, it, expect } from "bun:test";
import { crc32, incrementalCrc32 } from "../app/ts/zip.js";
import { assertZipCapacity, uniqueEntryName, ZipStreamWriter } from "../app/ts/zipWrite.js";
import { readZipEntries } from "./support/zipRead.js";

function bytesOf(size: number, seed: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(size));
	for (let i = 0; i < size; i++) out[i] = (seed + i * 31) & 0xff;
	return out;
}

async function collect(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
	const out = new Uint8Array(new ArrayBuffer(blob.size));
	const reader = blob.stream().getReader();
	let at = 0;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		const chunk = next.value;
		if (chunk) {
			out.set(chunk, at);
			at += chunk.length;
		}
	}
	return out;
}

describe("incrementalCrc32", () => {
	it("matches the one-shot crc32 across odd-size chunk splits", () => {
		const data = bytesOf(1000, 7);
		const inc = incrementalCrc32();
		inc.update(data.subarray(0, 1));
		inc.update(data.subarray(1, 513));
		inc.update(data.subarray(513));
		expect(inc.digest()).toBe(crc32(data));
	});

	it("digests the empty payload to 0 and stays idempotent", () => {
		const inc = incrementalCrc32();
		expect(inc.digest()).toBe(0);
		expect(inc.digest()).toBe(0);
	});
});

describe("assertZipCapacity", () => {
	it("accepts the batch scope with headroom", () => {
		expect(() => assertZipCapacity({ entryCount: 0xffff, totalBytes: 0xfffffffe, maxEntryBytes: 0xfffffffe })).not.toThrow();
	});

	it("throws past each classic-format limit", () => {
		expect(() => assertZipCapacity({ entryCount: 0x10000, totalBytes: 0, maxEntryBytes: 0 })).toThrow(/Too many files/);
		expect(() => assertZipCapacity({ entryCount: 1, totalBytes: 0, maxEntryBytes: 0x100000000 })).toThrow(/too large/);
		expect(() => assertZipCapacity({ entryCount: 1, totalBytes: 0x100000000, maxEntryBytes: 0 })).toThrow(/zip would be too large/);
	});

	it("treats the 0xFFFFFFFF sentinel itself as over the line", () => {
		expect(() => assertZipCapacity({ entryCount: 1, totalBytes: 0, maxEntryBytes: 0xffffffff })).toThrow(/too large/);
		expect(() => assertZipCapacity({ entryCount: 1, totalBytes: 0xffffffff, maxEntryBytes: 0 })).toThrow(/zip would be too large/);
	});
});

describe("uniqueEntryName", () => {
	it("keeps the bare name until a collision, then suffixes", () => {
		const used = new Set<string>();
		expect(uniqueEntryName("foo", "webm", used)).toBe("foo.webm");
		expect(uniqueEntryName("foo", "webm", used)).toBe("foo (2).webm");
		expect(uniqueEntryName("foo", "webm", used)).toBe("foo (3).webm");
	});

	it("treats membership case-insensitively", () => {
		const used = new Set<string>();
		expect(uniqueEntryName("FOO", "webm", used)).toBe("FOO.webm");
		expect(uniqueEntryName("foo", "webm", used)).toBe("foo (2).webm");
	});

	it("handles an empty extension", () => {
		const used = new Set<string>();
		expect(uniqueEntryName("prompt", "", used)).toBe("prompt");
		expect(uniqueEntryName("prompt", "", used)).toBe("prompt (2)");
	});
});

describe("ZipStreamWriter", () => {
	it("round-trips entries byte-exactly through the central directory", async () => {
		const sources = [
			{ name: "first.webm", blob: new Blob([bytesOf(64, 1)]) },
			{ name: "empty.bin", blob: new Blob([]) },
			{ name: "vídeo é.webm", blob: new Blob([bytesOf(70000, 2)]) },
		];
		const writer = new ZipStreamWriter();
		for (const s of sources) await writer.add(s);
		const zip = await writer.finish();
		expect(zip.type).toBe("application/zip");
		expect(writer.entryCount).toBe(3);

		const raw = await collect(zip);
		expect(writer.totalBytes).toBe(raw.length);
		const view = new DataView(raw.buffer);
		const entries = readZipEntries(raw);
		expect(entries.map((e) => e.name)).toEqual(["first.webm", "empty.bin", "vídeo é.webm"]);
		for (const [i, e] of entries.entries()) {
			expect(e.method).toBe(0);
			expect(e.crc).toBe(crc32(await collect(sources[i]?.blob ?? new Blob([]))));
			const source = sources[i]?.blob;
			expect(e.size).toBe(source?.size ?? -1);
			expect(Buffer.from(e.data).equals(Buffer.from(await collect(source ?? new Blob([]))))).toBe(true);
			// The LOCAL header must carry the same CRC and sizes as the central record.
			expect(view.getUint32(e.localHeaderOffset + 14, true)).toBe(e.crc);
			expect(view.getUint32(e.localHeaderOffset + 18, true)).toBe(e.size);
			expect(view.getUint32(e.localHeaderOffset + 22, true)).toBe(e.size);
		}
		// EOCD: entry count pair and the CD size/offset pair must agree with the walked directory (the EOCD sits directly after the CD, so the CD size is the distance between them).
		const eocd = raw.length - 22;
		const cdOffset = view.getUint32(eocd + 16, true);
		expect(view.getUint16(eocd + 8, true)).toBe(3);
		expect(view.getUint16(eocd + 10, true)).toBe(3);
		expect(view.getUint32(eocd + 12, true)).toBe(eocd - cdOffset);
		// The CD starts immediately after the last entry's data: its local header + 30-byte fixed part + 14-byte name + data.
		const last = entries[2];
		expect(cdOffset).toBe((last?.localHeaderOffset ?? 0) + 30 + 14 + (last?.size ?? 0));
	});

	it("encodes name lengths in UTF-8 BYTES in both headers for a multi-byte name", async () => {
		const writer = new ZipStreamWriter();
		const name = "vídeo é.webm";
		const nameBytes = new TextEncoder().encode(name);
		expect(nameBytes.length).toBe(14);
		await writer.add({ name, blob: new Blob([bytesOf(8, 9)]) });
		const raw = await collect(await writer.finish());
		const view = new DataView(raw.buffer);
		const entries = readZipEntries(raw);
		expect(entries[0]?.name).toBe(name);
		// Local name length at +26; the single central record starts at the EOCD's CD offset, its name length at +28.
		const eocd = raw.length - 22;
		const cdStart = view.getUint32(eocd + 16, true);
		expect(view.getUint16((entries[0]?.localHeaderOffset ?? 0) + 26, true)).toBe(14);
		expect(view.getUint16(cdStart + 28, true)).toBe(14);
	});

	it("sets the UTF-8 flag only for non-ASCII names and encodes name lengths in bytes", async () => {
		const writer = new ZipStreamWriter();
		await writer.add({ name: "plain.webm", blob: new Blob([bytesOf(4, 3)]) });
		await writer.add({ name: "vídeo é.webm", blob: new Blob([bytesOf(4, 4)]) });
		const raw = await collect(await writer.finish());
		const view = new DataView(raw.buffer);
		const entries = readZipEntries(raw);
		expect(entries).toHaveLength(2);
		expect(view.getUint16((entries[0]?.localHeaderOffset ?? 0) + 6, true)).toBe(0);
		expect(view.getUint16((entries[1]?.localHeaderOffset ?? 0) + 6, true)).toBe(0x0800);
		expect(new TextEncoder().encode("vídeo é.webm").length).toBe(14);
	});

	it("writes the 1980 DOS floor timestamp and classic version in local headers", async () => {
		const writer = new ZipStreamWriter();
		await writer.add({ name: "x.webm", blob: new Blob([bytesOf(4, 5)]) });
		const raw = await collect(await writer.finish());
		const view = new DataView(raw.buffer);
		expect(view.getUint32(0, true)).toBe(0x04034b50);
		expect(view.getUint16(4, true)).toBe(20);
		expect(view.getUint16(8, true)).toBe(0);
		expect(view.getUint16(10, true)).toBe(0);
		expect(view.getUint16(12, true)).toBe(0x0021);
	});

	it("records zero CRC and sizes for an empty entry", async () => {
		const writer = new ZipStreamWriter();
		await writer.add({ name: "empty.bin", blob: new Blob([]) });
		const entries = readZipEntries(await collect(await writer.finish()));
		expect(entries[0]?.crc).toBe(0);
		expect(entries[0]?.size).toBe(0);
		expect(entries[0]?.data.length).toBe(0);
	});

	it("rejects a name past the 0xFFFF byte limit", async () => {
		const writer = new ZipStreamWriter();
		await expect(writer.add({ name: "x".repeat(0x10000) + ".webm", blob: new Blob([]) })).rejects.toThrow(/too long/);
	});

	it("refuses to finish with zero entries", async () => {
		const writer = new ZipStreamWriter();
		await expect(writer.finish()).rejects.toThrow(/empty/);
	});
});
