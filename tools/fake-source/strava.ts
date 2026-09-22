/**
 * Strava-shaped dataset + API. Shapes follow docs/phase0-findings.md: JSON listings that answer
 * with the HTML page unless the request carries `X-Requested-With`, activities paged with
 * `page=`/`per_page=` (capped at 20), photos paged with `cursor=`, streams as parallel arrays,
 * GPX exports served as `application/octet-stream`, and the routes list behind a POST that
 * needs a CSRF token minted — for the current session only — by another POST.
 */
import {
	BASE_EPOCH,
	DAY,
	NAMES,
	PLATFORM_TRAILS,
	fnv1a,
	isoUtc,
	lineStats,
	makeLine,
	type Env,
	type Pt,
	type ResolvedDataset
} from './dataset.ts';
import { buildGpx, xmlEscape } from './gpx.ts';
import type { PhotoSpec } from './photos.ts';
import { parseIntParam, type ApiRequest, type Reply } from './reply.ts';
import { SENTINELS } from './sentinels.ts';
import type { ExpectedArchive, Json, StravaObjects } from './types.ts';

const ME_ID = 3001;
const OTHER_ID = 3999;
/** The activity and photo listings never return more than this, whatever is asked for. */
const PER_PAGE_CAP = 20;
const GPX_NS = {
	prefix: 'gpxtpx',
	uri: 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1'
};
const MINT_PATH = '/api/next/mint-csrf-token';
const ROUTES_PATH = '/api/next/data/routes/my-routes';

/** The one CSRF token the current session accepts. Signed out, the mint hands out a dud. */
export function stravaCsrfToken(generation: number | null): string {
	return `${SENTINELS.csrfToken}-${generation === null ? 'anonymous' : `s${generation}`}`;
}

export interface StravaActivityObject {
	id: string;
	summary: Json;
	/** Every stream the activity has; a request gets the ones it names. */
	streams: Record<string, unknown[]>;
	/** Native GPX export; null for an indoor activity, whose export bounces to the dashboard. */
	gpx: Buffer | null;
}

export interface StravaRouteObject {
	id: string;
	own: boolean;
	node: Json;
	gpx: Buffer;
}

export interface StravaPhotoObject {
	item: Json;
	isVideo: boolean;
	/** Path of the `large` rendition on the photo host. */
	path: string;
	spec: PhotoSpec;
}

export interface StravaData {
	me: Json;
	activities: StravaActivityObject[];
	routes: StravaRouteObject[];
	photos: StravaPhotoObject[];
	expected(): ExpectedArchive;
	objects(): StravaObjects;
}

function hex(seed: string, length: number): string {
	let out = '';
	for (let i = 0; out.length < length; i++)
		out += fnv1a(`${seed}:${i}`).toString(16).padStart(8, '0');
	return out.slice(0, length);
}

