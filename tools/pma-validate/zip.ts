/**
 * Random-access ZIP plumbing for the validator. Nothing here loads the archive into memory:
 * yauzl reads the central directory from the end of the file and streams single entries.
 */
import { open as openFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

export interface EntryInfo {
	name: string;
	/** 0 = stored, 8 = deflated */
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	isDirectory: boolean;
}

export interface RawEntry {
	/** position in the central directory */
	index: number;
	info: EntryInfo;
	entry: Entry;
	/** false when the name bytes are not valid UTF-8 */
	nameIsUtf8: boolean;
	localHeaderOffset: number;
	encrypted: boolean;
}

const FOUR_GIB = 0xffffffff;

/**
 * Names are decoded here rather than by yauzl (`decodeStrings: false`): yauzl aborts the whole
 * archive on the first unsafe name, and the validator wants to report every one of them.
 */
export function openZip(path: string): Promise<ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(
			path,
			{
				lazyEntries: true,
				autoClose: false,
				decodeStrings: false,
				validateEntrySizes: true,
				strictFileNames: false
			},
			(err, zip) => (err ? reject(err) : resolve(zip))
		);
	});
}

export function listEntries(zip: ZipFile): Promise<RawEntry[]> {
	return new Promise((resolve, reject) => {
		const out: RawEntry[] = [];
		const strict = new TextDecoder('utf-8', { fatal: true });
		zip.on('error', reject);
		zip.on('end', () => resolve(out));
		zip.on('entry', (entry: Entry) => {
			const raw: Buffer = entry.fileNameRaw ?? (entry.fileName as unknown as Buffer);
			let name: string;
			let nameIsUtf8 = true;
			try {
				name = strict.decode(raw);
			} catch {
				name = raw.toString('latin1');
				nameIsUtf8 = false;
			}
			out.push({
				index: out.length,
				info: {
					name,
					compressionMethod: entry.compressionMethod,
					compressedSize: entry.compressedSize,
					uncompressedSize: entry.uncompressedSize,
					isDirectory: name.endsWith('/')
				},
				entry,
				nameIsUtf8,
				localHeaderOffset: entry.relativeOffsetOfLocalHeader,
				encrypted: entry.isEncrypted()
			});
			zip.readEntry();
		});
		zip.readEntry();
	});
}

export function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
	});
}

const nativeCrc32 = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

/** Streams one entry through `onChunk`, verifying size (yauzl) and CRC-32 (when Node has it). */
export async function streamEntry(
	zip: ZipFile,
	entry: Entry,
	onChunk: (chunk: Buffer) => void
): Promise<void> {
	const stream = await openEntryStream(zip, entry);
	let crc = 0;
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		if (nativeCrc32) crc = nativeCrc32(chunk, crc);
		onChunk(chunk);
	}
	if (nativeCrc32 && crc >>> 0 !== entry.crc32 >>> 0) {
		throw new Error('CRC-32 mismatch');
	}
}

export async function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await streamEntry(zip, entry, (chunk) => chunks.push(chunk));
	return Buffer.concat(chunks);
}

/**
 * Does the archive use Zip64 structures? True when a Zip64 end-of-central-directory locator
 * (signature 0x07064b50) sits directly before the end-of-central-directory record, or when any
 * entry count/size/offset exceeds what the classic structures can express.
 */
export async function detectZip64(path: string, entries: RawEntry[]): Promise<boolean> {
	if (entries.length > 0xffff) return true;
	for (const e of entries) {
		if (
			e.info.compressedSize >= FOUR_GIB ||
			e.info.uncompressedSize >= FOUR_GIB ||
			e.localHeaderOffset >= FOUR_GIB
		) {
			return true;
		}
	}
	const file = await openFile(path, 'r');
	try {
		const { size } = await file.stat();
		// EOCD is 22 bytes + up to 65535 bytes of comment; the locator is the 20 bytes before it.
		const length = Math.min(size, 22 + 0xffff + 20);
		const tail = Buffer.alloc(length);
		await file.read(tail, 0, length, size - length);
		for (let i = tail.length - 22; i >= 0; i--) {
			if (tail.readUInt32LE(i) !== 0x06054b50) continue;
			if (tail.readUInt16LE(i + 20) !== tail.length - i - 22) continue; // comment length must fit
			return i >= 20 && tail.readUInt32LE(i - 20) === 0x07064b50;
		}
		return false;
	} finally {
		await file.close();
	}
}
