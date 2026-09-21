import { describe, expect, it } from 'vitest';
import { createAllTrailsAdapter } from '../src/adapters/alltrails/index.ts';
import { allTrailsKey } from '../src/adapters/alltrails/key.ts';
import {
	displayName,
	mapLine,
	mapList,
	mapPhoto,
	mapSegments,
	mapTrailReference,
	mapWaypoint,
	type AllTrailsUrls
} from '../src/adapters/alltrails/mapper.ts';
import { decodeIndexed, decodePolyline } from '../src/adapters/alltrails/polyline.ts';
import {
	AllTrailsListItemsSchema,
	AllTrailsListsPageSchema,
	AllTrailsMapDetailSchema,
	AllTrailsMapsPageSchema,
	AllTrailsPhotosPageSchema,
	AllTrailsTrailSchema
} from '../src/adapters/alltrails/schemas.ts';
import { AdapterOutdatedError, ItemError } from '../src/shared/errors.ts';
import { TimestampSchema } from '../src/shared/schemas.ts';
import { encodeIndexed } from '../tools/fake-source/polyline.ts';
import { collect, fixtureTransport, loadFixture } from './helpers/fixture-transport.ts';

const ORIGIN = 'https://www.alltrails.com';
const urls: AllTrailsUrls = {
	recording: (map) => `${ORIGIN}/explore/recording/${map.slug ?? map.id}`,
	route: (map) => `${ORIGIN}/explore/map/${map.slug ?? map.id}`,
	trail: (trail) => `${ORIGIN}/trail/${trail.slug ?? trail.id}`,
	photoFile: (id) => `${ORIGIN}/api/alltrails/v3/photos/${id}/image?key=k&size=original`
};

const tracks = () => AllTrailsMapsPageSchema.parse(loadFixture('alltrails', 'tracks-listing')).maps;
const routes = () => AllTrailsMapsPageSchema.parse(loadFixture('alltrails', 'maps-listing')).maps;
const detail = (name: string) =>
	AllTrailsMapDetailSchema.parse(loadFixture('alltrails', name)).maps[0]!;

describe('AllTrails decoding', () => {
	it('decodes the canonical Google polyline at precision 5', () => {
		expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
			[38.5, -120.2],
			[40.7, -120.95],
			[43.252, -126.453]
		]);
	});

	it('decodes indexed series: delta-coded (index × 100, value) pairs, beyond int32', () => {
		// Encoded by the fake server's independent encoder; the second value does not fit an int32.
		const encoded = encodeIndexed([760934456, null, 3_000_000_123]);
		expect([...decodeIndexed(encoded)]).toEqual([
			[0, 760934456],
			[2, 3_000_000_123]
		]);
		expect(decodeIndexed('')).toEqual(new Map());
	});
});

