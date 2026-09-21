/**
 * Gaia-GPS-shaped dataset + API. Shapes follow docs/phase0-findings.md: unpaginated
 * `/api/objects/<type>/` listings, GeoJSON details, `/api/v3/user/` for the account.
 */
import {
	BASE_EPOCH,
	DAY,
	NAMES,
	isoUtc,
	lineStats,
	makeLine,
	type Env,
	type Pt,
	type ResolvedDataset
} from './dataset.ts';
import { buildGpx } from './gpx.ts';
import type { PhotoMime, PhotoSpec } from './photos.ts';
import { json, type ApiRequest, type Reply } from './reply.ts';
import { SENTINELS } from './sentinels.ts';
import type { ExpectedArchive, GaiaObjects, Json } from './types.ts';

const ME_ID = 1001;
const OTHER_ID = 2002;
const ME_NAME = 'Test H.';
const GPX_NS = { prefix: 'gaia', uri: 'https://www.gaiagps.com/gpx/extensions/1' };
const CREATOR = 'GaiaGPS';

/** A listed object: what the listing shows, what the detail endpoint returns, and who owns it. */
export interface GaiaItem {
	id: string;
	own: boolean;
	deleted: boolean;
	summary: Json;
	detail: Json;
}

export interface GaiaLine extends GaiaItem {
	gpx: Buffer;
}

export interface GaiaPhoto extends GaiaItem {
	spec: PhotoSpec;
}

export interface GaiaData {
	me: Json;
	tracks: GaiaLine[];
	routes: GaiaLine[];
	waypoints: GaiaItem[];
	areas: GaiaItem[];
	folders: GaiaItem[];
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
	deleted?: boolean;
	/** Days after BASE_EPOCH. */
	day: number;
	public?: boolean;
}

function created(spec: { day: number }): number {
	return BASE_EPOCH + spec.day * DAY + (spec.day % 7) * 1733;
}

/** `2024-06-05T15:26:30.000000` — microseconds and no zone, as the real listings have it. */
function serverStamp(epochSeconds: number): string {
	return `${isoUtc(epochSeconds).slice(0, 19)}.000000`;
}

function slug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'untitled'
	);
}

/** Fields every listed object carries. Listings say nothing about who owns the object. */
function common(spec: CommonSpec): Json {
	const own = spec.own !== false;
	const t = created(spec);
	return {
		id: spec.id,
		updated_date: isoUtc(t + 3 * DAY + 4521),
		time_created: isoUtc(t),
		last_updated_on_server: serverStamp(t + 3 * DAY + 4530),
		deleted: spec.deleted === true,
		title: spec.title,
		notes: own ? (spec.notes ?? '') : SENTINELS.otherUserDescription,
		public: spec.public ?? false,
		folder: '',
		folder_name: '',
		path: slug(spec.title),
		sync_to_mobile: null
	};
}

/** The owner block on detail responses: all of it is personal data that must not be archived. */
function owner(env: Env, own: boolean): Json {
	const id = own ? ME_ID : OTHER_ID;
	const name = own ? ME_NAME : SENTINELS.otherUserName;
	return {
		user_displayname: name,
		username: own ? SENTINELS.email : SENTINELS.otherUserEmail,
		user_email: own ? SENTINELS.email : SENTINELS.otherUserEmail,
		user_id: id,
		created_by: {
			id,
			displayName: name,
			link: `/profile/${id}/`,
			image: `${env.origin}/profile/${id}/image/`
		},
		writable: own
	};
}

interface LineSpecG extends CommonSpec {
	activities: string[];
	color?: string;
	source?: string | null;
	start: [number, number];
	segments: number[];
}

