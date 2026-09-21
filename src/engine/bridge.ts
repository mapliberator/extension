/**
 * Source-tab lifecycle and the export-page end of the Port protocol (PRD §5.2).
 *
 * The export page owns a dedicated, inactive tab on the source origin and uses it as a stateless
 * fetch executor, so the browser supplies authentication itself and the extension never touches
 * cookies or tokens. Tab death surfaces as a Port disconnect and is recoverable.
 */
import type { BridgeRequest, SourceId } from '../shared/models';
import {
	BRIDGE_PORT_NAME,
	BridgeEventSchema,
	type BodyKind,
	type BridgeCommand,
	type BridgeEvent
} from './bridge-protocol';

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

interface Pending {
	resolve: (response: BridgeResponse) => void;
	reject: (error: Error) => void;
	onChunk?: (chunk: string) => Promise<void>;
	head?: Omit<BridgeResponse, 'bodyKind' | 'json'>;
	/** Serializes chunk handling so acks go out in order. */
	chain: Promise<void>;
}

export interface BridgeTarget {
	id: SourceId;
	bridgeUrl: string;
	loginUrl: string;
}

const TAB_LOAD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 10_000;

export class SourceBridge {
	private tabId: number | null = null;
	private port: Browser.runtime.Port | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private connecting: Promise<void> | null = null;
	private closed = false;

	constructor(private readonly target: BridgeTarget) {}

	get sourceTabId(): number | null {
		return this.tabId;
	}

