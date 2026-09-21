/**
 * Normalized records adapters emit. Everything here is already converted to archive units
 * (WGS84, meters, seconds, RFC 3339 UTC) — adapters convert at mapping time (PRD §8.10).
 */
import type { SourceId } from '../adapters/hosts';
import type { ObjectType } from './schemas';

export type { ObjectType, SourceId };

export interface BridgeRequest {
	method: 'GET';
	url: string;
	accept: 'json' | 'text-stream';
	/** Extra request headers the platform demands. Never session material. */
	headers?: Record<string, string>;
}

export interface UserInfo {
	id: string;
	displayName: string;
}

export interface TrackPoint {
	lon: number;
	lat: number;
	ele?: number | null;
	/** RFC 3339 UTC */
	time?: string | null;
}

export type Position = [number, number] | [number, number, number];
export type Visibility = 'private' | 'unlisted' | 'public' | null;

export interface SourceInfo {
	id: string;
	url: string | null;
	/** Unscrubbed source representation. The engine scrubs or drops it; adapters never write it. */
	raw: unknown;
}

interface BaseRecord {
	name: string;
	description: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	visibility: Visibility;
	tags: string[];
	source: SourceInfo;
}

export interface LineStats {
	distanceMeters: number | null;
	ascentMeters: number | null;
	durationSeconds: number | null;
}

export interface LineRecord extends BaseRecord {
	kind: 'track' | 'route';
	activityType: string | null;
	stats: LineStats;
	/** Platform's own GPX export, tried first and stored verbatim (PRD §6.3). */
	nativeGpx: BridgeRequest | null;
	/** JSON fallback, fetched only when the native path is unavailable. */
	loadSegments(): Promise<TrackPoint[][]>;
}

export interface WaypointRecord extends BaseRecord {
	kind: 'waypoint';
	position: Position;
	icon: string | null;
}

export interface AreaRecord extends BaseRecord {
	kind: 'area';
	geometry:
		| { type: 'Polygon'; coordinates: Position[][] }
		| { type: 'MultiPolygon'; coordinates: Position[][][] };
	areaSquareMeters: number | null;
}

export interface PhotoRecord {
	kind: 'photo';
	name: string | null;
	caption: string | null;
	takenAt: string | null;
	uploadedAt: string | null;
	coordinate: Position | null;
	/** Absolute URL on one of the adapter's asset origins. */
	url: string;
	rendition: 'original' | 'largest-available';
	attachedTo: { type: ObjectType; sourceId: string } | null;
	source: SourceInfo;
}

export type Annotations = {
	completedAt?: string | null;
	rating?: number | null;
	review?: string | null;
	notes?: string | null;
};

/** Content the user saved but did not author: a pointer, never geometry (PRD §6.4). */
export interface ReferenceRecord {
	name: string;
	source: { id: string; url: string | null };
	coordinate: [number, number] | null;
	annotations?: Annotations;
}

export type CollectionMemberRecord =
	| { kind: 'object'; type: ObjectType; sourceId: string }
	| { kind: 'reference'; reference: ReferenceRecord };

export interface CollectionRecord {
	kind: 'collection';
	name: string;
	description: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	parentSourceId: string | null;
	/** null for collections the adapter synthesizes (e.g. "Completed trails"). */
	source: SourceInfo | null;
	/** Stable key used for parent lookups; equals source.id for real collections. */
	key: string;
	members: CollectionMemberRecord[];
}

export interface AdapterLimits {
	apiConcurrency: number;
	assetConcurrency: number;
	minIntervalMs: number;
}

/** What adapters use to reach the platform. Pacing, retries and pauses live behind it. */
export interface AdapterTransport {
	/** GET a JSON document from one of the adapter's API origins. */
	getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
}

export interface MapSourceAdapter {
	readonly id: SourceId;
	readonly label: string;
	readonly version: string;
	readonly origins: string[];
	readonly assetOrigins: string[];
	readonly limits: AdapterLimits;
	/** Lightweight same-origin page the dedicated source tab parks on. */
	readonly bridgeUrl: string;
	/** Where the user signs in when the session is missing. */
	readonly loginUrl: string;
	/** True when a (redirected) response URL is the platform's sign-in page. */
	isLoginUrl(url: string): boolean;
	/** A platform's own signed-out answer, when it is neither a 401 nor a redirect to sign-in. */
	isSignedOut?(response: { status: number; bodyKind: string; json?: unknown }): boolean;
	/** Extra `source.raw` keys to drop, on top of the shared scrub list. */
	readonly rawScrubKeys: string[];
	readonly notes: string[];

	identifyUser(): Promise<UserInfo>;
	count(type: ObjectType): Promise<number | null>;
	enumerateTracks(): AsyncIterable<LineRecord>;
	enumerateRoutes(): AsyncIterable<LineRecord>;
	enumerateWaypoints(): AsyncIterable<WaypointRecord>;
	enumerateAreas(): AsyncIterable<AreaRecord>;
	enumerateCollections(): AsyncIterable<CollectionRecord>;
	enumeratePhotos(): AsyncIterable<PhotoRecord>;
}

export type AdapterFactory = (transport: AdapterTransport, mode: string) => MapSourceAdapter;

export interface ExportSelection {
	routes: boolean;
	tracks: boolean;
	waypoints: boolean;
	areas: boolean;
	collections: boolean;
	photos: boolean;
	rawSourceData: boolean;
}
