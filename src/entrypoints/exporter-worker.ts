/**
 * Exporter worker (PRD §5.3): owns the ZIP writer and the sink, fetches photos itself and pipes
 * them into stored entries, and runs the GPX stream check and the serializers. Photos never cross
 * a thread boundary; every RPC resolves only after its bytes reached the sink, which is what
 * gates the page's request loop.
 */
import { FeatureCollectionSerializer } from '../archive/geojson';
import { countPoints, isValidPoint, serializeGpx } from '../archive/gpx';
import { GpxCheckError, GpxStreamCheck } from '../archive/gpx-check';
import { extensionForContentType, normalizeContentType } from '../archive/filenames';
import { ArchiveWriter } from '../archive/zip';
import type {
	PhotoResult,
	WorkerEnvelope,
	WorkerError,
	WorkerReply,
	WorkerRequest
} from '../engine/worker-protocol';
import { FatalError } from '../shared/errors';
import { DirectFileSink } from '../sinks/direct-file';
import { OpfsSink } from '../sinks/opfs';
import type { ArchiveSink } from '../sinks/types';

/** Native GPX is text and "at most a few MB"; anything beyond this is not a GPX export. */
const MAX_NATIVE_GPX_BYTES = 256 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;

interface PendingGpx {
	check: GpxStreamCheck;
	chunks: Uint8Array[];
	bytes: number;
}