function buildLine(env: Env, kind: 'track' | 'route', spec: LineSpecG): GaiaLine {
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
	const color = spec.color ?? '#ff5a00';
	const summary: Json = {
		...common(spec),
		distance: stats.distance,
		total_ascent: stats.ascent,
		total_time: kind === 'track' ? stats.duration : 0,
		activities: spec.activities,
		privacy_level: null,
		source: spec.source === undefined ? (kind === 'track' ? 'iPhone X' : '') : spec.source
	};
	const { folder: _folder, folder_name: _folderName, path: _path, ...listed } = summary;
	const feature: Json = {
		type: 'Feature',
		id: spec.id,
		properties: {
			...listed,
			db_insert_date: isoUtc(t + 60),
			color,
			hexcolor: color,
			is_active: true,
			revision: 7,
			track_type: kind === 'track' ? '' : 'route',
			routing_mode: kind === 'track' ? null : 'snap-hiking',
			cover_photo_id: null,
			total_descent: stats.ascent,
			folder: null,
			preferred_link: `/datasummary/${kind}/${spec.id}/`,
			...owner(env, own),
			latitude: first.lat,
			longitude: first.lon
		},
		style: { stroke: color },
		geometry: {
			type: 'MultiLineString',
			// Routes carry a zero where tracks carry epoch seconds.
			coordinates: segments.map((seg) =>
				seg.map((p) => [p.lon, p.lat, p.ele, kind === 'track' ? p.time : 0])
			)
		}
	};
	const detail: Json = { type: 'FeatureCollection', id: spec.id, features: [feature] };
	const extensions: [string, string][] = [['color', color]];
	const gpx = buildGpx({
		creator: CREATOR,
		ns: GPX_NS,
		kind: kind === 'track' ? 'trk' : 'rte',
		name: spec.title,
		desc: own ? spec.notes : SENTINELS.otherUserDescription,
		time: t,
		extensions,
		segments,
		digits: 6
	});
	return { id: spec.id, own, deleted: spec.deleted === true, summary, detail, gpx };
}

function waypoint(
	env: Env,
	spec: CommonSpec & { icon: string; at: [lon: number, lat: number, ele: number | null] }
): GaiaItem {
	const own = spec.own !== false;
	const [lon, lat, ele] = spec.at;
	const marker = { marker_type: 'pin', marker_color: '#2d5bff', marker_decoration: null };
	const summary: Json = {
		...common(spec),
		icon: spec.icon,
		...marker,
		// One-element arrays: that is what the real listing returns.
		latitude: [lat],
		longitude: [lon],
		cover_photo_id: null
	};
	const detail: Json = {
		type: 'Feature',
		id: spec.id,
		geometry: { type: 'Point', coordinates: [lon, lat] },
		properties: {
			id: spec.id,
			updated_date: summary.updated_date,
			time_created: summary.time_created,
			deleted: summary.deleted,
			title: spec.title,
			public: summary.public,
			is_active: true,
			icon: spec.icon,
			revision: 3,
			notes: summary.notes,
			latitude: lat,
			longitude: lon,
			elevation: ele,
			track_id: '',
			folder: null,
			...marker,
			photos: [],
			created_by: owner(env, own).created_by,
			writable: own
		}
	};
	return { id: spec.id, own, deleted: spec.deleted === true, summary, detail };
}

/**
 * An area is a track-shaped object whose geometry is a polygon: the listing has the line fields
 * (all zero) and no size, the detail is a FeatureCollection like a track's.
 */
function area(
	env: Env,
	spec: CommonSpec & { center: [lat: number, lon: number]; radius: number; n: number }
): GaiaItem {
	const own = spec.own !== false;
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
	const summary: Json = {
		...common(spec),
		distance: 0,
		total_ascent: 0,
		total_time: 0,
		activities: [],
		privacy_level: 'private',
		source: null
	};
	const { folder: _folder, folder_name: _folderName, path: _path, ...listed } = summary;
	const feature: Json = {
		type: 'Feature',
		id: spec.id,
		properties: {
			...listed,
			color: '#ff5a00',
			hexcolor: '#ff5a00',
			track_type: 'polygon',
			routing_mode: null,
			preferred_link: `/public/${spec.id}`,
			...owner(env, own)
		},
		style: { stroke: '#ff5a00' },
		// Three numbers per vertex, the last one an elevation.
		geometry: { type: 'Polygon', coordinates: [ring.map(([lon, lat]) => [lon, lat, 0])] }
	};
	const detail: Json = { type: 'FeatureCollection', id: spec.id, features: [feature] };
	return { id: spec.id, own, deleted: spec.deleted === true, summary, detail };
}

interface PhotoSpecG extends CommonSpec {
	/** Every Gaia photo hangs off a waypoint. */
	waypoint: { id: string; name: string; at: [lat: number, lon: number] };
	mime: PhotoMime;
	size: number;
}