function uuid(seed: string): string {
	const h = hex(seed, 32);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `2024-06-02T14:11:09+0000`: UTC, with an offset RFC 3339 does not allow. */
function stravaTime(epochSeconds: number): string {
	return isoUtc(epochSeconds).replace('Z', '+0000');
}

function clock(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
	const s = String(Math.floor(seconds % 60)).padStart(2, '0');
	return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

interface ActivitySpec {
	id: number;
	name: string;
	description?: string;
	day: number;
	sport: string;
	visibility: 'everyone' | 'only_me' | 'followers_only';
	/** Omitted: an indoor session with no GPS. */
	start?: [number, number];
	points?: number;
}

function buildActivity(env: Env, spec: ActivitySpec): StravaActivityObject {
	const startEpoch = BASE_EPOCH + spec.day * DAY + (spec.day % 7) * 1733;
	const id = String(spec.id);
	const segments: Pt[][] = spec.start
		? makeLine({
				seed: `strava:${spec.id}`,
				start: spec.start,
				segments: [spec.points ?? 80],
				digits: 6,
				startTime: startEpoch
			})
		: [];
	const points = segments.flat();
	const stats = lineStats(segments);
	const elapsed = spec.start ? stats.duration : 45 * 60;
	const distances: number[] = [];
	let travelled = 0;
	for (const [i, p] of points.entries()) {
		if (i > 0) travelled += lineStats([[points[i - 1]!, p]]).distance;
		distances.push(Math.round(travelled * 10) / 10);
	}
	const summary: Json = {
		id: spec.id,
		id_str: id,
		name: spec.name,
		sport_type: spec.sport,
		display_type: spec.sport,
		activity_type_display_name: spec.sport,
		private: spec.visibility === 'only_me',
		bike_id: null,
		athlete_gear_id: null,
		start_date: new Date(startEpoch * 1000).toDateString(),
		// Local wall time dressed up as epoch seconds (UTC−7 here).
		start_date_local_raw: startEpoch - 7 * 3600,
		start_time: stravaTime(startEpoch),
		start_day: 'Sun',
		distance: (stats.distance / 1000).toFixed(2),
		distance_raw: spec.start ? stats.distance : 0,
		long_unit: 'kilometers',
		short_unit: 'km',
		moving_time: clock(Math.round(elapsed * 0.95)),
		moving_time_raw: Math.round(elapsed * 0.95),
		elapsed_time: clock(elapsed),
		elapsed_time_raw: elapsed,
		trainer: !spec.start,
		static_map: `${env.origin}/static-maps/${id}.png`,
		has_latlng: spec.start !== undefined,
		commute: false,
		elevation_gain: String(Math.round(stats.ascent)),
		elevation_unit: 'm',
		elevation_gain_raw: stats.ascent,
		description: spec.description ?? null,
		activity_url: `${env.origin}/activities/${id}`,
		activity_url_for_twitter: `${env.origin}/activities/${id}?utm_source=twitter`,
		twitter_msg: `${spec.sport} on Strava`,
		is_changing_type: false,
		suffer_score: 17,
		tags: { 4: false, 5: false },
		selected_tag_type: null,
		flagged: false,
		hide_power: false,
		hide_heartrate: false,
		visibility: spec.visibility,
		embeddable: true
	};
	const streams: Record<string, unknown[]> = spec.start
		? {
				latlng: points.map((p) => [p.lat, p.lon]),
				altitude: points.map((p) => p.ele),
				time: points.map((p) => p.time! - startEpoch),
				distance: distances,
				moving: points.map(() => true)
			}
		: {
				time: Array.from({ length: 60 }, (_, i) => i * 45),
				distance: Array.from({ length: 60 }, (_, i) => i * 120),
				moving: Array.from({ length: 60 }, () => true)
			};
	const gpx = spec.start
		? buildGpx({
				creator: 'StravaGPX',
				ns: GPX_NS,
				kind: 'trk',
				name: spec.name,
				time: startEpoch,
				extensions: [],
				segments,
				digits: 6
			})
		: null;
	return { id, summary, streams, gpx };
}

interface RouteSpec {
	/** 19 digits: past 2^53, so a double would round it. */
	id: string;
	title: string;
	own?: boolean;
	day: number;
	type: string;
	private?: boolean;
	start: [number, number];
	points: number;
}

function buildRoute(spec: RouteSpec): StravaRouteObject {
	const own = spec.own !== false;
	const created = BASE_EPOCH + spec.day * DAY + 911;
	// Somebody else's route is drawn over a platform trail: its coordinates are sentinels.
	const segments: Pt[][] = own
		? makeLine({
				seed: `strava-route:${spec.id}`,
				start: spec.start,
				segments: [spec.points],
				digits: 6,
				startTime: created,
				time: false
			})
		: [PLATFORM_TRAILS[0]!.geometry.map(([lat, lon]) => ({ lat, lon, ele: 1400, time: null }))];
	const stats = lineStats(segments);
	const node: Json = {
		title: spec.title,
		id: spec.id,
		isStarred: true,
		elevationGain: stats.ascent,
		length: stats.distance,
		estimatedTime: { expectedTime: Math.round(stats.distance / 2.5) },
		creationTime: isoUtc(created),
		themedMapImages: [],
		routeType: spec.type,
		athlete: { id: String(own ? ME_ID : OTHER_ID) },
		isPrivate: spec.private ?? false
	};
	const gpx = buildGpx({
		creator: 'StravaGPX',
		ns: GPX_NS,
		kind: 'trk',
		name: spec.title,
		time: created,
		author: own ? 'Test Rider' : SENTINELS.otherUserName,
		extensions: [],
		segments,
		digits: 6
	});
	return { id: spec.id, own, node, gpx };
}

interface PhotoSpecS {
	id: number;
	activity: StravaActivityObject;
	caption: string;
	video?: boolean;
	size: number;
}

function buildPhoto(env: Env, spec: PhotoSpecS): StravaPhotoObject {
	const token = Buffer.from(hex(`strava-photo:${spec.id}`, 30), 'hex').toString('base64url');
	const path = `/${token}-1536x2048.jpg`;
	const a = spec.activity.summary;
	return {
		isVideo: spec.video === true,
		path,
		spec: { key: `strava/${spec.id}/large`, size: spec.size, mime: 'image/jpeg' },
		item: {
			photo_id: uuid(`strava-photo:${spec.id}`),
			id: spec.id,
			media_type: spec.video ? 2 : 1,
			activity_id: a.id,
			activity_id_str: a.id_str,
			post_id: null,
			activity_name_escaped: xmlEscape(String(a.name)),
			caption_escaped: xmlEscape(spec.caption),
			thumbnail: `${env.cdnOrigin}/${token}-96x128.jpg`,
			large: `${env.cdnOrigin}${path}`,
			video: spec.video ? `${env.cdnOrigin}/${token}.mp4` : null,
			duration: spec.video ? 12.5 : null,
			// Null in every listing entry observed, though the activity page has them.
			lat: null,
			lng: null,
			native: true,
			owner_id: ME_ID,
			viewing_athlete_id: ME_ID,
			editable: true,
			activity: {
				id: a.id,
				id_str: a.id_str,
				athlete_id: ME_ID,
				athlete_id_str: String(ME_ID),
				name: a.name,
				description: a.description,
				elapsed_time: a.elapsed_time_raw,
				moving_time: a.moving_time_raw,
				elev_gain: a.elevation_gain_raw,
				distance: a.distance_raw,
				type: a.sport_type,
				private: 0,
				start_date: isoUtc(Date.parse(String(a.start_time).replace('+0000', 'Z')) / 1000)
			},
			dimensions: {
				large: { height: 2048, width: 1536 },
				thumbnail: { height: 128, width: 96 }
			},
			is_sponsored_photo: false,
			enhanced_photo: null
		}
	};
}

const ME: Json = {
	id: ME_ID,
	id_str: String(ME_ID),
	// A per-account secret, planted so the archive check would catch it.
	external_identity_hash: SENTINELS.csrfToken,
	super_user: false,
	firstname: 'Test',
	lastname: 'Rider',
	gender: 'Other',
	athlete_type: 0,
	is_subscriber: false,
	profile_medium: 'https://avatars.invalid/medium.jpg',
	measurement_units: 'meters',
	features: {},
	experiments: {},
	preferences: {},
	in_preview: false,
	num_days_remaining_in_preview: null,
	dob_required: false,
	age: 40
};

const PAGE_CONTEXT: Json = {
	loggedOutExperiment: null,
	features: {},
	loggedOutAthleteData: { eligibleForLoggedOutGifting: false },
	cookieManagementPlatform: { useSnowplowServerSidePageViewEvents: false }
};

function finish(env: Env, parts: Pick<StravaData, 'activities' | 'routes' | 'photos'>): StravaData {
	return {
		me: ME,
		...parts,
		expected(): ExpectedArchive {
			const ids = {
				tracks: parts.activities.filter((a) => a.gpx !== null).map((a) => a.id),
				routes: parts.routes.filter((r) => r.own).map((r) => r.id),
				waypoints: [] as string[],
				areas: [] as string[],
				photos: parts.photos.filter((p) => !p.isVideo).map((p) => String(p.item.photo_id))
			};
			const starred = parts.routes.filter((r) => !r.own);
			return {
				account: { id: String(ME_ID), displayName: 'Test R.' },
				counts: {
					tracks: ids.tracks.length,
					routes: ids.routes.length,
					waypoints: 0,
					areas: 0,
					// One synthesized "Starred routes" collection, when there is anything to put in it.
					collections: starred.length > 0 ? 1 : 0,
					photos: ids.photos.length
				},
				ids,
				references: starred.map((r) => ({
					name: String(r.node.title),
					url: `${env.origin}/routes/${r.id}`,
					sourceId: r.id,
					coordinate: null
				}))
			};
		},
		objects(): StravaObjects {
			return {
				me: ME,
				activities: parts.activities.map(({ summary, streams }) => ({ summary, streams })),
				routes: parts.routes.map((r) => r.node),
				photos: parts.photos.map((p) => p.item)
			};
		}
	};
}

function buildSmall(env: Env): StravaData {
	// Newest first, as the listing has them.
	const activities = [
		buildActivity(env, {
			id: 11200000005,
			name: NAMES.emoji,
			description: 'Summit push <finally> & a long way down.\nWorth it.',
			day: 20,
			sport: 'Hike',
			visibility: 'everyone',
			start: [36.57855, -118.29217],
			points: 140
		}),
		buildActivity(env, {
			id: 11200000004,
			name: 'Trainer spin',
			day: 18,
			sport: 'Ride',
			visibility: 'only_me'
		}),
		buildActivity(env, {
			id: 11200000003,
			name: NAMES.accents,
			day: 12,
			sport: 'TrailRun',
			visibility: 'followers_only',
			start: [36.60122, -118.25401],
			points: 90
		}),
		buildActivity(env, {
			id: 11200000002,
			name: NAMES.duplicate,
			description: '',
			day: 6,
			sport: 'Walk',
			visibility: 'only_me',
			start: [36.58711, -118.27006],
			points: 45
		}),
		buildActivity(env, {
			id: 11200000001,
			name: NAMES.duplicate,
			day: 3,
			sport: 'Ride',
			visibility: 'everyone',
			start: [36.55012, -118.31448],
			points: 120
		})
	];
	const routes = [
		buildRoute({
			id: '3401234567890123457',
			title: NAMES.slashes,
			day: 1,
			type: 'Run',
			start: [36.56601, -118.30112],
			points: 110
		}),
		buildRoute({
			id: '3401234567890123461',
			title: 'Gravel loop',
			day: 4,
			type: 'Ride',
			private: true,
			start: [36.54177, -118.33902],
			points: 160
		}),
		buildRoute({
			id: '3408765432109876543',
			title: 'Classic loop by someone else',
			own: false,
			day: 5,
			type: 'Ride',
			start: [37.74, -119.53],
			points: 5
		}),
		buildRoute({
			id: '3401234567890123499',
			title: NAMES.long,
			day: 9,
			type: 'Hike',
			start: [36.59033, -118.28544],
			points: 75
		})
	];
	const photos = [
		buildPhoto(env, {
			id: 9101,
			activity: activities[0]!,
			caption: 'Summit & snacks <3',
			size: 48_210
		}),
		buildPhoto(env, { id: 9102, activity: activities[0]!, caption: '', video: true, size: 20_000 }),
		// On an indoor activity: nothing in the archive for it to hang from.
		buildPhoto(env, { id: 9103, activity: activities[1]!, caption: 'Pain cave', size: 12_345 }),
		buildPhoto(env, { id: 9104, activity: activities[2]!, caption: 'Ridge', size: 31_999 })
	];
	return finish(env, { activities, routes, photos });
}

export function buildStrava(env: Env, ds: ResolvedDataset): StravaData {
	// The large dataset is Gaia-only; this platform is an empty (but valid) account.
	if (ds.kind === 'large') return finish(env, { activities: [], routes: [], photos: [] });
	return buildSmall(env);
}

// ---------------------------------------------------------------------------------------------

/** Paths the fake treats as API traffic (the rest are pages). */
export function isStravaApiPath(path: string): boolean {
	return (
		path.startsWith('/api/') ||
		path.startsWith('/frontend/') ||
		path === '/athlete/training_activities' ||
		/^\/athletes\/\d+\/photos$/.test(path) ||
		/^\/activities\/\d+\/(streams|export_gpx)$/.test(path) ||
		/^\/routes\/\d+\/export_gpx$/.test(path)
	);
}

export interface StravaRequestContext {
	authed: boolean;
	/** The token the current session accepts, or null while signed out. */
	csrfToken: string | null;
	/** POST body, read by the server. */
	body: string;
}

const EMPTY = Buffer.alloc(0);
const empty = (status: number): Reply => ({
	kind: 'bytes',
	status,
	contentType: 'application/json; charset=utf-8',
	body: EMPTY
});
const redirect = (location: string): Reply => ({ kind: 'redirect', location });
const notFound: Reply = { kind: 'json', status: 404, body: { error: 'Record Not Found' } };
const INTERNAL: Reply = {
	kind: 'bytes',
	status: 500,
	contentType: 'text/plain; charset=utf-8',
	body: Buffer.from('Internal Server Error')
};
/** What a JSON listing sends a request that forgot `X-Requested-With`: the page itself. */
const PAGE: Reply = {
	kind: 'bytes',
	status: 200,
	contentType: 'text/html; charset=utf-8',
	body: Buffer.from(
		'<!doctype html>\n<html><head><title>My Activities</title></head><body></body></html>\n'
	)
};
const GPX_TYPE = 'application/octet-stream';

function capped(value: string | null, fallback: number, ds: ResolvedDataset): number {
	const requested = parseIntParam(value, fallback);
	return Math.min(
		Number.isFinite(requested) && requested >= 1 ? requested : fallback,
		PER_PAGE_CAP,
		ds.maxPageSize
	);
}

/** Every Strava-shaped request that is not a page or a photo. */
export function handleStravaApi(
	data: StravaData,
	ds: ResolvedDataset,
	req: ApiRequest,
	ctx: StravaRequestContext
): Reply {
	const xhr = req.headers['x-requested-with'] === 'XMLHttpRequest';
	const { path, method } = req;

	if (path === MINT_PATH) {
		if (method !== 'POST')
			return { kind: 'json', status: 405, body: { error: 'Method Not Allowed' } };
		// Signed out it still answers, with a token no session will accept.
		const token = ctx.authed && ctx.csrfToken !== null ? ctx.csrfToken : stravaCsrfToken(null);
		return { kind: 'json', status: 200, body: { token } };
	}
	if (path === ROUTES_PATH) {
		if (method !== 'POST') return empty(405);
		const token = req.headers['x-csrf-token'];
		if (!ctx.authed || ctx.csrfToken === null || token !== ctx.csrfToken) return empty(403);
		return routesPage(data, ds, ctx.body);
	}
	if (path === '/frontend/athletes/current') {
		return {
			kind: 'json',
			status: 200,
			body: { currentAthlete: ctx.authed ? data.me : null, pageContext: PAGE_CONTEXT }
		};
	}
	if (method !== 'GET' && method !== 'HEAD') return empty(405);

	const gpx =
		/^\/activities\/(\d+)\/export_gpx$/.exec(path) ?? /^\/routes\/(\d+)\/export_gpx$/.exec(path);
	if (gpx) {
		if (!ctx.authed) return redirect('/login');
		if (path.startsWith('/routes/')) {
			const route = data.routes.find((r) => r.id === gpx[1]);
			return route
				? { kind: 'bytes', status: 200, contentType: GPX_TYPE, body: route.gpx }
				: notFound;
		}
		const activity = data.activities.find((a) => a.id === gpx[1]);
		if (!activity) return notFound;
		// No GPS, no file: the real site bounces to the dashboard.
		if (!activity.gpx) return redirect('/dashboard');
		return { kind: 'bytes', status: 200, contentType: GPX_TYPE, body: activity.gpx };
	}

	// The JSON listings: 401 for a signed-out XHR, the sign-in page for anything else.
	if (!ctx.authed) return xhr ? empty(401) : redirect('/login');

	const streams = /^\/activities\/(\d+)\/streams$/.exec(path);
	if (streams) {
		const activity = data.activities.find((a) => a.id === streams[1]);
		if (!activity) return notFound;
		const wanted = req.query.getAll('stream_types[]');
		const body: Json = {};
		for (const type of wanted) if (type in activity.streams) body[type] = activity.streams[type];
		return { kind: 'json', status: 200, body };
	}
	if (path === '/athlete/training_activities') {
		if (!xhr) return PAGE;
		const page = parseIntParam(req.query.get('page'), 1);
		if (!Number.isFinite(page) || page < 1) return INTERNAL;
		const perPage = capped(req.query.get('per_page'), PER_PAGE_CAP, ds);
		const all = data.activities.map((a) => a.summary);
		return {
			kind: 'json',
			status: 200,
			listingKey: 'models',
			body: {
				models: all.slice((page - 1) * perPage, page * perPage),
				page,
				perPage,
				total: all.length
			}
		};
	}
	const photos = /^\/athletes\/(\d+)\/photos$/.exec(path);
	if (photos) {
		if (photos[1] !== String(ME_ID)) return notFound;
		if (!xhr) return PAGE;
		return photosPage(data, ds, req.query);
	}
	return notFound;
}

/** `cursor=<epoch>,<photo id>` of the last item seen; an unknown cursor gives an empty page. */
function photosPage(data: StravaData, ds: ResolvedDataset, query: URLSearchParams): Reply {
	const items = data.photos.map((p) => p.item);
	const perPage = capped(query.get('per_page'), 10, ds);
	const cursor = query.get('cursor');
	let start = 0;
	if (cursor !== null) {
		const id = Number(cursor.split(',')[1]);
		const at = items.findIndex((item) => item.id === id);
		start = at === -1 ? items.length : at + 1;
	}
	const page = items.slice(start, start + perPage);
	const last = page.at(-1);
	const epoch = (item: Json) => Date.parse(String((item.activity as Json).start_date)) / 1000;
	return {
		kind: 'json',
		status: 200,
		listingKey: 'items',
		body: {
			items: page,
			next_cursor: last ? `${epoch(last)},${String(last.id)}` : null,
			has_more: start + page.length < items.length
		}
	};
}

/**
 * The routes query. `after` is `'0'` for the first page, then the previous page's `endCursor`,
 * which is the 0-based index of its last item. Without `searchArgs` the server falls over;
 * without `routeTypes` it applies no type filter.
 */
function routesPage(data: StravaData, ds: ResolvedDataset, raw: string): Reply {
	let body: { pageSize?: unknown; after?: unknown; searchArgs?: { routeTypes?: unknown } };
	try {
		body = JSON.parse(raw) as typeof body;
	} catch {
		return INTERNAL;
	}
	if (typeof body.searchArgs !== 'object' || body.searchArgs === null) return INTERNAL;
	const after = typeof body.after === 'string' ? body.after : '0';
	if (!/^\d+$/.test(after)) return INTERNAL;
	const types = body.searchArgs.routeTypes;
	const nodes = data.routes
		.map((r) => r.node)
		.filter((node) => !Array.isArray(types) || types.includes(node.routeType));
	const requested = typeof body.pageSize === 'number' && body.pageSize >= 1 ? body.pageSize : 20;
	const size = Math.min(requested, ds.maxPageSize);
	const start = after === '0' ? 0 : Number(after) + 1;
	const page = nodes.slice(start, start + size);
	const end = start + page.length;
	return {
		kind: 'json',
		status: 200,
		listingKey: 'me',
		body: {
			me: {
				id: String(ME_ID),
				measurementPreference: 'meters',
				searchRoutes: {
					nodes: page,
					pageInfo: {
						endCursor: String(Math.max(end - 1, 0)),
						startCursor: String(start),
						hasNextPage: end < nodes.length,
						hasPreviousPage: start > 0
					}
				}
			}
		}
	};
}

/** Photo host: every rendition of every photo, by path. No session, no signature. */
export function handleStravaCdn(data: StravaData, path: string): Reply | null {
	const found = data.photos.find((p) => p.path === path);
	return found ? { kind: 'photo', spec: found.spec } : null;
}
