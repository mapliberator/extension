/**
 * Gaia GPS adapter. Runs on the export page and talks to the platform only through the bridged
 * transport; it never retries and never emits archive bytes (PRD §6.1).
 */
import { z } from 'zod';
import type {
	AdapterFactory,
	AreaRecord,
	CollectionRecord,
	LineRecord,
	ObjectType,
	PhotoRecord,
	ReferenceRecord,
	UserInfo,
	WaypointRecord
} from '../../shared/models';
import { sourceHosts } from '../hosts';
import { parseItem, parseListing } from '../support';
import {
	mapArea,
	mapFolder,
	mapForeignLine,
	mapLineGeometry,
	mapLineSummary,
	mapPhoto,
	mapSharedFolder,
	mapWaypoint,
	type GaiaUrls
} from './mapper';
import {
	GaiaAreaSchema,
	GaiaFolderSchema,
	GaiaLineDetailSchema,
	GaiaPhotoSchema,
	GaiaTrackSummarySchema,
	GaiaUserSchema,
	GaiaWaypointSchema,
	gaiaListingSchema
} from './schemas';

const PAGE_SIZE = 100;
const LISTING_PATHS = {
	track: 'track',
	route: 'route',
	waypoint: 'waypoint',
	area: 'area',
	photo: 'photo',
	collection: 'folder'
} as const satisfies Record<ObjectType, string>;

export const SHARED_WITH_ME_KEY = 'mapliberator:shared-with-me';

export const createGaiaAdapter: AdapterFactory = (transport, mode) => {
	const hosts = sourceHosts(mode).gaiagps;
	const origin = hosts.origins[0]!;
	const api = `${origin}/api/v3`;
	const identity = { label: 'Gaia GPS', version: '1.0.0' };
	const urls: GaiaUrls = {
		object: (type, id) => `${origin}/datasummary/${type}/${encodeURIComponent(id)}/`
	};

	let me: UserInfo | null = null;
	/** Other users' objects seen in my listings, kept only as references for collections. */
	const foreign = new Map<string, ReferenceRecord>();

	async function identifyUser(): Promise<UserInfo> {
		const user = parseListing(
			identity,
			GaiaUserSchema,
			await transport.getJson(`${api}/me/`),
			'account'
		);
		me = { id: user.id, displayName: user.display_name };
		return me;
	}

	async function requireUser(): Promise<UserInfo> {
		return me ?? identifyUser();
	}

	async function* pages<S extends z.ZodType>(
		type: ObjectType,
		item: S
	): AsyncGenerator<z.output<S>> {
		const schema = gaiaListingSchema(item);
		let url: string | null = `${api}/${LISTING_PATHS[type]}/?page=1&page_size=${PAGE_SIZE}`;
		while (url) {
			const page: z.output<typeof schema> = parseListing(
				identity,
				schema,
				await transport.getJson(url),
				`${type} listing`
			);
			yield* page.results as z.output<S>[];
			// Only ever follow pagination on our own API origin.
			url =
				page.next && new URL(page.next, origin).origin === origin
					? new URL(page.next, origin).href
					: null;
		}
	}

	async function* lines(kind: 'track' | 'route'): AsyncGenerator<LineRecord> {
		const user = await requireUser();
		for await (const summary of pages(kind, GaiaTrackSummarySchema)) {
			// Authored → full content; merely listed → reference (PRD §6.4).
			if (summary.user_id !== user.id) {
				foreign.set(`${kind}:${summary.id}`, mapForeignLine(kind, summary, urls));
				continue;
			}
			const objectApi = `${api}/${kind}/${encodeURIComponent(summary.id)}`;
			yield {
				...mapLineSummary(kind, summary, urls),
				nativeGpx: { method: 'GET', url: `${objectApi}.gpx`, accept: 'text-stream' },
				loadSegments: async () =>
					mapLineGeometry(parseItem(GaiaLineDetailSchema, await transport.getJson(`${objectApi}/`)))
			};
		}
	}

	return {
		id: 'gaiagps',
		label: identity.label,
		version: identity.version,
		origins: hosts.origins,
		assetOrigins: hosts.assetOrigins,
		limits: { apiConcurrency: 2, assetConcurrency: 4, minIntervalMs: 150 },
		bridgeUrl: `${origin}/robots.txt`,
		loginUrl: `${origin}/login`,
		isLoginUrl: (url) => new URL(url).pathname.startsWith('/login'),
		rawScrubKeys: ['saved_hikes', 'shared_by', 'user_name'],
		notes: [],

		identifyUser,

		async count(type) {
			const schema = gaiaListingSchema(z.unknown());
			const json = await transport.getJson(`${api}/${LISTING_PATHS[type]}/?page=1&page_size=1`);
			return parseListing(identity, schema, json, `${type} count`).count;
		},

		enumerateTracks: () => lines('track'),
		enumerateRoutes: () => lines('route'),

		async *enumerateWaypoints(): AsyncGenerator<WaypointRecord> {
			const user = await requireUser();
			for await (const waypoint of pages('waypoint', GaiaWaypointSchema)) {
				if (waypoint.user_id === user.id) yield mapWaypoint(waypoint, urls);
			}
		},

		async *enumerateAreas(): AsyncGenerator<AreaRecord> {
			const user = await requireUser();
			for await (const area of pages('area', GaiaAreaSchema)) {
				if (area.user_id === user.id) yield mapArea(area, urls);
			}
		},

		async *enumerateCollections(): AsyncGenerator<CollectionRecord> {
			const user = await requireUser();
			const shared: ReferenceRecord[] = [];
			for await (const folder of pages('collection', GaiaFolderSchema)) {
				if (folder.user_id === user.id) yield mapFolder(folder, urls, foreign);
				else shared.push(mapSharedFolder(folder, urls));
			}
			if (shared.length > 0) {
				yield {
					kind: 'collection',
					key: SHARED_WITH_ME_KEY,
					name: 'Shared with me',
					description: null,
					createdAt: null,
					updatedAt: null,
					parentSourceId: null,
					source: null,
					members: shared.map((reference) => ({ kind: 'reference', reference }))
				};
			}
		},

		async *enumeratePhotos(): AsyncGenerator<PhotoRecord> {
			const user = await requireUser();
			for await (const photo of pages('photo', GaiaPhotoSchema)) {
				// Only photos uploaded by the user.
				if (photo.user_id === user.id) yield mapPhoto(photo, urls);
			}
		}
	};
};
