/**
 * AllTrails adapter. Same interface as every other adapter; any engine change it forces is an
 * interface bug (PRD §6.5, Phase 5). Gentler pacing than Gaia.
 */
import type { z } from 'zod';
import type {
	AdapterFactory,
	CollectionRecord,
	LineRecord,
	PhotoRecord,
	UserInfo,
	WaypointRecord
} from '../../shared/models';
import { sourceHosts } from '../hosts';
import { parseItem, parseListing } from '../support';
import {
	displayName,
	mapActivity,
	mapCompleted,
	mapList,
	mapMap,
	mapMapWaypoint,
	mapPhoto,
	mapSegments,
	type AllTrailsUrls
} from './mapper';
import {
	AllTrailsActivitySchema,
	AllTrailsCompletedSchema,
	AllTrailsListSchema,
	AllTrailsMapSchema,
	AllTrailsMeSchema,
	AllTrailsPhotoSchema,
	AllTrailsSegmentsSchema,
	AllTrailsStatsSchema,
	allTrailsListingSchema
} from './schemas';

const PAGE_LIMIT = 50;
export const COMPLETED_KEY = 'mapliberator:completed';

export const createAllTrailsAdapter: AdapterFactory = (transport, mode) => {
	const hosts = sourceHosts(mode).alltrails;
	const origin = hosts.origins[0]!;
	const api = `${origin}/api/alltrails/v3`;
	const identity = { label: 'AllTrails', version: '1.0.0' };
	const urls: AllTrailsUrls = {
		activity: (id) => `${origin}/explore/recording/${id}`,
		map: (id) => `${origin}/explore/map/${id}`,
		list: (id) => `${origin}/lists/${id}`,
		trail: (trail) => `${origin}/trail/${trail.slug ?? trail.id}`,
		photo: (id) => `${origin}/photos/${id}`
	};

	let me: UserInfo | null = null;

	async function identifyUser(): Promise<UserInfo> {
		const json = await transport.getJson(`${api}/me`);
		const { user } = parseListing(identity, AllTrailsMeSchema, json, 'account');
		me = { id: String(user.id), displayName: displayName(user) };
		return me;
	}

	async function requireUser(): Promise<UserInfo> {
		return me ?? identifyUser();
	}

	async function* pages<S extends z.ZodType>(
		resource: string,
		item: S
	): AsyncGenerator<z.output<S>> {
		const user = await requireUser();
		const schema = allTrailsListingSchema(item);
		let cursor: string | null = null;
		do {
			const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
			const page: z.output<typeof schema> = parseListing(
				identity,
				schema,
				await transport.getJson(`${api}/users/${user.id}/${resource}?limit=${PAGE_LIMIT}${query}`),
				`${resource} listing`
			);
			yield* page.items as z.output<S>[];
			cursor = page.meta.nextCursor;
		} while (cursor);
	}

	const segmentsLoader = (resource: 'activities' | 'maps', id: number) => async () =>
		mapSegments(
			parseItem(AllTrailsSegmentsSchema, await transport.getJson(`${api}/${resource}/${id}`))
		);

	return {
		id: 'alltrails',
		label: identity.label,
		version: identity.version,
		origins: hosts.origins,
		assetOrigins: hosts.assetOrigins,
		limits: { apiConcurrency: 1, assetConcurrency: 2, minIntervalMs: 250 },
		bridgeUrl: `${origin}/robots.txt`,
		loginUrl: `${origin}/login`,
		isLoginUrl: (url) => new URL(url).pathname.startsWith('/login'),
		rawScrubKeys: ['items', 'trail'],
		notes: ['Saved AllTrails trails are exported as links, not trail geometry.'],

		identifyUser,

		async count(type) {
			if (type === 'area') return 0;
			if (type !== 'track' && type !== 'route' && type !== 'photo') return null;
			const user = await requireUser();
			const json = await transport.getJson(`${api}/users/${user.id}/stats`);
			const stats = parseListing(identity, AllTrailsStatsSchema, json, 'stats');
			const value = { track: stats.activities, route: stats.maps, photo: stats.photos }[type];
			return value ?? null;
		},

		async *enumerateTracks(): AsyncGenerator<LineRecord> {
			const user = await requireUser();
			for await (const activity of pages('activities', AllTrailsActivitySchema)) {
				if (String(activity.user.id) !== user.id) continue;
				yield {
					...mapActivity(activity, urls),
					nativeGpx: {
						method: 'GET',
						url: `${api}/activities/${activity.id}/export?format=gpx`,
						accept: 'text-stream'
					},
					loadSegments: segmentsLoader('activities', activity.id)
				};
			}
		},

		async *enumerateRoutes(): AsyncGenerator<LineRecord> {
			const user = await requireUser();
			for await (const map of pages('maps', AllTrailsMapSchema)) {
				if (String(map.user.id) !== user.id) continue;
				yield {
					...mapMap(map, urls),
					nativeGpx: {
						method: 'GET',
						url: `${api}/maps/${map.id}/export?format=gpx`,
						accept: 'text-stream'
					},
					loadSegments: segmentsLoader('maps', map.id)
				};
			}
		},

		// Waypoints only exist embedded in the user's custom maps.
		async *enumerateWaypoints(): AsyncGenerator<WaypointRecord> {
			const user = await requireUser();
			for await (const map of pages('maps', AllTrailsMapSchema)) {
				if (String(map.user.id) !== user.id) continue;
				for (const waypoint of map.waypoints) yield mapMapWaypoint(waypoint, map, urls);
			}
		},

		// eslint-disable-next-line require-yield
		async *enumerateAreas() {
			// AllTrails has no area objects.
		},

		async *enumerateCollections(): AsyncGenerator<CollectionRecord> {
			const user = await requireUser();
			for await (const list of pages('lists', AllTrailsListSchema)) {
				if (String(list.user.id) === user.id) yield mapList(list, urls);
			}
			const completed: CollectionRecord['members'] = [];
			for await (const entry of pages('completed', AllTrailsCompletedSchema)) {
				completed.push({ kind: 'reference', reference: mapCompleted(entry, urls) });
			}
			if (completed.length > 0) {
				yield {
					kind: 'collection',
					key: COMPLETED_KEY,
					name: 'Completed trails',
					description: null,
					createdAt: null,
					updatedAt: null,
					parentSourceId: null,
					source: null,
					members: completed
				};
			}
		},

		async *enumeratePhotos(): AsyncGenerator<PhotoRecord> {
			const user = await requireUser();
			for await (const photo of pages('photos', AllTrailsPhotoSchema)) {
				if (String(photo.user.id) === user.id) yield mapPhoto(photo, urls);
			}
		}
	};
};
