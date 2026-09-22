import { describe, expect, it } from 'vitest';
import { STARRED_ROUTES_KEY, createStravaAdapter } from '../src/adapters/strava/index.ts';
import {
	displayName,
	mapActivity,
	mapPhoto,
	mapRoute,
	mapStarredRoute,
	mapStreams,
	unescapeHtml,
	type StravaUrls
} from '../src/adapters/strava/mapper.ts';
import {
	StravaActivitiesPageSchema,
	StravaPhotosPageSchema,
	StravaRoutesPageSchema,
	StravaStreamsSchema
} from '../src/adapters/strava/schemas.ts';
import { AdapterOutdatedError, ItemError } from '../src/shared/errors.ts';
import { TimestampSchema } from '../src/shared/schemas.ts';
import {
	collect,
	fixtureTransport,
	loadFixture,
	type PostedRequest
} from './helpers/fixture-transport.ts';

const ORIGIN = 'https://www.strava.com';
const urls: StravaUrls = {
	activity: (id) => `${ORIGIN}/activities/${id}`,
	route: (id) => `${ORIGIN}/routes/${id}`
};

const activities = () =>
	StravaActivitiesPageSchema.parse(loadFixture('strava', 'activities-listing')).models;
const routes = () =>
	StravaRoutesPageSchema.parse(loadFixture('strava', 'routes-listing')).me.searchRoutes.nodes;
const photos = () => StravaPhotosPageSchema.parse(loadFixture('strava', 'photos-listing')).items;

describe('Strava mappers (fixtures)', () => {
	it('maps an activity: UTC start, SI stats, visibility, provenance', () => {
		const [activity] = activities();
		const record = mapActivity(activity!, urls);
		expect(record).toMatchObject({
			kind: 'track',
			name: '🏔️🥾',
			description: 'Summit push <finally> & a long way down.\nWorth it.',
			visibility: 'public',
			tags: [],
			activityType: 'Hike',
			updatedAt: null,
			source: { id: '11200000005', url: `${ORIGIN}/activities/11200000005` }
		});
		// `+0000` is not RFC 3339; the record's timestamp is.
		expect(activity!.start_time).toMatch(/\+0000$/);
		expect(TimestampSchema.safeParse(record.createdAt).success).toBe(true);
		expect(record.createdAt).toBe(activity!.start_time!.replace('+0000', 'Z'));
		expect(record.stats.distanceMeters).toBe(activity!.distance_raw);
		expect(record.stats.durationSeconds).toBe(activity!.elapsed_time_raw);
		expect(record.source.raw).toBe(activity);
	});

	it('only "everyone" is public; followers-only and only-me are private', () => {
		const [activity] = activities();
		const as = (visibility: string | null, isPrivate = false) =>
			mapActivity({ ...activity!, visibility, private: isPrivate }, urls).visibility;
		expect(as('everyone')).toBe('public');
		expect(as('followers_only')).toBe('private');
		expect(as('only_me', true)).toBe('private');
		expect(as(null)).toBeNull();
		expect(as(null, true)).toBe('private');
		expect(mapActivity({ ...activity!, name: ' ', description: '' }, urls)).toMatchObject({
			name: 'Untitled',
			description: null
		});
	});

	it('rebuilds an activity from its streams: one segment, times from the start', () => {
		const [activity] = activities();
		const streams = StravaStreamsSchema.parse(loadFixture('strava', 'streams'));
		const segments = mapStreams(streams, activity!);
		expect(segments).toHaveLength(1);
		const points = segments[0]!;
		expect(points).toHaveLength(streams.latlng!.length);
		expect(points[0]).toEqual({
			lat: streams.latlng![0]![0],
			lon: streams.latlng![0]![1],
			ele: streams.altitude![0],
			time: activity!.start_time!.replace('+0000', 'Z')
		});
		const last = points.at(-1)!;
		expect(Date.parse(last.time!) - Date.parse(points[0]!.time!)).toBe(
			streams.time!.at(-1)! * 1000
		);
	});

	it('an activity without GPS streams has no geometry', () => {
		const [activity] = activities();
		expect(mapStreams({ time: [0, 1, 2] }, activity!)).toEqual([]);
		const noTime = mapStreams({ latlng: [[1, 2]] }, { ...activity!, start_time: null });
		expect(noTime).toEqual([[{ lat: 1, lon: 2, ele: null, time: null }]]);
	});

	it('maps a route: its 19-digit id intact, no duration, privacy', () => {
		const [route, privateRoute] = routes();
		expect(route!.id).toBe('3401234567890123457');
		// A double would have rounded it.
		expect(String(Number(route!.id))).not.toBe(route!.id);
		expect(mapRoute(route!, urls)).toMatchObject({
			kind: 'route',
			name: 'Morning loop / ridge ../summit',
			description: null,
			visibility: 'public',
			activityType: 'Run',
			stats: { distanceMeters: route!.length, ascentMeters: route!.elevationGain },
			source: { id: '3401234567890123457', url: `${ORIGIN}/routes/3401234567890123457` }
		});
		expect(mapRoute(route!, urls).stats.durationSeconds).toBeNull();
		expect(mapRoute(privateRoute!, urls).visibility).toBe('private');
	});

	it('another athlete’s starred route becomes a name and a link, nothing more', () => {
		const theirs = routes().find((route) => route.athlete.id !== '3001')!;
		expect(mapStarredRoute(theirs, urls)).toEqual({
			name: 'Classic loop by someone else',
			source: { id: '3408765432109876543', url: `${ORIGIN}/routes/3408765432109876543` },
			coordinate: null
		});
	});

	it('undoes the listing’s HTML escaping, and only that', () => {
		expect(unescapeHtml('Summit &amp; snacks &lt;3')).toBe('Summit & snacks <3');
		expect(unescapeHtml('&quot;hi&quot; &#39;there&#x27; &#128512;')).toBe(`"hi" 'there' 😀`);
		expect(unescapeHtml('&amp;lt; stays &lt;')).toBe('&lt; stays <');
		expect(unescapeHtml('&nope; &#0; &#xZZ;')).toBe('&nope; &#0; &#xZZ;');
	});

	it('maps photos: caption unescaped, attached to its activity, largest rendition', () => {
		const [photo] = photos();
		expect(mapPhoto(photo!)).toEqual({
			kind: 'photo',
			name: null,
			caption: 'Summit & snacks <3',
			takenAt: null,
			uploadedAt: null,
			coordinate: null,
			url: photo!.large,
			rendition: 'largest-available',
			attachedTo: { type: 'track', sourceId: '11200000005' },
			source: { id: photo!.photo_id, url: null, raw: photo }
		});
		expect(mapPhoto({ ...photo!, lat: 36.5, lng: -118.2 }).coordinate).toEqual([-118.2, 36.5]);
		expect(mapPhoto({ ...photo!, caption_escaped: '', activity_id_str: null })).toMatchObject({
			caption: null,
			attachedTo: null
		});
	});

	it('shortens the account name', () => {
		expect(displayName({ firstname: 'Test', lastname: 'Rider' })).toBe('Test R.');
		expect(displayName({ firstname: null, lastname: null })).toBe('Strava athlete');
	});
});

