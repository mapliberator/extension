/** Gaia-GPS-shaped dataset + API (`/api/v3`, page-numbered listings). */
import {
	BASE_EPOCH,
	DAY,
	NAMES,
	PLATFORM_TRAILS,
	isoDate,
	isoWithOffset,
	lineStats,
	makeLine,
	type Env,
	type Pt,
	type ResolvedDataset
} from './dataset.ts';
import { buildGpx } from './gpx.ts';
import type { PhotoMime, PhotoSpec } from './photos.ts';
import { json, parseIntParam, type ApiRequest, type Reply } from './reply.ts';
import { SENTINELS } from './sentinels.ts';
import type { ExpectedArchive, GaiaObjects, Json } from './types.ts';

const ME_ID = 'gu-1001';
const OTHER_ID = 'gu-2002';
const GPX_NS = { prefix: 'gaia', uri: 'https://www.gaiagps.com/gpx/extensions/1' };
const CREATOR = 'GaiaGPS (fake-source)';

export interface GaiaLine {
	id: string;
	own: boolean;
	summary: Json;
	detail: Json;
	gpx: Buffer;
}

export interface GaiaPhoto {
	json: Json;
	own: boolean;
	spec: PhotoSpec;
}

export interface GaiaData {
	me: Json;
	tracks: GaiaLine[];
	routes: GaiaLine[];
	waypoints: Json[];
	areas: Json[];
	folders: Json[];
	photoCount: number;
	photoAt(index: number): GaiaPhoto;
	photoById(id: string): GaiaPhoto | undefined;
	expected(): ExpectedArchive;
	objects(): GaiaObjects;
}

interface CommonSpec {
	id: string;
	title: string;
	notes?: string;
	own?: boolean;
	/** Days after BASE_EPOCH. */
	day: number;
	offsetMinutes?: number;
	public?: boolean;
	tags?: string[];
}

function created(spec: CommonSpec): number {
	return BASE_EPOCH + spec.day * DAY + (spec.day % 7) * 1733;
}

function common(spec: CommonSpec): Json {
	const own = spec.own !== false;
	const t = created(spec);
	const out: Json = {
		id: spec.id,
		title: spec.title,
		notes: own ? (spec.notes ?? '') : SENTINELS.otherUserDescription,
		time_created: isoWithOffset(t, spec.offsetMinutes),
		updated_date: isoWithOffset(t + 3 * DAY + 4521, spec.offsetMinutes),
		public: spec.public ?? false,
		user_id: own ? ME_ID : OTHER_ID
	};
	if (!own) out.user_name = SENTINELS.otherUserName;
	out.user_email = own ? SENTINELS.email : SENTINELS.otherUserEmail;
	out.tags = spec.tags ?? [];
	return out;
}

interface LineSpecG extends CommonSpec {
	activities: string[];
	color?: string;
	start: [number, number];
	segments: number[];
}

function buildLine(kind: 'track' | 'route', spec: LineSpecG): GaiaLine {
	const own = spec.own !== false;
	const t = created(spec);
	const segments: Pt[][] = makeLine({
		seed: `gaia:${spec.id}`,
		start: spec.start,
		segments: spec.segments,
		digits: 6,
		startTime: t - 6 * 3600,
		time: kind === 'track'
	});
	const stats = lineStats(segments);
	const first = segments[0]![0]!;
	const summary: Json = { ...common(spec), activities: spec.activities, distance: stats.distance };
	summary.total_ascent = stats.ascent;
	if (kind === 'track') {
		summary.total_time = stats.duration;
		summary.color = spec.color ?? '#ff5a00';
	}
	summary.start_location = { latitude: first.lat, longitude: first.lon };
	const detail: Json = {
		...summary,
		geometry: {
			type: 'MultiLineString',
			coordinates: segments.map((seg) =>
				seg.map((p) => (kind === 'track' ? [p.lon, p.lat, p.ele, p.time] : [p.lon, p.lat, p.ele]))
			)
		}
	};
	const extensions: [string, string][] = [];
	if (kind === 'track') extensions.push(['color', spec.color ?? '#ff5a00']);
	for (const a of spec.activities) extensions.push(['activity', a]);
	extensions.push(['public', String(spec.public ?? false)]);
	const gpx = buildGpx({
		creator: CREATOR,
		ns: GPX_NS,
		kind: kind === 'track' ? 'trk' : 'rte',
		name: spec.title,
		desc: own ? spec.notes : SENTINELS.otherUserDescription,
		time: t,
		author: own ? undefined : SENTINELS.otherUserName,
		extensions,
		segments,
		digits: 6
	});
	return { id: spec.id, own, summary, detail, gpx };
}

