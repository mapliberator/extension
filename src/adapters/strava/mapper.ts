/** Strava → normalized records. Pure functions, covered by fixtures. */
import type { PhotoRecord, ReferenceRecord, TrackPoint, Visibility } from '../../shared/models';
import { finiteOrNull, nonEmpty, toUtcTimestamp } from '../support';
import type { StravaActivity, StravaPhoto, StravaRoute, StravaStreams } from './schemas';

export const UNTITLED = 'Untitled';

export interface StravaUrls {
	activity(id: string): string;
	route(id: string): string;
}

export function activityId(activity: StravaActivity): string {
	return activity.id_str ?? String(activity.id);
}

/** Followers-only is not something anyone with the link may see, so it counts as private. */
function activityVisibility(activity: StravaActivity): Visibility {
	switch (activity.visibility) {
		case 'everyone':
			return 'public';
		case 'only_me':
		case 'followers_only':
			return 'private';
		default:
			return activity.private === true ? 'private' : null;
	}
}

/** `+0000` offsets are not RFC 3339, and not every Date parser takes them. */
function stravaTime(value: string | null | undefined): string | null {
	return toUtcTimestamp(value?.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

export function displayName(athlete: {
	firstname?: string | null;
	lastname?: string | null;
}): string {
	const first = nonEmpty(athlete.firstname);
	const last = nonEmpty(athlete.lastname);
	if (first && last) return `${first} ${last[0]}.`;
	return first ?? last ?? 'Strava athlete';
}

/** An activity becomes a track. */
export function mapActivity(activity: StravaActivity, urls: StravaUrls) {
	const id = activityId(activity);
	return {
		kind: 'track' as const,
		name: nonEmpty(activity.name) ?? UNTITLED,
		description: nonEmpty(activity.description),
		createdAt: stravaTime(activity.start_time),
		updatedAt: null,
		visibility: activityVisibility(activity),
		tags: [] as string[],
		activityType: nonEmpty(activity.sport_type),
		stats: {
			distanceMeters: finiteOrNull(activity.distance_raw),
			ascentMeters: finiteOrNull(activity.elevation_gain_raw),
			durationSeconds: finiteOrNull(activity.elapsed_time_raw)
		},
		source: { id, url: urls.activity(id), raw: activity }
	};
}

/**
 * The fallback geometry: one segment, as the platform's own GPX export has it. Stream times
 * count seconds from the activity's start.
 */
export function mapStreams(streams: StravaStreams, activity: StravaActivity): TrackPoint[][] {
	const latlng = streams.latlng ?? [];
	const start = activity.start_time ? Date.parse(stravaTime(activity.start_time) ?? '') : NaN;
	const points = latlng.map(([lat, lon], index): TrackPoint => {
		const altitude = streams.altitude?.[index];
		const offset = streams.time?.[index];
		return {
			lat,
			lon,
			ele: typeof altitude === 'number' ? altitude : null,
			time:
				typeof offset === 'number' && Number.isFinite(start)
					? toUtcTimestamp(start / 1000 + offset)
					: null
		};
	});
	return points.length > 0 ? [points] : [];
}

/** One of the user's own routes. Planned, so it has no duration of its own. */
export function mapRoute(route: StravaRoute, urls: StravaUrls) {
	return {
		kind: 'route' as const,
		name: nonEmpty(route.title) ?? UNTITLED,
		description: null,
		createdAt: toUtcTimestamp(route.creationTime),
		updatedAt: null,
		visibility: (route.isPrivate === true ? 'private' : 'public') as Visibility,
		tags: [] as string[],
		activityType: nonEmpty(route.routeType),
		stats: {
			distanceMeters: finiteOrNull(route.length),
			ascentMeters: finiteOrNull(route.elevationGain),
			durationSeconds: null
		},
		source: { id: route.id, url: urls.route(route.id), raw: route }
	};
}

/** Somebody else's route the user starred: a name and a link, never its geometry. */
export function mapStarredRoute(route: StravaRoute, urls: StravaUrls): ReferenceRecord {
	return {
		name: nonEmpty(route.title) ?? UNTITLED,
		source: { id: route.id, url: urls.route(route.id) },
		coordinate: null
	};
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'"
};

/** Undo the listing's HTML escaping. The result is text, never markup. */
export function unescapeHtml(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
		if (body[0] === '#') {
			const code =
				body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: entity;
		}
		return ENTITIES[body.toLowerCase()] ?? entity;
	});
}

export function mapPhoto(photo: StravaPhoto): PhotoRecord {
	const activity = nonEmpty(photo.activity_id_str);
	const lat = photo.lat;
	const lng = photo.lng;
	return {
		kind: 'photo',
		// Strava photos have a caption but no title.
		name: null,
		caption: nonEmpty(unescapeHtml(photo.caption_escaped ?? '')),
		takenAt: null,
		uploadedAt: null,
		coordinate: typeof lat === 'number' && typeof lng === 'number' ? [lng, lat] : null,
		url: photo.large,
		// The listing's biggest size, which is not always the upload's own size.
		rendition: 'largest-available',
		attachedTo: activity ? { type: 'track', sourceId: activity } : null,
		source: { id: photo.photo_id, url: null, raw: photo }
	};
}
