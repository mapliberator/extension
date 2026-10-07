/**
 * Garmin Connect adapter, written against docs/phase0-findings.md. Same interface as every other
 * adapter (PRD §6.5).
 *
 * Activities are tracks and courses are routes, both with the platform's own GPX export, and
 * both with JSON geometry to fall back on. Courses the user favorited from other people are
 * references. Garmin Connect has no free-standing waypoints, areas or folders.
 *
 * Every request to the web app's API (`/gc-api/…`), GPX exports included, needs the session's
 * CSRF token in a header. The token is the `<meta name="csrf-token">` of any app page; it stays
 * the same for the whole session, so the engine reads it once and keeps it until it is refused.
 */
import type { z } from 'zod';
import type {
	AdapterFactory,
	BridgeRequest,
	CollectionMemberRecord,
	CollectionRecord,
	CsrfSource,
	LineRecord,
	UserInfo
} from '../../shared/models';
import { sourceHosts } from '../hosts';
import { parseItem, parseListing } from '../support';
import {
	displayName,
	mapActivity,
	mapActivityDetails,
	mapCourse,
	mapCourseDetail,
	mapFavoriteCourse,
	type GarminUrls
} from './mapper';
import {
	GarminActivitiesPageSchema,
	GarminActivityCountSchema,
	GarminActivityDetailsSchema,
	GarminCourseDetailSchema,
	GarminCoursesSchema,
	GarminFavoritesSchema,
	GarminSocialProfileSchema,
	type GarminActivity,
	type GarminCourse,
	type GarminProfile
} from './schemas';

/** The listing takes at least 1000; a smaller page keeps one response modest. */
const PAGE_SIZE = 100;
/** Enough for any activity: the details answer one row per recorded point up to these. */
const DETAIL_SIZE = 'maxChartSize=100000&maxPolylineSize=100000';

export const FAVORITE_COURSES_KEY = 'mapliberator:garmin-favorite-courses';

