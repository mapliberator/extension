/**
 * AllTrails-shaped dataset + API. Shapes follow docs/phase0-findings.md: `/api/alltrails`,
 * an `X-AT-KEY` header on every call, `{ <resource>: [...], meta, pageInfo }` envelopes paged
 * with `after=<nextCursor>`, recordings and custom routes as one `maps` resource, geometry as
 * encoded polylines with indexed elevation/time series, waypoints and photo links only inside
 * the map detail, list items that carry nothing but a trail id.
 */
import {
	BASE_EPOCH,
	DAY,
	NAMES,
	PLATFORM_TRAILS,
	isoUtc,
	lineStats,
	makeLine,
	type Env,
	type Pt,
	type ResolvedDataset
} from './dataset.ts';
import type { PhotoMime, PhotoSpec } from './photos.ts';
import { encodeIndexed, encodePolyline } from './polyline.ts';
import { parseIntParam, type ApiRequest, type Reply } from './reply.ts';
import { SENTINELS } from './sentinels.ts';
import type { AllTrailsObjects, ExpectedArchive, Json } from './types.ts';

const ME_ID = 7001;
const OTHER_ID = 7999;
const PREFIX = '/api/alltrails';
/** The app key the fake site's "JavaScript" would send. Not a secret, and not the real one. */
export const FAKE_AT_KEY = SENTINELS.appKey;
/** Indexed time series count hundredths of a second from an origin of the platform's choosing. */
const TIME_ORIGIN = BASE_EPOCH - 7_600_000;

function user(own: boolean): Json {
	return own
		? {
				id: ME_ID,
				username: 'test-hiker',
				firstName: 'Test',
				lastName: 'Hiker',
				slug: 'test-hiker'
			}
		: {
				id: OTHER_ID,
				username: SENTINELS.otherUserEmail,
				firstName: SENTINELS.otherUserName,
				lastName: 'X',
				slug: 'someone-else'
			};
}

export interface AtLine {
	id: number;
	own: boolean;
	summary: Json;
	detail: Json;
}

export interface AtPhoto {
	json: Json;
	own: boolean;
	spec: PhotoSpec;
}

export interface AllTrailsData {
	me: Json;
	tracks: AtLine[];
	maps: AtLine[];
	lists: { list: Json; items: Json[] }[];
	trails: Json[];
	photos: AtPhoto[];
	expected(): ExpectedArchive;
	objects(): AllTrailsObjects;
}

interface LineSpecA {
	id: number;
	name: string;
	notes?: string;
	own?: boolean;
	day: number;
	private?: boolean;
	activityType: string;
	start: [number, number];
	segments: number[];
	ele?: boolean;
	description?: string;
	waypoints?: { id: number; name: string; description: string; at: [number, number] }[];
	/** IDs of photos attached to this map; filled in by `attach`. */
	photos?: number[];
}

