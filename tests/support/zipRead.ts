// Structural zip reader used only by tests to verify archives the writer produces.
// It parses the EOCD + central directory and slices each entry's stored data back out; it deliberately understands nothing about the upload-format semantics that analyzeZip enforces.

export interface ZipReadEntry {
	name: string;
	method: number;
	crc: number;
	size: number;
	localHeaderOffset: number;
	data: Uint8Array;
}

export function readZipEntries(bytes: Uint8Array): ZipReadEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocd = findEocd(bytes, view);
	const count = view.getUint16(eocd + 10, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	const entries: ZipReadEntry[] = [];
	let p = cdOffset;
	for (let i = 0; i < count; i++) {
		if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`Bad central directory signature at ${p}.`);
		const method = view.getUint16(p + 10, true);
		const crc = view.getUint32(p + 16, true);
		const size = view.getUint32(p + 24, true);
		const nameLength = view.getUint16(p + 28, true);
		const localHeaderOffset = view.getUint32(p + 42, true);
		const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
		const localNameLength = view.getUint16(localHeaderOffset + 26, true);
		const extraLength = view.getUint16(localHeaderOffset + 28, true);
		const dataStart = localHeaderOffset + 30 + localNameLength + extraLength;
		entries.push({ name, method, crc, size, localHeaderOffset, data: bytes.subarray(dataStart, dataStart + size) });
		p += 46 + nameLength;
	}
	return entries;
}

function findEocd(bytes: Uint8Array, view: DataView): number {
	const min = Math.max(0, bytes.length - 22 - 0xffff);
	for (let p = bytes.length - 22; p >= min; p--) {
		if (view.getUint32(p, true) === 0x06054b50) return p;
	}
	throw new Error("No EOCD record found.");
}
