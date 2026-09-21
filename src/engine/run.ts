/**
 * Export orchestration (PRD §9): listing page → object → (native GPX │ normalize + serialize) →
 * ZIP entry → release → next. Holds the one deliberate in-memory structure of a run: the
 * `sourceId → archiveId` map, bounded by record count and never by bytes (PRD §3.4).
 */
import { buildCollections } from '../archive/collections';
import { archiveId, baseName, DIRECTORIES } from '../archive/filenames';
import {
	areaFeature,
	isValidAreaGeometry,
	isValidPosition,
	waypointFeature
} from '../archive/geojson';
import type { FeatureSource } from '../archive/geojson';
import { buildManifest, emptyCounts, GENERATOR_NAME } from '../archive/manifest';
import { scrubRaw } from '../archive/scrub';
import { lineSidecar, photoSidecar } from '../archive/sidecar';
import { CancelledError, FatalError, ItemError } from '../shared/errors';
import type {
	CollectionRecord,
	ExportSelection,
	LineRecord,
	MapSourceAdapter,
	PhotoRecord,
	SourceInfo,
	UserInfo
} from '../shared/models';
import { PLURAL, type ErrorEntry, type Manifest, type ObjectType } from '../shared/schemas';
import type { SourceBridge } from './bridge';
import type { ClassifyContext } from './classify';
import { fetchNativeGpx } from './transport';
import { parseRetryAfter, type AttemptOutcome, type Lane } from './pacing';
import type { ProgressStore } from './progress';
import type { RunController } from './state';
import type { WorkerClient } from './worker-client';
import type { PhotoResult } from './worker-protocol';

export interface RunContext {
	adapter: MapSourceAdapter;
	user: UserInfo;
	selection: ExportSelection;
	bridge: SourceBridge;
	worker: WorkerClient;
	apiLane: Lane;
	assetLane: Lane;
	controller: RunController;
	progress: ProgressStore;
	generatorVersion: string;
	browser: string;
	/** Diagnostic report input: categories only — no names, IDs or URLs. */
	onItemError?(type: ObjectType, category: string): void;
}

export interface RunResult {
	manifest: Manifest;
	errors: ErrorEntry[];
	bytesWritten: number;
}

/** Run `job` for every item with at most `limit` in flight, pulling lazily from the iterator. */
async function forEachLimited<T>(
	items: AsyncIterable<T>,
	limit: number,
	job: (item: T, index: number) => Promise<void>
): Promise<void> {
	const inFlight = new Set<Promise<void>>();
	let failure: unknown = null;
	let index = 0;
	for await (const item of items) {
		if (failure) break;
		const task = job(item, index++)
			.catch((error: unknown) => {
				failure ??= error;
			})
			.finally(() => inFlight.delete(task));
		inFlight.add(task);
		if (inFlight.size >= limit) await Promise.race(inFlight);
	}
	await Promise.all(inFlight);
	if (failure) throw failure;
}