function buildLine(env: Env, kind: 'track' | 'map', spec: LineSpecA): AtLine {
	const own = spec.own !== false;
	const createdAt = BASE_EPOCH + spec.day * DAY + (spec.day % 5) * 2113;
	const segments: Pt[][] = makeLine({
		seed: `alltrails:${spec.id}`,
		start: spec.start,
		segments: spec.segments,
		digits: 5,
		startTime: createdAt - 5 * 3600,
		ele: spec.ele,
		time: kind === 'track'
	});
	const stats = lineStats(segments);
	const first = segments[0]![0]!;
	const text = own ? (spec.description ?? spec.notes ?? '') : SENTINELS.otherUserDescription;
	const isPrivate = spec.private ?? false;
	const privacy = `urn:alltrails:visibility:${isPrivate ? 'private' : 'public'}`;
	const summary: Json = {
		id: spec.id,
		name: spec.name,
		description: text,
		presentationType: kind,
		slug: `${kind}-${spec.id}`,
		created_at: isoUtc(createdAt),
		// Strings, as the real listing has them.
		location: {
			city: null,
			country: 'US',
			latitude: String(first.lat),
			longitude: String(first.lon)
		},
		trailId: null,
		activity: { uid: spec.activityType, name: spec.activityType },
		user: user(own),
		private: isPrivate,
		contentPrivacy: privacy,
		summaryStats: {
			duration: kind === 'track' ? stats.duration : 0,
			distanceTotal: stats.distance,
			elevationGain: stats.ascent
		},
		photoCount: 0,
		metadata: {
			created: isoUtc(createdAt),
			updated: isoUtc(createdAt + 2 * DAY + 1234),
			status: 'A',
			cursor: Buffer.from(`c:${spec.id}`).toString('base64url')
		}
	};
	const polyline = (seg: Pt[]): Json => ({
		pointsData: encodePolyline(
			seg.map((p) => [p.lat, p.lon] as const),
			5
		),
		...(kind === 'track'
			? {
					indexedTimeData: encodeIndexed(
						seg.map((p) => (p.time === null ? null : (p.time - TIME_ORIGIN) * 100))
					),
					elevationData: null
				}
			: {}),
		indexedElevationData: seg.every((p) => p.ele !== null)
			? encodeIndexed(seg.map((p) => Math.round(p.ele! * 1e5)))
			: null
	});
	const lines =
		kind === 'track'
			? {
					tracks: [
						{
							id: spec.id + 5_000_000,
							status: 'A',
							sequence_num: 0,
							lineTimedSegments: segments.map((seg, i) => ({
								id: spec.id * 10 + i,
								sequence_num: i,
								dateTimeStart: isoUtc(seg[0]!.time!),
								dateTimeStop: isoUtc(seg.at(-1)!.time!),
								polyline: polyline(seg)
							}))
						}
					]
				}
			: {
					routes: [
						{
							id: spec.id + 5_000_000,
							status: 'A',
							sequence_num: 0,
							lineSegments: segments.map((seg, i) => ({
								id: spec.id * 10 + i,
								sequence_num: i,
								polyline: polyline(seg)
							}))
						}
					]
				};
	const waypoints = (spec.waypoints ?? []).map((w, i) => ({
		id: w.id,
		name: w.name,
		name_original: w.name,
		description: w.description === '' ? null : w.description,
		order: i,
		location: { latitude: w.at[0], longitude: w.at[1] },
		at_map_id: spec.id,
		waypointCategory: { id: 1, name: 'General', uid: 'general', icon: 'waypoint-general' },
		contentPrivacy: privacy,
		isGlobal: false,
		// snake_case here, camelCase on the map: that is how the real API has it.
		user: { id: own ? ME_ID : OTHER_ID, first_name: own ? 'Test' : SENTINELS.otherUserName }
	}));
	const detail: Json = { ...summary, ...lines, waypoints, mapPhotos: [], map_source: 'ios' };
	return { id: spec.id, own, summary, detail };
}

/** `GET /trails/<id>`: everything but name, slug and location is the platform's own content. */
function trail(index: number): Json {
	const t = PLATFORM_TRAILS[index]!;
	return {
		id: 850001 + index,
		name: t.name,
		slug: `us/california/${t.slug}`,
		overview: `${SENTINELS.trailDescription} (${t.name})`,
		location: { city: 'Yosemite Valley', latitude: t.trailhead[0], longitude: t.trailhead[1] },
		defaultMap: { polyline: { pointsData: encodePolyline(t.geometry, 5) } }
	};
}

interface PhotoSpecA {
	id: number;
	title: string;
	description: string;
	own?: boolean;
	day: number;
	at: [number, number] | null;
	/** The recording or custom route it was added to. */
	map: number | null;
	/** A photo posted on a platform trail instead. */
	trailId?: number;
	mime?: PhotoMime;
	size: number;
}

