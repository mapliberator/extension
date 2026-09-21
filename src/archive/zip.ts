/**
 * Streaming ZIP writer on top of zip.js. Runs inside the worker; bytes flow straight into an
 * ArchiveSink and are never accumulated. Zip64 kicks in automatically.
 */
import { BlobReader, configure, ZipWriter } from '@zip.js/zip.js';
import type { ArchiveSink } from '../sinks/types';

// We already are a worker; zip.js must not try to spawn its own.
configure({ useWebWorkers: false });

const TEXT_LEVEL = 5;

export class ArchiveWriter {
	private readonly zip: ZipWriter<unknown>;
	private readonly encoder = new TextEncoder();
	private sinkError: unknown = null;
	bytesWritten = 0;

	constructor(
		private readonly sink: ArchiveSink,
		onProgress?: (bytesWritten: number) => void
	) {
		const writable = new WritableStream<Uint8Array>(
			{
				write: async (chunk) => {
					try {
						await this.sink.write(chunk);
					} catch (error) {
						this.sinkError ??= error;
						throw error;
					}
					this.bytesWritten += chunk.byteLength;
					onProgress?.(this.bytesWritten);
				}
			},
			// One chunk in flight: the sink is the end of a single backpressure chain.
			new CountQueuingStrategy({ highWaterMark: 1 })
		);
		this.zip = new ZipWriter(writable, { keepOrder: true, bufferedWrite: false });
	}

	/** A failed sink is fatal for the whole archive, whatever zip.js reports. */
	private async guard<T>(operation: Promise<T>): Promise<T> {
		try {
			return await operation;
		} catch (error) {
			throw this.sinkError ?? error;
		}
	}

	async addText(path: string, text: string): Promise<number> {
		const bytes = this.encoder.encode(text);
		await this.addBytes(path, [bytes]);
		return bytes.byteLength;
	}

	/** Deflated entry from in-memory chunks (GPX, JSON). */
	async addBytes(path: string, chunks: Uint8Array[]): Promise<void> {
		const blob = new Blob(chunks as BlobPart[]);
		// Known size: no Zip64 extra field and no guessing for small text entries.
		await this.guard(this.zip.add(path, new BlobReader(blob), { level: TEXT_LEVEL }));
	}

	/** Deflated entry from a stream of unknown length (aggregated GeoJSON). */
	async addTextStream(path: string, readable: ReadableStream<Uint8Array>): Promise<void> {
		await this.guard(this.zip.add(path, readable, { level: TEXT_LEVEL }));
	}

	/** Stored entry: photos and other already-compressed assets pass through untouched. */
	async addStored(path: string, readable: ReadableStream<Uint8Array>): Promise<void> {
		await this.guard(this.zip.add(path, readable, { level: 0 }));
	}

	async close(): Promise<void> {
		await this.guard(this.zip.close(undefined, { preventClose: true }));
	}
}
