/**
 * Everything the export page does, behind one observable view model: lifecycle lock and orphan
 * sweep (PRD §5.4), preflight (§4.2), the run, cancellation (§13), and the OPFS → download
 * hand-off (§10.1). The Svelte UI only renders `SessionView` and calls these methods.
 */
import { findSource, type SourceDescriptor } from '../adapters';
import { matchPatternsFor, sourceHosts } from '../adapters/hosts';
import { defaultArchiveFilename } from '../archive/manifest';
import { CancelledError, FatalError, formatBytes } from '../shared/errors';
import type { ExportSelection, MapSourceAdapter, ObjectType, UserInfo } from '../shared/models';
import { PLURAL, type ErrorEntry, type Manifest } from '../shared/schemas';
import { getStagedFile, removeStagedFile, sweepStagedFiles } from '../sinks/opfs';
import { selectSinkKind } from '../sinks/select';
import type { SinkKind, SinkSpec } from '../sinks/types';
import { SourceBridge } from './bridge';
import { Lane } from './pacing';
import { ProgressStore, TYPE_ORDER, type PluralType, type ProgressSnapshot } from './progress';
import { runExport } from './run';
import { RunController, type RunSnapshot } from './state';
import { timingsForMode } from './timings';
import { createAdapterTransport } from './transport';
import { WorkerClient } from './worker-client';

export const EXPORT_LOCK = 'mapliberator-export';
const CHANNEL = 'mapliberator';
const LOW_STORAGE_BYTES = 2_000_000_000;

export type Phase =
	| 'starting'
	| 'locked-out'
	| 'pick-source'
	| 'permission'
	| 'connecting'
	| 'ready'
	| 'exporting'
	| 'saving'
	| 'done'
	| 'failed'
	| 'cancelled';

export interface ExportResult {
	manifest: Manifest;
	errors: ErrorEntry[];
	bytesWritten: number;
	filename: string;
	downloadId: number | null;
	/** The browser download was interrupted; the staged archive is still available. */
	saveInterrupted: boolean;
}

export interface SessionView {
	phase: Phase;
	source: { id: string; label: string; notes: string[] } | null;
	permissionDenied: boolean;
	user: UserInfo | null;
	counts: Partial<Record<PluralType, number | null>>;
	sinkKind: SinkKind;
	storageWarning: string | null;
	run: RunSnapshot;
	/** Engine state history, e.g. "running paused(auth) running"; also in the diagnostic report. */
	history: string;
	progress: ProgressSnapshot;
	result: ExportResult | null;
	failure: string | null;
}

export class ExportSession {
	private readonly mode = import.meta.env.MODE;
	private readonly listeners = new Set<(view: SessionView) => void>();
	private controller = new RunController();
	private progress = new ProgressStore();
	private descriptor: SourceDescriptor | null = null;
	private adapter: MapSourceAdapter | null = null;
	private bridge: SourceBridge | null = null;
	private worker: WorkerClient | null = null;
	private apiLane: Lane | null = null;
	private runId: string | null = null;
	private errorCategories = new Map<string, number>();
	private view: SessionView;

	constructor() {
		this.view = {
			phase: 'starting',
			source: null,
			permissionDenied: false,
			user: null,
			counts: {},
			sinkKind: selectSinkKind(globalThis),
			storageWarning: null,
			run: this.controller.snapshot(),
			history: '',
			progress: this.progress.snapshot(),
			result: null,
			failure: null
		};
		this.controller.subscribe((run) =>
			this.patch({
				run,
				history: this.controller.history
					.map((entry) => (entry.reason ? `${entry.state}(${entry.reason})` : entry.state))
					.join(' ')
			})
		);
		this.progress.subscribe((progress) => this.patch({ progress }));
	}

	current(): SessionView {
		return this.view;
	}

	subscribe(listener: (view: SessionView) => void): () => void {
		this.listeners.add(listener);
		listener(this.view);
		return () => this.listeners.delete(listener);
	}

