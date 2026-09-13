// A streaming STORED-entry zip writer for video-sized Blobs.
// Entries assemble as a parts list — small header arrays plus the entry Blob by REFERENCE — so peak memory stays independent of the payload, and `finish()` hands back one `application/zip` Blob the browser pages to disk on its own.
// Each entry's CRC is computed first with a streaming pass over `blob.stream()`, because the local header must carry the real CRC before the data (no data descriptors; general-purpose bit 3 stays clear).
// The writer intentionally supports only the classic format (no zip64): any entry count, size, or offset that would need zip64 throws a user-facing error instead of emitting a corrupt archive — the batch sizes this serves (tens of videos, well under 4 GiB) never approach those limits.
//
// Byte layout follows the APPNOTE 6.3.10 record definitions: local file header (30 bytes + name), central directory header (46 bytes + name), and EOCD (22 bytes), all little-endian.
// Names travel as UTF-8 with general-purpose bit 11 set only when they are not ASCII; the DOS timestamp is the fixed 1980-01-01 floor (date 0x0021, time 0x0000), which carries no meaning for generated videos.

import { incrementalCrc32 } from "./zip.js";

export interface ZipEntryInput {
	name: string;
	blob: Blob;
}

export interface ZipCapacity {
	/** Number of entries the archive will contain. */
	entryCount: number;
	/** Projected total archive bytes including local headers, central directory, and EOCD. */
	totalBytes: number;
	/** Largest single entry's uncompressed byte size. */
	maxEntryBytes: number;
}

// Zip64 becomes necessary past these classic-format limits; sizes and offsets equal to 0xFFFFFFFF are the zip64 sentinels themselves, so anything at or past that line is treated as over it (conservatively, matching Info-ZIP / Go practice). The entry count is different: it lives in a uint16 field where 0xFFFF fits and is written literally, so only counts past it overflow.
const MAX_ENTRIES = 0xffff;
const MAX_FIELD = 0xffffffff;

/** Throws a user-facing Error when any zip64 condition would be hit, so a corrupt archive can never be emitted. */
export function assertZipCapacity(cap: ZipCapacity): void {
	if (cap.entryCount > MAX_ENTRIES) throw new Error("Too many files for a single zip.");
	if (cap.maxEntryBytes >= MAX_FIELD) throw new Error("A file in the zip is too large.");
	if (cap.totalBytes >= MAX_FIELD) throw new Error("The resulting zip would be too large.");
}

/**
 * Collision-unique zip entry naming: `stem.ext`, then `stem (2).ext`, `stem (3).ext`, …
 * Membership checks and recording are both done on the LOWERCASED name, so seed `used` with lowercase names (or populate it only through this function).
 * The suffix is applied before the writer's own name-length check, so stems already near the 0xFFFF-byte limit can still be rejected by add().
 */
export function uniqueEntryName(stem: string, ext: string, used: Set<string>): string {
	const bare = entryNameVariant(stem, ext, 1);
	if (!used.has(bare.toLowerCase())) {
		used.add(bare.toLowerCase());
		return bare;
	}
	for (let n = 2; ; n++) {
		const candidate = entryNameVariant(stem, ext, n);
		if (!used.has(candidate.toLowerCase())) {
			used.add(candidate.toLowerCase());
			return candidate;
		}
	}
}

function entryNameVariant(stem: string, ext: string, n: number): string {
	const suffix = n === 1 ? "" : ` (${n})`;
	return ext === "" ? `${stem}${suffix}` : `${stem}${suffix}.${ext}`;
}

export class ZipStreamWriter {
	private parts: BlobPart[] = [];
	private offset = 0;
	// Running total of the central-directory bytes every accumulated record will occupy; the per-add capacity projection needs it because the CD itself is only written at finish().
	private cdBytes = 0;
	private records: { nameBytes: Uint8Array; ascii: boolean; crc: number; size: number; localOffset: number }[] = [];

	get entryCount(): number {
		return this.records.length;
	}

	get totalBytes(): number {
		return this.offset;
	}