function photo(env: Env, spec: PhotoSpecG): GaiaPhoto {
	const image = (size: string): string =>
		`${env.origin}/api/objects/photo/${spec.id}/image/${size}/`;
	const summary: Json = {
		...common(spec),
		thumbnail: image('100'),
		scaled: image('1000'),
		waypoint_id: spec.waypoint.id,
		waypoint_name: spec.waypoint.name
	};
	const detail: Json = {
		type: 'Feature',
		id: spec.id,
		geometry: { type: 'Point', coordinates: [spec.waypoint.at[1], spec.waypoint.at[0]] },
		properties: {
			id: spec.id,
			updated_date: summary.updated_date,
			time_created: summary.time_created,
			deleted: summary.deleted,
			title: spec.title,
			revision: 1,
			notes: summary.notes,
			elevation: 0,
			waypoint_id: spec.waypoint.id,
			thumbnail_url: image('100'),
			web_url: image('500'),
			scaled_url: image('1000'),
			fullsize_url: image('full')
		}
	};
	return {
		id: spec.id,
		own: true,
		deleted: spec.deleted === true,
		summary,
		detail,
		spec: { key: `gaia/${spec.id}/full`, size: spec.size, mime: spec.mime }
	};
}

interface FolderSpec {
	id: string;
	name: string;
	notes?: string;
	parent?: string | null;
	children?: string[];
	day: number;
	shared?: boolean;
	deleted?: boolean;
	tracks?: string[];
	routes?: string[];
	waypoints?: string[];
	areas?: string[];
}

function folder(spec: FolderSpec): GaiaItem {
	const t = BASE_EPOCH + spec.day * DAY + 301;
	const shared = spec.shared === true;
	const notes = shared ? SENTINELS.otherUserDescription : (spec.notes ?? '');
	const members = {
		tracks: spec.tracks ?? [],
		routes: spec.routes ?? [],
		areas: spec.areas ?? [],
		waypoints: spec.waypoints ?? []
	};
	const summary: Json = {
		id: spec.id,
		updated_date: isoUtc(t + 5 * DAY + 86),
		time_created: isoUtc(t),
		last_updated_on_server: serverStamp(t + 5 * DAY + 90),
		deleted: spec.deleted === true,
		title: spec.name,
		public: false,
		revision: 4,
		notes,
		...members,
		maps: [],
		mapSources: [],
		children: spec.children ?? [],
		date_group: '',
		cover_photo_id: null,
		path: slug(spec.name),
		imported: null,
		folder: null,
		is_shared: shared,
		access: shared ? 'read' : 'owner',
		sync_to_mobile: null,
		preferred_link: `/datasummary/folder/${spec.id}/`,
		parent: spec.parent ?? null,
		folder_name: null,
		writable: !shared
	};
	const stub = (id: string): Json => ({ id, title: id, deleted: false, public: false });
	const detail: Json = {
		type: 'FeatureCollection',
		id: spec.id,
		properties: {
			id: spec.id,
			// `name` here, `title` in the listing — as on the real API.
			name: spec.name,
			updated_date: summary.updated_date,
			time_created: summary.time_created,
			notes,
			deleted: summary.deleted,
			public: false,
			tracks: members.tracks.map(stub),
			routes: members.routes.map(stub),
			areas: members.areas.map(stub),
			waypoints: members.waypoints.map(stub),
			maps: [],
			mapSources: [],
			folders: (spec.children ?? []).map(stub),
			trackstats: {}
		},
		features: []
	};
	return { id: spec.id, own: !shared, deleted: spec.deleted === true, summary, detail };
}

const ME: Json = {
	id: ME_ID,
	display_name: ME_NAME,
	username: SENTINELS.email,
	email: SENTINELS.email,
	first_name: 'Test',
	last_name: 'Hiker',
	is_authenticated: true,
	distance_units: 'imperial',
	didomi_auth: { id: 'didomi-1001', algorithm: 'hmac-sha256', digest: SENTINELS.csrfToken }
};

/** What `/api/v3/user/` answers without a session: 200, not an error. */
export const GAIA_ANONYMOUS_USER: Json = { id: null, display_name: '', is_authenticated: false };

