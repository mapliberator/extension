/** RPC between the export page and the exporter worker, which owns the ZIP and the sink. */
import type { GpxMeta } from '../archive/gpx';
import type { TrackPoint } from '../shared/models';
import type { SinkSpec } from '../sinks/types';

export type WorkerRequest =
	| { op: 'open'; sink: SinkSpec; filename: string; assetOrigins: string[] }
	/** Native GPX: chunks are checked as they arrive and buffered until the check passes. */
	| { op: 'gpx-begin'; key: string }
	| { op: 'gpx-chunk'; key: string; text: string }
	| { op: 'gpx-commit'; key: string; path: string }
	| { op: 'gpx-discard'; key: string }
	| { op: 'gpx-serialize'; path: string; meta: GpxMeta; segments: TrackPoint[][] }
	| { op: 'json'; path: string; value: unknown }
	| { op: 'features-begin'; path: string }
	| { op: 'feature'; value: unknown }
	| { op: 'features-end' }
	/** Fetch a photo straight from the CDN into a stored entry. `basePath` has no extension. */
	| { op: 'photo'; url: string; basePath: string }
	| { op: 'close' }
	| { op: 'abort' };

export type PhotoResult =
	| { ok: true; file: string; contentType: string; bytes: number }
	| { ok: false; kind: 'http'; status: number; retryAfter: string | null }
	| { ok: false; kind: 'network'; message: string }
	| { ok: false; kind: 'refused'; message: string };

export interface WorkerResults {
	open: null;
	'gpx-begin': null;
	'gpx-chunk': null;
	'gpx-commit': { pointCount: number };
	'gpx-discard': null;
	'gpx-serialize': { pointCount: number };
	json: null;
	'features-begin': null;
	feature: null;
	'features-end': null;
	photo: PhotoResult;
	close: { bytesWritten: number };
	abort: null;
}

export interface WorkerError {
	name: string;
	message: string;
	/** FatalError code, when the failure must stop the run (sink failure, quota). */
	fatalCode?: string;
	/** GPX check failures are expected and lead to the JSON fallback. */
	gpxCheck?: boolean;
}

export type WorkerEnvelope = { id: number; request: WorkerRequest };

export type WorkerReply =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; error: WorkerError }
	| { event: 'progress'; bytesWritten: number };