	/** Streams the entry's bytes once for the CRC, then appends the local header and the Blob itself (referenced, never copied). */
	async add(entry: ZipEntryInput): Promise<void> {
		const nameBytes = new TextEncoder().encode(entry.name);
		if (nameBytes.length > 0xffff) throw new Error("A file name in the zip is too long.");
		// Fail fast on an oversized entry before streaming its bytes for the CRC.
		if (entry.blob.size >= MAX_FIELD) throw new Error("A file in the zip is too large.");
		const crc = incrementalCrc32();
		const reader = entry.blob.stream().getReader();
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			if (next.value) crc.update(next.value);
		}
		const value = crc.digest();
		const size = entry.blob.size;
		// The projection is the exact final archive size if nothing else is added: data written so far, this entry's local header + data, every record's central bytes (including this one), and the EOCD.
		assertZipCapacity({ entryCount: this.records.length + 1, totalBytes: this.offset + this.cdBytes + 30 + nameBytes.length + size + 46 + nameBytes.length + 22, maxEntryBytes: size });
		const ascii = nameBytes.every((b) => b < 0x80);
		const localOffset = this.offset;
		const header = new Uint8Array(30 + nameBytes.length);
		const view = new DataView(header.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(6, ascii ? 0 : 0x0800, true);
		view.setUint16(8, 0, true);
		view.setUint16(10, 0, true);
		view.setUint16(12, 0x0021, true);
		view.setUint32(14, value, true);
		view.setUint32(18, size, true);
		view.setUint32(22, size, true);
		view.setUint16(26, nameBytes.length, true);
		view.setUint16(28, 0, true);
		header.set(nameBytes, 30);
		this.parts.push(header, entry.blob);
		this.records.push({ nameBytes, ascii, crc: value, size, localOffset });
		this.cdBytes += 46 + nameBytes.length;
		this.offset += 30 + nameBytes.length + size;
	}

	/** Appends the central directory and EOCD, returning the finished archive. Throws when no entry was added. */
	async finish(): Promise<Blob> {
		if (this.records.length === 0) throw new Error("Refusing to assemble an empty zip.");
		// Belt re-check with the exact final totals (add() projects per-entry; this closes any drift, e.g. a caller that kept adding right up to the line).
		const maxEntry = this.records.reduce((m, r) => Math.max(m, r.size), 0);
		assertZipCapacity({ entryCount: this.records.length, totalBytes: this.offset + this.cdBytes + 22, maxEntryBytes: maxEntry });
		const cdOffset = this.offset;
		for (const rec of this.records) {
			const header = new Uint8Array(46 + rec.nameBytes.length);
			const view = new DataView(header.buffer);
			view.setUint32(0, 0x02014b50, true);
			view.setUint16(4, 20, true);
			view.setUint16(6, 20, true);
			view.setUint16(8, rec.ascii ? 0 : 0x0800, true);
			view.setUint16(10, 0, true);
			view.setUint16(12, 0, true);
			view.setUint16(14, 0x0021, true);
			view.setUint32(16, rec.crc, true);
			view.setUint32(20, rec.size, true);
			view.setUint32(24, rec.size, true);
			view.setUint16(28, rec.nameBytes.length, true);
			view.setUint16(30, 0, true);
			view.setUint16(32, 0, true);
			view.setUint16(34, 0, true);
			view.setUint16(36, 0, true);
			view.setUint32(38, 0, true);
			view.setUint32(42, rec.localOffset, true);
			header.set(rec.nameBytes, 46);
			this.parts.push(header);
			this.offset += header.length;
		}
		const eocd = new Uint8Array(22);
		const view = new DataView(eocd.buffer);
		view.setUint32(0, 0x06054b50, true);
		view.setUint16(4, 0, true);
		view.setUint16(6, 0, true);
		view.setUint16(8, this.records.length, true);
		view.setUint16(10, this.records.length, true);
		view.setUint32(12, this.offset - cdOffset, true);
		view.setUint32(16, cdOffset, true);
		view.setUint16(20, 0, true);
		this.parts.push(eocd);
		this.offset += eocd.length;
		return new Blob(this.parts, { type: "application/zip" });
	}
}