function finish(
	env: Env,
	parts: Omit<GaiaData, 'expected' | 'objects' | 'me'>,
	collections: number
): GaiaData {
	const allPhotos = (): GaiaPhoto[] =>
		Array.from({ length: parts.photoCount }, (_, i) => parts.photoAt(i));
	const exported = (items: GaiaItem[]): string[] =>
		items.filter((item) => item.own && !item.deleted).map((item) => item.id);
	const pair = ({ summary, detail }: GaiaItem) => ({ summary, detail });
	return {
		me: ME,
		...parts,
		expected(): ExpectedArchive {
			const ids = {
				tracks: exported(parts.tracks),
				routes: exported(parts.routes),
				waypoints: exported(parts.waypoints),
				areas: exported(parts.areas),
				photos: exported(allPhotos())
			};
			// Other users' lines filed in one of my folders: they come out as references.
			const references: ExpectedArchive['references'] = [];
			for (const kind of ['track', 'route'] as const) {
				const lines = kind === 'track' ? parts.tracks : parts.routes;
				const key = kind === 'track' ? 'tracks' : 'routes';
				for (const line of lines.filter((l) => !l.own && !l.deleted)) {
					const filed = parts.folders.some(
						(f) => f.own && !f.deleted && (f.summary[key] as string[]).includes(line.id)
					);
					if (!filed) continue;
					const properties = (line.detail.features as Json[])[0]!.properties as Json;
					references.push({
						name: String(line.summary.title),
						url: `${env.origin}/datasummary/${kind}/${line.id}/`,
						sourceId: line.id,
						coordinate: [Number(properties.longitude), Number(properties.latitude)]
					});
				}
			}
			return {
				account: { id: String(ME_ID), displayName: ME_NAME },
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
				tracks: parts.tracks.map(pair),
				routes: parts.routes.map(pair),
				waypoints: parts.waypoints.map(pair),
				areas: parts.areas.map(pair),
				photos: allPhotos().map(pair),
				folders: parts.folders.map(pair)
			};
		}
	};
}

