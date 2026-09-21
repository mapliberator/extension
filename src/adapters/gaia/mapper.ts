/** Gaia GPS → normalized records. Pure functions, covered by fixtures. */
import type {
	AreaRecord,
	CollectionMemberRecord,
	CollectionRecord,
	LineStats,
	PhotoRecord,
	Position,
	ReferenceRecord,
	TrackPoint,
	Visibility,
	WaypointRecord
} from '../../shared/models';
import { finiteOrNull, nonEmpty, toUtcTimestamp } from '../support';
import type {
	GaiaAreaDetail,
	GaiaAreaSummary,
	GaiaFolder,
	GaiaLineDetail,
	GaiaPhoto,
	GaiaTrackSummary,
	GaiaWaypoint
} from './schemas';

export const UNTITLED = 'Untitled';

export interface GaiaUrls {
	object(type: 'track' | 'route' | 'waypoint' | 'area' | 'photo' | 'folder', id: string): string;
	/** The original image: answers without a session and redirects to the photo host. */
	photoFile(id: string): string;
}

/** Folders list their access level; anything but the owner's is somebody else's folder. */
export function isOwnFolder(folder: GaiaFolder): boolean {
	return folder.access ? folder.access === 'owner' : folder.is_shared !== true;
}

function visibility(isPublic: boolean | undefined): Visibility {
	return isPublic === undefined ? null : isPublic ? 'public' : 'private';
}

function base(
	summary: {
		id: string;
		title: string | null;
		notes?: string | null;
		time_created: string | null;
		updated_date?: string | null;
		public?: boolean;
	},
	url: string
) {
	return {
		name: nonEmpty(summary.title) ?? UNTITLED,
		description: nonEmpty(summary.notes),
		createdAt: toUtcTimestamp(summary.time_created),
		updatedAt: toUtcTimestamp(summary.updated_date),
		visibility: visibility(summary.public),
		// Gaia has no tags.
		tags: [],
		source: { id: summary.id, url, raw: summary }
	};
}

export function mapLineSummary(kind: 'track' | 'route', summary: GaiaTrackSummary, urls: GaiaUrls) {
	const stats: LineStats = {
		distanceMeters: finiteOrNull(summary.distance),
		ascentMeters: finiteOrNull(summary.total_ascent),
		durationSeconds: kind === 'track' ? finiteOrNull(summary.total_time) : null
	};
	return {
		kind,
		...base(summary, urls.object(kind, summary.id)),
		activityType: summary.activities?.[0] ?? null,
		stats
	};
}

/** [lon, lat, ele?, epochSeconds?] → TrackPoint segments. */
export function mapLineGeometry(detail: GaiaLineDetail): TrackPoint[][] {
	return detail.features[0]!.geometry.coordinates.map((segment) =>
		segment.flatMap((coordinate): TrackPoint[] => {
			const [lon, lat, ele, time] = coordinate;
			if (typeof lon !== 'number' || typeof lat !== 'number') return [];
			return [
				{
					lon,
					lat,
					ele: finiteOrNull(ele),
					time: typeof time === 'number' && time > 0 ? toUtcTimestamp(time) : null
				}
			];
		})
	);
}

const first = (value: number | number[]): number => (typeof value === 'number' ? value : value[0]!);

/** [lon, lat] of a listed waypoint. The listing carries no elevation. */
export function waypointCoordinate(waypoint: GaiaWaypoint): [number, number] {
	return [first(waypoint.longitude), first(waypoint.latitude)];
}

export function mapWaypoint(waypoint: GaiaWaypoint, urls: GaiaUrls): WaypointRecord {
	const position: Position = waypointCoordinate(waypoint);
	return {
		kind: 'waypoint',
		...base(waypoint, urls.object('waypoint', waypoint.id)),
		position,
		icon: nonEmpty(waypoint.icon)
	};
}

