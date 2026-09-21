/** AllTrails-shaped dataset + API (`/api/alltrails/v3`, cursor listings, encoded polylines). */
import {
	BASE_EPOCH,
	DAY,
	NAMES,
	PLATFORM_TRAILS,
	isoDate,
	lineStats,
	makeLine,
	type Env,
	type Pt,
	type ResolvedDataset
} from './dataset.ts';
import { buildGpx, type GpxWaypoint } from './gpx.ts';
import type { PhotoMime, PhotoSpec } from './photos.ts';
import { encodePolyline } from './polyline.ts';
import { json, parseIntParam, type ApiRequest, type Reply } from './reply.ts';
import { SENTINELS } from './sentinels.ts';
import type { AllTrailsObjects, ExpectedArchive, Json } from './types.ts';

const ME_ID = 7001;
const OTHER_ID = 7999;
const PREFIX = '/api/alltrails/v3';
const GPX_NS = { prefix: 'at', uri: 'https://www.alltrails.com/gpx/extensions/1' };
const CREATOR = 'AllTrails (fake-source)';

const ME_USER = { id: ME_ID, name: 'Test Hiker' };
const OTHER_USER = { id: OTHER_ID, name: SENTINELS.otherUserName };

export interface AtLine {
	id: number;
	own: boolean;
	summary: Json;
	detail: Json;
	gpx: Buffer;
}

export interface AtPhoto {
	json: Json;
	own: boolean;
	renditions: Record<string, PhotoSpec>;
}

export interface AllTrailsData {
	me: Json;
	activities: AtLine[];
	maps: AtLine[];
	lists: Json[];
	completed: Json[];
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
	/** Maps only. */
	description?: string;
	waypoints?: { id: number; name: string; description: string; at: [number, number] }[];
}

function buildLine(kind: 'activity' | 'map', spec: LineSpecA): AtLine {
	const own = spec.own !== false;
	const createdAt = BASE_EPOCH + spec.day * DAY + (spec.day % 5) * 2113;
	const segments: Pt[][] = makeLine({
		seed: `alltrails:${spec.id}`,
		start: spec.start,
		segments: spec.segments,
		digits: 5,
		startTime: createdAt - 5 * 3600,
		ele: spec.ele,
		time: kind === 'activity'
	});
	const stats = lineStats(segments);
	const first = segments[0]![0]!;
	const notes = own ? (spec.notes ?? '') : SENTINELS.otherUserDescription;
	const summary: Json = {
		id: spec.id,
		name: spec.name,
		notes
	};
	const waypoints = (spec.waypoints ?? []).map((w, i) => ({
		id: w.id,
		name: w.name,
		description: w.description,
		location: { latitude: w.at[0], longitude: w.at[1] },
		createdAt: createdAt + 60 * (i + 1)
	}));
	if (kind === 'map') summary.description = own ? (spec.description ?? '') : notes;
	summary.createdAt = createdAt;
	summary.updatedAt = createdAt + 2 * DAY + 1234;
	summary.activityType = { uid: spec.activityType };
	summary.private = spec.private ?? false;
	summary.user = own ? ME_USER : OTHER_USER;
	summary.summaryStats =
		kind === 'activity'
			? { distanceTotal: stats.distance, elevationGain: stats.ascent, timeTotal: stats.duration }
			: { distanceTotal: stats.distance, elevationGain: stats.ascent };
	summary.location = { latitude: first.lat, longitude: first.lon };
	if (kind === 'map') summary.waypoints = waypoints;

	const detail: Json = {
		...summary,
		segments: segments.map((seg) => ({
			polyline: {
				pointsData: encodePolyline(
					seg.map((p) => [p.lat, p.lon] as const),
					5
				),
				elevationData: seg.every((p) => p.ele !== null) ? seg.map((p) => p.ele) : null,
				timeData: seg.every((p) => p.time !== null) ? seg.map((p) => p.time) : null
			}
		}))
	};
	const gpxWaypoints: GpxWaypoint[] = waypoints.map((w) => ({
		lat: w.location.latitude,
		lon: w.location.longitude,
		name: w.name,
		desc: w.description
	}));
	const gpx = buildGpx({
		creator: CREATOR,
		ns: GPX_NS,
		kind: 'trk',
		name: spec.name,
		desc: kind === 'map' && own ? spec.description || notes : notes,
		time: createdAt,
		author: own ? undefined : SENTINELS.otherUserName,
		extensions: [
			['activityType', spec.activityType],
			['kind', kind]
		],
		segments,
		waypoints: gpxWaypoints,
		digits: 5
	});
	return { id: spec.id, own, summary, detail, gpx };
}

