/** Garmin Connect → normalized records. Pure functions, covered by fixtures. */
import type { ReferenceRecord, TrackPoint, Visibility } from '../../shared/models';
import { finiteOrNull, nonEmpty, toUtcTimestamp } from '../support';
import type {
	GarminActivity,
	GarminActivityDetails,
	GarminCourse,
	GarminCourseDetail
} from './schemas';

export const UNTITLED = 'Untitled';

export interface GarminUrls {
	activity(id: string): string;
	course(id: string): string;
}

/** Epoch milliseconds → RFC 3339 UTC. */
function fromMillis(value: number | null | undefined): string | null {
	return typeof value === 'number' && Number.isFinite(value) ? toUtcTimestamp(value / 1000) : null;
}

/** Followers-only ("subscribers") is not something anyone with the link may see: private. */
function visibility(privacy: { typeKey?: string | null } | null | undefined): Visibility {
	switch (privacy?.typeKey) {
		case 'public':
			return 'public';
		case 'private':
		case 'subscribers':
			return 'private';
		default:
			return null;
	}
}

/** "First Last" → "First L.", as the other adapters name an account. */
export function displayName(fullName: string | null | undefined): string {
	const words = nonEmpty(fullName)?.split(/\s+/) ?? [];
	if (words.length === 0) return 'Garmin Connect user';
	if (words.length === 1) return words[0]!;
	return `${words[0]} ${words.at(-1)![0]}.`;
}

/** An activity becomes a track. */
export function mapActivity(activity: GarminActivity, urls: GarminUrls) {
	const id = String(activity.activityId);
	return {
		kind: 'track' as const,
		name: nonEmpty(activity.activityName) ?? UNTITLED,
		description: nonEmpty(activity.description),
		createdAt: fromMillis(activity.beginTimestamp),
		updatedAt: null,
		visibility: visibility(activity.privacy),
		tags: [] as string[],
		activityType: nonEmpty(activity.activityType?.typeKey),
		stats: {
			distanceMeters: finiteOrNull(activity.distance),
			ascentMeters: finiteOrNull(activity.elevationGain),
			// Wall-clock time; `duration` leaves out the time the timer was paused.
			durationSeconds: finiteOrNull(activity.elapsedDuration ?? activity.duration)
		},
		source: { id, url: urls.activity(id), raw: activity }
	};
}

/**
 * The fallback geometry from an activity's details: one segment, as the platform's own GPX
 * export has it. Rows without a position (the device had no fix yet) are left out.
 */
export function mapActivityDetails(details: GarminActivityDetails): TrackPoint[][] {
	const column = new Map(details.metricDescriptors.map((d) => [d.key, d.metricsIndex]));
	const lat = column.get('directLatitude');
	const lon = column.get('directLongitude');
	if (lat === undefined || lon === undefined) return [];
	const ele = column.get('directElevation');
	const time = column.get('directTimestamp');
	const points: TrackPoint[] = [];
	for (const { metrics } of details.activityDetailMetrics) {
		const y = metrics[lat];
		const x = metrics[lon];
		if (typeof y !== 'number' || typeof x !== 'number') continue;
		points.push({
			lat: y,
			lon: x,
			ele: ele === undefined ? null : (metrics[ele] ?? null),
			time: time === undefined ? null : fromMillis(metrics[time])
		});
	}
	return points.length > 0 ? [points] : [];
}

/** One of the user's own courses. Planned, so it has no duration of its own. */
export function mapCourse(course: GarminCourse, urls: GarminUrls) {
	const id = String(course.courseId);
	return {
		kind: 'route' as const,
		name: nonEmpty(course.courseName) ?? UNTITLED,
		description: nonEmpty(course.courseDescription),
		createdAt: fromMillis(course.createdDate),
		updatedAt: fromMillis(course.updatedDate),
		visibility: visibility(course.privacyRule),
		tags: [] as string[],
		activityType: nonEmpty(course.activityType?.typeKey),
		stats: {
			distanceMeters: finiteOrNull(course.distanceInMeters),
			ascentMeters: finiteOrNull(course.elevationGainInMeters),
			durationSeconds: null
		},
		source: { id, url: urls.course(id), raw: course }
	};
}

/** A course's fallback geometry: its points, without times, as its GPX export has them. */
export function mapCourseDetail(detail: GarminCourseDetail): TrackPoint[][] {
	const points = detail.geoPoints.map((p): TrackPoint => ({
		lat: p.latitude,
		lon: p.longitude,
		ele: p.elevation ?? null,
		time: null
	}));
	return points.length > 0 ? [points] : [];
}

/** Somebody else's course the user favorited: a name, a link and where it starts. */
export function mapFavoriteCourse(course: GarminCourse, urls: GarminUrls): ReferenceRecord {
	const id = String(course.courseId);
	const lat = finiteOrNull(course.startLatitude);
	const lon = finiteOrNull(course.startLongitude);
	return {
		name: nonEmpty(course.courseName) ?? UNTITLED,
		source: { id, url: urls.course(id) },
		coordinate: lat !== null && lon !== null ? [lon, lat] : null
	};
}
