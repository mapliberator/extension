/** AllTrails → normalized records. Pure functions, covered by fixtures. */
import type {
	CollectionMemberRecord,
	CollectionRecord,
	PhotoRecord,
	ReferenceRecord,
	TrackPoint,
	Visibility,
	WaypointRecord
} from '../../shared/models';
import { finiteOrNull, nonEmpty, toUtcTimestamp } from '../support';
import { decodeIndexed, decodePolyline } from './polyline';
import type {
	AllTrailsList,
	AllTrailsListItem,
	AllTrailsMap,
	AllTrailsMapDetail,
	AllTrailsPhoto,
	AllTrailsSegment,
	AllTrailsTrail,
	AllTrailsWaypoint
} from './schemas';

export const UNTITLED = 'Untitled';

export interface AllTrailsUrls {
	recording(map: AllTrailsMap): string;
	route(map: AllTrailsMap): string;
	trail(trail: AllTrailsTrail): string;
	/** The image itself: needs the app key, not the session, and redirects to the image host. */
	photoFile(id: number): string;
}

function visibility(isPrivate: boolean | null | undefined): Visibility {
	return isPrivate === undefined || isPrivate === null ? null : isPrivate ? 'private' : 'public';
}

export function displayName(user: { firstName?: string | null; lastName?: string | null }): string {
	const first = nonEmpty(user.firstName);
	const last = nonEmpty(user.lastName);
	if (first && last) return `${first} ${last[0]}.`;
	return first ?? last ?? 'AllTrails user';
}

/** A recording becomes a track, a custom route a route. */
export function mapLine(kind: 'track' | 'route', map: AllTrailsMap, urls: AllTrailsUrls) {
	return {
		kind,
		name: nonEmpty(map.name) ?? UNTITLED,
		description: nonEmpty(map.description),
		createdAt: toUtcTimestamp(map.metadata?.created ?? map.created_at),
		updatedAt: toUtcTimestamp(map.metadata?.updated),
		visibility: visibility(map.private),
		tags: [] as string[],
		activityType: nonEmpty(map.activity?.uid),
		stats: {
			distanceMeters: finiteOrNull(map.summaryStats?.distanceTotal),
			ascentMeters: finiteOrNull(map.summaryStats?.elevationGain),
			durationSeconds: kind === 'track' ? finiteOrNull(map.summaryStats?.duration) : null
		},
		source: {
			id: String(map.id),
			url: kind === 'track' ? urls.recording(map) : urls.route(map),
			raw: map
		}
	};
}

function bySequence(segments: AllTrailsSegment[]): AllTrailsSegment[] {
	return [...segments].sort((a, b) => (a.sequence_num ?? 0) - (b.sequence_num ?? 0));
}

/**
 * Elevation is metres × 10⁵. Time counts hundredths of a second from an origin the platform
 * does not document, so it is read relative to the segment's own `dateTimeStart`.
 */
function mapSegment(segment: AllTrailsSegment): TrackPoint[] {
	const { polyline } = segment;
	const elevations = polyline.indexedElevationData
		? decodeIndexed(polyline.indexedElevationData)
		: null;
	const times = polyline.indexedTimeData ? decodeIndexed(polyline.indexedTimeData) : null;
	const start = segment.dateTimeStart ? Date.parse(segment.dateTimeStart) : Number.NaN;
	const firstTick = times?.values().next().value;
	return decodePolyline(polyline.pointsData).map(([lat, lon], index) => {
		const elevation = elevations?.get(index);
		const tick = times?.get(index);
		const timed = tick !== undefined && firstTick !== undefined && Number.isFinite(start);
		return {
			lat,
			lon,
			ele: elevation === undefined ? null : elevation / 1e5,
			time: timed ? toUtcTimestamp((start + (tick - firstTick) * 10) / 1000) : null
		};
	});
}

export function mapSegments(detail: AllTrailsMapDetail): TrackPoint[][] {
	const segments = [
		...(detail.tracks ?? []).flatMap((track) => bySequence(track.lineTimedSegments)),
		...(detail.routes ?? []).flatMap((route) => bySequence(route.lineSegments))
	];
	return segments.map(mapSegment).filter((points) => points.length > 0);
}

/** Waypoints only exist inside the recording or route they were dropped on. */
export function mapWaypoint(
	waypoint: AllTrailsWaypoint,
	kind: 'track' | 'route',
	map: AllTrailsMap,
	urls: AllTrailsUrls
): WaypointRecord {
	// The embedded `user` block is a name and a portrait: not something to archive.
	const { user: _user, ...raw } = waypoint as AllTrailsWaypoint & { user?: unknown };
	return {
		kind: 'waypoint',
		name: nonEmpty(waypoint.name) ?? UNTITLED,
		description: nonEmpty(waypoint.description),
		createdAt: null,
		updatedAt: null,
		visibility: visibility(map.private),
		tags: [],
		position: [waypoint.location.longitude, waypoint.location.latitude],
		icon: nonEmpty(waypoint.waypointCategory?.uid),
		source: {
			id: String(waypoint.id),
			url: kind === 'track' ? urls.recording(map) : urls.route(map),
			raw
		}
	};
}

/** Platform trail → name, link, one coordinate. Never its overview, geometry or photos. */
export function mapTrailReference(
	trail: AllTrailsTrail,
	item: AllTrailsListItem,
	urls: AllTrailsUrls
): ReferenceRecord {
	const latitude = trail.location?.latitude;
	const longitude = trail.location?.longitude;
	const notes = nonEmpty(item.notes);
	return {
		name: trail.name,
		source: { id: String(trail.id), url: urls.trail(trail) },
		coordinate:
			typeof latitude === 'number' && typeof longitude === 'number' ? [longitude, latitude] : null,
		// The user's own words ride along; nothing of the platform's does.
		...(notes ? { annotations: { notes } } : {})
	};
}

export function mapList(list: AllTrailsList, members: CollectionMemberRecord[]): CollectionRecord {
	return {
		kind: 'collection',
		key: String(list.id),
		name: nonEmpty(list.name) ?? UNTITLED,
		description: nonEmpty(list.description),
		createdAt: null,
		updatedAt: null,
		parentSourceId: null,
		// Lists have no page of their own that is known to be stable.
		source: { id: String(list.id), url: null, raw: list },
		members
	};
}

export function mapPhoto(
	photo: AllTrailsPhoto,
	attachedTo: PhotoRecord['attachedTo'],
	urls: AllTrailsUrls
): PhotoRecord {
	const latitude = photo.location?.latitude;
	const longitude = photo.location?.longitude;
	return {
		kind: 'photo',
		name: nonEmpty(photo.title),
		caption: nonEmpty(photo.description),
		takenAt: null,
		uploadedAt: toUtcTimestamp(photo.metadata?.created),
		coordinate:
			typeof latitude === 'number' && typeof longitude === 'number' ? [longitude, latitude] : null,
		url: urls.photoFile(photo.id),
		// Every size the site offers tops out at the same file; whether that is the upload is unknown.
		rendition: 'largest-available',
		attachedTo,
		source: { id: String(photo.id), url: null, raw: photo }
	};
}
