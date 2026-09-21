/**
 * A deliberately tiny ZIP writer for test fixtures.
 *
 * Normal ZIP libraries refuse to write unsafe entry names such as `../evil.gpx`; the fixtures
 * need exactly those. Supports stored (method 0) and deflated (method 8) entries, UTF-8 names,
 * no Zip64, no data descriptors. Not for production use.
 */
import { writeFileSync } from 'node:fs';
import * as zlib from 'node:zlib';

export interface ZipInput {
	name: string;
	data: string | Uint8Array;
	/** true = stored (method 0); default is deflate (method 8) */
	store?: boolean;
}

let table: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
	const native = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;
	if (typeof native === 'function') return native(data) >>> 0;
	if (!table) {
		table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of data) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

const DOS_TIME = (12 << 11) | (0 << 5) | 0; // 12:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (9 << 5) | 21; // 2026-09-21
const FLAG_UTF8 = 0x0800;

export function buildZip(inputs: ZipInput[]): Buffer {
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;

	for (const input of inputs) {
		const name = Buffer.from(input.name, 'utf8');
		const raw = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data;
		const method = input.store ? 0 : 8;
		const body = input.store ? Buffer.from(raw) : zlib.deflateRawSync(raw, { level: 6 });
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(FLAG_UTF8, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28); // extra length

		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4); // version made by
		header.writeUInt16LE(20, 6); // version needed
		header.writeUInt16LE(FLAG_UTF8, 8);
		header.writeUInt16LE(method, 10);
		header.writeUInt16LE(DOS_TIME, 12);
		header.writeUInt16LE(DOS_DATE, 14);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(body.length, 20);
		header.writeUInt32LE(raw.length, 24);
		header.writeUInt16LE(name.length, 28);
		// extra length, comment length, disk number, internal attrs, external attrs: all zero
		header.writeUInt32LE(offset, 42);

		chunks.push(local, name, body);
		central.push(header, name);
		offset += local.length + name.length + body.length;
	}

	const centralSize = central.reduce((sum, b) => sum + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(inputs.length, 8);
	end.writeUInt16LE(inputs.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);

	return Buffer.concat([...chunks, ...central, end]);
}

export function writeZip(path: string, inputs: ZipInput[]): void {
	writeFileSync(path, buildZip(inputs));
}