function photo(spec: PhotoSpecA): AtPhoto {
	const own = spec.own !== false;
	const createdAt = BASE_EPOCH + spec.day * DAY + 4410;
	return {
		own,
		spec: { key: `alltrails/${spec.id}/full`, size: spec.size, mime: spec.mime ?? 'image/jpeg' },
		json: {
			id: spec.id,
			title: spec.title,
			description: own ? spec.description || null : SENTINELS.otherUserDescription,
			likeCount: 0,
			photoHash: spec.id.toString(16).padStart(32, '0'),
			trailId: spec.trailId ?? null,
			trailIds: spec.trailId ? [spec.trailId] : [],
			location: spec.at
				? { latitude: spec.at[0], longitude: spec.at[1] }
				: { latitude: null, longitude: null },
			user: user(own),
			metadata: { created: isoUtc(createdAt), updated: isoUtc(createdAt + 60), status: 'A' }
		}
	};
}

/** Photos are tied to their map only inside that map's detail (`mapPhotos`) and `photoCount`. */
function attach(lines: AtLine[], photos: { photo: AtPhoto; map: number | null }[]): void {
	for (const { photo: p, map } of photos) {
		const line = lines.find((l) => l.id === map);
		if (!line) continue;
		const location = p.json.location as { latitude: number | null; longitude: number | null };
		(line.detail.mapPhotos as Json[]).push({
			id: Number(p.json.id) + 1_000_000,
			mapId: line.id,
			location: { latitude: String(location.latitude), longitude: String(location.longitude) },
			photo: p.json
		});
		line.summary.photoCount = line.detail.photoCount = (line.detail.mapPhotos as Json[]).length;
	}
}

const ME_USER: Json = {
	...user(true),
	email: SENTINELS.email,
	referralCode: SENTINELS.csrfToken,
	metric: false
};

function finish(
	env: Env,
	parts: Omit<AllTrailsData, 'me' | 'expected' | 'objects'>
): AllTrailsData {
	const counters = {
		tracks: parts.tracks.filter((t) => t.own).length,
		maps: parts.maps.filter((m) => m.own).length,
		photos: parts.photos.filter((p) => p.own).length,
		// The real counters stay at zero for the built-in lists; never trust them.
		lists: 0,
		favorites: 0
	};
	const me: Json = { ...ME_USER, ...counters };
	return {
		me,
		...parts,
		expected(): ExpectedArchive {
			const own = [...parts.tracks, ...parts.maps].filter((l) => l.own);
			const references: ExpectedArchive['references'] = [];
			for (const { items } of parts.lists) {
				for (const item of items) {
					const t = parts.trails.find((candidate) => candidate.id === item.trailId);
					if (!t || references.some((r) => r.sourceId === String(t.id))) continue;
					const loc = t.location as { latitude: number; longitude: number };
					references.push({
						name: String(t.name),
						url: `${env.origin}/trail/${String(t.slug)}`,
						sourceId: String(t.id),
						coordinate: [loc.longitude, loc.latitude]
					});
				}
			}
			const ids = {
				tracks: parts.tracks.filter((a) => a.own).map((a) => String(a.id)),
				routes: parts.maps.filter((m) => m.own).map((m) => String(m.id)),
				// Waypoints come out in the order their maps are read: recordings, then routes.
				waypoints: own.flatMap((l) =>
					(l.detail.waypoints as { id: number }[]).map((w) => String(w.id))
				),
				areas: [] as string[],
				photos: parts.photos.filter((p) => p.own).map((p) => String(p.json.id))
			};
			return {
				account: { id: String(ME_ID), displayName: 'Test H.' },
				counts: {
					tracks: ids.tracks.length,
					routes: ids.routes.length,
					waypoints: ids.waypoints.length,
					areas: 0,
					// Lists without items are not exported.
					collections: parts.lists.filter((l) => l.items.length > 0).length,
					photos: ids.photos.length
				},
				ids,
				references
			};
		},
		objects(): AllTrailsObjects {
			return {
				me,
				tracks: parts.tracks.map(({ summary, detail }) => ({ summary, detail })),
				maps: parts.maps.map(({ summary, detail }) => ({ summary, detail })),
				lists: parts.lists,
				trails: parts.trails,
				photos: parts.photos.map((p) => p.json)
			};
		}
	};
}