	private patch(patch: Partial<SessionView>): void {
		this.view = { ...this.view, ...patch };
		for (const listener of this.listeners) listener(this.view);
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────────

	/** Take the cross-page export lock, sweep crash leftovers, pick up `?source=`. */
	async init(sourceId: string | null): Promise<void> {
		const channel = new BroadcastChannel(CHANNEL);
		const acquired = await new Promise<boolean>((resolve) => {
			void navigator.locks.request(EXPORT_LOCK, { ifAvailable: true }, (lock) => {
				resolve(lock !== null);
				// Held for the life of this page: one export at a time.
				return lock ? new Promise<void>(() => {}) : undefined;
			});
		});
		if (!acquired) {
			channel.postMessage({ type: 'focus-export-page' });
			this.patch({ phase: 'locked-out' });
			return;
		}
		channel.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
			if (event.data?.type === 'focus-export-page') void focusThisTab();
		});

		// We hold the lock and no run has started: everything in exports/ is an orphan.
		await sweepStagedFiles().catch(() => 0);

		window.addEventListener('beforeunload', (event) => {
			if (this.view.phase === 'exporting') event.preventDefault();
		});
		window.addEventListener('pagehide', () => {
			// Closing the export tab mid-run is a cancel.
			if (this.view.phase === 'exporting' || this.view.phase === 'connecting') void this.cancel();
			else void this.bridge?.close();
		});