function buildSmall(env: Env): GaiaData {
	const tracks = [
		buildLine(env, 'track', {
			id: 'gt-3001',
			title: NAMES.slashes,
			notes: 'Sunrise lap before work. Windy on top.',
			day: 0,
			activities: ['hiking'],
			color: '#ff0000',
			start: [36.578581, -118.292288],
			segments: [180]
		}),
		buildLine(env, 'track', {
			id: 'gt-3002',
			title: NAMES.emoji,
			day: 3,
			activities: ['backpacking', 'hiking'],
			color: '#00aa55',
			start: [36.561204, -118.301977],
			segments: [64]
		}),
		buildLine(env, 'track', {
			id: 'gt-3003',
			title: NAMES.accents,
			notes: 'Déjeuner au col — très beau. <3 & "quotes"',
			day: 9,
			public: true,
			activities: ['hiking'],
			start: [36.590115, -118.270843],
			segments: [240]
		}),
		buildLine(env, 'track', {
			id: 'gt-9001',
			title: 'Shared ridge run',
			own: false,
			day: 11,
			public: true,
			activities: ['trail-running'],
			start: [36.602331, -118.251092],
			segments: [48]
		}),
		buildLine(env, 'track', {
			id: 'gt-3004',
			title: NAMES.long,
			notes: 'Long day.',
			day: 15,
			activities: ['hiking'],
			color: '#3366ff',
			start: [36.553017, -118.313452],
			segments: [300]
		}),
		buildLine(env, 'track', {
			id: 'gt-3005',
			title: NAMES.duplicate,
			day: 20,
			activities: ['walking'],
			start: [36.571839, -118.288014],
			segments: [36]
		}),
		buildLine(env, 'track', {
			id: 'gt-3006',
			title: NAMES.duplicate,
			notes: 'Paused for dinner, so two segments.',
			day: 21,
			activities: ['walking'],
			start: [36.571902, -118.287655],
			segments: [42, 55]
		}),
		buildLine(env, 'track', {
			id: 'gt-3900',
			title: 'Deleted track',
			deleted: true,
			day: 23,
			activities: [],
			source: null,
			start: [36.571902, -118.287655],
			segments: [12]
		})
	];
	const routes = [
		buildLine(env, 'route', {
			id: 'gr-4001',
			title: 'Whitney Portal to Lone Pine Lake',
			notes: 'Planned for August.',
			day: 1,
			activities: ['hiking'],
			start: [36.586912, -118.240031],
			segments: [120]
		}),
		buildLine(env, 'route', {
			id: 'gr-4002',
			title: 'Plan B: Meysan Lakes?',
			day: 5,
			activities: ['hiking'],
			start: [36.580127, -118.232945],
			segments: [75]
		}),
		buildLine(env, 'route', {
			id: 'gr-9002',
			title: 'Group route (shared)',
			own: false,
			day: 8,
			public: true,
			activities: ['hiking'],
			start: [36.610458, -118.262117],
			segments: [40]
		}),
		buildLine(env, 'route', {
			id: 'gr-4003',
			title: 'Übernachtung am See',
			notes: 'Two-day variant.',
			day: 12,
			activities: ['backpacking'],
			start: [36.566341, -118.329876],
			segments: [210]
		}),
		buildLine(env, 'route', {
			id: 'gr-4004',
			title: 'Bike shuttle',
			day: 18,
			activities: ['mountain-biking'],
			start: [36.548823, -118.220764],
			segments: [33]
		})
	];
	const waypoints = [
		waypoint(env, {
			id: 'gw-5001',
			title: 'Camp & water cache',
			notes: 'Flat spot, 3 tents max.',
			day: 1,
			icon: 'campsite',
			at: [-118.291507, 36.577214, 3652.4]
		}),
		waypoint(env, {
			id: 'gw-5002',
			title: 'Trailhead parking',
			day: 1,
			icon: 'car',
			at: [-118.239866, 36.586953, 2548.1]
		}),
		waypoint(env, {
			id: 'gw-5003',
			title: 'Café du Lac ☕',
			notes: 'Open Thu–Sun.',
			day: 9,
			icon: 'food',
			at: [-118.270412, 36.590633, 2710]
		}),
		waypoint(env, {
			id: 'gw-5004',
			title: 'Trailhead parking',
			notes: 'Overflow lot.',
			day: 10,
			icon: 'car',
			at: [-118.241102, 36.585471, 2531.7]
		}),
		waypoint(env, {
			id: 'gw-5005',
			title: 'Summit',
			day: 15,
			public: true,
			icon: 'peak',
			at: [-118.292301, 36.578402, 4418.9]
		}),
		waypoint(env, {
			id: 'gw-5900',
			title: 'Old photo spot',
			deleted: true,
			day: 22,
			icon: '',
			at: [-118.288014, 36.571839, null]
		})
	];
	const areas = [
		area(env, {
			id: 'ga-6001',
			title: 'Closure zone 2024',
			notes: 'Per ranger station notice.',
			day: 2,
			center: [36.5642, -118.3105],
			radius: 0.004,
			n: 7
		}),
		area(env, {
			id: 'ga-6002',
			title: 'Possible campsites',
			day: 14,
			center: [36.5921, -118.2688],
			radius: 0.0015,
			n: 5
		})
	];
	const at = (id: string): PhotoSpecG['waypoint'] => {
		const found = waypoints.find((w) => w.id === id)!;
		const [lon, lat] = (found.detail.geometry as { coordinates: [number, number] }).coordinates;
		return { id, name: String(found.summary.title), at: [lat, lon] };
	};
	const photos = [
		photo(env, {
			id: 'gp-7001',
			title: 'IMG_2041.JPG',
			notes: 'Alpenglow from the ridge',
			day: 0,
			waypoint: at('gw-5005'),
			mime: 'image/jpeg',
			size: 48_213
		}),
		photo(env, {
			id: 'gp-7002',
			title: 'Screenshot: camp map',
			day: 1,
			waypoint: at('gw-5001'),
			mime: 'image/png',
			size: 12_007
		}),
		photo(env, {
			id: 'gp-7900',
			title: 'Deleted photo',
			deleted: true,
			day: 2,
			waypoint: at('gw-5001'),
			mime: 'image/jpeg',
			size: 5_000
		}),
		photo(env, {
			id: 'gp-7003',
			title: 'IMG_2077.HEIC',
			notes: 'Lake, planned lunch stop',
			day: 4,
			waypoint: at('gw-5003'),
			mime: 'image/heic',
			size: 30_500
		}),
		// Hangs off a waypoint that has since been deleted: no place to attach it to.
		photo(env, {
			id: 'gp-7004',
			title: 'IMG_2102.JPG',
			day: 22,
			waypoint: at('gw-5900'),
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
			children: ['gf-8002'],
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
		folder({ id: 'gf-8900', name: 'Deleted folder', deleted: true, day: 4, tracks: ['gt-3004'] }),
		// Holds another user's track next to nothing else: it must come out as a reference.
		folder({ id: 'gf-8003', name: 'Wishlist', day: 6, tracks: ['gt-9001'] }),
		folder({
			id: 'gf-9004',
			name: 'Club outings',
			shared: true,
			day: 8,
			tracks: ['gt-9001'],
			routes: ['gr-9002']
		})
	];
	const byId = new Map(photos.map((p) => [p.id, p]));
	return finish(
		env,
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
		buildLine(env, 'track', {
			id: 'gt-3001',
			title: 'Big trip, day 1',
			notes: 'Lots of photos.',
			day: 0,
			activities: ['hiking'],
			start: [36.578581, -118.292288],
			segments: [200]
		}),
		buildLine(env, 'track', {
			id: 'gt-3002',
			title: 'Big trip, day 2',
			day: 1,
			activities: ['hiking'],
			start: [36.561204, -118.301977],
			segments: [150, 90]
		})
	];
	const waypoints = [
		waypoint(env, {
			id: 'gw-5001',
			title: 'Camp one',
			day: 0,
			icon: 'campsite',
			at: [-118.291507, 36.577214, 3652.4]
		}),
		waypoint(env, {
			id: 'gw-5002',
			title: 'Camp two',
			day: 1,
			icon: 'campsite',
			at: [-118.301977, 36.561204, 3301.2]
		})
	];
	const photoAt = (i: number): GaiaPhoto => {
		const id = `gp-${LARGE_PHOTO_BASE + i}`;
		const camp = i % 2 === 0 ? 'Camp one' : 'Camp two';
		return photo(env, {
			id,
			title: `IMG_${String(i + 1).padStart(5, '0')}.JPG`,
			day: i % 2,
			waypoint: {
				id: i % 2 === 0 ? 'gw-5001' : 'gw-5002',
				name: camp,
				at: i % 2 === 0 ? [36.577214, -118.291507] : [36.561204, -118.301977]
			},
			mime: 'image/jpeg',
			size: ds.photoBytes
		});
	};
	return finish(
		env,
		{
			tracks,
			routes: [],
			waypoints,
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

/** The whole collection as one bare array — the real API does not paginate. */
function listing(items: Json[]): Reply {
	return { kind: 'json', status: 200, body: items, listing: true };
}

/** Authenticated `/api/*` requests. */
export function handleGaiaApi(data: GaiaData, req: ApiRequest): Reply {
	if (req.method !== 'GET' && req.method !== 'HEAD')
		return json(405, { detail: 'Method not allowed.' });
	if (req.path === '/api/v3/user/') return json(200, data.me);
	if (!req.path.startsWith('/api/objects/')) return NOT_FOUND;
	const rest = req.path.slice('/api/objects/'.length);

	const gpx = /^(track|route)\/([^/]+)\.gpx\/?$/.exec(rest);
	if (gpx) {
		const line = (gpx[1] === 'track' ? data.tracks : data.routes).find((l) => l.id === gpx[2]);
		if (!line) return NOT_FOUND;
		return { kind: 'bytes', status: 200, contentType: 'application/gpx+xml', body: line.gpx };
	}

	const m = /^(track|route|waypoint|area|photo|folder)\/(?:([^/]+)\/)?$/.exec(rest);
	if (!m) return NOT_FOUND;
	const type = m[1]!;
	const id = m[2];
	if (type === 'photo') {
		if (id === undefined)
			return listing(Array.from({ length: data.photoCount }, (_, i) => data.photoAt(i).summary));
		const found = data.photoById(id);
		return found ? json(200, found.detail) : NOT_FOUND;
	}
	const items: GaiaItem[] = {
		track: data.tracks,
		route: data.routes,
		waypoint: data.waypoints,
		area: data.areas,
		folder: data.folders
	}[type]!;
	if (id === undefined) return listing(items.map((item) => item.summary));
	const item = items.find((o) => o.id === id);
	return item ? json(200, item.detail) : NOT_FOUND;
}

/**
 * `/api/objects/photo/<id>/image/<size>/` on the site host: answers without a session and
 * redirects to a signed, short-lived URL on the photo host.
 */
export function gaiaPhotoRedirect(data: GaiaData, env: Env, path: string): string | null {
	const m = /^\/api\/objects\/photo\/([^/]+)\/image\/[^/]+\/$/.exec(path);
	if (!m || !data.photoById(m[1]!)) return null;
	return `${env.cdnOrigin}/photos/${m[1]!}/full?Expires=1790106526&Signature=${SENTINELS.photoSignature}`;
}

/** Photo host: `/photos/<id>/full`. */
export function handleGaiaCdn(data: GaiaData, path: string): Reply | null {
	const m = /^\/photos\/([^/]+)\/full$/.exec(path);
	if (!m) return null;
	const p = data.photoById(m[1]!);
	return p ? { kind: 'photo', spec: p.spec } : null;
}