describe('Strava adapter (fixture-backed transport)', () => {
	const fixtureRoutes: [RegExp, unknown][] = [
		[/\/frontend\/athletes\/current$/, loadFixture('strava', 'current-athlete')],
		[/\/athlete\/training_activities\?page=1&/, loadFixture('strava', 'activities-listing')],
		[/\/activities\/\d+\/streams\?/, loadFixture('strava', 'streams')],
		[/\/api\/next\/data\/routes\/my-routes$/, loadFixture('strava', 'routes-listing')],
		[/\/athletes\/3001\/photos\?/, loadFixture('strava', 'photos-listing')]
	];
	const adapter = (
		requested: string[] = [],
		headers: (Record<string, string> | undefined)[] = [],
		posted: PostedRequest[] = []
	) =>
		createStravaAdapter(fixtureTransport(fixtureRoutes, requested, headers, posted), 'production');

	it('identifies the account; every call says it is an XHR, or the listings answer HTML', async () => {
		const headers: (Record<string, string> | undefined)[] = [];
		const strava = adapter([], headers);
		expect(await strava.identifyUser()).toEqual({ id: '3001', displayName: 'Test R.' });
		await collect(strava.enumerateTracks());
		await collect(strava.enumerateRoutes());
		await collect(strava.enumeratePhotos());
		expect(headers.length).toBeGreaterThan(3);
		for (const sent of headers) expect(sent).toEqual({ 'X-Requested-With': 'XMLHttpRequest' });
	});

	it('exports activities with GPS as tracks, native GPX first, streams as the fallback', async () => {
		const requested: string[] = [];
		const tracks = await collect(adapter(requested).enumerateTracks());
		// The indoor session (…004) has nothing to put on a map.
		expect(tracks.map((track) => track.source.id)).toEqual([
			'11200000005',
			'11200000003',
			'11200000002',
			'11200000001'
		]);
		expect(tracks[0]!.nativeGpx).toEqual({
			method: 'GET',
			url: `${ORIGIN}/activities/11200000005/export_gpx`,
			accept: 'text-stream'
		});
		expect(requested.some((url) => url.includes('/streams'))).toBe(false);
		const segments = await tracks[0]!.loadSegments();
		expect(segments.flat().length).toBeGreaterThan(10);
		expect(requested.at(-1)).toBe(
			`${ORIGIN}/activities/11200000005/streams?stream_types[]=latlng&stream_types[]=altitude&stream_types[]=time`
		);
	});

	it('pages activities with page= until the total is reached, and drops repeats', async () => {
		const all = loadFixture('strava', 'activities-listing');
		const page = (models: unknown[], n: number) => ({ models, page: n, perPage: 2, total: 5 });
		const requested: string[] = [];
		const strava = createStravaAdapter(
			fixtureTransport(
				[
					[/page=1&/, page(all.models.slice(0, 2), 1)],
					// An upload during the run pushed …002 onto page 3 as well.
					[/page=2&/, page(all.models.slice(2, 4), 2)],
					[/page=3&/, page(all.models.slice(3, 5), 3)]
				],
				requested
			),
			'production'
		);
		const ids = (await collect(strava.enumerateTracks())).map((track) => track.source.id);
		expect(ids).toEqual(['11200000005', '11200000003', '11200000002', '11200000001']);
		expect(requested).toHaveLength(3);
		expect(requested[0]).toBe(`${ORIGIN}/athlete/training_activities?page=1&per_page=20`);
	});

	it('lists routes with a POST that asks for a fresh CSRF token, and keeps ids as strings', async () => {
		const posted: PostedRequest[] = [];
		const routeRecords = await collect(adapter([], [], posted).enumerateRoutes());
		expect(routeRecords.map((route) => route.source.id)).toEqual([
			'3401234567890123457',
			'3401234567890123461',
			'3401234567890123499'
		]);
		expect(routeRecords[0]!.nativeGpx?.url).toBe(`${ORIGIN}/routes/3401234567890123457/export_gpx`);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toEqual({
			url: `${ORIGIN}/api/next/data/routes/my-routes`,
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
			csrf: { url: `${ORIGIN}/api/next/mint-csrf-token`, field: 'token', header: 'x-csrf-token' },
			body: {
				pageSize: 50,
				after: '0',
				searchArgs: {
					query: '',
					onlyStarred: false,
					createdBy: 'Any',
					elevGainMin: 0,
					elevGainMax: null,
					distanceMin: 0,
					distanceMax: null
				},
				resolutions: []
			}
		});
		// No type filter: a route type the site adds later is not silently left out.
		expect(posted[0]!.body).not.toHaveProperty('searchArgs.routeTypes');
	});

	it('routes have no JSON geometry to fall back on', async () => {
		const [route] = await collect(adapter().enumerateRoutes());
		await expect(route!.loadSegments()).rejects.toBeInstanceOf(ItemError);
	});

	it('pages routes with after=<endCursor>', async () => {
		const listing = loadFixture('strava', 'routes-listing');
		const nodes = listing.me.searchRoutes.nodes;
		const page = (from: number, to: number) => ({
			me: {
				id: '3001',
				searchRoutes: {
					nodes: nodes.slice(from, to),
					pageInfo: { endCursor: String(to - 1), hasNextPage: to < nodes.length }
				}
			}
		});
		const posted: PostedRequest[] = [];
		const strava = createStravaAdapter(
			fixtureTransport(
				[
					[/\/frontend\/athletes\/current$/, loadFixture('strava', 'current-athlete')],
					[
						/my-routes$/,
						(body: unknown) => ((body as { after: string }).after === '0' ? page(0, 2) : page(2, 4))
					]
				],
				[],
				[],
				posted
			),
			'production'
		);
		expect(await collect(strava.enumerateRoutes())).toHaveLength(3);
		expect(posted.map((post) => (post.body as { after: string }).after)).toEqual(['0', '1']);
	});

	it('collects other athletes’ starred routes as references, listing routes if need be', async () => {
		const posted: PostedRequest[] = [];
		const strava = adapter([], [], posted);
		const [collection] = await collect(strava.enumerateCollections());
		expect(posted).toHaveLength(1);
		expect(collection).toMatchObject({
			kind: 'collection',
			key: STARRED_ROUTES_KEY,
			name: 'Starred routes',
			source: null,
			members: [
				{
					kind: 'reference',
					reference: {
						name: 'Classic loop by someone else',
						source: { id: '3408765432109876543' }
					}
				}
			]
		});
		// After the routes were exported, the list is not asked for again.
		const again = adapter([], [], posted);
		await collect(again.enumerateRoutes());
		await collect(again.enumerateCollections());
		expect(posted).toHaveLength(2);
	});

	it('exports the user’s photos, skipping videos, paged with cursor=', async () => {
		const all = loadFixture('strava', 'photos-listing').items;
		const requested: string[] = [];
		const strava = createStravaAdapter(
			fixtureTransport(
				[
					[/\/frontend\/athletes\/current$/, loadFixture('strava', 'current-athlete')],
					[/cursor=/, { items: all.slice(2), next_cursor: null, has_more: false }],
					[/\/photos\?/, { items: all.slice(0, 2), next_cursor: '1718000000,9102', has_more: true }]
				],
				requested
			),
			'production'
		);
		const records = await collect(strava.enumeratePhotos());
		expect(records.map((photo) => photo.caption)).toEqual([
			'Summit & snacks <3',
			'Pain cave',
			'Ridge'
		]);
		expect(requested.at(-1)).toBe(
			`${ORIGIN}/athletes/3001/photos?per_page=20&cursor=1718000000%2C9102`
		);
		const foreign = { ...all[0], photo_id: 'x', owner_id: 42 };
		const mixed = createStravaAdapter(
			fixtureTransport([
				[/\/frontend\/athletes\/current$/, loadFixture('strava', 'current-athlete')],
				[/\/photos\?/, { items: [foreign, all[0]], has_more: false }]
			]),
			'production'
		);
		expect((await collect(mixed.enumeratePhotos())).map((p) => p.source.id)).toEqual([
			all[0].photo_id
		]);
	});

	it('counts activities from the listing total and offers no count it does not have', async () => {
		const strava = adapter();
		expect(await strava.count('track')).toBe(5);
		expect(await strava.count('waypoint')).toBe(0);
		expect(await strava.count('area')).toBe(0);
		expect(await strava.count('route')).toBeNull();
		expect(await strava.count('photo')).toBeNull();
		expect(await strava.count('collection')).toBeNull();
	});

	it('knows its signed-out answers', () => {
		const strava = adapter();
		const signedOut = strava.isSignedOut!;
		expect(signedOut({ status: 403, bodyKind: 'empty' })).toBe(true);
		expect(
			signedOut({ status: 200, bodyKind: 'json', json: { currentAthlete: null, pageContext: {} } })
		).toBe(true);
		expect(signedOut({ status: 200, bodyKind: 'json', json: { currentAthlete: { id: 1 } } })).toBe(
			false
		);
		expect(signedOut({ status: 200, bodyKind: 'json', json: { models: [] } })).toBe(false);
		expect(signedOut({ status: 403, bodyKind: 'json', json: { url: 'x' } })).toBe(false);
		expect(strava.isLoginUrl(`${ORIGIN}/login`)).toBe(true);
		expect(strava.isLoginUrl(`${ORIGIN}/dashboard`)).toBe(false);
	});

	it('listing schema drift is fatal and names adapter + version; item drift is item-level', async () => {
		const strava = createStravaAdapter(
			fixtureTransport([
				[/\/frontend\/athletes\/current$/, loadFixture('strava', 'current-athlete')],
				[/my-routes$/, { me: { id: '3001', entries: [] } }],
				[/training_activities/, loadFixture('strava', 'activities-listing')],
				[/\/streams\?/, { latlng: 'surprise' }]
			]),
			'production'
		);
		const failure = await collect(strava.enumerateRoutes()).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AdapterOutdatedError);
		expect((failure as Error).message).toContain('Strava adapter v1.0.0 is out of date');
		expect((failure as Error).message).toContain('route listing');
		const [track] = await collect(strava.enumerateTracks());
		await expect(track!.loadSegments()).rejects.toBeInstanceOf(ItemError);
	});
});
