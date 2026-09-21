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
	GaiaArea,
	GaiaFolder,
	GaiaLineDetail,
	GaiaPhoto,
	GaiaSavedHike,
	GaiaTrackSummary,
	GaiaWaypoint
} from './schemas';

export const UNTITLED = 'Untitled';

export interface GaiaUrls {
	object(type: 'track' | 'route' | 'waypoint' | 'area' | 'photo' | 'folder', id: string): string;
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
		tags?: string[];
	},
	url: string
) {
	return {
		name: nonEmpty(summary.title) ?? UNTITLED,
		description: nonEmpty(summary.notes),
		createdAt: toUtcTimestamp(summary.time_created),
		updatedAt: toUtcTimestamp(summary.updated_date),
		visibility: visibility(summary.public),
		tags: summary.tags ?? [],
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
	return detail.geometry.coordinates.map((segment) =>
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

export function mapWaypoint(waypoint: GaiaWaypoint, urls: GaiaUrls): WaypointRecord {
	const [lon, lat, ele] = waypoint.geometry.coordinates;
	const position: Position =
		typeof ele === 'number' && Number.isFinite(ele) ? [lon!, lat!, ele] : [lon!, lat!];
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

export function mapArea(area: GaiaArea, urls: GaiaUrls): AreaRecord {
	const geometry: AreaRecord['geometry'] =
		area.geometry.type === 'Polygon'
			? {
					type: 'Polygon',
					coordinates: area.geometry.coordinates.map((ring) => ring.map(toPosition))
				}
			: {
					type: 'MultiPolygon',
					coordinates: area.geometry.coordinates.map((polygon) =>
						polygon.map((ring) => ring.map(toPosition))
					)
				};
	return {
		kind: 'area',
		...base(area, urls.object('area', area.id)),
		geometry,
		areaSquareMeters: finiteOrNull(area.area)
	};
}

export function mapPhoto(photo: GaiaPhoto, urls: GaiaUrls): PhotoRecord {
	const hasCoordinate = typeof photo.latitude === 'number' && typeof photo.longitude === 'number';
	return {
		kind: 'photo',
		name: nonEmpty(photo.title),
		caption: nonEmpty(photo.caption) ?? nonEmpty(photo.notes),
		takenAt: toUtcTimestamp(photo.taken_at),
		uploadedAt: toUtcTimestamp(photo.time_created),
		coordinate: hasCoordinate ? [photo.longitude!, photo.latitude!] : null,
		url: photo.fullsize_url,
		rendition: 'original',
		attachedTo: photo.attached_to
			? { type: photo.attached_to.type, sourceId: photo.attached_to.id }
			: null,
		source: { id: photo.id, url: urls.object('photo', photo.id), raw: photo }
	};
}

/** Another user's object that shows up in my listings: name, link and one coordinate. Nothing else. */
export function mapForeignLine(
	kind: 'track' | 'route',
	summary: GaiaTrackSummary,
	urls: GaiaUrls
): ReferenceRecord {
	const start = summary.start_location;
	return {
		name: nonEmpty(summary.title) ?? UNTITLED,
		source: { id: summary.id, url: urls.object(kind, summary.id) },
		coordinate: start ? [start.longitude, start.latitude] : null
	};
}

export function mapSavedHike(hike: GaiaSavedHike): ReferenceRecord {
	return {
		name: hike.name,
		source: { id: hike.id, url: hike.url ?? null },
		coordinate: hike.trailhead ? [hike.trailhead.longitude, hike.trailhead.latitude] : null,
		// The user's own words and dates — not the platform's description or geometry.
		annotations: {
			completedAt: nonEmpty(hike.completed_on),
			rating: finiteOrNull(hike.user_rating),
			notes: nonEmpty(hike.user_notes)
		}
	};
}

export function mapSharedFolder(folder: GaiaFolder, urls: GaiaUrls): ReferenceRecord {
	return {
		name: nonEmpty(folder.name) ?? UNTITLED,
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
	for (const hike of folder.saved_hikes) {
		members.push({ kind: 'reference', reference: mapSavedHike(hike) });
	}
	return {
		kind: 'collection',
		key: folder.id,
		name: nonEmpty(folder.name) ?? UNTITLED,
		description: nonEmpty(folder.notes),
		createdAt: toUtcTimestamp(folder.time_created),
		updatedAt: toUtcTimestamp(folder.updated_date),
		parentSourceId: folder.parent ?? null,
		source: { id: folder.id, url: urls.object('folder', folder.id), raw: folder },
		members
	};
}
