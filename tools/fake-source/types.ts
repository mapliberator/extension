/** Public types of `tools/fake-source`. See API.md — that document is the contract. */

export type Platform = 'gaiagps' | 'alltrails';

export type Lane = 'api' | 'asset' | 'page';

export type FaultAction =
	| { kind: 'status'; status: number; retryAfter?: number; body?: string }
	| { kind: 'challenge' }
	/**
	 * Destroy the socket. `before-response` (default): without sending anything — note that
	 * Chromium silently re-sends an idempotent request once when a reused socket dies this way.
	 * `mid-response`: after the headers and a few body bytes.
	 */
	| { kind: 'drop'; when?: 'before-response' | 'mid-response' }
	| { kind: 'expire-session' }
	| { kind: 'schema-drift' }
	| { kind: 'delay'; ms: number };

export interface Fault {
	platform?: Platform;
	/** RegExp source tested against `path + search`. */
	match: string;
	/** Let this many matching requests through first. Default 0. */
	skip?: number;
	/** Then apply to this many matching requests; omit = forever. */
	count?: number;
	action: FaultAction;
}

export interface RequestLogEntry {
	platform: Platform;
	lane: Lane;
	method: string;
	/** Path including the query string. */
	path: string;
	/** HTTP status, or 0 for a dropped / aborted connection (and while still in flight). */
	status: number;
	/** `performance.now()` when the request arrived. */
	start: number;
	/** `performance.now()` when the response finished or the connection closed. */
	end: number;
}

export interface ExpectedArchive {
	account: { id: string; displayName: string };
	/** Counts of objects AUTHORED by the account (what a clean export must contain). */
	counts: {
		tracks: number;
		routes: number;
		waypoints: number;
		areas: number;
		collections: number;
		photos: number;
	};
	/** Source IDs of authored objects, in listing order. */
	ids: {
		tracks: string[];
		routes: string[];
		waypoints: string[];
		areas: string[];
		photos: string[];
	};
	/** Saved platform trails that must show up as `reference` members. `coordinate` is [lon, lat]. */
	references: { name: string; url: string; sourceId: string; coordinate: [number, number] }[];
}

export type DatasetOptions =
	| { kind: 'small'; maxPageSize?: number }
	| { kind: 'large'; photos?: number; photoBytes?: number; maxPageSize?: number };

export interface StartOptions {
	/** Default 4610. `0` picks an ephemeral port; every emitted URL reflects the real port. */
	port?: number;
	/** Default `'small'`. */
	dataset?: 'small' | 'large' | DatasetOptions;
}

export interface SourceStats {
	apiRequests: number;
	assetRequests: number;
	peakApiConcurrency: number;
	peakAssetConcurrency: number;
	/** Infinity with fewer than two api requests. */
	minApiGapMs: number;
}

export interface SessionCookie {
	name: 'fs_session';
	value: string;
	domain: 'gaia.localhost' | 'alltrails.localhost';
	path: '/';
	httpOnly: true;
	secure: false;
	sameSite: 'Lax';
}

export type Json = Record<string, unknown>;

/** An object's listing entry plus its full JSON detail response. */
export interface LineObject {
	summary: Json;
	detail: Json;
}

export interface GaiaObjects {
	me: Json;
	tracks: LineObject[];
	routes: LineObject[];
	waypoints: LineObject[];
	areas: LineObject[];
	photos: LineObject[];
	folders: LineObject[];
}

export interface AllTrailsObjects {
	me: Json;
	tracks: LineObject[];
	maps: LineObject[];
	lists: { list: Json; items: Json[] }[];
	trails: Json[];
	photos: Json[];
}

export interface FakeSource {
	/** The port actually bound. */
	readonly port: number;
	/** Site origin, e.g. `http://gaia.localhost:4610`. */
	origin(platform: Platform): string;
	/** CDN origin, e.g. `http://cdn.gaia.localhost:4610`. */
	assetOrigin(platform: Platform): string;
	sessionCookie(platform: Platform): SessionCookie;
	setFaults(faults: Fault[]): void;
	login(platform: Platform): void;
	logout(platform: Platform): void;
	resetLog(): void;
	log(): RequestLogEntry[];
	stats(platform: Platform): SourceStats;
	expected(platform: Platform): ExpectedArchive;
	/** Exact bytes the native GPX endpoint serves. Do not mutate the returned Buffer. */
	nativeGpx(platform: Platform, kind: 'track' | 'route', id: string | number): Buffer;
	/** Raw seeded objects (own and others'), for fixture dumps. */
	objects(platform: 'gaiagps'): GaiaObjects;
	objects(platform: 'alltrails'): AllTrailsObjects;
	objects(platform: Platform): GaiaObjects | AllTrailsObjects;
	close(): Promise<void>;
}
