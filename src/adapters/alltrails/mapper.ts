/** AllTrails → normalized records. Pure functions, covered by fixtures. */
import type {
	CollectionMemberRecord,
	CollectionRecord,
	LineStats,
	PhotoRecord,
	ReferenceRecord,
	TrackPoint,
	Visibility,
	WaypointRecord
} from '../../shared/models';
import { finiteOrNull, nonEmpty, toUtcTimestamp } from '../support';
import { decodePolyline } from './polyline';
import type {
	AllTrailsActivity,
	AllTrailsCompleted,
	AllTrailsList,
	AllTrailsMap,
	AllTrailsMapWaypoint,
	AllTrailsPhoto,
	AllTrailsSegments,
	AllTrailsTrail
} from './schemas';

export const UNTITLED = 'Untitled';

export interface AllTrailsUrls {
	activity(id: number): string;
	map(id: number): string;
	list(id: number): string;
	trail(trail: AllTrailsTrail): string;
	photo(id: number): string;
}

function visibility(isPrivate: boolean | undefined): Visibility {
	return isPrivate === undefined ? null : isPrivate ? 'private' : 'public';
}

export function displayName(user: { firstName?: string | null; lastName?: string | null }): string {
	const first = nonEmpty(user.firstName);
	const last = nonEmpty(user.lastName);
	if (first && last) return `${first} ${last[0]}.`;
	return first ?? last ?? 'AllTrails user';
}

function lineStats(line: AllTrailsActivity | AllTrailsMap, withDuration: boolean): LineStats {
	return {
		distanceMeters: finiteOrNull(line.summaryStats?.distanceTotal),
		ascentMeters: finiteOrNull(line.summaryStats?.elevationGain),
		durationSeconds: withDuration ? finiteOrNull(line.summaryStats?.timeTotal) : null
	};
}

export function mapActivity(activity: AllTrailsActivity, urls: AllTrailsUrls) {
	return {
		kind: 'track' as const,
		name: nonEmpty(activity.name) ?? UNTITLED,
		description: nonEmpty(activity.notes),
		createdAt: toUtcTimestamp(activity.createdAt),
		updatedAt: toUtcTimestamp(activity.updatedAt),
		visibility: visibility(activity.private),
		tags: [] as string[],
		activityType: activity.activityType?.uid ?? null,
		stats: lineStats(activity, true),
		source: { id: String(activity.id), url: urls.activity(activity.id), raw: activity }
	};
}

export function mapMap(map: AllTrailsMap, urls: AllTrailsUrls) {
	// Embedded waypoints are exported as waypoints of their own, not duplicated into raw.
	const { waypoints: _waypoints, ...raw } = map;
	return {
		kind: 'route' as const,
		name: nonEmpty(map.name) ?? UNTITLED,
		description: nonEmpty(map.description),
		createdAt: toUtcTimestamp(map.createdAt),
		updatedAt: toUtcTimestamp(map.updatedAt),
		visibility: visibility(map.private),
		tags: [] as string[],
		activityType: map.activityType?.uid ?? null,
		stats: lineStats(map, false),
		source: { id: String(map.id), url: urls.map(map.id), raw }
	};
}

export function mapSegments(detail: AllTrailsSegments): TrackPoint[][] {
	return detail.segments.map(({ polyline }) => {
		const points = decodePolyline(polyline.pointsData);
		const elevations =
			polyline.elevationData?.length === points.length ? polyline.elevationData : null;
		const times = polyline.timeData?.length === points.length ? polyline.timeData : null;
		return points.map(([lat, lon], index) => ({
			lat,
			lon,
			ele: finiteOrNull(elevations?.[index]),
			time: toUtcTimestamp(times?.[index] ?? null)
		}));
	});
}

export function mapMapWaypoint(
	waypoint: AllTrailsMapWaypoint,
	map: AllTrailsMap,
	urls: AllTrailsUrls
): WaypointRecord {
	return {
		kind: 'waypoint',
		name: nonEmpty(waypoint.name) ?? UNTITLED,
		description: nonEmpty(waypoint.description),
		createdAt: toUtcTimestamp(waypoint.createdAt),
		updatedAt: null,
		visibility: visibility(map.private),
		tags: [],
		position: [waypoint.location.longitude, waypoint.location.latitude],
		icon: null,
		source: {
			id: String(waypoint.id),
			url: urls.map(map.id),
			raw: { ...waypoint, mapId: map.id }
		}
	};
}

/** Platform trail → name, link, one coordinate. Never its description, geometry or photos. */
export function mapTrailReference(trail: AllTrailsTrail, urls: AllTrailsUrls): ReferenceRecord {
	return {
		name: trail.name,
		source: { id: String(trail.id), url: urls.trail(trail) },
		coordinate: trail.location ? [trail.location.longitude, trail.location.latitude] : null
	};
}

export function mapList(list: AllTrailsList, urls: AllTrailsUrls): CollectionRecord {
	const members: CollectionMemberRecord[] = list.items.map((item) => {
		switch (item.type) {
			case 'trail':
				return { kind: 'reference', reference: mapTrailReference(item.trail, urls) };
			case 'map':
				return { kind: 'object', type: 'route', sourceId: String(item.id) };
			case 'activity':
				return { kind: 'object', type: 'track', sourceId: String(item.id) };
		}
	});
	return {
		kind: 'collection',
		key: String(list.id),
		name: nonEmpty(list.name) ?? UNTITLED,
		description: nonEmpty(list.description),
		createdAt: toUtcTimestamp(list.createdAt),
		updatedAt: toUtcTimestamp(list.updatedAt),
		parentSourceId: null,
		source: { id: String(list.id), url: urls.list(list.id), raw: list },
		members
	};
}

/** The user's own review, rating, date and notes ride along with the reference. */
export function mapCompleted(completed: AllTrailsCompleted, urls: AllTrailsUrls): ReferenceRecord {
	return {
		...mapTrailReference(completed.trail, urls),
		annotations: {
			completedAt: nonEmpty(completed.completedAt),
			rating: finiteOrNull(completed.rating),
			review: nonEmpty(completed.review),
			notes: nonEmpty(completed.privateNotes)
		}
	};
}

export function mapPhoto(photo: AllTrailsPhoto, urls: AllTrailsUrls): PhotoRecord {
	const attached = photo.attachedTo;
	return {
		kind: 'photo',
		name: nonEmpty(photo.title),
		caption: nonEmpty(photo.caption),
		takenAt: toUtcTimestamp(photo.takenAt),
		uploadedAt: toUtcTimestamp(photo.createdAt),
		coordinate: photo.location ? [photo.location.longitude, photo.location.latitude] : null,
		url: photo.urls.original ?? photo.urls.large,
		rendition: photo.urls.original ? 'original' : 'largest-available',
		// Platform trails are not archive objects, so a trail photo is simply unattached.
		attachedTo:
			attached && attached.type !== 'trail'
				? { type: attached.type === 'activity' ? 'track' : 'route', sourceId: String(attached.id) }
				: null,
		source: { id: String(photo.id), url: urls.photo(photo.id), raw: photo }
	};
}
