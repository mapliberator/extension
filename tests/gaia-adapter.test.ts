import { describe, expect, it } from 'vitest';
import { createGaiaAdapter, SHARED_WITH_ME_KEY } from '../src/adapters/gaia/index.ts';
import {
	mapArea,
	mapFolder,
	mapLineGeometry,
	mapLineSummary,
	mapPhoto,
	mapSavedHike,
	mapWaypoint,
	type GaiaUrls
} from '../src/adapters/gaia/mapper.ts';
import {
	GaiaAreaSchema,
	GaiaFolderSchema,
	GaiaLineDetailSchema,
	GaiaPhotoSchema,
	GaiaTrackSummarySchema,
	GaiaWaypointSchema,
	gaiaListingSchema
} from '../src/adapters/gaia/schemas.ts';
import { AdapterOutdatedError, ItemError } from '../src/shared/errors.ts';
import { TimestampSchema } from '../src/shared/schemas.ts';
import { collect, fixtureTransport, loadFixture } from './helpers/fixture-transport.ts';

const urls: GaiaUrls = {
	object: (type, id) => `https://www.gaiagps.com/datasummary/${type}/${id}/`
};
const ME = 'gu-1001';

const listing = <S extends Parameters<typeof gaiaListingSchema>[0]>(name: string, schema: S) =>
	gaiaListingSchema(schema).parse(loadFixture('gaia', name)).results;