function buildSmall(env: Env): AllTrailsData {
	const tracks = [
		buildLine(env, 'track', {
			id: 810001,
			name: NAMES.slashes,
			notes: 'Great morning. Saw two marmots.',
			day: 2,
			activityType: 'hiking',
			start: [36.77012, -118.37044],
			segments: [150],
			waypoints: [
				{
					id: 830010,
					name: 'Marmot rock',
					description: 'They live here.',
					at: [36.77188, -118.36907]
				}
			]
		}),
		buildLine(env, 'track', {
			id: 810002,
			name: NAMES.accents,
			notes: 'Très venteux.',
			day: 6,
			private: true,
			activityType: 'trail-running',
			start: [36.75533, -118.35208],
			segments: [90]
		}),
		buildLine(env, 'track', {
			id: 819001,
			name: 'Club run with friends',
			own: false,
			day: 7,
			activityType: 'trail-running',
			start: [36.79121, -118.33067],
			segments: [40]
		}),
		buildLine(env, 'track', {
			id: 810003,
			name: NAMES.duplicate,
			notes: 'Paused at the lake, so two segments.',
			day: 13,
			activityType: 'walking',
			start: [36.76208, -118.38115],
			segments: [60, 45]
		}),
		buildLine(env, 'track', {
			id: 810004,
			name: NAMES.duplicate,
			day: 14,
			activityType: 'walking',
			start: [36.76251, -118.38092],
			segments: [38],
			ele: false
		})
	];
	const maps = [
		buildLine(env, 'map', {
			id: 820001,
			name: NAMES.emoji,
			description: 'Two-night loop with a layover day.',
			notes: 'Permit needed.',
			day: 1,
			activityType: 'backpacking',
			start: [36.74418, -118.40127],
			segments: [220],
			waypoints: [
				{
					id: 830001,
					name: 'Night 1 camp',
					description: 'By the outlet.',
					at: [36.74951, -118.39582]
				},
				{ id: 830002, name: 'Water <last reliable>', description: '', at: [36.75307, -118.39011] }
			]
		}),
		buildLine(env, 'map', {
			id: 820002,
			name: NAMES.long,
			description: '',
			day: 10,
			private: true,
			activityType: 'hiking',
			start: [36.78102, -118.34519],
			segments: [96],
			waypoints: [
				{
					id: 830003,
					name: 'Night 1 camp',
					description: 'Alternate site.',
					at: [36.78466, -118.34102]
				},
				{ id: 830004, name: 'Bear box 🐻', description: 'Shared.', at: [36.78391, -118.34377] }
			]
		}),
		buildLine(env, 'map', {
			id: 820003,
			name: 'Gravel loop',
			description: 'Mostly fire roads.',
			day: 16,
			activityType: 'mountain-biking',
			start: [36.72865, -118.36254],
			segments: [70]
		})
	];
	const trails = [trail(0), trail(1), trail(2)];
	const listTime = BASE_EPOCH + 4 * DAY;
	const list = (
		id: number,
		type: string,
		name: string,
		description: string,
		isPrivate: boolean
	): Json => ({
		id,
		order: null,
		type,
		slug: null,
		private: isPrivate,
		contentPrivacy: `urn:alltrails:visibility:${isPrivate ? 'private' : 'public'}`,
		ownerId: ME_ID,
		isCollaborative: false,
		// Stale on the real API too: it said 0 for a list that had an item.
		metadata: { created: null, itemsCount: 0, status: 'A', updated: null },
		name,
		description,
		user: user(true)
	});
	const item = (
		id: number,
		listId: number,
		order: number,
		trailId: number,
		notes: string | null
	): Json => ({
		id,
		listId,
		type: 'trail',
		order,
		notes,
		trailId,
		metadata: {
			status: 'A',
			created: isoUtc(listTime + order * 60),
			updated: isoUtc(listTime + DAY)
		}
	});
	const lists = [
		{
			list: list(840001, 'user-built-in', 'Favorites', '', false),
			items: [
				item(841001, 840001, 0, 850001, 'Start before 7am; bring 3L of water.'),
				item(841002, 840001, 1, 850002, null)
			]
		},
		{ list: list(840002, 'user-built-in', 'Want to go', '', false), items: [] },
		{
			list: list(
				840003,
				'user-custom',
				'Summer goals / 2024',
				'Things to do before the snow.',
				true
			),
			items: [item(841003, 840003, 0, 850001, null), item(841004, 840003, 1, 850003, null)]
		}
	];
	const specs: PhotoSpecA[] = [
		{
			id: 860001,
			title: 'Marmot!',
			description: 'He wanted my sandwich',
			day: 2,
			at: [36.77188, -118.36907],
			map: 810001,
			size: 52_340
		},
		{
			id: 869001,
			title: 'Club photo',
			description: '',
			own: false,
			day: 7,
			at: [36.79133, -118.33041],
			map: 819001,
			size: 9_001
		},
		{
			id: 860002,
			title: '',
			description: '',
			day: 1,
			at: null,
			map: 820001,
			mime: 'image/png',
			size: 15_555
		},
		{
			id: 860003,
			title: 'Top of the falls',
			description: 'From my hike on the falls trail',
			day: 25,
			at: [36.76604, -118.37712],
			map: null,
			trailId: 850001,
			size: 33_333
		}
	];
	const photos = specs.map(photo);
	attach(
		[...tracks, ...maps],
		photos.map((p, i) => ({ photo: p, map: specs[i]!.map }))
	);
	return finish(env, { tracks, maps, lists, trails, photos });
}

