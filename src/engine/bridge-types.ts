/** What a bridged request resolves or fails with. No browser APIs here, so anything may import it. */
import type { BodyKind } from './bridge-protocol';

export interface BridgeResponse {
	status: number;
	headers: Record<string, string>;
	redirected: boolean;
	url: string;
	/** 'stream' when the body was delivered through onChunk. */
	bodyKind: BodyKind | 'stream';
	json?: unknown;
}

/** The source tab closed, navigated, was discarded or reloaded. Recoverable. */
export class TabLostError extends Error {
	constructor(message = 'source tab lost') {
		super(message);
		this.name = 'TabLostError';
	}
}

/** fetch() itself failed inside the tab: offline, DNS, dropped connection, system sleep. */
export class BridgeNetworkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BridgeNetworkError';
	}
}

/** The executor refused the request (origin not allowlisted). A bug, never retried. */
export class BridgeRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BridgeRefusedError';
	}
}