describe('Gaia mappers (fixtures)', () => {
	it('maps a track summary: UTC timestamps, SI stats, visibility, provenance', () => {
		const [summary] = listing('track-listing', GaiaTrackSummarySchema);
		const record = mapLineSummary('track', summary!, urls);
		expect(record).toMatchObject({
			kind: 'track',
			name: 'Morning loop / ridge ../summit',
			description: 'Sunrise lap before work. Windy on top.',
			// fixture: 2024-06-02T07:11:09-07:00
			createdAt: '2024-06-02T14:11:09Z',
			updatedAt: '2024-06-05T15:26:30Z',
			visibility: 'private',
			tags: ['sierra', 'loop'],
			activityType: 'hiking',
			stats: { distanceMeters: 3325.1, ascentMeters: 82, durationSeconds: 1760 },
			source: { id: 'gt-3001', url: 'https://www.gaiagps.com/datasummary/track/gt-3001/' }
		});
		expect(record.source.raw).toBe(summary);
	});

	it('normalizes every timestamp in every listing to RFC 3339 UTC', () => {
		const records = [
			...listing('track-listing', GaiaTrackSummarySchema).map((s) =>
				mapLineSummary('track', s, urls)
			),
			...listing('route-listing', GaiaTrackSummarySchema).map((s) =>
				mapLineSummary('route', s, urls)
			),
			...listing('waypoint-listing', GaiaWaypointSchema).map((w) => mapWaypoint(w, urls)),
			...listing('area-listing', GaiaAreaSchema).map((a) => mapArea(a, urls))
		];
		expect(records.length).toBeGreaterThan(15);
		for (const record of records) {
			for (const value of [record.createdAt, record.updatedAt]) {
				if (value !== null) expect(TimestampSchema.safeParse(value).success, value).toBe(true);
			}
		}
		// +02:00 offset in the fixture
		const paris = records.find((record) => record.source.id === 'gt-3003')!;
		expect(paris.createdAt).toMatch(/Z$/);
		expect(paris.visibility).toBe('public');
	});

	it('falls back to "Untitled" and null descriptions for empty strings', () => {
		const [summary] = listing('track-listing', GaiaTrackSummarySchema);
		const record = mapLineSummary('track', { ...summary!, title: '  ', notes: '' }, urls);
		expect(record.name).toBe('Untitled');
		expect(record.description).toBeNull();
	});

	it('routes carry no duration', () => {
		const [summary] = listing('route-listing', GaiaTrackSummarySchema);
		expect(mapLineSummary('route', summary!, urls).stats.durationSeconds).toBeNull();
	});

	it('maps detail geometry: [lon, lat, ele, epoch] → points with UTC times', () => {
		const detail = GaiaLineDetailSchema.parse(loadFixture('gaia', 'track-detail'));
		const segments = mapLineGeometry(detail);
		expect(segments).toHaveLength(detail.geometry.coordinates.length);
		expect(segments[0]![0]).toEqual({
			lon: -118.292288,
			lat: 36.578581,
			ele: 2447.9,
			time: '2024-06-02T08:11:09Z' // epoch 1717315869
		});
		expect(segments.flat().length).toBe(detail.geometry.coordinates.flat().length);
	});

	it('maps route geometry without times and drops unusable coordinates', () => {
		const detail = GaiaLineDetailSchema.parse(loadFixture('gaia', 'route-detail'));
		const [first] = mapLineGeometry(detail)[0]!;
		expect(first!.time).toBeNull();
		expect(typeof first!.ele).toBe('number');
		const broken = {
			...detail,
			geometry: {
				...detail.geometry,
				coordinates: [
					[
						[null, 1],
						[2, 3]
					]
				]
			}
		};
		expect(mapLineGeometry(broken as typeof detail)).toEqual([
			[{ lon: 2, lat: 3, ele: null, time: null }]
		]);
	});

	it('maps waypoints and areas', () => {
		const [waypoint] = listing('waypoint-listing', GaiaWaypointSchema);
		const mapped = mapWaypoint(waypoint!, urls);
		expect(mapped.kind).toBe('waypoint');
		expect(mapped.position).toEqual(waypoint!.geometry.coordinates);
		expect(mapped.name).toBe('Camp & water cache');

		const [area] = listing('area-listing', GaiaAreaSchema);
		const mappedArea = mapArea(area!, urls);
		expect(mappedArea.geometry.type).toBe('Polygon');
		expect(mappedArea.areaSquareMeters).toBe(area!.area);
	});

	it('maps photos: asset URL, attachment, optional coordinate', () => {
		const photos = listing('photo-listing', GaiaPhotoSchema);
		const attached = mapPhoto(
			photos.find((photo) => photo.id === 'gp-7001')!,
			urls
		);
		expect(attached).toMatchObject({
			kind: 'photo',
			rendition: 'original',
			attachedTo: { type: 'track', sourceId: 'gt-3001' },
			url: 'http://cdn.gaia.localhost:4610/photos/gp-7001/full'
		});
		expect(attached.coordinate).toHaveLength(2);
		const loose = mapPhoto(
			photos.find((photo) => photo.id === 'gp-7004')!,
			urls
		);
		expect(loose).toMatchObject({ attachedTo: null, coordinate: null, takenAt: null });
	});

	it('a saved hike becomes name + link + trailhead + my annotations — nothing of the platform’s', () => {
		const folders = listing('folder-listing', GaiaFolderSchema);
		const hike = folders.flatMap((folder) => folder.saved_hikes).find((h) => h.id === 'gh-2101')!;
		const raw = loadFixture('gaia', 'folder-listing')
			.results.flatMap((folder: any) => folder.saved_hikes)
			.find((h: any) => h.id === 'gh-2101');
		const reference = mapSavedHike(hike);
		expect(reference.name).toBe(raw.name);
		expect(reference.source).toEqual({ id: 'gh-2101', url: raw.url });
		expect(reference.coordinate).toEqual([raw.trailhead.longitude, raw.trailhead.latitude]);
		expect(reference.annotations).toEqual({
			completedAt: raw.completed_on,
			rating: raw.user_rating,
			notes: raw.user_notes
		});
		const serialized = JSON.stringify(reference);
		expect(serialized).not.toContain(raw.description);
		expect(serialized).not.toContain(String(raw.geometry.coordinates[0][1]));
	});

	it('folders keep many-to-many membership and nesting', () => {
		const folders = listing('folder-listing', GaiaFolderSchema);
		const child = mapFolder(
			folders.find((folder) => folder.id === 'gf-8002')!,
			urls,
			new Map()
		);
		expect(child.parentSourceId).toBe('gf-8001');
		const holders = folders
			.map((folder) => mapFolder(folder, urls, new Map()))
			.filter((record) =>
				record.members.some(
					(m) => m.kind === 'object' && m.type === 'track' && m.sourceId === 'gt-3001'
				)
			);
		expect(holders.map((record) => record.key).sort()).toEqual(['gf-8001', 'gf-8002']);
	});
});

