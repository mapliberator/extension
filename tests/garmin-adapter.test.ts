import { describe, expect, it } from 'vitest';
import { FAVORITE_COURSES_KEY, createGarminAdapter } from '../src/adapters/garmin/index.ts';
import {
	displayName,
	mapActivity,
	mapActivityDetails,
	mapCourse,
	mapCourseDetail,
	mapFavoriteCourse,
	type GarminUrls
} from '../src/adapters/garmin/mapper.ts';
import {
	GarminActivitiesPageSchema,
	GarminActivityDetailsSchema,
	GarminCourseDetailSchema,
	GarminCoursesSchema,
	GarminFavoritesSchema
} from '../src/adapters/garmin/schemas.ts';
import { AdapterOutdatedError, ItemError } from '../src/shared/errors.ts';
import type { CsrfSource } from '../src/shared/models.ts';
import { TimestampSchema } from '../src/shared/schemas.ts';
import { collect, fixtureTransport, loadFixture } from './helpers/fixture-transport.ts';

const ORIGIN = 'https://connect.garmin.com';
const API = `${ORIGIN}/gc-api`;
const urls: GarminUrls = {
	activity: (id) => `${ORIGIN}/app/activity/${id}`,
	course: (id) => `${ORIGIN}/app/course/${id}`
};
const CSRF: CsrfSource = {
	mint: { method: 'GET', url: `${ORIGIN}/app/`, meta: 'csrf-token' },
	header: 'connect-csrf-token',
	lifetime: 'session'
};

const activities = () =>
	GarminActivitiesPageSchema.parse(loadFixture('garmin', 'activities-listing'));
const courses = () =>
	GarminCoursesSchema.parse(loadFixture('garmin', 'courses-listing')).coursesForUser;
const favorites = () => GarminFavoritesSchema.parse(loadFixture('garmin', 'favorites-listing'));

