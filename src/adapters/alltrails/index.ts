/**
 * AllTrails adapter, written against docs/phase0-findings.md. Same interface as every other
 * adapter (PRD §6.5). Gentler pacing than Gaia.
 *
 * There is no GPX export to ask for: geometry is decoded from the map detail, which is also the
 * only place waypoints and photo attachments live. Details are therefore fetched once and kept.
 */
import type { z } from 'zod';
import { AdapterOutdatedError } from '../../shared/errors';
import type {
	AdapterFactory,
	CollectionMemberRecord,
	CollectionRecord,
	LineRecord,
	PhotoRecord,
	UserInfo,
	WaypointRecord
} from '../../shared/models';
import { sourceHosts } from '../hosts';
import { parseItem, parseListing } from '../support';
import { AT_KEY_HEADER, allTrailsKey } from './key';
import {
	displayName,
	mapLine,
	mapList,
	mapPhoto,
	mapSegments,
	mapTrailReference,
	mapWaypoint,
	type AllTrailsUrls
} from './mapper';
import {
	AllTrailsListItemsSchema,
	AllTrailsListsPageSchema,
	AllTrailsMapDetailSchema,
	AllTrailsMapsPageSchema,
	AllTrailsMeSchema,
	AllTrailsPhotosPageSchema,
	AllTrailsTrailSchema,
	type AllTrailsMap,
	type AllTrailsMapDetail,
	type AllTrailsTrail
} from './schemas';

const PAGE_LIMIT = 50;
type Kind = 'track' | 'route';
const PRESENTATION: Record<Kind, string> = { track: 'track', route: 'map' };

