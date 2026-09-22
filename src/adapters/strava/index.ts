/**
 * Strava adapter, written against docs/phase0-findings.md. Same interface as every other adapter
 * (PRD §6.5).
 *
 * Activities are tracks and routes are routes, both with the platform's own GPX export.
 * Activities fall back to their JSON streams; routes have no JSON geometry to fall back to.
 * The routes list is the one thing Strava serves only to a POST, and only with a CSRF token
 * minted by another POST: both paths are allowlisted in hosts.ts, and the transport mints the
 * token per attempt. Strava has no waypoints, areas or folders.
 */
import type { z } from 'zod';
import { ItemError } from '../../shared/errors';
import type {
	AdapterFactory,
	CollectionRecord,
	CsrfSource,
	LineRecord,
	PhotoRecord,
	ReferenceRecord,
	UserInfo
} from '../../shared/models';
import { sourceHosts } from '../hosts';
import { parseItem, parseListing } from '../support';
import {
	activityId,
	displayName,
	mapActivity,
	mapPhoto,
	mapRoute,
	mapStarredRoute,
	mapStreams,
	type StravaUrls
} from './mapper';
import {
	StravaActivitiesPageSchema,
	StravaCurrentAthleteSchema,
	StravaPhotosPageSchema,
	StravaRoutesPageSchema,
	StravaStreamsSchema,
	type StravaActivity,
	type StravaAthlete,
	type StravaRoute
} from './schemas';

/** The activity and photo listings return at most this many, whatever is asked for. */
const PAGE_SIZE = 20;
const ROUTE_PAGE_SIZE = 50;
/** Without it the listings answer with the HTML page instead of JSON. */
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const STREAMS = ['latlng', 'altitude', 'time'].map((type) => `stream_types[]=${type}`).join('&');

export const STARRED_ROUTES_KEY = 'mapliberator:strava-starred-routes';