	/** Make sure a tab exists, the executor is injected and the Port is open. */
	ensureReady(): Promise<void> {
		if (this.closed) return Promise.reject(new TabLostError('bridge closed'));
		if (this.port) return Promise.resolve();
		this.connecting ??= this.connect().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	/** Drop whatever is left of the old tab connection and build a fresh one. */
	async recover(): Promise<void> {
		this.dropPort();
		await this.ensureReady();
	}

	private async connect(): Promise<void> {
		// 1. Existing tab still on the source origin (e.g. the user just signed in there)?
		if (this.tabId !== null && (await this.tryAttach(this.tabId))) return;
		// 2. Existing tab that wandered elsewhere: bring it back to the parking page.
		if (this.tabId !== null) {
			try {
				const loaded = waitForTabLoad(this.tabId);
				loaded.catch(() => {});
				await browser.tabs.update(this.tabId, { url: this.target.bridgeUrl });
				await loaded;
				if (await this.tryAttach(this.tabId)) return;
			} catch {
				// tab is gone
			}
			await this.removeTab();
		}
		// 3. A fresh dedicated tab. The user's own browsing tab is never borrowed.
		const tab = await browser.tabs.create({ url: this.target.bridgeUrl, active: false });
		if (tab.id === undefined) throw new TabLostError('could not create source tab');
		this.tabId = tab.id;
		if (tab.status !== 'complete') await waitForTabLoad(tab.id);
		try {
			await browser.tabs.update(tab.id, { autoDiscardable: false });
		} catch {
			// not supported everywhere; the Port disconnect path covers discards
		}
		if (!(await this.tryAttach(tab.id))) {
			throw new TabLostError('could not reach the source tab');
		}
	}

	private async tryAttach(tabId: number): Promise<boolean> {
		try {
			await browser.scripting.executeScript({
				target: { tabId },
				files: ['/source-executor.js']
			});
		} catch {
			return false;
		}
		let port: Browser.runtime.Port;
		try {
			port = browser.tabs.connect(tabId, { name: BRIDGE_PORT_NAME });
		} catch {
			return false;
		}
		const ready = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
			const finish = (ok: boolean) => {
				clearTimeout(timer);
				port.onMessage.removeListener(onMessage);
				port.onDisconnect.removeListener(onDisconnect);
				resolve(ok);
			};
			const onMessage = (message: unknown) => {
				const event = BridgeEventSchema.safeParse(message);
				if (event.success && event.data.type === 'ready') finish(true);
				else if (event.success && event.data.type === 'refused') finish(false);
			};
			const onDisconnect = () => finish(false);
			port.onMessage.addListener(onMessage);
			port.onDisconnect.addListener(onDisconnect);
			port.postMessage({ type: 'init', adapter: this.target.id } satisfies BridgeCommand);
		});
		if (!ready) {
			try {
				port.disconnect();
			} catch {
				// already gone
			}
			return false;
		}
		port.onMessage.addListener((message: unknown) => this.onMessage(message));
		port.onDisconnect.addListener(() => {
			if (this.port === port) this.dropPort();
		});
		this.port = port;
		return true;
	}

	private dropPort(): void {
		const port = this.port;
		this.port = null;
		try {
			port?.disconnect();
		} catch {
			// already gone
		}
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) entry.reject(new TabLostError());
	}

	private onMessage(message: unknown): void {
		const parsed = BridgeEventSchema.safeParse(message);
		if (!parsed.success) return; // not ours, or malformed: never trusted
		const event: BridgeEvent = parsed.data;
		if (event.type === 'ready' || event.type === 'refused') return;
		const entry = this.pending.get(event.id);
		if (!entry) return;

		switch (event.type) {
			case 'response': {
				this.pending.delete(event.id);
				const { type: _type, id: _id, ...response } = event;
				entry.resolve(response);
				return;
			}
			case 'head': {
				const { type: _type, id: _id, ...head } = event;
				entry.head = head;
				return;
			}
			case 'chunk': {
				entry.chain = entry.chain
					.then(() => entry.onChunk?.(event.chunk))
					.then(
						() => this.post({ type: 'ack', id: event.id }),
						(error: unknown) => {
							// The consumer gave up (failed GPX check, cancel): stop the stream.
							this.pending.delete(event.id);
							this.post({ type: 'abort', id: event.id });
							entry.reject(error instanceof Error ? error : new Error(String(error)));
						}
					);
				return;
			}
			case 'end': {
				void entry.chain.then(() => {
					if (!this.pending.delete(event.id)) return;
					if (!entry.head) return entry.reject(new BridgeNetworkError('stream ended early'));
					entry.resolve({ ...entry.head, bodyKind: 'stream' });
				});
				return;
			}
			case 'error': {
				this.pending.delete(event.id);
				entry.reject(
					event.error === 'refused'
						? new BridgeRefusedError(event.message)
						: new BridgeNetworkError(event.message)
				);
				return;
			}
		}
	}

	private post(command: BridgeCommand): void {
		try {
			this.port?.postMessage(command);
		} catch {
			this.dropPort();
		}
	}

	/**
	 * Perform one request in the source tab. Text streams are delivered through `onChunk`; the
	 * next chunk is requested only after `onChunk` resolves, so backpressure crosses the bridge.
	 */
	async request(
		request: BridgeRequest,
		onChunk?: (chunk: string) => Promise<void>
	): Promise<BridgeResponse> {
		await this.ensureReady();
		const id = this.nextId++;
		return new Promise<BridgeResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onChunk, chain: Promise.resolve() });
			this.post({ type: 'request', id, ...request });
		});
	}

	/** Bring the source tab forward on the sign-in page so the user can re-authenticate. */
	async showLogin(): Promise<void> {
		if (this.tabId === null) {
			const tab = await browser.tabs.create({ url: this.target.loginUrl, active: true });
			this.tabId = tab.id ?? null;
			return;
		}
		try {
			await browser.tabs.update(this.tabId, { url: this.target.loginUrl, active: true });
		} catch {
			this.tabId = null;
			await this.showLogin();
		}
	}

	private async removeTab(): Promise<void> {
		const tabId = this.tabId;
		this.tabId = null;
		if (tabId === null) return;
		try {
			await browser.tabs.remove(tabId);
		} catch {
			// already closed
		}
	}

	/** Close the dedicated tab. Part of cancel and of normal completion. */
	async close(): Promise<void> {
		this.closed = true;
		this.dropPort();
		await this.removeTab();
	}
}

function waitForTabLoad(tabId: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			settled = true;
			clearTimeout(timer);
			clearInterval(poll);
			browser.tabs.onUpdated.removeListener(onUpdated);
			browser.tabs.onRemoved.removeListener(onRemoved);
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(); // try to inject anyway; failure is handled by the caller
		}, TAB_LOAD_TIMEOUT_MS);
		const onUpdated = (id: number, info: { status?: string }) => {
			if (id !== tabId || info.status !== 'complete') return;
			cleanup();
			resolve();
		};
		const onRemoved = (id: number) => {
			if (id !== tabId) return;
			cleanup();
			reject(new TabLostError('source tab closed while loading'));
		};
		browser.tabs.onUpdated.addListener(onUpdated);
		browser.tabs.onRemoved.addListener(onRemoved);
		// The load may have finished before the listener was attached.
		const poll = setInterval(() => {
			browser.tabs.get(tabId).then(
				(tab) => {
					if (tab.status === 'complete' && !settled) {
						cleanup();
						resolve();
					}
				},
				() => {}
			);
		}, 500);
	});
}