export const createAllTrailsAdapter: AdapterFactory = (transport, mode) => {
	const hosts = sourceHosts(mode).alltrails;
	const origin = hosts.origins[0]!;
	const api = `${origin}/api/alltrails`;
	const identity = { label: 'AllTrails', version: '1.0.0' };
	const key = allTrailsKey(mode);
	const urls: AllTrailsUrls = {
		recording: (map) => `${origin}/explore/recording/${map.slug ?? map.id}`,
		route: (map) => `${origin}/explore/map/${map.slug ?? map.id}`,
		trail: (trail) => `${origin}/trail/${trail.slug ?? trail.id}`,
		photoFile: (id) => `${api}/v3/photos/${id}/image?key=${encodeURIComponent(key)}&size=original`
	};

	type Me = z.output<typeof AllTrailsMeSchema>['users'][number];
	let me: Me | null = null;
	const details = new Map<number, AllTrailsMapDetail>();
	const trails = new Map<number, AllTrailsTrail>();

	function get(url: string): Promise<unknown> {
		if (!key) {
			throw new AdapterOutdatedError(identity.label, identity.version, 'no API key configured');
		}
		return transport.getJson(url, { [AT_KEY_HEADER]: key });
	}

	async function requireMe(): Promise<Me> {
		me ??= parseListing(identity, AllTrailsMeSchema, await get(`${api}/me`), 'account').users[0]!;
		return me;
	}

	async function identifyUser(): Promise<UserInfo> {
		const user = await requireMe();
		return { id: String(user.id), displayName: displayName(user) };
	}

	/** Walks `after=<nextCursor>` pages. Other cursor parameter names are silently ignored. */
	async function* pages<P extends { pageInfo?: PageInfo | null | undefined }, T>(
		path: string,
		schema: z.ZodType<P>,
		items: (page: P) => T[],
		what: string
	): AsyncGenerator<T> {
		let cursor: string | null = null;
		do {
			const separator = path.includes('?') ? '&' : '?';
			const after: string = cursor ? `&after=${encodeURIComponent(cursor)}` : '';
			const page: P = parseListing(
				identity,
				schema,
				await get(`${api}${path}${separator}limit=${PAGE_LIMIT}${after}`),
				what
			);
			yield* items(page);
			cursor = page.pageInfo?.hasNextPage === false ? null : (page.pageInfo?.nextCursor ?? null);
		} while (cursor);
	}
	interface PageInfo {
		hasNextPage?: boolean | null | undefined;
		nextCursor?: string | null | undefined;
	}

	/** The user's own recordings or custom routes. */
	async function* maps(kind: Kind): AsyncGenerator<AllTrailsMap> {
		const user = await requireMe();
		const path = `/users/${user.id}/maps?presentation_type=${PRESENTATION[kind]}`;
		for await (const map of pages(
			path,
			AllTrailsMapsPageSchema,
			(p) => p.maps,
			`${kind} listing`
		)) {
			if (map.user.id === user.id) yield map;
		}
	}

	async function detail(id: number): Promise<AllTrailsMapDetail> {
		const known = details.get(id);
		if (known) return known;
		const parsed = parseItem(AllTrailsMapDetailSchema, await get(`${api}/maps/${id}?detail=deep`));
		details.set(id, parsed.maps[0]!);
		return parsed.maps[0]!;
	}

	async function* lines(kind: Kind): AsyncGenerator<LineRecord> {
		for await (const map of maps(kind)) {
			yield {
				...mapLine(kind, map, urls),
				nativeGpx: null,
				loadSegments: async () => mapSegments(await detail(map.id))
			};
		}
	}

	async function trail(id: number): Promise<AllTrailsTrail> {
		const known = trails.get(id);
		if (known) return known;
		const parsed = parseItem(AllTrailsTrailSchema, await get(`${api}/trails/${id}`));
		trails.set(id, parsed.trails[0]!);
		return parsed.trails[0]!;
	}

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
		// Embedded people, and what is exported as objects of its own.
		rawScrubKeys: ['user', 'waypoints', 'mapPhotos', 'photoHash'],
		notes: [
			'Saved AllTrails trails are exported as links, not trail geometry.',
			'AllTrails offers no GPX download here, so tracks and routes are rebuilt from its map data.'
		],

		identifyUser,

		async count(type) {
			if (type === 'area') return 0;
			const user = await requireMe();
			// The list counters stay at zero for the built-in lists, so they are not offered.
			const value = { track: user.tracks, route: user.maps, photo: user.photos }[
				type as 'track' | 'route' | 'photo'
			];
			return value ?? null;
		},

		enumerateTracks: () => lines('track'),
		enumerateRoutes: () => lines('route'),

		async *enumerateWaypoints(): AsyncGenerator<WaypointRecord> {
			for (const kind of ['track', 'route'] as const) {
				for await (const map of maps(kind)) {
					for (const waypoint of (await detail(map.id)).waypoints ?? []) {
						yield mapWaypoint(waypoint, kind, map, urls);
					}
				}
			}
		},

		// eslint-disable-next-line require-yield
		async *enumerateAreas() {
			// AllTrails has no area objects.
		},

		async *enumerateCollections(): AsyncGenerator<CollectionRecord> {
			const user = await requireMe();
			const path = `/users/${user.id}/lists`;
			for await (const list of pages(path, AllTrailsListsPageSchema, (p) => p.lists, 'lists')) {
				if ((list.ownerId ?? list.user?.id) !== user.id) continue;
				const { listItems } = parseListing(
					identity,
					AllTrailsListItemsSchema,
					await get(`${api}/lists/${list.id}/items`),
					'list items'
				);
				const members: CollectionMemberRecord[] = [];
				for (const item of listItems) {
					// Only saved trails have been seen in the wild; anything else is left out.
					if (item.type !== 'trail' || typeof item.trailId !== 'number') continue;
					members.push({
						kind: 'reference',
						reference: mapTrailReference(await trail(item.trailId), item, urls)
					});
				}
				// The three built-in lists exist for everyone; empty ones are not the user's data.
				if (members.length > 0) yield mapList(list, members);
			}
		},

		async *enumeratePhotos(): AsyncGenerator<PhotoRecord> {
			const user = await requireMe();
			// Which map a photo belongs to is only written in that map's detail.
			const attachedTo = new Map<number, PhotoRecord['attachedTo']>();
			for (const kind of ['track', 'route'] as const) {
				for await (const map of maps(kind)) {
					if (!map.photoCount) continue;
					for (const entry of (await detail(map.id)).mapPhotos ?? []) {
						attachedTo.set(entry.photo.id, { type: kind, sourceId: String(map.id) });
					}
				}
			}
			const path = `/users/${user.id}/photos`;
			for await (const photo of pages(path, AllTrailsPhotosPageSchema, (p) => p.photos, 'photos')) {
				if (photo.user.id === user.id)
					yield mapPhoto(photo, attachedTo.get(photo.id) ?? null, urls);
			}
		}
	};
};