describe('Garmin mappers (fixtures)', () => {
	it('maps an activity: start from the epoch, wall-clock duration, visibility, provenance', () => {
		const [activity] = activities();
		const record = mapActivity(activity!, urls);
		expect(record).toMatchObject({
			kind: 'track',
			name: '🏔️🥾',
			description: 'Up the ridge & back <again>.',
			visibility: 'public',
			tags: [],
			activityType: 'hiking',
			updatedAt: null,
			source: { id: '20400000005', url: `${ORIGIN}/app/activity/20400000005` }
		});
		// `startTimeGMT` has no zone; the record's timestamp comes from the epoch and is UTC.
		expect(activity!.startTimeGMT).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
		expect(TimestampSchema.safeParse(record.createdAt).success).toBe(true);
		expect(record.createdAt).toBe(`${String(activity!.startTimeGMT).replace(' ', 'T')}Z`);
		expect(record.stats).toEqual({
			distanceMeters: activity!.distance,
			ascentMeters: activity!.elevationGain,
			durationSeconds: activity!.elapsedDuration
		});
		// Timer time is shorter: it leaves the pauses out.
		expect(activity!.duration).toBeLessThan(activity!.elapsedDuration!);
		expect(record.source.raw).toBe(activity);
	});

	it('only "public" is public; followers ("subscribers") and private are private', () => {
		const [activity] = activities();
		const as = (typeKey: string | null) =>
			mapActivity({ ...activity!, privacy: { typeKey } }, urls).visibility;
		expect(as('public')).toBe('public');
		expect(as('subscribers')).toBe('private');
		expect(as('private')).toBe('private');
		expect(as(null)).toBeNull();
		expect(
			mapActivity({ ...activity!, activityName: ' ', description: undefined }, urls)
		).toMatchObject({ name: 'Untitled', description: null });
		expect(
			mapActivity({ ...activity!, elapsedDuration: null, duration: 60 }, urls).stats.durationSeconds
		).toBe(60);
	});

	it('rebuilds an activity from its details: columns by metricsIndex, rows without a fix skipped', () => {
		const details = GarminActivityDetailsSchema.parse(loadFixture('garmin', 'activity-details'));
		// The list order is not the column order.
		expect(details.metricDescriptors.map((d) => d.metricsIndex)).not.toEqual(
			details.metricDescriptors.map((_, i) => i)
		);
		const segments = mapActivityDetails(details);
		expect(segments).toHaveLength(1);
		const points = segments[0]!;
		const withFix = details.activityDetailMetrics.filter((row) => row.metrics[0] !== null);
		expect(points).toHaveLength(withFix.length);
		expect(points.length).toBeLessThan(details.activityDetailMetrics.length);
		const [lat, lon, time, ele] = withFix[0]!.metrics;
		expect(points[0]).toEqual({
			lat,
			lon,
			ele,
			time: new Date(time!).toISOString().replace('.000Z', 'Z')
		});
		const [activity] = activities();
		expect(Date.parse(points[0]!.time!)).toBe(activity!.beginTimestamp);
	});

	it('details without a position column have no geometry; missing columns are null', () => {
		expect(
			mapActivityDetails({
				metricDescriptors: [{ metricsIndex: 0, key: 'directHeartRate' }],
				activityDetailMetrics: [{ metrics: [100] }]
			})
		).toEqual([]);
		expect(
			mapActivityDetails({
				metricDescriptors: [
					{ metricsIndex: 1, key: 'directLatitude' },
					{ metricsIndex: 0, key: 'directLongitude' }
				],
				activityDetailMetrics: [{ metrics: [-118.5, 36.5] }]
			})
		).toEqual([[{ lat: 36.5, lon: -118.5, ele: null, time: null }]]);
	});

	it('maps a course: description, created and updated, privacy, no duration', () => {
		const [course, privateCourse] = courses();
		const record = mapCourse(course!, urls);
		expect(record).toMatchObject({
			kind: 'route',
			name: 'Morning loop / ridge ../summit',
			description: 'Out along the ridge, back by the lake.',
			visibility: 'public',
			activityType: 'running',
			stats: {
				distanceMeters: course!.distanceInMeters,
				ascentMeters: course!.elevationGainInMeters,
				durationSeconds: null
			},
			source: { id: '519000001', url: `${ORIGIN}/app/course/519000001` }
		});
		expect(record.createdAt).toBe(
			new Date(course!.createdDate!).toISOString().replace('.000Z', 'Z')
		);
		expect(Date.parse(record.updatedAt!)).toBe(course!.updatedDate);
		expect(mapCourse(privateCourse!, urls)).toMatchObject({
			visibility: 'private',
			description: null
		});
	});

	it('rebuilds a course from its points, without times', () => {
		const detail = GarminCourseDetailSchema.parse(loadFixture('garmin', 'course-detail'));
		const [points] = mapCourseDetail(detail);
		expect(points).toHaveLength(detail.geoPoints.length);
		expect(points![0]).toEqual({
			lat: detail.geoPoints[0]!.latitude,
			lon: detail.geoPoints[0]!.longitude,
			ele: detail.geoPoints[0]!.elevation,
			time: null
		});
		expect(mapCourseDetail({ geoPoints: [] })).toEqual([]);
	});

	it('somebody else’s favourite course becomes a name, a link and its start', () => {
		const theirs = favorites().find((course) => course.userProfileId !== 5001)!;
		expect(mapFavoriteCourse(theirs, urls)).toEqual({
			name: 'Valley classic by someone else',
			source: { id: '477000009', url: `${ORIGIN}/app/course/477000009` },
			coordinate: [theirs.startLongitude, theirs.startLatitude]
		});
		expect(mapFavoriteCourse({ ...theirs, startLatitude: null }, urls).coordinate).toBeNull();
	});

	it('shortens the account name', () => {
		expect(displayName('Test Walker')).toBe('Test W.');
		expect(displayName('Ana María de la Cruz')).toBe('Ana C.');
		expect(displayName('Cher')).toBe('Cher');
		expect(displayName('  ')).toBe('Garmin Connect user');
		expect(displayName(null)).toBe('Garmin Connect user');
	});
});