export async function runExport(context: RunContext): Promise<RunResult> {
	const { adapter, selection, worker, controller, progress } = context;
	const adapterTag = `${adapter.id}@${adapter.version}`;
	const classifyContext: ClassifyContext = {
		isLoginUrl: (url) => adapter.isLoginUrl(url),
		isSignedOut: (response) => adapter.isSignedOut?.(response) === true
	};

	/** `${type}:${sourceId}` → archive ID, for exported objects and for failed ones alike. */
	const idMap = new Map<string, string>();
	const errors: ErrorEntry[] = [];
	const contents = emptyCounts();
	const errorCounts = emptyCounts();

	const sourceOf = (source: SourceInfo): FeatureSource => ({
		platform: adapter.id,
		id: source.id,
		url: source.url,
		...(selection.rawSourceData && source.raw !== undefined
			? { raw: scrubRaw(source.raw, adapter.rawScrubKeys) }
			: {})
	});

	const succeed = (type: ObjectType, name: string | null) => {
		contents[PLURAL[type]]++;
		progress.itemDone(type, name);
	};

	const recordError = (
		type: ObjectType,
		id: string | null,
		sourceId: string | null,
		error: ItemError
	) => {
		errors.push({ type, id, sourceId, adapter: adapterTag, error: error.message });
		errorCounts[PLURAL[type]]++;
		progress.itemFailed(type);
		context.onItemError?.(type, error.category);
	};

	/** Item-level failures are recorded; everything else (fatal, cancel) propagates. */
	const guardItem = async (
		type: ObjectType,
		id: string,
		sourceId: string,
		work: () => Promise<void>
	): Promise<void> => {
		try {
			await work();
		} catch (error) {
			if (error instanceof ItemError) return recordError(type, id, sourceId, error);
			throw error;
		}
	};

	async function exportLine(record: LineRecord, sequence: number): Promise<void> {
		const type = record.kind;
		const id = archiveId(type, sequence);
		idMap.set(`${type}:${record.source.id}`, id);
		const base = `${DIRECTORIES[type]}/${baseName(sequence, record.name)}`;
		const file = `${baseName(sequence, record.name)}.gpx`;

		await guardItem(type, id, record.source.id, async () => {
			let geometrySource: 'native-gpx' | 'serialized' = 'native-gpx';
			let pointCount = 0;
			let nativeFailure = 'no native GPX endpoint';
			let native = false;

			if (record.nativeGpx) {
				const key = crypto.randomUUID();
				try {
					const result = await fetchNativeGpx({
						bridge: context.bridge,
						lane: context.apiLane,
						context: classifyContext,
						request: record.nativeGpx,
						begin: async () => void (await worker.call({ op: 'gpx-begin', key })),
						onChunk: async (text) => void (await worker.call({ op: 'gpx-chunk', key, text }))
					});
					if (result.native) {
						try {
							({ pointCount } = await worker.call({ op: 'gpx-commit', key, path: `${base}.gpx` }));
							native = true;
						} catch (error) {
							if (error instanceof FatalError || error instanceof CancelledError) throw error;
							nativeFailure = (error as Error).message;
						}
					} else {
						nativeFailure = result.reason;
					}
				} catch (error) {
					if (!(error instanceof ItemError)) throw error;
					nativeFailure = error.message;
				} finally {
					if (!native) await worker.call({ op: 'gpx-discard', key }).catch(() => {});
				}
			}

			if (!native) {
				// Automatic per-object fallback: JSON API + our own serializer (PRD §6.3).
				geometrySource = 'serialized';
				let segments;
				try {
					segments = await record.loadSegments();
				} catch (error) {
					if (error instanceof ItemError) {
						throw new ItemError(
							error.category,
							`native GPX: ${nativeFailure}; JSON fallback: ${error.message}`
						);
					}
					throw error;
				}
				try {
					({ pointCount } = await worker.call({
						op: 'gpx-serialize',
						path: `${base}.gpx`,
						meta: {
							name: record.name,
							description: record.description,
							time: record.createdAt,
							type: record.activityType,
							creator: GENERATOR_NAME
						},
						segments
					}));
				} catch (error) {
					if (error instanceof FatalError || error instanceof CancelledError) throw error;
					throw new ItemError('no-geometry', (error as Error).message);
				}
			}

			await worker.call({
				op: 'json',
				path: `${base}.json`,
				value: lineSidecar({
					id,
					file,
					record,
					geometrySource,
					pointCount,
					source: sourceOf(record.source)
				})
			});
			succeed(type, record.name);
		});
	}

	async function exportLines(type: 'track' | 'route'): Promise<void> {
		const records = type === 'track' ? adapter.enumerateTracks() : adapter.enumerateRoutes();
		await forEachLimited(records, adapter.limits.apiConcurrency, (record, index) =>
			exportLine(record, index + 1)
		);
		progress.typeFinished(type);
	}

	async function exportFeatures(type: 'waypoint' | 'area'): Promise<void> {
		let open = false;
		let sequence = 0;
		const records = type === 'waypoint' ? adapter.enumerateWaypoints() : adapter.enumerateAreas();
		for await (const record of records) {
			controller.throwIfStopped();
			const id = archiveId(type, ++sequence);
			idMap.set(`${type}:${record.source.id}`, id);
			await guardItem(type, id, record.source.id, async () => {
				const valid =
					record.kind === 'waypoint'
						? isValidPosition(record.position)
						: isValidAreaGeometry(record.geometry);
				if (!valid) throw new ItemError('invalid-geometry', 'malformed geometry');
				const feature =
					record.kind === 'waypoint'
						? waypointFeature(id, record, sourceOf(record.source))
						: areaFeature(id, record, sourceOf(record.source));
				if (!open) {
					await worker.call({
						op: 'features-begin',
						path: `${PLURAL[type]}/${PLURAL[type]}.geojson`
					});
					open = true;
				}
				await worker.call({ op: 'feature', value: feature });
				succeed(type, record.name);
			});
		}
		if (open) await worker.call({ op: 'features-end' });
		progress.typeFinished(type);
	}

	async function exportPhoto(record: PhotoRecord, sequence: number): Promise<void> {
		const id = archiveId('photo', sequence);
		idMap.set(`photo:${record.source.id}`, id);
		const base = `${DIRECTORIES.photo}/${baseName(sequence, record.name ?? record.caption)}`;
		await guardItem('photo', id, record.source.id, async () => {
			const result = await context.assetLane.run<Extract<PhotoResult, { ok: true }>>(async () => {
				const outcome = await worker.call({ op: 'photo', url: record.url, basePath: base });
				return classifyPhoto(outcome);
			});
			const attachedTo = record.attachedTo
				? (idMap.get(`${record.attachedTo.type}:${record.attachedTo.sourceId}`) ?? null)
				: null;
			await worker.call({
				op: 'json',
				path: `${base}.json`,
				value: photoSidecar({
					id,
					file: result.file,
					contentType: result.contentType,
					record,
					attachedTo,
					source: sourceOf(record.source)
				})
			});
			succeed('photo', record.name);
		});
	}

	// ── Objects, in the order later stages depend on (photos attach to objects,
	//    collections reference everything). ─────────────────────────────────────
	if (selection.tracks) await exportLines('track');
	if (selection.routes) await exportLines('route');
	if (selection.waypoints) await exportFeatures('waypoint');
	if (selection.areas) await exportFeatures('area');
	if (selection.photos) {
		await forEachLimited(
			adapter.enumeratePhotos(),
			adapter.limits.assetConcurrency,
			(record, index) => exportPhoto(record, index + 1)
		);
		progress.typeFinished('photo');
	}

	// ── collections.json: after all objects ─────────────────────────────────────
	const collectionRecords: CollectionRecord[] = [];
	if (selection.collections) {
		for await (const record of adapter.enumerateCollections()) {
			controller.throwIfStopped();
			collectionRecords.push(record);
		}
	}
	const collections = buildCollections({
		records: collectionRecords,
		platform: adapter.id,
		lookup: { resolve: (type, sourceId) => idMap.get(`${type}:${sourceId}`) ?? null },
		sourceFor: (record) => {
			if (!record.source) return null;
			const { platform: _platform, ...source } = sourceOf(record.source);
			return { platform: adapter.id, ...source };
		}
	});
	await controller.whenRunning();
	await worker.call({ op: 'json', path: 'collections.json', value: collections });
	for (const record of collectionRecords) {
		contents.collections++;
		progress.itemDone('collection', record.name);
	}
	if (selection.collections) progress.typeFinished('collection');

	// ── errors.json, then manifest.json as the very last entry ──────────────────
	await controller.whenRunning();
	controller.finalizing();
	await worker.call({ op: 'json', path: 'errors.json', value: errors });
	const manifest = buildManifest({
		createdAt: new Date(),
		generatorVersion: context.generatorVersion,
		browser: context.browser,
		platform: adapter.id,
		adapterVersion: adapter.version,
		account: context.user,
		selection,
		contents,
		errors: errorCounts
	});
	await worker.call({ op: 'json', path: 'manifest.json', value: manifest });
	const { bytesWritten } = await worker.call({ op: 'close' });
	return { manifest, errors, bytesWritten };
}

function classifyPhoto(result: PhotoResult): AttemptOutcome<Extract<PhotoResult, { ok: true }>> {
	if (result.ok) return { type: 'ok', value: result };
	if (result.kind === 'refused') {
		return { type: 'fail', error: new ItemError('refused', result.message) };
	}
	if (result.kind === 'network')
		return { type: 'retry', reason: 'network', detail: 'network error' };
	const { status } = result;
	if (status === 429) {
		return {
			type: 'retry',
			reason: 'rate-limited',
			detail: 'HTTP 429',
			retryAfterMs: parseRetryAfter(result.retryAfter)
		};
	}
	if (status >= 500) return { type: 'retry', reason: 'server', detail: `HTTP ${status}` };
	return { type: 'fail', error: new ItemError(`http-${status}`, `HTTP ${status}`) };
}