		const descriptor = findSource(sourceId);
		if (descriptor) this.chooseSource(descriptor.id);
		else this.patch({ phase: 'pick-source' });
	}

	chooseSource(id: string): void {
		const descriptor = findSource(id);
		if (!descriptor) return;
		this.descriptor = descriptor;
		this.patch({
			phase: 'permission',
			source: { id: descriptor.id, label: descriptor.label, notes: [] },
			permissionDenied: false
		});
	}

	// ── Preflight ────────────────────────────────────────────────────────────────

	/**
	 * Must be called from a click: `permissions.request()` needs the user gesture. Host access
	 * is optional and granted per source at first use (PRD §4.2).
	 */
	async grantAndConnect(): Promise<void> {
		const descriptor = this.descriptor;
		if (!descriptor) return;
		const hosts = sourceHosts(this.mode)[descriptor.id];
		let granted = false;
		try {
			granted = await browser.permissions.request({ origins: matchPatternsFor(hosts) });
		} catch {
			granted = false;
		}
		if (!granted) {
			this.patch({ permissionDenied: true });
			return;
		}
		this.patch({ permissionDenied: false, phase: 'connecting' });
		await this.connect(descriptor);
	}

	private async connect(descriptor: SourceDescriptor): Promise<void> {
		const timings = timingsForMode(this.mode);
		let adapter: MapSourceAdapter | null = null;
		const bridge = new SourceBridge({
			id: descriptor.id,
			get bridgeUrl() {
				return adapter!.bridgeUrl;
			},
			get loginUrl() {
				return adapter!.loginUrl;
			}
		});
		let lane: Lane | null = null;
		const transport = createAdapterTransport(
			bridge,
			(attempt) => lane!.run(attempt),
			() => ({ isLoginUrl: (url) => adapter!.isLoginUrl(url) })
		);
		adapter = descriptor.create(transport, this.mode);
		const apiLane = new Lane(
			this.controller,
			{ concurrency: adapter.limits.apiConcurrency, minIntervalMs: adapter.limits.minIntervalMs },
			timings,
			{ recoverTab: () => bridge.recover() }
		);
		lane = apiLane;
		this.adapter = adapter;
		this.bridge = bridge;
		this.apiLane = apiLane;
		this.patch({
			source: { id: adapter.id, label: adapter.label, notes: adapter.notes }
		});

		this.controller.start();
		try {
			const user = await adapter.identifyUser();
			this.patch({ user });
			const counts: SessionView['counts'] = {};
			for (const type of TYPE_ORDER) {
				// Cheap listing/count calls only; null simply omits the number (PRD §4.3).
				counts[PLURAL[type]] = await adapter.count(type).catch((error: unknown) => {
					if (error instanceof CancelledError || error instanceof FatalError) throw error;
					return null;
				});
				this.patch({ counts: { ...counts } });
			}
			this.patch({ phase: 'ready' });
		} catch (error) {
			await this.handleFailure(error);
		}
	}

	/** "Not you?" / session lost: bring the source tab forward on the sign-in page. */
	async showLogin(): Promise<void> {
		await this.bridge?.showLogin();
	}

	resume(): void {
		this.controller.resume();
	}

	// ── Export ───────────────────────────────────────────────────────────────────

	/** Must be called from a click: the save-file picker needs the user gesture. */
	async startExport(selection: ExportSelection): Promise<void> {
		const { adapter, bridge, apiLane } = this;
		const user = this.view.user;
		if (!adapter || !bridge || !apiLane || !user || this.view.phase !== 'ready') return;

		const filename = defaultArchiveFilename(adapter.id, new Date());
		const runId = crypto.randomUUID();
		let sink: SinkSpec;
		if (this.view.sinkKind === 'direct') {
			let handle: FileSystemFileHandle;
			try {
				handle = await (
					window as unknown as {
						showSaveFilePicker(options: object): Promise<FileSystemFileHandle>;
					}
				).showSaveFilePicker({
					suggestedName: filename,
					types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]
				});
			} catch {
				return; // picker dismissed: stay on the selection screen
			}
			sink = { kind: 'direct', handle };
		} else {
			sink = { kind: 'opfs', runId };
			this.patch({ storageWarning: await storagePreflight(selection.photos) });
		}

		this.runId = runId;
		this.patch({ phase: 'exporting' });
		for (const type of TYPE_ORDER) {
			if (selection[PLURAL[type]])
				this.progress.select(type, this.view.counts[PLURAL[type]] ?? null);
		}

		const timings = timingsForMode(this.mode);
		const worker = new WorkerClient();
		this.worker = worker;
		worker.onProgress = (bytes) => this.progress.bytes(bytes);

		try {
			await worker.call({ op: 'open', sink, filename, assetOrigins: adapter.assetOrigins });
			const result = await runExport({
				adapter,
				user,
				selection,
				bridge,
				worker,
				apiLane,
				assetLane: new Lane(
					this.controller,
					{ concurrency: adapter.limits.assetConcurrency, minIntervalMs: 0 },
					timings
				),
				controller: this.controller,
				progress: this.progress,
				generatorVersion: browser.runtime.getManifest().version,
				browser: import.meta.env.BROWSER,
				onItemError: (type: ObjectType, category: string) => {
					const key = `${type}:${category}`;
					this.errorCategories.set(key, (this.errorCategories.get(key) ?? 0) + 1);
				}
			});
			worker.terminate();
			this.worker = null;
			await bridge.close();

			const exportResult: ExportResult = {
				...result,
				filename,
				downloadId: null,
				saveInterrupted: false
			};
			if (sink.kind === 'opfs') {
				this.patch({ phase: 'saving', result: exportResult });
				await this.handOff();
			} else {
				this.patch({ result: exportResult });
			}
			if (!this.view.result?.saveInterrupted) {
				this.controller.done();
				this.patch({ phase: 'done' });
			}
		} catch (error) {
			await this.handleFailure(error);
		}
	}

	/**
	 * OPFS → downloads. Cleanup happens when the download reaches "complete", not when
	 * download() is called (PRD §10.1).
	 */
	private async handOff(): Promise<void> {
		const runId = this.runId;
		const result = this.view.result;
		if (!runId || !result) return;
		const file = await getStagedFile(runId);
		const url = URL.createObjectURL(file);
		let downloadId: number | null = null;
		let completed = false;
		try {
			downloadId = await browser.downloads.download({
				url,
				filename: result.filename,
				saveAs: true
			});
			completed = await waitForDownload(downloadId);
		} catch {
			completed = false;
		} finally {
			URL.revokeObjectURL(url);
		}
		if (completed) {
			await removeStagedFile(runId);
			this.patch({ result: { ...result, downloadId, saveInterrupted: false } });
		} else {
			// Hours of export are not thrown away because a save dialog was dismissed.
			this.patch({ result: { ...result, downloadId: null, saveInterrupted: true } });
		}
	}

	async saveAgain(): Promise<void> {
		if (!this.view.result?.saveInterrupted) return;
		await this.handOff();
		if (!this.view.result?.saveInterrupted) {
			this.controller.done();
			this.patch({ phase: 'done' });
		}
	}

	async showInFolder(): Promise<void> {
		const id = this.view.result?.downloadId;
		if (id !== null && id !== undefined) await browser.downloads.show(id);
	}

	// ── Cancel and failure ───────────────────────────────────────────────────────

	/** Stop requests, stop the worker, abort the sink, close the source tab (PRD §13). */
	async cancel(): Promise<void> {
		if (['done', 'failed', 'cancelled'].includes(this.view.phase)) return;
		this.controller.cancel();
		await this.teardown();
		this.patch({ phase: 'cancelled' });
	}

	private async teardown(): Promise<void> {
		const worker = this.worker;
		this.worker = null;
		if (worker) {
			await Promise.race([
				worker.call({ op: 'abort' }).catch(() => {}),
				new Promise((resolve) => setTimeout(resolve, 5000))
			]);
			worker.terminate();
		}
		if (this.runId) await removeStagedFile(this.runId).catch(() => {});
		await this.bridge?.close();
	}

	private async handleFailure(error: unknown): Promise<void> {
		if (error instanceof CancelledError || this.controller.cancelled) {
			if (this.view.phase !== 'cancelled') await this.cancel();
			return;
		}
		this.controller.fail();
		await this.teardown();
		const message = error instanceof Error ? error.message : String(error);
		this.patch({ phase: 'failed', failure: message });
	}

	// ── Diagnostics ──────────────────────────────────────────────────────────────

	/**
	 * Clipboard text for bug reports. Contains no names, coordinates, IDs or URLs (PRD §19.2).
	 */
	diagnosticReport(): string {
		const manifest = browser.runtime.getManifest();
		const { adapter } = this;
		const lines = [
			'MapLiberator diagnostic report',
			`extension: ${manifest.version}`,
			`browser: ${import.meta.env.BROWSER}`,
			`adapter: ${adapter ? `${adapter.id}@${adapter.version}` : 'none'}`,
			`sink: ${this.view.sinkKind}`,
			`phase: ${this.view.phase}`,
			`bytes written: ${formatBytes(this.view.progress.bytesWritten)}`,
			'',
			'counts (done / errors / total):'
		];
		for (const [type, progress] of Object.entries(this.view.progress.types)) {
			if (!progress.selected) continue;
			lines.push(`  ${type}: ${progress.done} / ${progress.errors} / ${progress.total ?? '?'}`);
		}
		lines.push('', 'errors by category:');
		if (this.errorCategories.size === 0) lines.push('  none');
		for (const [key, count] of this.errorCategories) lines.push(`  ${key} × ${count}`);
		if (this.view.failure && this.controller.state === 'failed') {
			// Fatal messages are ours and never embed source data.
			lines.push('', `fatal: ${this.view.failure.split('\n')[0]}`);
		}
		lines.push('', 'state history:');
		const start = this.controller.history[0]?.at ?? 0;
		for (const entry of this.controller.history) {
			const seconds = ((entry.at - start) / 1000).toFixed(1);
			lines.push(`  +${seconds}s ${entry.state}${entry.reason ? ` (${entry.reason})` : ''}`);
		}
		return lines.join('\n');
	}
}

