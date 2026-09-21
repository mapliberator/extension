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
	type BridgeCommand,
	type BridgeEvent
} from './bridge-protocol';

import {
	BridgeNetworkError,
	BridgeRefusedError,
	TabLostError,
	type BridgeResponse
} from './bridge-types';

export { BridgeNetworkError, BridgeRefusedError, TabLostError, type BridgeResponse };

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
/** How long a committed page may keep loading before the executor is injected anyway. */
const SETTLE_MS = 4_000;

export class SourceBridge {
	private tabId: number | null = null;
	private port: Browser.runtime.Port | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private connecting: Promise<void> | null = null;
	private closed = false;

	/** Why the source tab was unreachable or dropped, newest last. No URLs, names or IDs. */
	readonly notes: string[] = [];

	constructor(
		private readonly target: BridgeTarget,
		private readonly onNote: (note: string) => void = () => {}
	) {}

	private note(text: string): void {
		this.notes.push(text);
		if (this.notes.length > 12) this.notes.shift();
		console.warn('MapLiberator source tab —', text);
		this.onNote(text);
	}

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
		/** Why each attempt failed, for the error the user (and a bug report) ends up seeing. */
		const failures: string[] = [];
		const attach = async (tabId: number, where: string): Promise<boolean> => {
			const failure = await this.tryAttach(tabId);
			if (failure === null) return true;
			failures.push(`${where}: ${failure} [${await this.describeTab(tabId)}]`);
			return false;
		};
		const origin = new URL(this.target.bridgeUrl).origin;
		// 1. Existing tab still on the source origin (e.g. the user just signed in there)?
		if (this.tabId !== null && (await attach(this.tabId, 'existing tab'))) return;
		// 2. Existing tab that wandered elsewhere: bring it back to the parking page.
		if (this.tabId !== null) {
			try {
				await browser.tabs.update(this.tabId, { url: this.target.bridgeUrl });
				await waitForTabLoad(this.tabId, origin, true);
				if (await attach(this.tabId, 'parking page')) return;
			} catch {
				// tab is gone
			}
			await this.removeTab();
		}
		// 3. A fresh dedicated tab. The user's own browsing tab is never borrowed.
		const tab = await browser.tabs.create({ url: this.target.bridgeUrl, active: false });
		if (tab.id === undefined) throw new TabLostError('could not create source tab');
		this.tabId = tab.id;
		await waitForTabLoad(tab.id, origin, false);
		try {
			await browser.tabs.update(tab.id, { autoDiscardable: false });
		} catch {
			// not supported everywhere; the Port disconnect path covers discards
		}
		if (await attach(tab.id, 'parking page')) return;
		this.note(`could not attach: ${failures.join('; ')}`);
		throw new TabLostError(`could not reach the source tab (${failures.join('; ')})`);
	}

	/** What the browser says about the tab and our access to it. No URLs, names or IDs. */
	private async describeTab(tabId: number): Promise<string> {
		const origin = new URL(this.target.bridgeUrl).origin;
		let access = 'unknown';
		try {
			const held = await browser.permissions.contains({ origins: [`${origin}/*`] });
			access = held ? 'held' : 'NOT held';
		} catch {
			// leave unknown
		}
		try {
			const tab = await browser.tabs.get(tabId);
			// The URL is only visible to us when the tab is on a site we may access.
			const where =
				tab.url === undefined ? 'hidden' : tab.url.startsWith(origin) ? 'on site' : 'elsewhere';
			return `site access ${access}, tab ${tab.status ?? '?'}, url ${where}${tab.discarded ? ', discarded' : ''}${tab.active ? ', active' : ', background'}`;
		} catch {
			return `site access ${access}, tab gone`;
		}
	}

	/** Resolves null once attached, otherwise a short reason (no URLs, names or IDs). */
	private async tryAttach(tabId: number): Promise<string | null> {
		try {
			await browser.scripting.executeScript({
				target: { tabId },
				files: ['/source-executor.js']
			});
		} catch (error) {
			return `injection refused (${error instanceof Error ? error.message : String(error)})`;
		}
		let port: Browser.runtime.Port;
		try {
			port = browser.tabs.connect(tabId, { name: BRIDGE_PORT_NAME });
		} catch {
			return 'could not open a port';
		}
		const ready = await new Promise<string | null>((resolve) => {
			const timer = setTimeout(() => resolve('executor did not answer'), READY_TIMEOUT_MS);
			const finish = (failure: string | null) => {
				clearTimeout(timer);
				port.onMessage.removeListener(onMessage);
				port.onDisconnect.removeListener(onDisconnect);
				resolve(failure);
			};
			const onMessage = (message: unknown) => {
				const event = BridgeEventSchema.safeParse(message);
				if (event.success && event.data.type === 'ready') finish(null);
				else if (event.success && event.data.type === 'refused')
					finish('executor refused the page');
			};
			const onDisconnect = () => finish('port closed before the executor answered');
			port.onMessage.addListener(onMessage);
			port.onDisconnect.addListener(onDisconnect);
			port.postMessage({ type: 'init', adapter: this.target.id } satisfies BridgeCommand);
		});
		if (ready !== null) {
			try {
				port.disconnect();
			} catch {
				// already gone
			}
			return ready;
		}
		port.onMessage.addListener((message: unknown) => this.onMessage(message));
		port.onDisconnect.addListener(() => {
			if (this.port !== port) return;
			// The tab navigated, reloaded, was discarded or closed underneath us.
			const reason = browser.runtime.lastError?.message;
			if (!this.closed) {
				this.note(
					`connection dropped with ${this.pending.size} request(s) in flight` +
						(reason ? ` (${reason})` : '')
				);
			}
			this.dropPort();
		});
		this.port = port;
		return null;
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

/**
 * Resolves once the tab has really arrived on `origin`. A bare "status: complete" is not enough:
 * a fresh tab reports it for its initial blank page, and a tab that was just told to navigate
 * still reports it for the page it is about to leave. Injecting then fails with "Missing host
 * permission for the tab". What cannot be faked is the tab's URL being visible to us and on the
 * origin — the browser only shows it once that document has committed.
 */
function waitForTabLoad(tabId: number, origin: string, navigating: boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		/** After `tabs.update`, the old page must be seen to go before the new one counts. */
		let left = !navigating;
		let arrivedAt: number | null = null;
		const cleanup = () => {
			clearTimeout(timer);
			clearInterval(poll);
			browser.tabs.onRemoved.removeListener(onRemoved);
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(); // try to inject anyway; failure is handled by the caller
		}, TAB_LOAD_TIMEOUT_MS);
		const onRemoved = (id: number) => {
			if (id !== tabId) return;
			cleanup();
			reject(new TabLostError('source tab closed while loading'));
		};
		browser.tabs.onRemoved.addListener(onRemoved);
		const poll = setInterval(() => {
			browser.tabs.get(tabId).then(
				(tab) => {
					const onSite = tab.url !== undefined && tab.url.startsWith(`${origin}/`);
					// A navigation that never shows up as "loading" (served from cache) still counts
					// after a moment.
					if (!left && (tab.status === 'loading' || !onSite || Date.now() - started > 1500)) {
						left = true;
					}
					if (!left || !onSite) return;
					arrivedAt ??= Date.now();
					// Heavy pages stay "loading" for a long time; the document is there well before.
					if (tab.status === 'complete' || Date.now() - arrivedAt > SETTLE_MS) {
						cleanup();
						resolve();
					}
				},
				() => {}
			);
		}, 150);
	});
}