function trail(index: number): Json {
	const t = PLATFORM_TRAILS[index]!;
	return {
		id: 850001 + index,
		name: t.name,
		slug: t.slug,
		description: `${SENTINELS.trailDescription} (${t.name})`,
		location: { latitude: t.trailhead[0], longitude: t.trailhead[1] },
		polyline: { pointsData: encodePolyline(t.geometry, 5) },
		user: null
	};
}

interface PhotoSpecA {
	id: number;
	title: string;
	caption: string;
	own?: boolean;
	day: number;
	taken: boolean;
	at: [number, number] | null;
	attached: { type: 'activity' | 'map' | 'trail'; id: number } | null;
	mime?: PhotoMime;
	original: number | null;
	large: number;
}

function photo(env: Env, spec: PhotoSpecA): AtPhoto {
	const own = spec.own !== false;
	const mime = spec.mime ?? 'image/jpeg';
	const createdAt = BASE_EPOCH + spec.day * DAY + 4410;
	const renditions: Record<string, PhotoSpec> = {
		large: { key: `alltrails/${spec.id}/large`, size: spec.large, mime }
	};
	const urls: Record<string, string> = {};
	if (spec.original !== null) {
		renditions.original = { key: `alltrails/${spec.id}/original`, size: spec.original, mime };
		urls.original = `${env.cdnOrigin}/p/${spec.id}/original`;
	}
	urls.large = `${env.cdnOrigin}/p/${spec.id}/large`;
	return {
		own,
		renditions,
		json: {
			id: spec.id,
			title: spec.title,
			caption: spec.caption,
			createdAt,
			takenAt: spec.taken ? createdAt - 7200 : null,
			user: own ? ME_USER : OTHER_USER,
			location: spec.at ? { latitude: spec.at[0], longitude: spec.at[1] } : null,
			urls,
			attachedTo: spec.attached
		}
	};
}

const ME: Json = {
	user: {
		id: ME_ID,
		firstName: 'Test',
		lastName: 'Hiker',
		email: SENTINELS.email,
		slug: 'test-hiker',
		metric: false
	},
	csrfToken: SENTINELS.csrfToken
};

function finish(
	env: Env,
	parts: Omit<AllTrailsData, 'me' | 'expected' | 'objects'>
): AllTrailsData {
	return {
		me: ME,
		...parts,
		expected(): ExpectedArchive {
			const ownMaps = parts.maps.filter((m) => m.own);
			const references: ExpectedArchive['references'] = [];
			const addTrail = (t: Json): void => {
				const sourceId = String(t.id);
				if (references.some((r) => r.sourceId === sourceId)) return;
				const loc = t.location as { latitude: number; longitude: number };
				references.push({
					name: String(t.name),
					url: `${env.origin}/trail/${String(t.slug)}`,
					sourceId,
					coordinate: [loc.longitude, loc.latitude]
				});
			};
			for (const list of parts.lists) {
				for (const item of list.items as Json[]) {
					if (item.type === 'trail') addTrail(item.trail as Json);
				}
			}
			for (const c of parts.completed) addTrail(c.trail as Json);
			const ids = {
				tracks: parts.activities.filter((a) => a.own).map((a) => String(a.id)),
				routes: ownMaps.map((m) => String(m.id)),
				waypoints: ownMaps.flatMap((m) =>
					(m.summary.waypoints as { id: number }[]).map((w) => String(w.id))
				),
				areas: [] as string[],
				photos: parts.photos.filter((p) => p.own).map((p) => String(p.json.id))
			};
			const ownLists = parts.lists.filter((l) => (l.user as { id: number }).id === ME_ID).length;
			return {
				account: { id: String(ME_ID), displayName: 'Test H.' },
				counts: {
					tracks: ids.tracks.length,
					routes: ids.routes.length,
					waypoints: ids.waypoints.length,
					areas: 0,
					collections: ownLists + (parts.completed.length > 0 ? 1 : 0),
					photos: ids.photos.length
				},
				ids,
				references
			};
		},
		objects(): AllTrailsObjects {
			return {
				me: ME,
				activities: parts.activities.map(({ summary, detail }) => ({ summary, detail })),
				maps: parts.maps.map(({ summary, detail }) => ({ summary, detail })),
				lists: parts.lists,
				completed: parts.completed,
				photos: parts.photos.map((p) => p.json)
			};
		}
	};
}