describe('Garmin adapter (fixture-backed transport)', () => {
	const listing = loadFixture('garmin', 'activities-listing');
	/** Pages of two, as a listing that hands out fewer than it was asked for. */
	const paged = (url: string) => {
		const start = Number(new URL(url).searchParams.get('start'));
		return listing.slice(start, start + 2);
	};
	const fixtureRoutes: [RegExp, unknown][] = [
		[/\/userprofile-service\/socialProfile$/, loadFixture('garmin', 'social-profile')],
		[/\/activities\/count$/, loadFixture('garmin', 'activity-count')],
		[/\/activity\/\d+\/details\?/, loadFixture('garmin', 'activity-details')],
		[/\/web-gateway\/course\/owner\/$/, loadFixture('garmin', 'courses-listing')],
		[/\/course-service\/course\/favorites$/, loadFixture('garmin', 'favorites-listing')],
		[/\/course-service\/course\/\d+$/, loadFixture('garmin', 'course-detail')]
	];
	const adapter = (
		requested: string[] = [],
		csrf: (CsrfSource | undefined)[] = [],
		routes = fixtureRoutes
	) => {
		const transport = fixtureTransport(routes, requested, [], [], csrf);
		const getJson = transport.getJson;
		transport.getJson = (url, options) =>
			url.includes('/search/activities?')
				? (requested.push(url), Promise.resolve(paged(url)))
				: getJson(url, options);
		return createGarminAdapter(transport, 'production');
	};

	it('identifies the account; every API call asks for the session’s CSRF token', async () => {
		const requested: string[] = [];
		const csrf: (CsrfSource | undefined)[] = [];
		const garmin = adapter(requested, csrf);
		expect(await garmin.identifyUser()).toEqual({ id: '5001', displayName: 'Test W.' });
		await collect(garmin.enumerateRoutes());
		await collect(garmin.enumerateCollections());
		expect(csrf.length).toBeGreaterThan(2);
		for (const sent of csrf) expect(sent).toEqual(CSRF);
		for (const url of requested) expect(url.startsWith(`${API}/`)).toBe(true);
	});

	it('exports activities with GPS as tracks, native GPX first, details as the fallback', async () => {
		const requested: string[] = [];
		const tracks = await collect(adapter(requested).enumerateTracks());
		// The treadmill session (…004) has nothing to put on a map.
		expect(tracks.map((track) => track.source.id)).toEqual([
			'20400000005',
			'20400000003',
			'20400000002',
			'20400000001'
		]);
		// Pages of two until an empty one: start=0, 2, 4, then 5 comes back empty.
		expect(requested.filter((url) => url.includes('/search/activities?'))).toEqual(
			[0, 2, 4, 5].map(
				(start) =>
					`${API}/activitylist-service/activities/search/activities?start=${start}&limit=100`
			)
		);
		expect(tracks[0]!.nativeGpx).toEqual({
			method: 'GET',
			url: `${API}/download-service/export/gpx/activity/20400000005`,
			accept: 'text-stream',
			csrf: CSRF
		});
		const segments = await tracks[0]!.loadSegments();
		expect(segments[0]!.length).toBeGreaterThan(10);
		expect(requested.at(-1)).toBe(
			`${API}/activity-service/activity/20400000005/details?maxChartSize=100000&maxPolylineSize=100000`
		);
	});

	it('drops repeats when an upload shifts the pages, and other people’s activities', async () => {
		const requested: string[] = [];
		const transport = fixtureTransport(fixtureRoutes, requested);
		const pages = [
			listing.slice(0, 2),
			// A new upload pushed …003 back onto this page.
			listing.slice(1, 3),
			[{ ...listing[3], ownerId: 5999 }, listing[4]],
			[]
		];
		const getJson = transport.getJson;
		transport.getJson = (url, options) =>
			url.includes('/search/activities?')
				? Promise.resolve(structuredClone(pages.shift()))
				: getJson(url, options);
		const tracks = await collect(createGarminAdapter(transport, 'production').enumerateTracks());
		expect(tracks.map((track) => track.source.id)).toEqual([
			'20400000005',
			'20400000003',
			'20400000001'
		]);
	});

	it('exports own courses as routes, with GPX and the course detail as the fallback', async () => {
		const requested: string[] = [];
		const routes = await collect(adapter(requested).enumerateRoutes());
		expect(routes.map((route) => route.source.id)).toEqual(['519000001', '519000002', '519000003']);
		expect(routes[0]!.nativeGpx).toEqual({
			method: 'GET',
			url: `${API}/course-service/course/gpx/519000001`,
			accept: 'text-stream',
			csrf: CSRF
		});
		const [points] = await routes[0]!.loadSegments();
		expect(points!.every((point) => point.time === null)).toBe(true);
		expect(requested.at(-1)).toBe(`${API}/course-service/course/519000001`);
	});

	it('favourites: own courses as members, other people’s as references', async () => {
		const [collection, ...rest] = await collect(adapter().enumerateCollections());
		expect(rest).toEqual([]);
		expect(collection).toMatchObject({
			kind: 'collection',
			key: FAVORITE_COURSES_KEY,
			name: 'Favorite courses',
			source: null,
			parentSourceId: null
		});
		expect(collection!.members).toEqual([
			{ kind: 'object', type: 'route', sourceId: '519000001' },
			{
				kind: 'reference',
				reference: {
					name: 'Valley classic by someone else',
					source: { id: '477000009', url: `${ORIGIN}/app/course/477000009` },
					coordinate: [-119.55801, 37.73264]
				}
			}
		]);
		const none = adapter(
			[],
			[],
			fixtureRoutes.map(([pattern, value]) =>
				pattern.source.includes('favorites') ? [pattern, []] : [pattern, value]
			)
		);
		expect(await collect(none.enumerateCollections())).toEqual([]);
	});

	it('counts activities from the count endpoint; no waypoints, areas or photos', async () => {
		const garmin = adapter();
		expect(await garmin.count('track')).toBe(5);
		expect(await garmin.count('route')).toBeNull();
		for (const type of ['waypoint', 'area', 'photo'] as const) {
			expect(await garmin.count(type)).toBe(0);
		}
		expect(await collect(garmin.enumerateWaypoints())).toEqual([]);
		expect(await collect(garmin.enumerateAreas())).toEqual([]);
		expect(await collect(garmin.enumeratePhotos())).toEqual([]);
	});

	it('a listing that changed shape is fatal, naming the adapter; a bad detail is one item', async () => {
		const drifted = adapter(
			[],
			[],
			fixtureRoutes.map(([pattern, value]) =>
				pattern.source.includes('owner') ? [pattern, { results: [] }] : [pattern, value]
			)
		);
		await expect(collect(drifted.enumerateRoutes())).rejects.toThrow(AdapterOutdatedError);
		await expect(collect(drifted.enumerateRoutes())).rejects.toThrow(/Garmin Connect/);

		const brokenDetail = adapter(
			[],
			[],
			fixtureRoutes.map(([pattern, value]) =>
				pattern.source.includes('details') ? [pattern, { nope: true }] : [pattern, value]
			)
		);
		const [track] = await collect(brokenDetail.enumerateTracks());
		await expect(track!.loadSegments()).rejects.toThrow(ItemError);
	});

	it('knows its sign-in page, keeps people out of the raw data, and says what it skips', () => {
		const garmin = adapter();
		expect(garmin.isLoginUrl(`${ORIGIN}/signin/`)).toBe(true);
		expect(garmin.isLoginUrl('https://sso.garmin.com/portal/sso/en-US/sign-in')).toBe(true);
		expect(garmin.isLoginUrl(`${ORIGIN}/app/activities`)).toBe(false);
		expect(garmin.bridgeUrl).toBe(`${ORIGIN}/robots.txt`);
		expect(garmin.isSignedOut).toBeUndefined();
		for (const key of ['ownerFullName', 'ownerDisplayName', 'userRoles', 'displayName']) {
			expect(garmin.rawScrubKeys).toContain(key);
		}
		expect(garmin.notes.join(' ')).toMatch(/photos are not exported/);
	});
});
