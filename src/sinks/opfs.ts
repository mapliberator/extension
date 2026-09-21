/**
 * OpfsSink — the universal baseline (PRD §10.1).
 *
 *   ZIP stream → FileSystemSyncAccessHandle (worker) → exports/<runId>.zip
 *              → getFile() → blob URL → downloads.download()
 *              → on "complete": revoke URL, delete the OPFS file
 *
 * The sink itself runs in the worker; the page-side helpers below cover the sweep and lookup.
 */
import { QuotaError } from '../shared/errors';
import { EXPORTS_DIR, type ArchiveSink } from './types';

interface SyncAccessHandle {
	write(buffer: Uint8Array, options?: { at?: number }): number;
	flush(): void;
	close(): void;
	truncate(size: number): void;
}

type SyncCapableFileHandle = FileSystemFileHandle & {
	createSyncAccessHandle(): Promise<SyncAccessHandle>;
};

export function stagedFileName(runId: string): string {
	return `${runId}.zip`;
}

async function exportsDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
	const root = await navigator.storage.getDirectory();
	try {
		return await root.getDirectoryHandle(EXPORTS_DIR, { create });
	} catch (error) {
		if ((error as DOMException).name === 'NotFoundError') return null;
		throw error;
	}
}

export class OpfsSink implements ArchiveSink {
	private handle: SyncAccessHandle | null = null;
	private position = 0;

	constructor(private readonly runId: string) {}

	async open(): Promise<void> {
		const dir = (await exportsDirectory(true))!;
		const file = (await dir.getFileHandle(stagedFileName(this.runId), {
			create: true
		})) as SyncCapableFileHandle;
		this.handle = await file.createSyncAccessHandle();
		this.handle.truncate(0);
		this.position = 0;
	}

	async write(chunk: Uint8Array): Promise<void> {
		const handle = this.handle;
		if (!handle) throw new Error('OpfsSink is not open');
		let offset = 0;
		while (offset < chunk.byteLength) {
			let written: number;
			try {
				written = handle.write(offset === 0 ? chunk : chunk.subarray(offset), {
					at: this.position
				});
			} catch (error) {
				if ((error as DOMException).name === 'QuotaExceededError') {
					throw new QuotaError(this.position);
				}
				throw error;
			}
			if (written <= 0) throw new QuotaError(this.position);
			offset += written;
			this.position += written;
		}
	}

	async close(): Promise<void> {
		this.handle?.flush();
		this.handle?.close();
		this.handle = null;
	}

	async abort(): Promise<void> {
		try {
			this.handle?.close();
		} catch {
			// already closed
		}
		this.handle = null;
		await removeStagedFile(this.runId);
	}
}

export async function getStagedFile(runId: string): Promise<File> {
	const dir = await exportsDirectory(false);
	if (!dir) throw new Error('Staged archive not found');
	const handle = await dir.getFileHandle(stagedFileName(runId));
	return handle.getFile();
}

export async function removeStagedFile(runId: string): Promise<void> {
	const dir = await exportsDirectory(false);
	if (!dir) return;
	try {
		await dir.removeEntry(stagedFileName(runId));
	} catch (error) {
		if ((error as DOMException).name !== 'NotFoundError') throw error;
	}
}

/**
 * Orphan sweep (PRD §5.4): called by the page that holds the export lock, before any run starts,
 * so everything in `exports/` is a leftover from a crash, a killed tab or power loss.
 */
export async function sweepStagedFiles(): Promise<number> {
	const dir = await exportsDirectory(false);
	if (!dir) return 0;
	const names: string[] = [];
	for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
		names.push(name);
	}
	let removed = 0;
	for (const name of names) {
		try {
			await dir.removeEntry(name, { recursive: true });
			removed++;
		} catch {
			// Still locked by a dying worker; the next load gets it.
		}
	}
	return removed;
}

export async function listStagedFiles(): Promise<string[]> {
	const dir = await exportsDirectory(false);
	if (!dir) return [];
	const names: string[] = [];
	for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
		names.push(name);
	}
	return names;
}
