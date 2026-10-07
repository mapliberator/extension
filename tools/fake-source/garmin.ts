/**
 * Garmin-Connect-shaped dataset + API. Shapes follow docs/phase0-findings.md: the web app's
 * `/gc-api/…` proxy wants the session cookie AND the session's CSRF token in a
 * `connect-csrf-token` header on every request (403 without it, 401 without a session). The
 * token is the `<meta name="csrf-token">` of the app's pages (`/app/…`), which redirect to
 * `/signin/` when signed out. Activities come as a bare array paged with `start=`/`limit=`,
 * courses in one unpaged listing, and both have GPX exports plus JSON geometry.
 */
import {
	BASE_EPOCH,
	DAY,
	NAMES,
	PLATFORM_TRAILS,
	fnv1a,
	isoUtc,
	lineStats,
	makeLine,
	type Env,
	type Pt,
	type ResolvedDataset
} from './dataset.ts';
import { buildGpx, type GpxWaypoint } from './gpx.ts';
import { parseIntParam, type ApiRequest, type Reply } from './reply.ts';
import { SENTINELS } from './sentinels.ts';
import type { ExpectedArchive, GarminObjects, Json } from './types.ts';

const ME_ID = 5001;
const OTHER_ID = 5999;
const API = '/gc-api';
const GPX_TYPE = 'application/gpx+xml';
const GPX_NS = { prefix: 'ns3', uri: 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1' };
const CSRF_HEADER = 'connect-csrf-token';

/** The token the current session's pages carry, and the only one its API accepts. */
export function garminCsrfToken(generation: number): string {
	return `${SENTINELS.csrfToken}-garmin-s${generation}`;
}

export interface GarminActivityObject {
	id: string;
	summary: Json;
	details: Json;
	/** Native GPX export. An indoor activity's has no points at all. */
	gpx: Buffer;
	hasGps: boolean;
}

export interface GarminCourseObject {
	id: string;
	own: boolean;
	favorite: boolean;
	summary: Json;
	detail: Json;
	gpx: Buffer;
	/** [lon, lat] of the start, for the reference a favourite becomes. */
	start: [number, number];
}

export interface GarminData {
	me: Json;
	activities: GarminActivityObject[];
	courses: GarminCourseObject[];
	expected(): ExpectedArchive;
	objects(): GarminObjects;
}

function hex(seed: string, length: number): string {
	let out = '';
	for (let i = 0; out.length < length; i++)
		out += fnv1a(`${seed}:${i}`).toString(16).padStart(8, '0');
	return out.slice(0, length);
}

function uuid(seed: string): string {
	const h = hex(seed, 32);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `2024-06-02 14:11:09`: no zone at all, so a Date parser reads it as local time. */
function spaced(epochSeconds: number): string {
	return isoUtc(epochSeconds).replace('T', ' ').replace('Z', '');
}

const PROFILE_UUID = uuid('garmin:me');
const OTHER_NAME = SENTINELS.otherUserName;

function activityType(typeKey: string): Json {
	const typeId = fnv1a(typeKey) % 200;
	return { typeId, typeKey, parentTypeId: 17, isHidden: false, restricted: false, trimmable: true };
}

const PRIVACY: Record<string, number> = { public: 1, private: 2, subscribers: 4 };

interface ActivitySpec {
	id: number;
	name: string;
	description?: string;
	day: number;
	type: string;
	privacy: 'public' | 'private' | 'subscribers';
	/** Omitted: an indoor session with no GPS. */
	start?: [number, number];
	points?: number;
}

/**
 * The details' columns, in the order the platform lists them. Each one's `metricsIndex` is its
 * column in a row, which is not its place in this list.
 */
const METRICS = [
	['directElevation', 'meter', 100],
	['directHeartRate', 'bpm', 1],
	['directLongitude', 'dd', 1],
	['sumDistance', 'meter', 100],
	['directTimestamp', 'gmt', 0],
	['directLatitude', 'dd', 1]
] as const;
const COLUMN: Record<(typeof METRICS)[number][0], number> = {
	directLatitude: 0,
	directLongitude: 1,
	directTimestamp: 2,
	directElevation: 3,
	sumDistance: 4,
	directHeartRate: 5
};

function buildActivity(spec: ActivitySpec): GarminActivityObject {
	const startEpoch = BASE_EPOCH + spec.day * DAY + (spec.day % 5) * 977;
	const id = String(spec.id);
	const segments: Pt[][] = spec.start
		? makeLine({
				seed: `garmin:${spec.id}`,
				start: spec.start,
				segments: [spec.points ?? 80],
				digits: 6,
				startTime: startEpoch
			})
		: [];
	const points = segments.flat();
	const stats = lineStats(segments);
	const elapsed = spec.start ? stats.duration : 45 * 60;
	const summary: Json = {
		activityId: spec.id,
		activityUUID: uuid(`garmin-activity:${id}`),
		activityName: spec.name,
		...(spec.description === undefined ? {} : { description: spec.description }),
		startTimeLocal: spaced(startEpoch - 6 * 3600),
		startTimeGMT: spaced(startEpoch),
		endTimeGMT: spaced(startEpoch + elapsed),
		beginTimestamp: startEpoch * 1000,
		activityType: activityType(spec.type),
		eventType: { typeId: 9, typeKey: 'uncategorized', sortOrder: 10 },
		isFavorite: false,
		isPR: false,
		isParent: false,
		distance: spec.start ? stats.distance : 0,
		// Timer time leaves the pauses out; elapsed is wall-clock.
		duration: Math.round(elapsed * 0.97),
		elapsedDuration: elapsed,
		movingDuration: Math.round(elapsed * 0.9),
		elevationGain: stats.ascent,
		elevationLoss: stats.ascent,
		averageSpeed: elapsed > 0 ? stats.distance / elapsed : 0,
		...(spec.start ? { startLatitude: spec.start[0], startLongitude: spec.start[1] } : {}),
		hasPolyline: spec.start !== undefined,
		hasImages: false,
		hasVideo: false,
		ownerId: ME_ID,
		ownerDisplayName: PROFILE_UUID,
		ownerFullName: 'Test Walker',
		ownerProfileImageUrlSmall: 'https://avatars.invalid/small.png',
		ownerProfileImageUrlMedium: 'https://avatars.invalid/medium.png',
		ownerProfileImageUrlLarge: 'https://avatars.invalid/large.png',
		calories: 512,
		userRoles: ['SCOPE_GOLF_API_READ', 'ROLE_CONNECTUSER'],
		privacy: { typeId: PRIVACY[spec.privacy], typeKey: spec.privacy },
		userPro: false,
		timeZoneId: 124,
		deviceId: 3435303985,
		manualActivity: false
	};

	// The device has no fix for the first few rows: no position, the rest still there.
	const rows: Json[] = [];
	for (let i = 0; i < 3 && points.length > 0; i++) {
		rows.push({ metrics: row(null, null, (startEpoch - 3 + i) * 1000, points[0]!.ele, 0, 95) });
	}
	let travelled = 0;
	for (const [i, p] of points.entries()) {
		if (i > 0) travelled += lineStats([[points[i - 1]!, p]]).distance;
		rows.push({ metrics: row(p.lat, p.lon, p.time! * 1000, p.ele, travelled, 120 + (i % 30)) });
	}
	const details: Json = {
		activityId: spec.id,
		measurementCount: METRICS.length,
		metricsCount: rows.length,
		totalMetricsCount: rows.length,
		metricDescriptors: METRICS.map(([key, unit, factor]) => ({
			metricsIndex: COLUMN[key],
			key,
			unit: { id: fnv1a(unit) % 100, key: unit, factor }
		})),
		activityDetailMetrics: rows,
		// Lat/lon/time here too, but never an altitude.
		geoPolylineDTO: spec.start
			? {
					minLat: Math.min(...points.map((p) => p.lat)),
					maxLat: Math.max(...points.map((p) => p.lat)),
					minLon: Math.min(...points.map((p) => p.lon)),
					maxLon: Math.max(...points.map((p) => p.lon)),
					polyline: points.map((p) => ({
						lat: p.lat,
						lon: p.lon,
						altitude: null,
						time: p.time! * 1000,
						valid: true
					}))
				}
			: null,
		heartRateDTOs: null,
		pendingData: null,
		detailsAvailable: true
	};
	const gpx = buildGpx({
		creator: 'Garmin Connect',
		ns: GPX_NS,
		kind: 'trk',
		name: spec.name,
		time: startEpoch,
		extensions: [],
		segments,
		digits: 6
	});
	return { id, summary, details, gpx, hasGps: spec.start !== undefined };
}

function row(
	lat: number | null,
	lon: number | null,
	timestamp: number,
	ele: number | null,
	distance: number,
	heartRate: number
): (number | null)[] {
	const out: (number | null)[] = [];
	out[COLUMN.directLatitude] = lat;
	out[COLUMN.directLongitude] = lon;
	out[COLUMN.directTimestamp] = timestamp;
	out[COLUMN.directElevation] = ele;
	out[COLUMN.sumDistance] = Math.round(distance * 10) / 10;
	out[COLUMN.directHeartRate] = heartRate;
	return out;
}

interface CourseSpec {
	id: number;
	name: string;
	description?: string;
	own?: boolean;
	favorite?: boolean;
	day: number;
	type: string;
	privacy: 'public' | 'private';
	start: [number, number];
	points: number;
	coursePoints?: { name: string; type: string; at: number }[];
}

function buildCourse(spec: CourseSpec): GarminCourseObject {
	const own = spec.own !== false;
	const created = BASE_EPOCH + spec.day * DAY + 611;
	const id = String(spec.id);
	// Somebody else's course is drawn over a platform trail: its coordinates are sentinels, and
	// only its start (the trailhead) may reach an archive.
	const trail = PLATFORM_TRAILS[1]!;
	const segments: Pt[][] = own
		? makeLine({
				seed: `garmin-course:${spec.id}`,
				start: spec.start,
				segments: [spec.points],
				digits: 6,
				startTime: created,
				time: false
			})
		: [trail.geometry.map(([lat, lon]) => ({ lat, lon, ele: 1300, time: null }))];
	const start: [number, number] = own ? spec.start : trail.trailhead;
	const points = segments.flat();
	const stats = lineStats(segments);
	const typeKey = activityType(spec.type);
	const millis = created * 1000;
	const ownerId = own ? ME_ID : OTHER_ID;
	const summary: Json = {
		courseId: spec.id,
		userProfileId: ownerId,
		// A UUID for this account, a user name for anybody else.
		displayName: own ? PROFILE_UUID : OTHER_NAME,
		userGroupId: null,
		geoRoutePk: null,
		activityType: typeKey,
		courseName: spec.name,
		courseDescription: spec.description ?? null,
		createdDate: millis,
		updatedDate: millis + 3600_000,
		privacyRule: { typeId: spec.privacy === 'public' ? 1 : 2, typeKey: spec.privacy },
		distanceInMeters: stats.distance,
		elevationGainInMeters: stats.ascent,
		elevationLossInMeters: stats.ascent,
		startLatitude: start[0],
		startLongitude: start[1],
		speedInMetersPerSecond: 2.5,
		sourceTypeId: 3,
		sourcePk: null,
		elapsedSeconds: null,
		coordinateSystem: 'WGS84',
		originalCoordinateSystem: 'WGS84',
		consumer: null,
		elevationSource: 1,
		hasShareableEvent: false,
		hasPaceBand: false,
		hasPowerGuide: false,
		favorite: spec.favorite === true,
		hasTurnDetectionDisabled: false,
		curatedCourseId: null,
		startNote: null,
		finishNote: null,
		cutoffDuration: null,
		activityTypeId: typeKey,
		public: spec.privacy === 'public',
		createdDateFormatted: `${spaced(created)}.0 GMT`,
		updatedDateFormatted: `${spaced(created + 3600)}.0 GMT`
	};
	const coursePoints = (spec.coursePoints ?? []).map((cp, index) => {
		const p = points[Math.min(cp.at, points.length - 1)]!;
		return {
			coursePointId: spec.id * 10 + index,
			name: cp.name,
			coursePk: spec.id,
			coursePointType: cp.type,
			lon: p.lon,
			lat: p.lat,
			distance: 0,
			elevation: p.ele,
			derivedElevation: p.ele,
			timestamp: millis,
			createdDate: `${isoUtc(created).slice(0, 19)}.0`,
			modifiedDate: `${isoUtc(created).slice(0, 19)}.0`,
			uuid: null,
			note: null,
			cutoffDuration: null,
			restDuration: null
		};
	});
	const detail: Json = {
		courseId: spec.id,
		courseName: spec.name,
		description: spec.description ?? null,
		openStreetMap: false,
		matchedToSegments: false,
		userProfilePk: ownerId,
		userGroupPk: null,
		rulePK: spec.privacy === 'public' ? 1 : 2,
		firstName: own ? 'Test' : 'Sentinel',
		lastName: own ? 'Walker' : 'Otheruser',
		displayName: own ? PROFILE_UUID : OTHER_NAME,
		geoRoutePk: null,
		sourceTypeId: 3,
		sourcePk: null,
		distanceMeter: stats.distance,
		elevationGainMeter: stats.ascent,
		elevationLossMeter: stats.ascent,
		activityTypePk: typeKey.typeId,
		geoPoints: points.map((p) => ({
			latitude: p.lat,
			longitude: p.lon,
			elevation: p.ele,
			distance: 0,
			timestamp: millis
		})),
		coursePoints,
		courseLines: [{ courseId: spec.id, sortOrder: 1, numberOfPoints: points.length }]
	};
	const waypoints: GpxWaypoint[] = coursePoints.map((cp) => ({
		lat: cp.lat,
		lon: cp.lon,
		ele: cp.elevation ?? undefined,
		name: cp.name,
		type: cp.coursePointType
	}));
	const gpx = buildGpx({
		creator: 'Garmin Connect',
		ns: GPX_NS,
		kind: 'trk',
		name: spec.name,
		time: created,
		extensions: [],
		segments,
		waypoints,
		digits: 6
	});
	return {
		id,
		own,
		favorite: spec.favorite === true,
		summary,
		detail,
		gpx,
		start: [start[1], start[0]]
	};
}

const ME: Json = {
	id: 88001,
	profileId: ME_ID,
	garminGUID: uuid('garmin:guid'),
	displayName: PROFILE_UUID,
	fullName: 'Test Walker',
	// Garmin's user name is the sign-in e-mail address.
	userName: SENTINELS.email,
	profileImageType: 'UPLOADED_PHOTO',
	profileImageUrlLarge: 'https://avatars.invalid/large.png',
	profileImageUrlMedium: 'https://avatars.invalid/medium.png',
	profileImageUrlSmall: 'https://avatars.invalid/small.png',
	hasPremiumSocialIcon: false,
	location: 'Somewhere',
	facebookUrl: '',
	twitterUrl: '',
	personalWebsite: '',
	bio: null
};

function finish(env: Env, parts: Pick<GarminData, 'activities' | 'courses'>): GarminData {
	const own = parts.courses.filter((c) => c.own);
	const favorites = parts.courses.filter((c) => c.favorite);
	return {
		me: ME,
		...parts,
		expected(): ExpectedArchive {
			const ids = {
				tracks: parts.activities.filter((a) => a.hasGps).map((a) => a.id),
				routes: own.map((c) => c.id),
				waypoints: [] as string[],
				areas: [] as string[],
				photos: [] as string[]
			};
			return {
				account: { id: String(ME_ID), displayName: 'Test W.' },
				counts: {
					tracks: ids.tracks.length,
					routes: ids.routes.length,
					waypoints: 0,
					areas: 0,
					// One synthesized "Favorite courses" collection, when anything is favourited.
					collections: favorites.length > 0 ? 1 : 0,
					photos: 0
				},
				ids,
				references: favorites
					.filter((c) => !c.own)
					.map((c) => ({
						name: String(c.summary.courseName),
						url: `${env.origin}/app/course/${c.id}`,
						sourceId: c.id,
						coordinate: c.start
					}))
			};
		},
		objects(): GarminObjects {
			return {
				me: ME,
				activities: parts.activities.map(({ summary, details }) => ({ summary, details })),
				courses: own.map(({ summary, detail }) => ({ summary, detail })),
				favorites: favorites.map((c) => c.summary)
			};
		}
	};
}

function buildSmall(env: Env): GarminData {
	// Newest first, as the listing has them.
	const activities = [
		buildActivity({
			id: 20400000005,
			name: NAMES.emoji,
			description: 'Up the ridge & back <again>.',
			day: 21,
			type: 'hiking',
			privacy: 'public',
			start: [36.57855, -118.29217],
			points: 130
		}),
		buildActivity({
			id: 20400000004,
			name: 'Treadmill',
			day: 19,
			type: 'treadmill_running',
			privacy: 'private'
		}),
		buildActivity({
			id: 20400000003,
			name: NAMES.accents,
			day: 14,
			type: 'trail_running',
			privacy: 'subscribers',
			start: [36.60122, -118.25401],
			points: 90
		}),
		buildActivity({
			id: 20400000002,
			name: NAMES.duplicate,
			day: 8,
			type: 'walking',
			privacy: 'private',
			start: [36.58711, -118.27006],
			points: 45
		}),
		buildActivity({
			id: 20400000001,
			name: NAMES.duplicate,
			day: 2,
			type: 'cycling',
			privacy: 'public',
			start: [36.55012, -118.31448],
			points: 110
		})
	];
	const courses = [
		buildCourse({
			id: 519000001,
			name: NAMES.slashes,
			description: 'Out along the ridge, back by the lake.',
			favorite: true,
			day: 1,
			type: 'running',
			privacy: 'public',
			start: [36.56601, -118.30112],
			points: 100,
			coursePoints: [
				{ name: 'Water', type: 'WATER', at: 30 },
				{ name: 'Summit', type: 'SUMMIT', at: 70 }
			]
		}),
		buildCourse({
			id: 519000002,
			name: 'Gravel loop',
			day: 4,
			type: 'gravel_cycling',
			privacy: 'private',
			start: [36.54177, -118.33902],
			points: 150
		}),
		buildCourse({
			id: 519000003,
			name: NAMES.long,
			day: 9,
			type: 'hiking',
			privacy: 'private',
			start: [36.59033, -118.28544],
			points: 70
		}),
		buildCourse({
			id: 477000009,
			name: 'Valley classic by someone else',
			own: false,
			favorite: true,
			day: 5,
			type: 'hiking',
			privacy: 'public',
			start: [0, 0],
			points: 0
		})
	];
	return finish(env, { activities, courses });
}

export function buildGarmin(env: Env, ds: ResolvedDataset): GarminData {
	// The large dataset is Gaia-only; this platform is an empty (but valid) account.
	if (ds.kind === 'large') return finish(env, { activities: [], courses: [] });
	return buildSmall(env);
}

// ---------------------------------------------------------------------------------------------

/**
 * Paths the fake treats as API traffic. The app page the token is read from counts too: the
 * extension fetches it through its paced lane like any API call.
 */
export function isGarminApiPath(path: string): boolean {
	return path.startsWith(`${API}/`) || path === '/app/';
}

/** App pages: the CSRF token for a session, the sign-in page for anyone else. */
export function handleGarminPage(path: string, authed: boolean, token: string): Reply | null {
	if (!/^\/(app|modern)(\/|$)/.test(path)) return null;
	if (!authed) return { kind: 'redirect', location: '/signin/' };
	return {
		kind: 'bytes',
		status: 200,
		contentType: 'text/html;charset=UTF-8',
		body: Buffer.from(
			'<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"/>' +
				'<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
				`<meta name="csrf-token" content="${token}"/>` +
				'<title>Garmin Connect</title></head><body><div id="root"></div></body></html>\n'
		)
	};
}

export interface GarminRequestContext {
	authed: boolean;
	/** The token the current session accepts. */
	csrfToken: string;
}

const EMPTY = Buffer.alloc(0);
const bare = (status: number): Reply => ({
	kind: 'bytes',
	status,
	contentType: 'text/plain;charset=UTF-8',
	body: EMPTY
});
const notFound: Reply = { kind: 'json', status: 404, body: { message: 'Not Found' } };

/** Every `/gc-api/` request. */
export function handleGarminApi(
	data: GarminData,
	ds: ResolvedDataset,
	req: ApiRequest,
	ctx: GarminRequestContext
): Reply {
	if (!ctx.authed) return bare(401);
	if (req.headers[CSRF_HEADER] !== ctx.csrfToken) return bare(403);
	if (req.method !== 'GET' && req.method !== 'HEAD') return bare(405);
	const path = req.path.slice(API.length);

	if (path === '/userprofile-service/socialProfile') {
		return { kind: 'json', status: 200, body: data.me };
	}
	if (path === '/activitylist-service/activities/count') {
		const total = data.activities.length;
		return {
			kind: 'json',
			status: 200,
			body: {
				totalCount: total,
				multisportParentCount: 0,
				multisportChildCount: 0,
				nonMultisportCount: total
			}
		};
	}
	if (path === '/activitylist-service/activities/search/activities') {
		const start = parseIntParam(req.query.get('start'), 0);
		const limit = parseIntParam(req.query.get('limit'), 20);
		if (!Number.isFinite(start) || start < 0 || !Number.isFinite(limit) || limit < 1) {
			return { kind: 'json', status: 400, body: { message: 'Bad Request' } };
		}
		const size = Math.min(limit, ds.maxPageSize);
		const page = data.activities.slice(start, start + size).map((a) => a.summary);
		return { kind: 'json', status: 200, body: page, listing: true };
	}
	const gpx = /^\/download-service\/export\/gpx\/activity\/(\d+)$/.exec(path);
	if (gpx) {
		const activity = data.activities.find((a) => a.id === gpx[1]);
		return activity
			? { kind: 'bytes', status: 200, contentType: GPX_TYPE, body: activity.gpx }
			: notFound;
	}
	const details = /^\/activity-service\/activity\/(\d+)\/details$/.exec(path);
	if (details) {
		const activity = data.activities.find((a) => a.id === details[1]);
		return activity ? { kind: 'json', status: 200, body: activity.details } : notFound;
	}
	if (path === '/web-gateway/course/owner/') {
		return {
			kind: 'json',
			status: 200,
			listingKey: 'coursesForUser',
			body: { coursesForUser: data.courses.filter((c) => c.own).map((c) => c.summary) }
		};
	}
	if (path === '/course-service/course/favorites') {
		return {
			kind: 'json',
			status: 200,
			listing: true,
			body: data.courses.filter((c) => c.favorite).map((c) => c.summary)
		};
	}
	const courseGpx = /^\/course-service\/course\/gpx\/(\d+)$/.exec(path);
	if (courseGpx) {
		const course = data.courses.find((c) => c.id === courseGpx[1]);
		return course
			? { kind: 'bytes', status: 200, contentType: GPX_TYPE, body: course.gpx }
			: notFound;
	}
	const course = /^\/course-service\/course\/(\d+)$/.exec(path);
	if (course) {
		const found = data.courses.find((c) => c.id === course[1]);
		return found ? { kind: 'json', status: 200, body: found.detail } : notFound;
	}
	return notFound;
}