describe('AllTrails mappers (fixtures)', () => {
	it('maps a recording: ISO timestamps, SI stats, visibility, provenance', () => {
		const [map] = tracks();
		const record = mapLine('track', map!, urls);
		expect(record).toMatchObject({
			kind: 'track',
			name: 'Morning loop / ridge ../summit',
			description: 'Great morning. Saw two marmots.',
			visibility: 'public',
			tags: [],
			activityType: 'hiking',
			source: { id: '810001', url: `${ORIGIN}/explore/recording/track-810001` }
		});
		expect(TimestampSchema.safeParse(record.createdAt).success).toBe(true);
		expect(TimestampSchema.safeParse(record.updatedAt).success).toBe(true);
		expect(record.stats.distanceMeters).toBeGreaterThan(0);
		expect(record.stats.durationSeconds).toBeGreaterThan(0);
		expect(record.source.raw).toBe(map);
	});

	it('custom routes carry no duration and link to the map page', () => {
		const [map] = routes();
		const record = mapLine('route', map!, urls);
		expect(record.kind).toBe('route');
		expect(record.stats.durationSeconds).toBeNull();
		expect(record.source.url).toBe(`${ORIGIN}/explore/map/map-820001`);
		expect(mapLine('route', { ...map!, name: ' ', private: true }, urls)).toMatchObject({
			name: 'Untitled',
			visibility: 'private'
		});
	});

	it('rebuilds a recording’s points, elevations and UTC times from the encoded series', () => {
		const track = detail('track-detail');
		const segments = mapSegments(track);
		expect(segments).toHaveLength(track.tracks![0]!.lineTimedSegments.length);
		const points = segments.flat();
		expect(points.length).toBe(150);
		const first = points[0]!;
		expect(first.lat).toBeCloseTo(36.77012, 5);
		expect(first.lon).toBeCloseTo(-118.37044, 5);
		expect(typeof first.ele).toBe('number');
		// The first point sits exactly on the segment's own start time.
		const start = track.tracks![0]!.lineTimedSegments[0]!.dateTimeStart!;
		expect(first.time).toBe(start);
		const times = points.map((point) => Date.parse(point.time!));
		expect(times.every((time, index) => index === 0 || time >= times[index - 1]!)).toBe(true);
		expect(times.at(-1)! - times[0]!).toBeGreaterThan(0);
	});

	it('rebuilds a custom route without times', () => {
		const segments = mapSegments(detail('map-detail'));
		expect(segments.flat().length).toBe(220);
		expect(segments.flat().every((point) => point.time === null)).toBe(true);
		expect(segments.flat().every((point) => typeof point.ele === 'number')).toBe(true);
	});

	it('tolerates a segment without elevation or time series', () => {
		const track = detail('track-detail');
		const [segment] = track.tracks![0]!.lineTimedSegments;
		const bare = {
			...track,
			tracks: [
				{
					lineTimedSegments: [
						{
							...segment!,
							polyline: { pointsData: segment!.polyline.pointsData }
						}
					]
				}
			]
		};
		const points = mapSegments(bare as typeof track).flat();
		expect(points.length).toBeGreaterThan(0);
		expect(points.every((point) => point.ele === null && point.time === null)).toBe(true);
	});

	it('maps embedded waypoints and drops the person attached to them', () => {
		const [map] = routes();
		const [waypoint] = detail('map-detail').waypoints!;
		const record = mapWaypoint(waypoint!, 'route', map!, urls);
		expect(record).toMatchObject({
			kind: 'waypoint',
			name: 'Night 1 camp',
			description: 'By the outlet.',
			position: [-118.39582, 36.74951],
			icon: 'general',
			source: { id: '830001', url: `${ORIGIN}/explore/map/map-820001` }
		});
		expect(record.source.raw).not.toHaveProperty('user');
	});

	it('a saved trail becomes name + link + one coordinate + my note — nothing of the platform’s', () => {
		const trail = AllTrailsTrailSchema.parse(loadFixture('alltrails', 'trail')).trails[0]!;
		const [item] = AllTrailsListItemsSchema.parse(loadFixture('alltrails', 'list-items')).listItems;
		const reference = mapTrailReference(trail, item!, urls);
		expect(reference).toEqual({
			name: 'Upper Yosemite Falls Trail',
			source: {
				id: '850001',
				url: `${ORIGIN}/trail/us/california/upper-yosemite-falls-trail`
			},
			coordinate: [-119.60214, 37.74235],
			annotations: { notes: 'Start before 7am; bring 3L of water.' }
		});
		expect(JSON.stringify(reference)).not.toMatch(/SENTINEL/);
		expect(mapTrailReference(trail, { ...item!, notes: null }, urls)).not.toHaveProperty(
			'annotations'
		);
	});

	it('maps lists and photos', () => {
		const [list] = AllTrailsListsPageSchema.parse(loadFixture('alltrails', 'lists-listing')).lists;
		expect(mapList(list!, [])).toMatchObject({
			kind: 'collection',
			key: '840001',
			name: 'Favorites',
			description: null,
			source: { id: '840001', url: null }
		});
		const photos = AllTrailsPhotosPageSchema.parse(
			loadFixture('alltrails', 'photos-listing')
		).photos;
		const attached = mapPhoto(photos[0]!, { type: 'track', sourceId: '810001' }, urls);
		expect(attached).toMatchObject({
			kind: 'photo',
			name: 'Marmot!',
			caption: 'He wanted my sandwich',
			coordinate: [-118.36907, 36.77188],
			rendition: 'largest-available',
			attachedTo: { type: 'track', sourceId: '810001' },
			url: `${ORIGIN}/api/alltrails/v3/photos/860001/image?key=k&size=original`
		});
		const bare = mapPhoto(
			photos.find((photo) => photo.id === 860002)!,
			null,
			urls
		);
		expect(bare).toMatchObject({ name: null, caption: null, coordinate: null, attachedTo: null });
	});

	it('shortens the account name', () => {
		expect(displayName({ firstName: 'Test', lastName: 'Hiker' })).toBe('Test H.');
		expect(displayName({ firstName: null, lastName: null })).toBe('AllTrails user');
	});
});