export const createStravaAdapter: AdapterFactory = (transport, mode) => {
	const hosts = sourceHosts(mode).strava;
	const origin = hosts.origins[0]!;
	const identity = { label: 'Strava', version: '1.0.0' };
	const urls: StravaUrls = {
		activity: (id) => `${origin}/activities/${id}`,
		route: (id) => `${origin}/routes/${id}`
	};
	const csrf: CsrfSource = {
		url: `${origin}/api/next/mint-csrf-token`,
		field: 'token',
		header: 'x-csrf-token'
	};

	let me: StravaAthlete | null = null;
	/** Other athletes' routes the user starred, found while listing routes. */
	const starred = new Map<string, ReferenceRecord>();
	let routesListed = false;

	const get = (url: string) => transport.getJson(url, XHR);

	async function requireMe(): Promise<StravaAthlete> {
		me ??= parseListing(
			identity,
			StravaCurrentAthleteSchema,
			await get(`${origin}/frontend/athletes/current`),
			'account'
		).currentAthlete;
		return me;
	}

	async function identifyUser(): Promise<UserInfo> {
		const athlete = await requireMe();
		return { id: String(athlete.id), displayName: displayName(athlete) };
	}

	type ActivitiesPage = z.output<typeof StravaActivitiesPageSchema>;
	function activityPage(page: number): Promise<ActivitiesPage> {
		return get(`${origin}/athlete/training_activities?page=${page}&per_page=${PAGE_SIZE}`).then(
			(json) => parseListing(identity, StravaActivitiesPageSchema, json, 'activity listing')
		);
	}

	/** Newest first. An upload during the run shifts later pages, so repeats are dropped. */
	async function* activities(): AsyncGenerator<StravaActivity> {
		const seen = new Set<string>();
		for (let page = 1; ; page++) {
			const { models, perPage, total } = await activityPage(page);
			for (const activity of models) {
				const id = activityId(activity);
				if (seen.has(id)) continue;
				seen.add(id);
				yield activity;
			}
			if (models.length === 0 || page * perPage >= total) return;
		}
	}

	/** Own routes, in listing order; other athletes' starred routes are set aside as references. */
	async function* routes(): AsyncGenerator<StravaRoute> {
		const user = await requireMe();
		let after = '0';
		for (;;) {
			const { me: page } = parseListing(
				identity,
				StravaRoutesPageSchema,
				await transport.postJson(`${origin}/api/next/data/routes/my-routes`, routeQuery(after), {
					headers: XHR,
					csrf
				}),
				'route listing'
			);
			for (const route of page.searchRoutes.nodes) {
				if (route.athlete.id === String(user.id)) yield route;
				else starred.set(route.id, mapStarredRoute(route, urls));
			}
			const { hasNextPage, endCursor } = page.searchRoutes.pageInfo;
			if (!hasNextPage || !endCursor || endCursor === after) break;
			after = endCursor;
		}
		routesListed = true;
	}

	return {
		id: 'strava',
		label: identity.label,
		version: identity.version,
		origins: hosts.origins,
		assetOrigins: hosts.assetOrigins,
		limits: { apiConcurrency: 1, assetConcurrency: 3, minIntervalMs: 500 },
		bridgeUrl: `${origin}/robots.txt`,
		loginUrl: `${origin}/login`,
		isLoginUrl: (url) => new URL(url).pathname.startsWith('/login'),
		// Signed out: 401 on the JSON listings (handled for every platform), a bare 403 from the
		// routes query, and no athlete on the account endpoint.
		isSignedOut: (response) =>
			(response.status === 403 && response.bodyKind === 'empty') ||
			(response.status === 200 &&
				typeof response.json === 'object' &&
				response.json !== null &&
				'currentAthlete' in response.json &&
				(response.json as { currentAthlete: unknown }).currentAthlete === null),
		// A route's owner, and the people a photo listing names.
		rawScrubKeys: ['athlete', 'athlete_id', 'athlete_id_str', 'owner_id', 'viewing_athlete_id'],
		notes: [
			'Indoor activities without GPS are skipped: they have nothing to put on a map.',
			'Routes you starred from other athletes are exported as links, not route geometry.'
		],

		identifyUser,

		async count(type) {
			switch (type) {
				case 'track':
					// Includes the indoor activities that are skipped for lack of GPS.
					return (await activityPage(1)).total;
				case 'waypoint':
				case 'area':
					return 0;
				default:
					// Routes and photos come without a total; counting them means listing them.
					return null;
			}
		},

		async *enumerateTracks(): AsyncGenerator<LineRecord> {
			for await (const activity of activities()) {
				if (!activity.has_latlng) continue;
				const id = activityId(activity);
				yield {
					...mapActivity(activity, urls),
					nativeGpx: {
						method: 'GET',
						url: `${origin}/activities/${id}/export_gpx`,
						accept: 'text-stream'
					},
					loadSegments: async () =>
						mapStreams(
							parseItem(
								StravaStreamsSchema,
								await get(`${origin}/activities/${id}/streams?${STREAMS}`)
							),
							activity
						)
				};
			}
		},

		async *enumerateRoutes(): AsyncGenerator<LineRecord> {
			for await (const route of routes()) {
				yield {
					...mapRoute(route, urls),
					nativeGpx: {
						method: 'GET',
						url: `${origin}/routes/${route.id}/export_gpx`,
						accept: 'text-stream'
					},
					loadSegments: () =>
						Promise.reject(
							new ItemError('no-fallback', 'Strava serves route geometry only as its GPX export')
						)
				};
			}
		},

		// eslint-disable-next-line require-yield
		async *enumerateWaypoints() {
			// Strava has no waypoint objects.
		},

		// eslint-disable-next-line require-yield
		async *enumerateAreas() {
			// Strava has no area objects.
		},

		async *enumerateCollections(): AsyncGenerator<CollectionRecord> {
			// Starred routes turn up in the routes list; walk it here if routes were not exported.
			if (!routesListed) for await (const route of routes()) void route;
			if (starred.size === 0) return;
			yield {
				kind: 'collection',
				key: STARRED_ROUTES_KEY,
				name: 'Starred routes',
				description: null,
				createdAt: null,
				updatedAt: null,
				parentSourceId: null,
				source: null,
				members: [...starred.values()].map((reference) => ({ kind: 'reference', reference }))
			};
		},

		async *enumeratePhotos(): AsyncGenerator<PhotoRecord> {
			const athlete = await requireMe();
			const seen = new Set<string>();
			let cursor: string | null = null;
			do {
				const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
				const page: z.output<typeof StravaPhotosPageSchema> = parseListing(
					identity,
					StravaPhotosPageSchema,
					await get(`${origin}/athletes/${athlete.id}/photos?per_page=${PAGE_SIZE}${query}`),
					'photo listing'
				);
				for (const photo of page.items) {
					// Videos list here too, as their poster frame; only photos are exported.
					if (photo.owner_id !== athlete.id || (photo.video ?? null) !== null) continue;
					if (seen.has(photo.photo_id)) continue;
					seen.add(photo.photo_id);
					yield mapPhoto(photo);
				}
				cursor = page.has_more ? (page.next_cursor ?? null) : null;
			} while (cursor);
		}
	};
};

/** Every route type, own and starred, with no filter. Omitting `routeTypes` means all of them. */
function routeQuery(after: string) {
	return {
		pageSize: ROUTE_PAGE_SIZE,
		after,
		searchArgs: {
			query: '',
			onlyStarred: false,
			createdBy: 'Any',
			elevGainMin: 0,
			elevGainMax: null,
			distanceMin: 0,
			distanceMax: null
		},
		// Map thumbnail sizes; none are wanted.
		resolutions: []
	};
}