export function buildAllTrails(env: Env, ds: ResolvedDataset): AllTrailsData {
	if (ds.kind === 'large') {
		// The large dataset is Gaia-only; this platform is an empty (but valid) account.
		return finish(env, { tracks: [], maps: [], lists: [], trails: [], photos: [] });
	}
	return buildSmall(env);
}

// ---------------------------------------------------------------------------------------------

function meta(items: number): Json {
	return { status: 'ok', items, timestamp: isoUtc(BASE_EPOCH) };
}

function fail(status: number, code: string, message: string): Reply {
	return {
		kind: 'json',
		status,
		body: { errors: [{ code, message, target: null, debug: null }], meta: { status: 'error' } }
	};
}

const NOT_FOUND = fail(404, 'not_found', 'Not found.');

function encodeCursor(offset: number): string {
	return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
	if (cursor === null || cursor === '') return 0;
	const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
	return m ? Number(m[1]) : Number.NaN;
}

/** `{ <key>: [...], meta, pageInfo }`, paged with `after`. Any other cursor name is ignored. */
function listing(ds: ResolvedDataset, req: ApiRequest, key: string, items: Json[]): Reply {
	const offset = decodeCursor(req.query.get('after'));
	if (!Number.isFinite(offset) || offset > items.length) {
		return fail(400, 'invalid_cursor', 'The cursor is invalid.');
	}
	const requested = parseIntParam(req.query.get('limit'), 20);
	const limit = Math.min(
		Number.isFinite(requested) && requested >= 1 ? requested : 20,
		ds.maxPageSize
	);
	const end = Math.min(offset + limit, items.length);
	const page = items.slice(offset, end);
	const hasNextPage = end < items.length;
	return {
		kind: 'json',
		status: 200,
		listingKey: key,
		body: {
			[key]: page,
			meta: meta(page.length),
			pageInfo: {
				totalItemCount: items.length,
				itemCount: page.length,
				hasNextPage,
				...(hasNextPage ? { nextCursor: encodeCursor(end) } : {})
			}
		}
	};
}

function one(key: string, item: Json): Reply {
	return { kind: 'json', status: 200, body: { [key]: [item], meta: meta(1) } };
}

