/**
 * Gaia GPS adapter. Runs on the export page and talks to the platform only through the bridged
 * transport; it never retries and never emits archive bytes (PRD §6.1).
 */
import { z } from 'zod';
import { AdapterOutdatedError } from '../../shared/errors';
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
	isOwnFolder,
	mapArea,
	mapFolder,
	mapForeignLine,
	mapLineGeometry,
	mapLineSummary,
	mapPhoto,
	mapSharedFolder,
	mapWaypoint,
	waypointCoordinate,
	type GaiaUrls
} from './mapper';
import {
	GaiaAreaDetailSchema,
	GaiaAreaSummarySchema,
	GaiaFolderSchema,
	GaiaLineDetailSchema,
	GaiaPhotoSchema,
	GaiaTrackSummarySchema,
	GaiaUserSchema,
	GaiaWaypointSchema,
	gaiaListingSchema
} from './schemas';

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
	const objects = `${origin}/api/objects`;
	const identity = { label: 'Gaia GPS', version: '1.0.0' };
	const urls: GaiaUrls = {
		object: (type, id) => `${origin}/datasummary/${type}/${encodeURIComponent(id)}/`,
		photoFile: (id) => `${objects}/photo/${encodeURIComponent(id)}/image/full/`
	};

	let me: (UserInfo & { numericId: number }) | null = null;
	/** Other users' objects seen in my listings, kept only as references for collections. */
	const foreign = new Map<string, ReferenceRecord>();
	let sharedMembers: Promise<Set<string>> | null = null;

	async function identifyUser(): Promise<UserInfo> {
		const user = parseListing(
			identity,
			GaiaUserSchema,
			await transport.getJson(`${origin}/api/v3/user/`),
			'account'
		);
		if (user.id === null) {
			throw new AdapterOutdatedError(identity.label, identity.version, 'account has no id');
		}
		me = {
			id: String(user.id),
			displayName: user.display_name?.trim() || user.username?.trim() || 'Gaia GPS user',
			numericId: user.id
		};
		return { id: me.id, displayName: me.displayName };
	}

	/** The whole collection in one response, minus what the user has deleted. */
	async function list<S extends z.ZodType>(type: ObjectType, item: S): Promise<z.output<S>[]> {
		const listed = parseListing(
			identity,
			gaiaListingSchema(item),
			await transport.getJson(`${objects}/${LISTING_PATHS[type]}/`),
			`${type} listing`
		) as (z.output<S> & { deleted?: boolean })[];
		return listed.filter((object) => object.deleted !== true);
	}

	/**
	 * Listings do not say who owns an object. Whatever sits in somebody else's folder might be
	 * theirs, so those — and only those — get their owner checked on the detail response.
	 */
	function membersOfSharedFolders(): Promise<Set<string>> {
		sharedMembers ??= list('collection', GaiaFolderSchema).then((folders) => {
			const ids = new Set<string>();
			for (const folder of folders) {
				if (isOwnFolder(folder)) continue;
				for (const id of folder.tracks) ids.add(`track:${id}`);
				for (const id of folder.routes) ids.add(`route:${id}`);
			}
			return ids;
		});
		// A failed attempt must not stick.
		sharedMembers.catch(() => (sharedMembers = null));
		return sharedMembers;
	}

	async function* lines(kind: 'track' | 'route'): AsyncGenerator<LineRecord> {
		const user = me ?? (await identifyUser(), me!);
		const suspects = await membersOfSharedFolders();
		for (const summary of await list(kind, GaiaTrackSummarySchema)) {
			const objectApi = `${objects}/${kind}/${encodeURIComponent(summary.id)}`;
			const loadDetail = async () =>
				parseItem(GaiaLineDetailSchema, await transport.getJson(`${objectApi}/`));
			// Authored → full content; merely listed → reference (PRD §6.4).
			if (suspects.has(`${kind}:${summary.id}`)) {
				const detail = await loadDetail();
				if (detail.features[0]!.properties.user_id !== user.numericId) {
					foreign.set(`${kind}:${summary.id}`, mapForeignLine(kind, summary, detail, urls));
					continue;
				}
			}
			yield {
				...mapLineSummary(kind, summary, urls),
				nativeGpx: { method: 'GET', url: `${objectApi}.gpx`, accept: 'text-stream' },
				loadSegments: async () => mapLineGeometry(await loadDetail())
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
		loginUrl: `${origin}/login/`,
		isLoginUrl: (url) => new URL(url).pathname.startsWith('/login'),
		// Signed out: a bare 403 on the object API, or an anonymous answer from the account endpoint.
		isSignedOut: (response) =>
			(response.status === 403 && response.bodyKind === 'empty') ||
			(response.status === 200 &&
				typeof response.json === 'object' &&
				response.json !== null &&
				(response.json as { is_authenticated?: unknown }).is_authenticated === false),
		rawScrubKeys: [],
		notes: [],

		identifyUser,

		async count(type) {
			return (await list(type, z.looseObject({ deleted: z.boolean().optional() }))).length;
		},

		enumerateTracks: () => lines('track'),
		enumerateRoutes: () => lines('route'),

		async *enumerateWaypoints(): AsyncGenerator<WaypointRecord> {
			for (const waypoint of await list('waypoint', GaiaWaypointSchema)) {
				yield mapWaypoint(waypoint, urls);
			}
		},

		async *enumerateAreas(): AsyncGenerator<AreaRecord> {
			for (const area of await list('area', GaiaAreaSummarySchema)) {
				const detail = parseListing(
					identity,
					GaiaAreaDetailSchema,
					await transport.getJson(`${objects}/area/${encodeURIComponent(area.id)}/`),
					'area detail'
				);
				yield mapArea(area, detail, urls);
			}
		},

		async *enumerateCollections(): AsyncGenerator<CollectionRecord> {
			const shared: ReferenceRecord[] = [];
			for (const folder of await list('collection', GaiaFolderSchema)) {
				if (isOwnFolder(folder)) yield mapFolder(folder, urls, foreign);
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
			// Photos carry no coordinate of their own; their waypoints do.
			const waypoints = new Map(
				(await list('waypoint', GaiaWaypointSchema)).map(
					(waypoint) => [waypoint.id, waypointCoordinate(waypoint)] as const
				)
			);
			for (const photo of await list('photo', GaiaPhotoSchema)) {
				yield mapPhoto(photo, urls, waypoints);
			}
		}
	};
};
