/**
 * DirectFileSink — Chromium fast path (PRD §10.2). Writes go to a browser-managed swap file that
 * replaces the target only on close(); abort() discards it, so cancelling leaves no partial file.
 */
import { QuotaError } from '../shared/errors';
import type { ArchiveSink } from './types';

export class DirectFileSink implements ArchiveSink {
	private stream: FileSystemWritableFileStream | null = null;
	private written = 0;

	constructor(private readonly handle: FileSystemFileHandle) {}

	async open(): Promise<void> {
		this.stream = await this.handle.createWritable({ keepExistingData: false });
		this.written = 0;
	}

	async write(chunk: Uint8Array): Promise<void> {
		if (!this.stream) throw new Error('DirectFileSink is not open');
		try {
			await this.stream.write(chunk as Uint8Array<ArrayBuffer>);
		} catch (error) {
			if ((error as DOMException).name === 'QuotaExceededError') throw new QuotaError(this.written);
			throw error;
		}
		this.written += chunk.byteLength;
	}

	async close(): Promise<void> {
		await this.stream?.close();
		this.stream = null;
	}

	async abort(): Promise<void> {
		const stream = this.stream;
		this.stream = null;
		try {
			await stream?.abort();
		} catch {
			// already closed or errored; the swap file is gone either way
		}
	}
}