function waypoint(
	spec: CommonSpec & { icon: string; at: [lon: number, lat: number, ele: number] }
): Json {
	return { ...common(spec), icon: spec.icon, geometry: { type: 'Point', coordinates: spec.at } };
}

function area(
	spec: CommonSpec & { center: [lat: number, lon: number]; radius: number; n: number }
): Json {
	const [lat0, lon0] = spec.center;
	const ring: [number, number][] = [];
	for (let i = 0; i < spec.n; i++) {
		const a = (i / spec.n) * Math.PI * 2;
		const r = spec.radius * (1 + 0.25 * Math.sin(i * 2.1));
		ring.push([
			Math.round((lon0 + (Math.sin(a) * r) / Math.cos((lat0 * Math.PI) / 180)) * 1e6) / 1e6,
			Math.round((lat0 + Math.cos(a) * r) * 1e6) / 1e6
		]);
	}
	ring.push([ring[0]![0], ring[0]![1]]);
	// Shoelace on a local tangent plane.
	const mLat = 111_320;
	const mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
	let twice = 0;
	for (let i = 0; i + 1 < ring.length; i++) {
		const [x1, y1] = ring[i]!;
		const [x2, y2] = ring[i + 1]!;
		twice += x1 * mLon * (y2 * mLat) - x2 * mLon * (y1 * mLat);
	}
	return {
		...common(spec),
		area: Math.round(Math.abs(twice) / 2),
		geometry: { type: 'Polygon', coordinates: [ring] }
	};
}

interface PhotoSpecG extends CommonSpec {
	caption: string;
	takenDay: number | null;
	at: [lat: number, lon: number] | null;
	attached: { type: 'track' | 'route' | 'waypoint'; id: string } | null;
	mime: PhotoMime;
	size: number;
}

function photo(env: Env, spec: PhotoSpecG): GaiaPhoto {
	return {
		own: spec.own !== false,
		spec: { key: `gaia/${spec.id}/full`, size: spec.size, mime: spec.mime },
		json: {
			...common(spec),
			caption: spec.caption,
			taken_at:
				spec.takenDay === null
					? null
					: isoWithOffset(BASE_EPOCH + spec.takenDay * DAY + 977, spec.offsetMinutes),
			latitude: spec.at ? spec.at[0] : null,
			longitude: spec.at ? spec.at[1] : null,
			fullsize_url: `${env.cdnOrigin}/photos/${spec.id}/full`,
			attached_to: spec.attached
		}
	};
}

function savedHike(
	env: Env,
	id: string,
	trailIndex: number,
	annotations: {
		user_notes: string | null;
		completed_on: string | null;
		user_rating: number | null;
	}
): Json {
	const trail = PLATFORM_TRAILS[trailIndex]!;
	return {
		id,
		name: trail.name,
		url: `${env.origin}/hike/${id}`,
		trailhead: { latitude: trail.trailhead[0], longitude: trail.trailhead[1] },
		description: `${SENTINELS.trailDescription} (${trail.name})`,
		geometry: { type: 'LineString', coordinates: trail.geometry.map(([lat, lon]) => [lon, lat]) },
		...annotations
	};
}

interface FolderSpec {
	id: string;
	name: string;
	notes?: string;
	parent?: string | null;
	day: number;
	shared?: boolean;
	tracks?: string[];
	routes?: string[];
	waypoints?: string[];
	areas?: string[];
	saved_hikes?: Json[];
}