describe('Gaia adapter (fixture-backed transport)', () => {
	const routes: [RegExp, unknown][] = [
		[/\/api\/v3\/me\/$/, loadFixture('gaia', 'me')],
		[/\/api\/v3\/track\/\?/, loadFixture('gaia', 'track-listing')],
		[/\/api\/v3\/route\/\?/, loadFixture('gaia', 'route-listing')],
		[/\/api\/v3\/waypoint\/\?/, loadFixture('gaia', 'waypoint-listing')],
		[/\/api\/v3\/area\/\?/, loadFixture('gaia', 'area-listing')],
		[/\/api\/v3\/photo\/\?/, loadFixture('gaia', 'photo-listing')],
		[/\/api\/v3\/folder\/\?/, loadFixture('gaia', 'folder-listing')],
		[/\/api\/v3\/track\/gt-3001\/$/, loadFixture('gaia', 'track-detail')]
	];

	it('identifies the account by display name and never exposes the e-mail', async () => {
		const adapter = createGaiaAdapter(fixtureTransport(routes), 'e2e');
		expect(await adapter.identifyUser()).toEqual({ id: ME, displayName: 'Test H.' });
	});

	it('exports only authored objects; listing membership alone proves nothing', async () => {
		const adapter = createGaiaAdapter(fixtureTransport(routes), 'e2e');
		const tracks = await collect(adapter.enumerateTracks());
		expect(tracks.map((track) => track.source.id)).toEqual([
			'gt-3001',
			'gt-3002',
			'gt-3003',
			'gt-3004',
			'gt-3005',
			'gt-3006'
		]);
		expect(
			(await collect(adapter.enumerateRoutes())).map((route) => route.source.id)
		).not.toContain('gr-9002');
		expect(
			(await collect(adapter.enumeratePhotos())).map((photo) => photo.source.id)
		).not.toContain('gp-9003');
		expect(await collect(adapter.enumerateWaypoints())).toHaveLength(5);
		expect(await collect(adapter.enumerateAreas())).toHaveLength(2);
	});

	it('requests native GPX first and only fetches JSON geometry on demand', async () => {
		const requested: string[] = [];
		const adapter = createGaiaAdapter(fixtureTransport(routes, requested), 'e2e');
		const [track] = await collect(adapter.enumerateTracks());
		expect(track!.nativeGpx).toEqual({
			method: 'GET',
			url: 'http://gaia.localhost:4610/api/v3/track/gt-3001.gpx',
			accept: 'text-stream'
		});
		expect(requested.some((url) => url.endsWith('/track/gt-3001/'))).toBe(false);
		const segments = await track!.loadSegments();
		expect(segments.flat().length).toBeGreaterThan(10);
	});

	it("turns other users' objects and shared folders into references inside collections", async () => {
		const adapter = createGaiaAdapter(fixtureTransport(routes), 'e2e');
		await collect(adapter.enumerateTracks());
		await collect(adapter.enumerateRoutes());
		const collections = await collect(adapter.enumerateCollections());
		expect(collections.map((c) => c.key)).toEqual([
			'gf-8001',
			'gf-8002',
			'gf-8003',
			SHARED_WITH_ME_KEY
		]);

		const wishlist = collections.find((c) => c.key === 'gf-8003')!;
		const foreign = wishlist.members.find(
			(m) => m.kind === 'reference' && m.reference.source.id === 'gt-9001'
		);
		expect(foreign).toMatchObject({
			kind: 'reference',
			reference: { coordinate: [expect.any(Number), expect.any(Number)] }
		});
		expect(wishlist.members.filter((m) => m.kind === 'reference')).toHaveLength(3);

		const shared = collections.at(-1)!;
		expect(shared.source).toBeNull();
		expect(shared.members).toEqual([
			{
				kind: 'reference',
				reference: {
					name: expect.any(String),
					source: { id: 'gf-9004', url: expect.any(String) },
					coordinate: null
				}
			}
		]);
		// Nothing about the other user survives normalization (raw is scrubbed separately).
		const { source: _s, ...rest } = wishlist;
		expect(JSON.stringify([rest, shared])).not.toMatch(/Otheruser|SENTINEL/);
	});

	it('uses the cheap listing count', async () => {
		const adapter = createGaiaAdapter(fixtureTransport(routes), 'e2e');
		expect(await adapter.count('track')).toBe(7);
	});

	it('listing schema drift is fatal and names adapter + version; item drift is item-level', async () => {
		const drifted = structuredClone(loadFixture('gaia', 'waypoint-listing'));
		drifted.data = drifted.results;
		delete drifted.results;
		const adapter = createGaiaAdapter(
			fixtureTransport([
				[/\/me\/$/, loadFixture('gaia', 'me')],
				[/\/waypoint\/\?/, drifted],
				[/\/track\/\?/, loadFixture('gaia', 'track-listing')],
				[/\/track\/gt-3001\/$/, { id: 'gt-3001', geometry: { type: 'Surprise' } }]
			]),
			'e2e'
		);
		const failure = await collect(adapter.enumerateWaypoints()).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AdapterOutdatedError);
		expect((failure as Error).message).toContain('Gaia GPS adapter v1.0.0 is out of date');
		expect((failure as Error).message).not.toMatch(/gw-|Camp/);

		const [track] = await collect(adapter.enumerateTracks());
		await expect(track!.loadSegments()).rejects.toBeInstanceOf(ItemError);
	});

	it('never follows pagination off its own origin', async () => {
		const evil = structuredClone(loadFixture('gaia', 'area-listing'));
		evil.next = 'https://evil.example/api/v3/area/?page=2';
		const requested: string[] = [];
		const adapter = createGaiaAdapter(
			fixtureTransport(
				[
					[/\/me\/$/, loadFixture('gaia', 'me')],
					[/\/area\/\?/, evil]
				],
				requested
			),
			'e2e'
		);
		await collect(adapter.enumerateAreas());
		expect(requested.filter((url) => url.includes('evil'))).toEqual([]);
	});
});