export const createGarminAdapter: AdapterFactory = (transport, mode) => {
	const hosts = sourceHosts(mode).garmin;
	const origin = hosts.origins[0]!;
	const api = `${origin}/gc-api`;
	const identity = { label: 'Garmin Connect', version: '1.0.0' };
	const urls: GarminUrls = {
		activity: (id) => `${origin}/app/activity/${id}`,
		course: (id) => `${origin}/app/course/${id}`
	};
	// The app's own pages carry it. It lasts the session, and every API call wants it.
	const csrf: CsrfSource = {
		mint: { method: 'GET', url: `${origin}/app/`, meta: 'csrf-token' },
		header: 'connect-csrf-token',
		lifetime: 'session'
	};

	let me: GarminProfile | null = null;

	const get = (path: string) => transport.getJson(`${api}${path}`, { csrf });
	const gpx = (path: string): BridgeRequest => ({
		method: 'GET',
		url: `${api}${path}`,
		accept: 'text-stream',
		csrf
	});

	async function requireMe(): Promise<GarminProfile> {
		me ??= parseListing(
			identity,
			GarminSocialProfileSchema,
			await get('/userprofile-service/socialProfile'),
			'account'
		);
		return me;
	}

	async function identifyUser(): Promise<UserInfo> {
		const profile = await requireMe();
		return { id: String(profile.profileId), displayName: displayName(profile.fullName) };
	}

	/**
	 * Newest first, until a page comes back empty: the listing may hand out fewer than asked for.
	 * An upload during the run shifts later pages, so repeats are dropped.
	 */
	async function* activities(): AsyncGenerator<GarminActivity> {
		const { profileId } = await requireMe();
		const seen = new Set<number>();
		for (let start = 0; ;) {
			const page: z.output<typeof GarminActivitiesPageSchema> = parseListing(
				identity,
				GarminActivitiesPageSchema,
				await get(
					`/activitylist-service/activities/search/activities?start=${start}&limit=${PAGE_SIZE}`
				),
				'activity listing'
			);
			if (page.length === 0) return;
			for (const activity of page) {
				if (activity.ownerId !== profileId || seen.has(activity.activityId)) continue;
				seen.add(activity.activityId);
				yield activity;
			}
			start += page.length;
		}
	}

	async function courses(): Promise<GarminCourse[]> {
		const { profileId } = await requireMe();
		const { coursesForUser } = parseListing(
			identity,
			GarminCoursesSchema,
			await get('/web-gateway/course/owner/'),
			'course listing'
		);
		return coursesForUser.filter((course) => course.userProfileId === profileId);
	}

	return {
		id: 'garmin',
		label: identity.label,
		version: identity.version,
		origins: hosts.origins,
		assetOrigins: hosts.assetOrigins,
		// Rate limits are unknown and Cloudflare sits in front: one request at a time, unhurried.
		limits: { apiConcurrency: 1, assetConcurrency: 1, minIntervalMs: 750 },
		bridgeUrl: `${origin}/robots.txt`,
		loginUrl: `${origin}/signin/`,
		// Signed out, app pages redirect to /signin/ (which may hand over to Garmin's SSO host).
		isLoginUrl: (url) => {
			const { hostname, pathname } = new URL(url);
			return pathname.startsWith('/signin') || hostname === 'sso.garmin.com';
		},
		// The API answers a lost session with a 401, which every platform handles. A 403 is a
		// missing or stale CSRF token, not a lost session.
		rawScrubKeys: [
			'ownerId',
			'ownerDisplayName',
			'ownerFullName',
			'ownerProfileImageUrlSmall',
			'ownerProfileImageUrlMedium',
			'ownerProfileImageUrlLarge',
			'userRoles',
			'userProfileId',
			'userProfilePk',
			'displayName',
			'firstName',
			'lastName'
		],
		notes: [
			'Indoor activities without GPS are skipped: they have nothing to put on a map.',
			'Courses you favorited from other people are exported as links, not course geometry.',
			'Course points are kept inside each course’s GPX file.',
			'Activity photos are not exported yet.'
		],

		identifyUser,

		async count(type) {
			switch (type) {
				case 'track':
					// Includes the indoor activities that are skipped for lack of GPS.
					return parseListing(
						identity,
						GarminActivityCountSchema,
						await get('/activitylist-service/activities/count'),
						'activity count'
					).totalCount;
				case 'waypoint':
				case 'area':
				case 'photo':
					return 0;
				default:
					return null;
			}
		},

		async *enumerateTracks(): AsyncGenerator<LineRecord> {
			for await (const activity of activities()) {
				if (!activity.hasPolyline) continue;
				const id = activity.activityId;
				yield {
					...mapActivity(activity, urls),
					nativeGpx: gpx(`/download-service/export/gpx/activity/${id}`),
					loadSegments: async () =>
						mapActivityDetails(
							parseItem(
								GarminActivityDetailsSchema,
								await get(`/activity-service/activity/${id}/details?${DETAIL_SIZE}`)
							)
						)
				};
			}
		},

		async *enumerateRoutes(): AsyncGenerator<LineRecord> {
			for (const course of await courses()) {
				const id = course.courseId;
				yield {
					...mapCourse(course, urls),
					nativeGpx: gpx(`/course-service/course/gpx/${id}`),
					loadSegments: async () =>
						mapCourseDetail(
							parseItem(GarminCourseDetailSchema, await get(`/course-service/course/${id}`))
						)
				};
			}
		},

		// eslint-disable-next-line require-yield
		async *enumerateWaypoints() {
			// No free-standing waypoints; course points live in their course's GPX.
		},

		// eslint-disable-next-line require-yield
		async *enumerateAreas() {
			// Garmin Connect has no area objects.
		},

		async *enumerateCollections(): AsyncGenerator<CollectionRecord> {
			const { profileId } = await requireMe();
			const favorites = parseListing(
				identity,
				GarminFavoritesSchema,
				await get('/course-service/course/favorites'),
				'favorite course listing'
			);
			if (favorites.length === 0) return;
			const members = favorites.map((course): CollectionMemberRecord =>
				course.userProfileId === profileId
					? { kind: 'object', type: 'route', sourceId: String(course.courseId) }
					: { kind: 'reference', reference: mapFavoriteCourse(course, urls) }
			);
			yield {
				kind: 'collection',
				key: FAVORITE_COURSES_KEY,
				name: 'Favorite courses',
				description: null,
				createdAt: null,
				updatedAt: null,
				parentSourceId: null,
				source: null,
				members
			};
		},

		// eslint-disable-next-line require-yield
		async *enumeratePhotos() {
			// Not exported yet: no account probed so far had activity photos to learn the API from.
		}
	};
};