function folder(spec: FolderSpec): Json {
	const t = BASE_EPOCH + spec.day * DAY + 301;
	const shared = spec.shared === true;
	return {
		id: spec.id,
		name: spec.name,
		notes: shared ? SENTINELS.otherUserDescription : (spec.notes ?? ''),
		parent: spec.parent ?? null,
		time_created: isoWithOffset(t),
		updated_date: isoWithOffset(t + 5 * DAY + 86),
		user_id: shared ? OTHER_ID : ME_ID,
		user_email: shared ? SENTINELS.otherUserEmail : SENTINELS.email,
		shared_by: shared ? { name: SENTINELS.otherUserName, email: SENTINELS.otherUserEmail } : null,
		tracks: spec.tracks ?? [],
		routes: spec.routes ?? [],
		waypoints: spec.waypoints ?? [],
		areas: spec.areas ?? [],
		saved_hikes: spec.saved_hikes ?? []
	};
}

const ME: Json = {
	id: ME_ID,
	display_name: 'Test H.',
	email: SENTINELS.email,
	csrf_token: SENTINELS.csrfToken,
	units: 'imperial'
};

function finish(
	parts: Omit<GaiaData, 'expected' | 'objects' | 'me'>,
	collections: number
): GaiaData {
	const allPhotos = (): GaiaPhoto[] =>
		Array.from({ length: parts.photoCount }, (_, i) => parts.photoAt(i));
	const ownIds = (items: Json[]): string[] =>
		items.filter((o) => o.user_id === ME_ID).map((o) => String(o.id));
	return {
		me: ME,
		...parts,
		expected(): ExpectedArchive {
			const ids = {
				tracks: parts.tracks.filter((t) => t.own).map((t) => t.id),
				routes: parts.routes.filter((r) => r.own).map((r) => r.id),
				waypoints: ownIds(parts.waypoints),
				areas: ownIds(parts.areas),
				photos: ownIds(allPhotos().map((p) => p.json))
			};
			const references: ExpectedArchive['references'] = [];
			for (const f of parts.folders) {
				if (f.user_id !== ME_ID) continue;
				for (const hike of f.saved_hikes as Json[]) {
					if (references.some((r) => r.sourceId === hike.id)) continue;
					const th = hike.trailhead as { latitude: number; longitude: number };
					references.push({
						name: String(hike.name),
						url: String(hike.url),
						sourceId: String(hike.id),
						coordinate: [th.longitude, th.latitude]
					});
				}
			}
			return {
				account: { id: ME_ID, displayName: 'Test H.' },
				counts: {
					tracks: ids.tracks.length,
					routes: ids.routes.length,
					waypoints: ids.waypoints.length,
					areas: ids.areas.length,
					collections,
					photos: ids.photos.length
				},
				ids,
				references
			};
		},
		objects(): GaiaObjects {
			return {
				me: ME,
				tracks: parts.tracks.map(({ summary, detail }) => ({ summary, detail })),
				routes: parts.routes.map(({ summary, detail }) => ({ summary, detail })),
				waypoints: parts.waypoints,
				areas: parts.areas,
				photos: allPhotos().map((p) => p.json),
				folders: parts.folders
			};
		}
	};
}