async function focusThisTab(): Promise<void> {
	const tab = await browser.tabs.getCurrent();
	if (tab?.id === undefined) return;
	await browser.tabs.update(tab.id, { active: true });
	if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

/** Ask for persistence and warn when the quota looks too small for photos (PRD §11.2). */
async function storagePreflight(withPhotos: boolean): Promise<string | null> {
	try {
		await navigator.storage.persist?.();
		const { quota, usage } = await navigator.storage.estimate();
		if (quota === undefined) return null;
		const available = quota - (usage ?? 0);
		if (withPhotos && available < LOW_STORAGE_BYTES) {
			return (
				`Your browser reports only ${formatBytes(available)} of temporary storage. ` +
				'A photo-inclusive export may not fit; consider exporting maps only.'
			);
		}
	} catch {
		// estimate() is advisory
	}
	return null;
}

function waitForDownload(downloadId: number): Promise<boolean> {
	return new Promise((resolve) => {
		const finish = (ok: boolean) => {
			browser.downloads.onChanged.removeListener(onChanged);
			resolve(ok);
		};
		const onChanged = (delta: Browser.downloads.DownloadDelta) => {
			if (delta.id !== downloadId || !delta.state) return;
			if (delta.state.current === 'complete') finish(true);
			else if (delta.state.current === 'interrupted') finish(false);
		};
		browser.downloads.onChanged.addListener(onChanged);
		// The download may already have finished before the listener was attached.
		void browser.downloads.search({ id: downloadId }).then(([item]) => {
			if (item?.state === 'complete') finish(true);
			else if (item?.state === 'interrupted') finish(false);
		});
	});
}