function buildSmall(env: Env): AllTrailsData {
	const activities = [
		buildLine('activity', {
			id: 810001,
			name: NAMES.slashes,
			notes: 'Great morning. Saw two marmots.',
			day: 2,
			activityType: 'hiking',
			start: [36.77012, -118.37044],
			segments: [150]
		}),
		buildLine('activity', {
			id: 810002,
			name: NAMES.accents,
			notes: 'Très venteux.',
			day: 6,
			private: true,
			activityType: 'trail-running',
			start: [36.75533, -118.35208],
			segments: [90]
		}),
		buildLine('activity', {
			id: 819001,
			name: 'Club run with friends',
			own: false,
			day: 7,
			activityType: 'trail-running',
			start: [36.79121, -118.33067],
			segments: [40]
		}),
		buildLine('activity', {
			id: 810003,
			name: NAMES.duplicate,
			notes: 'Paused at the lake, so two segments.',
			day: 13,
			activityType: 'walking',
			start: [36.76208, -118.38115],
			segments: [60, 45]
		}),
		buildLine('activity', {
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
		buildLine('map', {
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
		buildLine('map', {
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
		buildLine('map', {
			id: 820003,
			name: 'Gravel loop',
			description: 'Mostly fire roads.',
			day: 16,
			activityType: 'mountain-biking',
			start: [36.72865, -118.36254],
			segments: [70]
		})
	];
	const [trailA, trailB, trailC] = [trail(0), trail(1), trail(2)];
	const listTime = BASE_EPOCH + 4 * DAY;
	const lists: Json[] = [
		{
			id: 840001,
			name: 'Summer goals / 2024',
			description: 'Things to do before the snow.',
			private: false,
			createdAt: listTime,
			updatedAt: listTime + 9 * DAY,
			user: ME_USER,
			items: [
				{ type: 'trail', trail: trailA },
				{ type: 'trail', trail: trailB },
				{ type: 'map', id: 820001 },
				{ type: 'activity', id: 810001 }
			]
		},
		{
			id: 840002,
			name: 'Quick ones',
			description: '',
			private: true,
			createdAt: listTime + DAY,
			updatedAt: listTime + 2 * DAY,
			user: ME_USER,
			items: [{ type: 'trail', trail: trailA }]
		}
	];
	const completed: Json[] = [
		{
			trail: trailA,
			completedAt: isoDate(BASE_EPOCH + 25 * DAY),
			rating: 5,
			review: 'Steep but worth it. Go early to beat the crowds.',
			privateNotes: 'Parked at the lodge; 6h car to car.'
		},
		{
			trail: trailC,
			completedAt: isoDate(BASE_EPOCH + 40 * DAY),
			rating: null,
			review: null,
			privateNotes: 'Easy stroll with the kids.'
		}
	];
	const photos = [
		photo(env, {
			id: 860001,
			title: 'Marmot!',
			caption: 'He wanted my sandwich',
			day: 2,
			taken: true,
			at: [36.77188, -118.36907],
			attached: { type: 'activity', id: 810001 },
			original: 52_340,
			large: 21_077
		}),
		photo(env, {
			id: 869001,
			title: 'Club photo',
			caption: SENTINELS.otherUserDescription,
			own: false,
			day: 7,
			taken: true,
			at: [36.79133, -118.33041],
			attached: { type: 'activity', id: 819001 },
			original: 9_001,
			large: 4_003
		}),
		photo(env, {
			id: 860002,
			title: '',
			caption: '',
			day: 1,
			taken: false,
			at: null,
			attached: { type: 'map', id: 820001 },
			mime: 'image/png',
			original: null,
			large: 15_555
		}),
		photo(env, {
			id: 860003,
			title: 'Top of the falls',
			caption: 'From my hike on the falls trail',
			day: 25,
			taken: true,
			at: [36.76604, -118.37712],
			attached: { type: 'trail', id: 850001 },
			original: 33_333,
			large: 11_111
		})
	];
	return finish(env, { activities, maps, lists, completed, photos });
}

export function buildAllTrails(env: Env, ds: ResolvedDataset): AllTrailsData {
	if (ds.kind === 'large') {
		// The large dataset is Gaia-only; this platform is an empty (but valid) account.
		return finish(env, { activities: [], maps: [], lists: [], completed: [], photos: [] });
	}
	return buildSmall(env);
}

// ---------------------------------------------------------------------------------------------

const NOT_FOUND = json(404, { error: 'not_found' });

function encodeCursor(offset: number): string {
	return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
	if (cursor === null || cursor === '') return 0;
	const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
	return m ? Number(m[1]) : Number.NaN;
}

function listing(ds: ResolvedDataset, req: ApiRequest, items: Json[]): Reply {
	const offset = decodeCursor(req.query.get('cursor'));
	if (!Number.isFinite(offset) || offset > items.length) {
		return json(400, { error: 'invalid_cursor' });
	}
	const requested = parseIntParam(req.query.get('limit'), 50);
	const limit = Math.min(
		Number.isFinite(requested) && requested >= 1 ? requested : 50,
		ds.maxPageSize
	);
	const end = Math.min(offset + limit, items.length);
	return {
		kind: 'json',
		status: 200,
		listingKey: 'items',
		body: {
			items: items.slice(offset, end),
			meta: { nextCursor: end < items.length ? encodeCursor(end) : null }
		}
	};
}

/** Authenticated `/api/alltrails/v3/*` requests. */
export function handleAllTrailsApi(
	data: AllTrailsData,
	ds: ResolvedDataset,
	req: ApiRequest
): Reply {
	if (req.method !== 'GET' && req.method !== 'HEAD')
		return json(405, { error: 'method_not_allowed' });
	if (!req.path.startsWith(`${PREFIX}/`)) return NOT_FOUND;
	const rest = req.path.slice(PREFIX.length + 1).replace(/\/$/, '');
	if (rest === 'me') return json(200, data.me);

	const user = /^users\/([^/]+)\/(stats|activities|maps|lists|completed|photos)$/.exec(rest);
	if (user) {
		if (user[1] !== String(ME_ID)) return json(403, { error: 'forbidden' });
		switch (user[2]) {
			case 'stats':
				return json(200, {
					activities: data.activities.length,
					maps: data.maps.length,
					photos: data.photos.length,
					completed: data.completed.length
				});
			case 'activities':
				return listing(
					ds,
					req,
					data.activities.map((a) => a.summary)
				);
			case 'maps':
				return listing(
					ds,
					req,
					data.maps.map((m) => m.summary)
				);
			case 'lists':
				return listing(ds, req, data.lists);
			case 'completed':
				return listing(ds, req, data.completed);
			default:
				return listing(
					ds,
					req,
					data.photos.map((p) => p.json)
				);
		}
	}

	const item = /^(activities|maps)\/(\d+)(\/export)?$/.exec(rest);
	if (item) {
		const lines = item[1] === 'activities' ? data.activities : data.maps;
		const line = lines.find((l) => l.id === Number(item[2]));
		if (!line) return NOT_FOUND;
		if (item[3] === undefined) return json(200, line.detail);
		if (req.query.get('format') !== 'gpx') return json(400, { error: 'unsupported_format' });
		return { kind: 'bytes', status: 200, contentType: 'application/gpx+xml', body: line.gpx };
	}
	return NOT_FOUND;
}

/** CDN host: `/p/<id>/<rendition>`. */
export function handleAllTrailsCdn(data: AllTrailsData, path: string): Reply | null {
	const m = /^\/p\/(\d+)\/([a-z]+)$/.exec(path);
	if (!m) return null;
	const spec = data.photos.find((p) => p.json.id === Number(m[1]))?.renditions[m[2]!];
	return spec ? { kind: 'photo', spec } : null;
}

export function trailBySlug(slug: string): { name: string } | undefined {
	return PLATFORM_TRAILS.find((t) => t.slug === slug);
}