function buildSmall(env: Env): GaiaData {
	const tracks = [
		buildLine('track', {
			id: 'gt-3001',
			title: NAMES.slashes,
			notes: 'Sunrise lap before work. Windy on top.',
			day: 0,
			tags: ['sierra', 'loop'],
			activities: ['hiking'],
			color: '#ff0000',
			start: [36.578581, -118.292288],
			segments: [180]
		}),
		buildLine('track', {
			id: 'gt-3002',
			title: NAMES.emoji,
			day: 3,
			activities: ['backpacking', 'hiking'],
			color: '#00aa55',
			start: [36.561204, -118.301977],
			segments: [64]
		}),
		buildLine('track', {
			id: 'gt-3003',
			title: NAMES.accents,
			notes: 'Déjeuner au col — très beau. <3 & "quotes"',
			day: 9,
			offsetMinutes: 120,
			public: true,
			tags: ['été'],
			activities: ['hiking'],
			start: [36.590115, -118.270843],
			segments: [240]
		}),
		buildLine('track', {
			id: 'gt-9001',
			title: 'Shared ridge run',
			own: false,
			day: 11,
			public: true,
			activities: ['trail-running'],
			start: [36.602331, -118.251092],
			segments: [48]
		}),
		buildLine('track', {
			id: 'gt-3004',
			title: NAMES.long,
			notes: 'Long day.',
			day: 15,
			activities: ['hiking'],
			color: '#3366ff',
			start: [36.553017, -118.313452],
			segments: [300]
		}),
		buildLine('track', {
			id: 'gt-3005',
			title: NAMES.duplicate,
			day: 20,
			activities: ['walking'],
			start: [36.571839, -118.288014],
			segments: [36]
		}),
		buildLine('track', {
			id: 'gt-3006',
			title: NAMES.duplicate,
			notes: 'Paused for dinner, so two segments.',
			day: 21,
			activities: ['walking'],
			start: [36.571902, -118.287655],
			segments: [42, 55]
		})
	];
	const routes = [
		buildLine('route', {
			id: 'gr-4001',
			title: 'Whitney Portal to Lone Pine Lake',
			notes: 'Planned for August.',
			day: 1,
			activities: ['hiking'],
			start: [36.586912, -118.240031],
			segments: [120]
		}),
		buildLine('route', {
			id: 'gr-4002',
			title: 'Plan B: Meysan Lakes?',
			day: 5,
			tags: ['plan-b'],
			activities: ['hiking'],
			start: [36.580127, -118.232945],
			segments: [75]
		}),
		buildLine('route', {
			id: 'gr-9002',
			title: 'Group route (shared)',
			own: false,
			day: 8,
			public: true,
			activities: ['hiking'],
			start: [36.610458, -118.262117],
			segments: [40]
		}),
		buildLine('route', {
			id: 'gr-4003',
			title: 'Übernachtung am See',
			notes: 'Two-day variant.',
			day: 12,
			offsetMinutes: 120,
			activities: ['backpacking'],
			start: [36.566341, -118.329876],
			segments: [210]
		}),
		buildLine('route', {
			id: 'gr-4004',
			title: 'Bike shuttle',
			day: 18,
			activities: ['mountain-biking'],
			start: [36.548823, -118.220764],
			segments: [33]
		})
	];
	const waypoints = [
		waypoint({
			id: 'gw-5001',
			title: 'Camp & water cache',
			notes: 'Flat spot, 3 tents max.',
			day: 1,
			tags: ['camp'],
			icon: 'campsite',
			at: [-118.291507, 36.577214, 3652.4]
		}),
		waypoint({
			id: 'gw-5002',
			title: 'Trailhead parking',
			day: 1,
			icon: 'car',
			at: [-118.239866, 36.586953, 2548.1]
		}),
		waypoint({
			id: 'gw-5003',
			title: 'Café du Lac ☕',
			notes: 'Open Thu–Sun.',
			day: 9,
			offsetMinutes: 120,
			icon: 'food',
			at: [-118.270412, 36.590633, 2710]
		}),
		waypoint({
			id: 'gw-5004',
			title: 'Trailhead parking',
			notes: 'Overflow lot.',
			day: 10,
			icon: 'car',
			at: [-118.241102, 36.585471, 2531.7]
		}),
		waypoint({
			id: 'gw-5005',
			title: 'Summit',
			day: 15,
			public: true,
			icon: 'peak',
			at: [-118.292301, 36.578402, 4418.9]
		})
	];
	const areas = [
		area({
			id: 'ga-6001',
			title: 'Closure zone 2024',
			notes: 'Per ranger station notice.',
			day: 2,
			center: [36.5642, -118.3105],
			radius: 0.004,
			n: 7
		}),
		area({
			id: 'ga-6002',
			title: 'Possible campsites',
			day: 14,
			tags: ['camp'],
			center: [36.5921, -118.2688],
			radius: 0.0015,
			n: 5
		})
	];
	const photos = [
		photo(env, {
			id: 'gp-7001',
			title: 'IMG_2041.JPG',
			notes: 'Alpenglow',
			day: 0,
			caption: 'Alpenglow from the ridge',
			takenDay: 0,
			at: [36.578944, -118.291873],
			attached: { type: 'track', id: 'gt-3001' },
			mime: 'image/jpeg',
			size: 48_213
		}),
		photo(env, {
			id: 'gp-7002',
			title: 'Screenshot: camp map',
			day: 1,
			caption: '',
			takenDay: 1,
			at: [36.577214, -118.291507],
			attached: { type: 'waypoint', id: 'gw-5001' },
			mime: 'image/png',
			size: 12_007
		}),
		photo(env, {
			id: 'gp-9003',
			title: 'Group shot',
			own: false,
			day: 11,
			public: true,
			caption: 'Everyone at the saddle',
			takenDay: 11,
			at: [36.602514, -118.250877],
			attached: { type: 'track', id: 'gt-9001' },
			mime: 'image/jpeg',
			size: 8_192
		}),
		photo(env, {
			id: 'gp-7003',
			title: 'IMG_2077.HEIC',
			day: 4,
			caption: 'Lake, planned lunch stop',
			takenDay: 4,
			at: [36.586733, -118.240289],
			attached: { type: 'route', id: 'gr-4001' },
			mime: 'image/heic',
			size: 30_500
		}),
		photo(env, {
			id: 'gp-7004',
			title: 'IMG_2102.JPG',
			day: 22,
			caption: 'No location, no timestamp',
			takenDay: null,
			at: null,
			attached: null,
			mime: 'image/jpeg',
			size: 9_999
		})
	];
	const folders = [
		folder({
			id: 'gf-8001',
			name: 'Sierra 2024',
			notes: 'Everything for the August trip.',
			day: 0,
			tracks: ['gt-3001', 'gt-3002'],
			routes: ['gr-4001'],
			waypoints: ['gw-5001', 'gw-5002'],
			areas: ['ga-6001']
		}),
		folder({
			id: 'gf-8002',
			name: 'Day 2 / côté est',
			parent: 'gf-8001',
			day: 2,
			tracks: ['gt-3001', 'gt-3003'],
			routes: ['gr-4003'],
			waypoints: ['gw-5003']
		}),
		folder({
			id: 'gf-8003',
			name: 'Wishlist',
			day: 6,
			tracks: ['gt-9001'],
			saved_hikes: [
				savedHike(env, 'gh-2101', 0, {
					user_notes: 'Start before 7am; bring 3L of water.',
					completed_on: isoDate(BASE_EPOCH + 30 * DAY),
					user_rating: 5
				}),
				savedHike(env, 'gh-2102', 1, { user_notes: null, completed_on: null, user_rating: null })
			]
		}),
		folder({
			id: 'gf-9004',
			name: 'Club outings',
			shared: true,
			day: 8,
			tracks: ['gt-9001'],
			routes: ['gr-9002']
		})
	];
	const byId = new Map(photos.map((p) => [String(p.json.id), p]));
	return finish(
		{
			tracks,
			routes,
			waypoints,
			areas,
			folders,
			photoCount: photos.length,
			photoAt: (i) => photos[i]!,
			photoById: (id) => byId.get(id)
		},
		4
	);
}