function toPosition(coordinate: number[]): Position {
	const [lon, lat, ele] = coordinate;
	return typeof ele === 'number' ? [lon!, lat!, ele] : [lon!, lat!];
}

export function mapArea(
	summary: GaiaAreaSummary,
	detail: GaiaAreaDetail,
	urls: GaiaUrls
): AreaRecord {
	const source = detail.geometry;
	const geometry: AreaRecord['geometry'] =
		source.type === 'Polygon'
			? { type: 'Polygon', coordinates: source.coordinates.map((ring) => ring.map(toPosition)) }
			: {
					type: 'MultiPolygon',
					coordinates: source.coordinates.map((polygon) =>
						polygon.map((ring) => ring.map(toPosition))
					)
				};
	return {
		kind: 'area',
		...base(summary, urls.object('area', summary.id)),
		geometry,
		// Gaia does not report an area's size.
		areaSquareMeters: null
	};
}

/**
 * Every Gaia photo hangs off a waypoint, and the listing has no coordinate of its own: the photo
 * takes the waypoint's, when that waypoint is still around.
 */
export function mapPhoto(
	photo: GaiaPhoto,
	urls: GaiaUrls,
	waypoints: ReadonlyMap<string, [number, number]>
): PhotoRecord {
	const coordinate = photo.waypoint_id ? waypoints.get(photo.waypoint_id) : undefined;
	return {
		kind: 'photo',
		name: nonEmpty(photo.title),
		caption: nonEmpty(photo.notes),
		takenAt: null,
		uploadedAt: toUtcTimestamp(photo.time_created),
		coordinate: coordinate ?? null,
		url: urls.photoFile(photo.id),
		rendition: 'original',
		attachedTo: coordinate ? { type: 'waypoint', sourceId: photo.waypoint_id! } : null,
		source: { id: photo.id, url: urls.object('photo', photo.id), raw: photo }
	};
}

/** Another user's object that shows up in my listings: name, link and one coordinate. Nothing else. */
export function mapForeignLine(
	kind: 'track' | 'route',
	summary: GaiaTrackSummary,
	detail: GaiaLineDetail,
	urls: GaiaUrls
): ReferenceRecord {
	const { latitude, longitude } = detail.features[0]!.properties;
	return {
		name: nonEmpty(summary.title) ?? UNTITLED,
		source: { id: summary.id, url: urls.object(kind, summary.id) },
		coordinate:
			typeof latitude === 'number' && typeof longitude === 'number' ? [longitude, latitude] : null
	};
}

export function mapSharedFolder(folder: GaiaFolder, urls: GaiaUrls): ReferenceRecord {
	return {
		name: nonEmpty(folder.title) ?? UNTITLED,
		source: { id: folder.id, url: urls.object('folder', folder.id) },
		coordinate: null
	};
}

export function mapFolder(
	folder: GaiaFolder,
	urls: GaiaUrls,
	foreign: ReadonlyMap<string, ReferenceRecord>
): CollectionRecord {
	const members: CollectionMemberRecord[] = [];
	const add = (type: 'track' | 'route' | 'waypoint' | 'area', ids: string[]) => {
		for (const sourceId of ids) {
			const reference = foreign.get(`${type}:${sourceId}`);
			members.push(
				reference ? { kind: 'reference', reference } : { kind: 'object', type, sourceId }
			);
		}
	};
	add('track', folder.tracks);
	add('route', folder.routes);
	add('waypoint', folder.waypoints);
	add('area', folder.areas);
	return {
		kind: 'collection',
		key: folder.id,
		name: nonEmpty(folder.title) ?? UNTITLED,
		description: nonEmpty(folder.notes),
		createdAt: toUtcTimestamp(folder.time_created),
		updatedAt: toUtcTimestamp(folder.updated_date),
		parentSourceId: folder.parent ?? null,
		source: { id: folder.id, url: urls.object('folder', folder.id), raw: folder },
		members
	};
}