export default defineUnlistedScript(() => {
	const scope = self as unknown as {
		postMessage(message: WorkerReply): void;
		addEventListener(
			type: 'message',
			listener: (event: MessageEvent<WorkerEnvelope>) => void
		): void;
	};
	const encoder = new TextEncoder();
	const pendingGpx = new Map<string, PendingGpx>();

	let sink: ArchiveSink | null = null;
	let writer: ArchiveWriter | null = null;
	let assetOrigins: string[] = [];
	let aborted = false;
	let features: {
		serializer: FeatureCollectionSerializer;
		controller: ReadableStreamDefaultController<Uint8Array>;
		entry: Promise<void>;
		/** Resolves the pending `feature` call once the ZIP entry pulls again. */
		wake: (() => void) | null;
	} | null = null;
	/** The ZIP entry asked for more data (pull) and has not been given any since. */
	let demand = false;
	const fetchControllers = new Set<AbortController>();

	let lastProgress = 0;
	const reportProgress = (bytesWritten: number, force = false) => {
		const now = Date.now();
		if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) return;
		lastProgress = now;
		scope.postMessage({ event: 'progress', bytesWritten } satisfies WorkerReply);
	};

	const requireWriter = (): ArchiveWriter => {
		if (!writer || aborted) throw new FatalError('archive-closed', 'The archive is not open');
		return writer;
	};

	async function handle(request: WorkerRequest): Promise<unknown> {
		switch (request.op) {
			case 'open': {
				sink =
					request.sink.kind === 'opfs'
						? new OpfsSink(request.sink.runId)
						: new DirectFileSink(request.sink.handle);
				await sink.open(request.filename);
				writer = new ArchiveWriter(sink, reportProgress);
				assetOrigins = request.assetOrigins;
				return null;
			}

			case 'gpx-begin':
				pendingGpx.set(request.key, { check: new GpxStreamCheck(), chunks: [], bytes: 0 });
				return null;

			case 'gpx-chunk': {
				const pending = pendingGpx.get(request.key);
				if (!pending) throw new GpxCheckError('stream was discarded');
				try {
					pending.check.write(request.text);
					const bytes = encoder.encode(request.text);
					pending.bytes += bytes.byteLength;
					if (pending.bytes > MAX_NATIVE_GPX_BYTES) throw new GpxCheckError('GPX is too large');
					pending.chunks.push(bytes);
				} catch (error) {
					pendingGpx.delete(request.key);
					throw error;
				}
				return null;
			}

			case 'gpx-commit': {
				const pending = pendingGpx.get(request.key);
				pendingGpx.delete(request.key);
				if (!pending) throw new GpxCheckError('stream was discarded');
				const { pointCount } = pending.check.finish();
				await requireWriter().addBytes(request.path, pending.chunks);
				return { pointCount };
			}

			case 'gpx-discard':
				pendingGpx.delete(request.key);
				return null;

			case 'gpx-serialize': {
				const segments = request.segments
					.map((segment) => segment.filter(isValidPoint))
					.filter((segment) => segment.length > 0);
				const pointCount = countPoints(segments);
				if (pointCount === 0) throw new GpxCheckError('object has no usable geometry');
				const chunks: Uint8Array[] = [];
				for (const text of serializeGpx(request.meta, segments)) chunks.push(encoder.encode(text));
				await requireWriter().addBytes(request.path, chunks);
				return { pointCount };
			}

			case 'json':
				await requireWriter().addText(
					request.path,
					JSON.stringify(request.value, null, '\t') + '\n'
				);
				return null;

			case 'features-begin': {
				const serializer = new FeatureCollectionSerializer();
				demand = false;
				let controller!: ReadableStreamDefaultController<Uint8Array>;
				const readable = new ReadableStream<Uint8Array>(
					{
						start(c) {
							controller = c;
						},
						pull() {
							demand = true;
							const wake = features?.wake;
							if (features) features.wake = null;
							wake?.();
						}
					},
					{ highWaterMark: 0 }
				);
				const entry = requireWriter().addTextStream(request.path, readable);
				entry.catch(() => {});
				features = { serializer, controller, entry, wake: null };
				controller.enqueue(encoder.encode(serializer.open()));
				demand = false;
				return null;
			}

			case 'feature': {
				if (!features) throw new FatalError('archive-closed', 'No feature collection is open');
				const active = features;
				// Wait until the ZIP entry asked for more before handing over the next feature.
				if (!demand) {
					await Promise.race([
						new Promise<void>((resolve) => (active.wake = resolve)),
						active.entry
					]);
				}
				demand = false;
				active.controller.enqueue(encoder.encode(active.serializer.feature(request.value)));
				return null;
			}

			case 'features-end': {
				if (!features) return null;
				const active = features;
				features = null;
				active.controller.enqueue(encoder.encode(active.serializer.close()));
				active.controller.close();
				await active.entry;
				return null;
			}

			case 'photo':
				return fetchPhoto(request.url, request.basePath);

			case 'close': {
				const active = requireWriter();
				await active.close();
				await sink?.close();
				writer = null;
				reportProgress(active.bytesWritten, true);
				return { bytesWritten: active.bytesWritten };
			}

			case 'abort': {
				aborted = true;
				for (const controller of fetchControllers) controller.abort();
				try {
					features?.controller.error(new Error('aborted'));
				} catch {
					// stream already closed
				}
				features = null;
				pendingGpx.clear();
				writer = null;
				await sink?.abort();
				sink = null;
				return null;
			}
		}
	}

	async function fetchPhoto(url: string, basePath: string): Promise<PhotoResult> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return { ok: false, kind: 'refused', message: 'invalid photo URL' };
		}
		if (!assetOrigins.includes(parsed.origin)) {
			return { ok: false, kind: 'refused', message: 'photo host is not allowlisted' };
		}
		const active = requireWriter();
		const controller = new AbortController();
		fetchControllers.add(controller);
		try {
			let response: Response;
			try {
				// No credentials: asset URLs are self-contained and we never handle session material.
				response = await fetch(parsed.href, {
					credentials: 'omit',
					redirect: 'follow',
					signal: controller.signal
				});
			} catch (error) {
				return { ok: false, kind: 'network', message: (error as Error).message };
			}
			if (response.status !== 200 || !response.body) {
				await response.body?.cancel().catch(() => {});
				return {
					ok: false,
					kind: 'http',
					status: response.status,
					retryAfter: response.headers.get('retry-after')
				};
			}
			const contentType = normalizeContentType(response.headers.get('content-type'));
			if (contentType === 'text/html') {
				await response.body.cancel().catch(() => {});
				return { ok: false, kind: 'http', status: 415, retryAfter: null };
			}
			const path = `${basePath}.${extensionForContentType(contentType)}`;
			let bytes = 0;
			const counted = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, c) {
						bytes += chunk.byteLength;
						c.enqueue(chunk);
					}
				})
			);
			try {
				await active.addStored(path, counted);
			} catch (error) {
				if (error instanceof FatalError || aborted) throw error;
				// The body died mid-stream. zip.js drops the partial entry from the central
				// directory; the bytes already written are dead space, which ZIP permits.
				return { ok: false, kind: 'network', message: (error as Error).message };
			}
			return { ok: true, file: path.slice(path.lastIndexOf('/') + 1), contentType, bytes };
		} finally {
			fetchControllers.delete(controller);
		}
	}

	scope.addEventListener('message', (event: MessageEvent<WorkerEnvelope>) => {
		const { id, request } = event.data;
		handle(request).then(
			(result) => scope.postMessage({ id, ok: true, result } satisfies WorkerReply),
			(error: unknown) => {
				const failure: WorkerError = {
					name: error instanceof Error ? error.name : 'Error',
					message: error instanceof Error ? error.message : String(error),
					...(error instanceof FatalError ? { fatalCode: error.code } : {}),
					...(error instanceof GpxCheckError ? { gpxCheck: true } : {})
				};
				scope.postMessage({ id, ok: false, error: failure } satisfies WorkerReply);
			}
		);
	});
});