const LARGE_PHOTO_BASE = 1_000_001;

function buildLarge(env: Env, ds: ResolvedDataset): GaiaData {
	const tracks = [
		buildLine('track', {
			id: 'gt-3001',
			title: 'Big trip, day 1',
			notes: 'Lots of photos.',
			day: 0,
			activities: ['hiking'],
			start: [36.578581, -118.292288],
			segments: [200]
		}),
		buildLine('track', {
			id: 'gt-3002',
			title: 'Big trip, day 2',
			day: 1,
			activities: ['hiking'],
			start: [36.561204, -118.301977],
			segments: [150, 90]
		})
	];
	const photoAt = (i: number): GaiaPhoto => {
		const id = `gp-${LARGE_PHOTO_BASE + i}`;
		return photo(env, {
			id,
			title: `IMG_${String(i + 1).padStart(5, '0')}.JPG`,
			day: i % 2,
			caption: '',
			takenDay: i % 2,
			at: [
				Math.round((36.56 + ((i * 37) % 4000) / 1e5) * 1e6) / 1e6,
				Math.round((-118.31 + ((i * 53) % 4000) / 1e5) * 1e6) / 1e6
			],
			attached: i % 3 === 2 ? null : { type: 'track', id: i % 3 === 0 ? 'gt-3001' : 'gt-3002' },
			mime: 'image/jpeg',
			size: ds.photoBytes
		});
	};
	return finish(
		{
			tracks,
			routes: [],
			waypoints: [],
			areas: [],
			folders: [],
			photoCount: ds.photos,
			photoAt,
			photoById: (id) => {
				const m = /^gp-(\d+)$/.exec(id);
				if (!m) return undefined;
				const i = Number(m[1]) - LARGE_PHOTO_BASE;
				return i >= 0 && i < ds.photos ? photoAt(i) : undefined;
			}
		},
		0
	);
}