describe('AllTrails adapter (fixture-backed transport)', () => {
	const fixtureRoutes: [RegExp, unknown][] = [
		[/\/api\/alltrails\/me$/, loadFixture('alltrails', 'me')],
		[/\/users\/7001\/maps\?presentation_type=track&/, loadFixture('alltrails', 'tracks-listing')],
		[/\/users\/7001\/maps\?presentation_type=map&/, loadFixture('alltrails', 'maps-listing')],
		[/\/maps\/81\d+\?detail=deep$/, loadFixture('alltrails', 'track-detail')],
		[/\/maps\/82\d+\?detail=deep$/, loadFixture('alltrails', 'map-detail')],
		[/\/users\/7001\/lists\?/, loadFixture('alltrails', 'lists-listing')],
		[/\/lists\/840001\/items$/, loadFixture('alltrails', 'list-items')],
		[/\/lists\/\d+\/items$/, { listItems: [] }],
		[/\/trails\/\d+$/, loadFixture('alltrails', 'trail')],
		[/\/users\/7001\/photos\?/, loadFixture('alltrails', 'photos-listing')]
	];

	it('sends the app key on every request and identifies the account without the e-mail', async () => {
		const requested: string[] = [];
		const headers: (Record<string, string> | undefined)[] = [];
		const adapter = createAllTrailsAdapter(
			fixtureTransport(fixtureRoutes, requested, headers),
			'e2e'
		);
		expect(await adapter.identifyUser()).toEqual({ id: '7001', displayName: 'Test H.' });
		await collect(adapter.enumerateTracks());
		expect(headers.length).toBeGreaterThan(1);
		for (const sent of headers) expect(sent).toEqual({ 'X-AT-KEY': expect.any(String) });
	});

	it('production sends the configured app key, never the fake server’s', async () => {
		const headers: (Record<string, string> | undefined)[] = [];
		const production = fixtureRoutes.map(([pattern, body]) => [pattern, body] as [RegExp, unknown]);
		const adapter = createAllTrailsAdapter(fixtureTransport(production, [], headers), 'production');
		await adapter.identifyUser();
		const sent = headers[0]?.['X-AT-KEY'] ?? '';
		expect(sent).toMatch(/^[A-Za-z0-9]{32}$/);
		expect(sent).not.toBe(allTrailsKey('e2e'));
	});

	it('exports only the user’s own recordings and routes, with no native GPX to ask for', async () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(fixtureRoutes), 'e2e');
		const trackRecords = await collect(adapter.enumerateTracks());
		expect(trackRecords.map((track) => track.source.id)).toEqual([
			'810001',
			'810002',
			'810003',
			'810004'
		]);
		expect(trackRecords.every((track) => track.nativeGpx === null)).toBe(true);
		expect((await collect(adapter.enumerateRoutes())).map((route) => route.source.id)).toEqual([
			'820001',
			'820002',
			'820003'
		]);
	});

	it('fetches a map’s detail once, however many things are read from it', async () => {
		const requested: string[] = [];
		const adapter = createAllTrailsAdapter(fixtureTransport(fixtureRoutes, requested), 'e2e');
		const [track] = await collect(adapter.enumerateTracks());
		expect(requested.some((url) => url.includes('detail=deep'))).toBe(false);
		expect((await track!.loadSegments()).flat().length).toBeGreaterThan(10);
		await collect(adapter.enumerateWaypoints());
		await collect(adapter.enumeratePhotos());
		const deep = requested.filter((url) => url.includes('/maps/810001?detail=deep'));
		expect(deep).toHaveLength(1);
	});

	it('finds waypoints inside recordings and routes alike', async () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(fixtureRoutes), 'e2e');
		const waypoints = await collect(adapter.enumerateWaypoints());
		// Every recording answers with the same fixture here, and so does every route.
		expect(waypoints.length).toBe(4 * 1 + 3 * 2);
		expect(waypoints[0]!.source.url).toContain('/explore/recording/');
		expect(waypoints.at(-1)!.source.url).toContain('/explore/map/');
	});

	it('attaches photos through the map details and skips other people’s', async () => {
		const requested: string[] = [];
		const adapter = createAllTrailsAdapter(fixtureTransport(fixtureRoutes, requested), 'e2e');
		const photos = await collect(adapter.enumeratePhotos());
		expect(photos.map((photo) => photo.source.id)).toEqual(['860001', '860002', '860003']);
		expect(photos[0]!.attachedTo).toEqual({ type: 'track', sourceId: '810001' });
		// A photo posted on a platform trail has nothing in the archive to hang from.
		expect(photos[2]!.attachedTo).toBeNull();
		expect(photos[0]!.url).toContain('/api/alltrails/v3/photos/860001/image?key=');
		// Only maps that say they have photos are opened.
		const deep = requested.filter((url) => url.includes('detail=deep'));
		expect(deep.map((url) => /maps\/(\d+)/.exec(url)![1]).sort()).toEqual(['810001', '820001']);
	});

	it('exports lists that hold something, as references looked up by trail id', async () => {
		const requested: string[] = [];
		const adapter = createAllTrailsAdapter(fixtureTransport(fixtureRoutes, requested), 'e2e');
		const collections = await collect(adapter.enumerateCollections());
		expect(collections.map((collection) => collection.name)).toEqual(['Favorites']);
		expect(collections[0]!.members).toHaveLength(2);
		expect(collections[0]!.members[0]).toMatchObject({
			kind: 'reference',
			reference: { source: { id: '850001' }, annotations: { notes: expect.any(String) } }
		});
		const { source: _source, ...rest } = collections[0]!;
		expect(JSON.stringify(rest)).not.toMatch(/SENTINEL/);
		// Every list's items are asked for: the item counters on lists cannot be trusted.
		expect(requested.filter((url) => /\/lists\/\d+\/items$/.test(url))).toHaveLength(3);
	});

	it('counts from the account record, and offers no count it cannot trust', async () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(fixtureRoutes), 'e2e');
		expect(await adapter.count('track')).toBe(4);
		expect(await adapter.count('route')).toBe(3);
		expect(await adapter.count('photo')).toBe(3);
		expect(await adapter.count('area')).toBe(0);
		expect(await adapter.count('collection')).toBeNull();
		expect(await adapter.count('waypoint')).toBeNull();
	});

	it('pages with after=<nextCursor>', async () => {
		const all = loadFixture('alltrails', 'tracks-listing');
		const page = (maps: unknown[], nextCursor?: string) => ({
			maps,
			pageInfo: { hasNextPage: nextCursor !== undefined, nextCursor }
		});
		const requested: string[] = [];
		const adapter = createAllTrailsAdapter(
			fixtureTransport(
				[
					[/\/me$/, loadFixture('alltrails', 'me')],
					[/after=CURSOR2/, page(all.maps.slice(2))],
					[/presentation_type=track/, page(all.maps.slice(0, 2), 'CURSOR2')]
				],
				requested
			),
			'e2e'
		);
		expect(await collect(adapter.enumerateTracks())).toHaveLength(4);
		expect(requested.filter((url) => url.includes('/maps?'))).toHaveLength(2);
		expect(requested.at(-1)).toContain('&after=CURSOR2');
	});

	it('listing schema drift is fatal and names adapter + version; item drift is item-level', async () => {
		const adapter = createAllTrailsAdapter(
			fixtureTransport([
				[/\/me$/, loadFixture('alltrails', 'me')],
				[/presentation_type=map/, { entries: [] }],
				[/presentation_type=track/, loadFixture('alltrails', 'tracks-listing')],
				[/detail=deep/, { maps: [{ id: 810001, tracks: 'surprise' }] }]
			]),
			'e2e'
		);
		const failure = await collect(adapter.enumerateRoutes()).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AdapterOutdatedError);
		expect((failure as Error).message).toContain('AllTrails adapter v1.0.0 is out of date');
		const [track] = await collect(adapter.enumerateTracks());
		await expect(track!.loadSegments()).rejects.toBeInstanceOf(ItemError);
	});
});