/** Authenticated `/api/alltrails/*` requests. */
export function handleAllTrailsApi(
	data: AllTrailsData,
	ds: ResolvedDataset,
	req: ApiRequest
): Reply {
	if (req.method !== 'GET' && req.method !== 'HEAD')
		return fail(405, 'method_not_allowed', 'Method not allowed.');
	if (!req.path.startsWith(`${PREFIX}/`)) return NOT_FOUND;
	// The real site's bot protection turns away API calls that name /robots.txt as their referrer:
	// a 403 whose JSON body is nothing but the address of a challenge page.
	if (String(req.headers.referer ?? '').endsWith('/robots.txt')) {
		return { kind: 'json', status: 403, body: { url: 'https://challenge.invalid/captcha' } };
	}
	if (req.headers['x-at-key'] === undefined)
		return fail(400, 'missing_key', 'The API key is missing.');
	if (req.headers['x-at-key'] !== FAKE_AT_KEY)
		return fail(400, 'invalid_key', 'The API key is invalid.');
	const rest = req.path.slice(PREFIX.length + 1).replace(/\/$/, '');
	if (rest === 'me') return one('users', data.me);

	const owned = /^users\/([^/]+)\/(maps|lists|photos)$/.exec(rest);
	if (owned) {
		if (owned[1] !== String(ME_ID)) return fail(403, 'forbidden', 'Forbidden.');
		if (owned[2] === 'maps') {
			// Without a presentation type the real listing mixes recordings and custom routes.
			const type = req.query.get('presentation_type');
			const lines = [...data.maps, ...data.tracks].filter(
				(l) => type === null || l.summary.presentationType === type
			);
			return listing(
				ds,
				req,
				'maps',
				lines.map((l) => l.summary)
			);
		}
		if (owned[2] === 'lists')
			return listing(
				ds,
				req,
				'lists',
				data.lists.map((l) => l.list)
			);
		return listing(
			ds,
			req,
			'photos',
			data.photos.map((p) => p.json)
		);
	}

	const map = /^maps\/(\d+)$/.exec(rest);
	if (map) {
		const line = [...data.tracks, ...data.maps].find((l) => l.id === Number(map[1]));
		if (!line) return NOT_FOUND;
		// Geometry, waypoints and photo links only come with `detail=deep`.
		return one('maps', req.query.get('detail') === 'deep' ? line.detail : line.summary);
	}
	const items = /^lists\/(\d+)\/items$/.exec(rest);
	if (items) {
		const found = data.lists.find((l) => l.list.id === Number(items[1]));
		if (!found) return NOT_FOUND;
		return {
			kind: 'json',
			status: 200,
			listingKey: 'listItems',
			body: { listItems: found.items, meta: meta(found.items.length) }
		};
	}
	const trailMatch = /^trails\/(\d+)$/.exec(rest);
	if (trailMatch) {
		const found = data.trails.find((t) => t.id === Number(trailMatch[1]));
		return found ? one('trails', found) : NOT_FOUND;
	}
	return fail(400, 'method_not_found', `The api call ${rest} could not be found.`);
}

/**
 * `/api/alltrails/v3/photos/<id>/image?key=…&size=…` on the site host: needs the key but no
 * session, and redirects to the image host. Every size gives the same (largest) file.
 */
export function allTrailsPhotoRedirect(
	data: AllTrailsData,
	env: Env,
	path: string,
	query: URLSearchParams
): { location: string } | { status: number } | null {
	const m = /^\/api\/alltrails\/(?:v3\/)?photos\/(\d+)\/image$/.exec(path);
	if (!m) return null;
	if (query.get('key') !== FAKE_AT_KEY) return { status: 400 };
	if (!data.photos.some((p) => p.json.id === Number(m[1]))) return { status: 404 };
	return { location: `${env.cdnOrigin}/p/${m[1]!}/full` };
}

/** Image host: `/p/<id>/full`. */
export function handleAllTrailsCdn(data: AllTrailsData, path: string): Reply | null {
	const m = /^\/p\/(\d+)\/full$/.exec(path);
	if (!m) return null;
	const found = data.photos.find((p) => p.json.id === Number(m[1]));
	return found ? { kind: 'photo', spec: found.spec } : null;
}

export function trailBySlug(slug: string): { name: string } | undefined {
	return PLATFORM_TRAILS.find((t) => slug === t.slug || slug.endsWith(`/${t.slug}`));
}