export function buildGaia(env: Env, ds: ResolvedDataset): GaiaData {
	return ds.kind === 'large' ? buildLarge(env, ds) : buildSmall(env);
}

// ---------------------------------------------------------------------------------------------

const NOT_FOUND = json(404, { detail: 'Not found.' });

function listing(
	env: Env,
	ds: ResolvedDataset,
	req: ApiRequest,
	count: number,
	at: (index: number) => Json
): Reply {
	const page = parseIntParam(req.query.get('page'), 1);
	const requested = parseIntParam(req.query.get('page_size'), 50);
	if (!Number.isFinite(page) || page < 1) return json(404, { detail: 'Invalid page.' });
	const size = Math.min(
		Number.isFinite(requested) && requested >= 1 ? requested : 50,
		ds.maxPageSize
	);
	const pages = Math.max(1, Math.ceil(count / size));
	if (page > pages) return json(404, { detail: 'Invalid page.' });
	const start = (page - 1) * size;
	const results: Json[] = [];
	for (let i = start; i < Math.min(start + size, count); i++) results.push(at(i));
	const link = (p: number): string => `${env.origin}${req.path}?page=${p}&page_size=${size}`;
	return {
		kind: 'json',
		status: 200,
		listingKey: 'results',
		body: {
			count,
			next: page < pages ? link(page + 1) : null,
			previous: page > 1 ? link(page - 1) : null,
			results
		}
	};
}

/** Authenticated `/api/v3/*` requests. */
export function handleGaiaApi(
	data: GaiaData,
	env: Env,
	ds: ResolvedDataset,
	req: ApiRequest
): Reply {
	if (req.method !== 'GET' && req.method !== 'HEAD')
		return json(405, { detail: 'Method not allowed.' });
	const rest = req.path.slice('/api/v3/'.length);
	if (rest === 'me/' || rest === 'me') return json(200, data.me);

	const gpx = /^(track|route)\/([^/]+)\.gpx$/.exec(rest);
	if (gpx) {
		const line = (gpx[1] === 'track' ? data.tracks : data.routes).find((l) => l.id === gpx[2]);
		if (!line) return NOT_FOUND;
		return { kind: 'bytes', status: 200, contentType: 'application/gpx+xml', body: line.gpx };
	}

	const m = /^(track|route|waypoint|area|photo|folder)(?:\/([^/]+))?\/?$/.exec(rest);
	if (!m) return NOT_FOUND;
	const type = m[1]!;
	const id = m[2];
	if (type === 'track' || type === 'route') {
		const lines = type === 'track' ? data.tracks : data.routes;
		if (id === undefined) return listing(env, ds, req, lines.length, (i) => lines[i]!.summary);
		const line = lines.find((l) => l.id === id);
		return line ? json(200, line.detail) : NOT_FOUND;
	}
	if (type === 'photo') {
		if (id === undefined)
			return listing(env, ds, req, data.photoCount, (i) => data.photoAt(i).json);
		const p = data.photoById(id);
		return p ? json(200, p.json) : NOT_FOUND;
	}
	const items = type === 'waypoint' ? data.waypoints : type === 'area' ? data.areas : data.folders;
	if (id === undefined) return listing(env, ds, req, items.length, (i) => items[i]!);
	const item = items.find((o) => o.id === id);
	return item ? json(200, item) : NOT_FOUND;
}

/** CDN host: `/photos/<id>/full`. */
export function handleGaiaCdn(data: GaiaData, path: string): Reply | null {
	const m = /^\/photos\/([^/]+)\/full$/.exec(path);
	if (!m) return null;
	const p = data.photoById(m[1]!);
	return p ? { kind: 'photo', spec: p.spec } : null;
}
