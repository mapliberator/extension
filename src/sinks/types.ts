/** Where archive bytes go. The ZIP writer and adapters do not know which sink is in use. */
export interface ArchiveSink {
	open(filename: string): Promise<void>;
	write(chunk: Uint8Array): Promise<void>;
	/** Finalize. For OpfsSink the page then hands the staged file to the downloads API. */
	close(): Promise<void>;
	/** Leave nothing behind. */
	abort(): Promise<void>;
}

export type SinkKind = 'opfs' | 'direct';

export type SinkSpec =
	{ kind: 'opfs'; runId: string } | { kind: 'direct'; handle: FileSystemFileHandle };

export const EXPORTS_DIR = 'exports';
