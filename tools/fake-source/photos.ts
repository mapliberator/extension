/** Deterministic photo bodies, streamed from one shared pseudo-random block. */
import type { ServerResponse } from 'node:http';
import { fnv1a, mulberry32 } from './dataset.ts';

export type PhotoMime = 'image/jpeg' | 'image/png' | 'image/heic';

export interface PhotoSpec {
	/** Distinguishes the bytes: photo id plus rendition. */
	key: string;
	size: number;
	mime: PhotoMime;
}

const BLOCK_SIZE = 1 << 20;
const HEADER_SIZE = 64;
const MAX_CHUNK = 256 * 1024;

let block: Buffer | null = null;

function sharedBlock(): Buffer {
	if (block) return block;
	const b = Buffer.allocUnsafe(BLOCK_SIZE);
	const rng = mulberry32(0x5eedf00d);
	for (let i = 0; i < BLOCK_SIZE; i += 4) b.writeUInt32LE(Math.floor(rng() * 4294967296), i);
	block = b;
	return b;
}

const MAGIC: Record<PhotoMime, number[]> = {
	// SOI + APP0 'JFIF'
	'image/jpeg': [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01],
	'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	// ftyp box, major brand 'heic'
	'image/heic': [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]
};

/** Magic bytes followed by a per-photo ASCII tag, zero-padded to 64 bytes. */
export function photoHeader(spec: PhotoSpec): Buffer {
	const header = Buffer.alloc(HEADER_SIZE);
	const magic = MAGIC[spec.mime];
	header.set(magic, 0);
	header.write(`fake-source:${spec.key}`, magic.length, HEADER_SIZE - magic.length, 'latin1');
	return header.subarray(0, Math.min(HEADER_SIZE, spec.size));
}

/**
 * Streams `spec.size` bytes with backpressure. Only views of the shared block are written, so
 * memory use is independent of the photo size. Safe against the client going away mid-stream.
 */
export function streamPhoto(res: ServerResponse, spec: PhotoSpec, headOnly: boolean): void {
	res.writeHead(200, {
		'Content-Type': spec.mime,
		'Content-Length': String(spec.size),
		'Cache-Control': 'public, max-age=3600'
	});
	if (headOnly) {
		res.end();
		return;
	}
	const data = sharedBlock();
	const header = photoHeader(spec);
	let remaining = spec.size - header.length;
	let offset = fnv1a(spec.key) % BLOCK_SIZE;
	let closed = false;

	const pump = (): void => {
		while (!closed && remaining > 0) {
			const n = Math.min(remaining, MAX_CHUNK, BLOCK_SIZE - offset);
			const chunk = data.subarray(offset, offset + n);
			offset = (offset + n) % BLOCK_SIZE;
			remaining -= n;
			if (!res.write(chunk)) {
				res.once('drain', pump);
				return;
			}
		}
		if (!closed) res.end();
	};
	res.once('close', () => {
		closed = true;
		res.removeListener('drain', pump);
	});
	res.write(header);
	pump();
}
