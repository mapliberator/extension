import { describe, expect, it } from 'vitest';
import { createGaiaAdapter, SHARED_WITH_ME_KEY } from '../src/adapters/gaia/index.ts';
import {
	isOwnFolder,
	mapArea,
	mapFolder,
	mapForeignLine,
	mapLineGeometry,
	mapLineSummary,
	mapPhoto,
	mapWaypoint,
	waypointCoordinate,
	type GaiaUrls
} from '../src/adapters/gaia/mapper.ts';
import {
	GaiaAreaDetailSchema,
	GaiaAreaSummarySchema,
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
	object: (type, id) => `https://www.gaiagps.com/datasummary/${type}/${id}/`,
	photoFile: (id) => `https://www.gaiagps.com/api/objects/photo/${id}/image/full/`
};
const ME = '1001';

const listing = <S extends Parameters<typeof gaiaListingSchema>[0]>(name: string, schema: S) =>
	gaiaListingSchema(schema).parse(loadFixture('gaia', name));

describe('Gaia mappers (fixtures)', () => {
	it('maps a track summary: UTC timestamps, SI stats, visibility, provenance', () => {
		const [summary] = listing('track-listing', GaiaTrackSummarySchema);
		const record = mapLineSummary('track', summary!, urls);
		expect(record).toMatchObject({
			kind: 'track',
			name: 'Morning loop / ridge ../summit',
			description: 'Sunrise lap before work. Windy on top.',
			createdAt: '2024-06-02T14:11:09Z',
			updatedAt: '2024-06-05T15:26:30Z',
			visibility: 'private',
			tags: [],
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
			...listing('waypoint-listing', GaiaWaypointSchema).map((w) => mapWaypoint(w, urls))
		];
		expect(records.length).toBeGreaterThan(15);
		for (const record of records) {
			for (const value of [record.createdAt, record.updatedAt]) {
				if (value !== null) expect(TimestampSchema.safeParse(value).success, value).toBe(true);
			}
		}
		expect(records.find((record) => record.source.id === 'gt-3003')!.visibility).toBe('public');
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

	it('maps detail geometry: [lon, lat, ele, epoch] inside a FeatureCollection → points with UTC times', () => {
		const detail = GaiaLineDetailSchema.parse(loadFixture('gaia', 'track-detail'));
		const coordinates = detail.features[0]!.geometry.coordinates;
		const segments = mapLineGeometry(detail);
		expect(segments).toHaveLength(coordinates.length);
		expect(segments[0]![0]).toEqual({
			lon: -118.292288,
			lat: 36.578581,
			ele: 2447.9,
			time: '2024-06-02T08:11:09Z' // epoch 1717315869
		});
		expect(segments.flat().length).toBe(coordinates.flat().length);
	});

	it('maps route geometry (zero in the time slot) without times and drops unusable coordinates', () => {
		const detail = GaiaLineDetailSchema.parse(loadFixture('gaia', 'route-detail'));
		expect(detail.features[0]!.geometry.coordinates[0]![0]![3]).toBe(0);
		const [first] = mapLineGeometry(detail)[0]!;
		expect(first!.time).toBeNull();
		expect(typeof first!.ele).toBe('number');
		const feature = detail.features[0]!;
		const broken = {
			features: [
				{
					...feature,
					geometry: {
						...feature.geometry,
						coordinates: [
							[
								[null, 1],
								[2, 3]
							]
						]
					}
				}
			]
		};
		expect(mapLineGeometry(broken as typeof detail)).toEqual([
			[{ lon: 2, lat: 3, ele: null, time: null }]
		]);
	});

	it('maps waypoints from the one-element coordinate arrays of the listing', () => {
		const [waypoint] = listing('waypoint-listing', GaiaWaypointSchema);
		expect(waypoint!.latitude).toEqual([36.577214]);
		const mapped = mapWaypoint(waypoint!, urls);
		expect(mapped.kind).toBe('waypoint');
		expect(mapped.position).toEqual([-118.291507, 36.577214]);
		expect(mapped.name).toBe('Camp & water cache');
		// A plain number is accepted too, should the platform ever tidy that up.
		const tidy = GaiaWaypointSchema.parse({ ...waypoint!, latitude: 1.5, longitude: 2.5 });
		expect(waypointCoordinate(tidy)).toEqual([2.5, 1.5]);
	});

	it('maps an area from its listing entry plus the polygon in its detail', () => {
		const [area] = listing('area-listing', GaiaAreaSummarySchema);
		const detail = GaiaAreaDetailSchema.parse(loadFixture('gaia', 'area-detail'));
		const mapped = mapArea(area!, detail, urls);
		expect(mapped.geometry.type).toBe('Polygon');
		expect(mapped.geometry.coordinates[0]![0]).toHaveLength(3);
		expect(mapped.areaSquareMeters).toBeNull();
		// A bare Feature is accepted as well as the recorded FeatureCollection.
		const wrapped = GaiaAreaDetailSchema.parse(loadFixture('gaia', 'area-detail').features[0]);
		expect(mapArea(area!, wrapped, urls).geometry).toEqual(mapped.geometry);
	});

	it('maps photos: session-free file URL, waypoint attachment and the waypoint’s coordinate', () => {
		const photos = listing('photo-listing', GaiaPhotoSchema);
		const waypoints = new Map(
			listing('waypoint-listing', GaiaWaypointSchema)
				.filter((waypoint) => waypoint.deleted !== true)
				.map((waypoint) => [waypoint.id, waypointCoordinate(waypoint)] as const)
		);
		const attached = mapPhoto(
			photos.find((photo) => photo.id === 'gp-7001')!,
			urls,
			waypoints
		);
		expect(attached).toMatchObject({
			kind: 'photo',
			name: 'IMG_2041.JPG',
			caption: 'Alpenglow from the ridge',
			rendition: 'original',
			attachedTo: { type: 'waypoint', sourceId: 'gw-5005' },
			coordinate: [-118.292301, 36.578402],
			url: 'https://www.gaiagps.com/api/objects/photo/gp-7001/image/full/'
		});
		// Its waypoint was deleted: nothing to attach to, no coordinate.
		const loose = mapPhoto(
			photos.find((photo) => photo.id === 'gp-7004')!,
			urls,
			waypoints
		);
		expect(loose).toMatchObject({ attachedTo: null, coordinate: null, takenAt: null });
	});

	it('another user’s line becomes name + link + one coordinate — nothing of theirs', () => {
		const summary = listing('track-listing', GaiaTrackSummarySchema).find(
			(track) => track.id === 'gt-9001'
		)!;
		const detail = GaiaLineDetailSchema.parse(loadFixture('gaia', 'foreign-track-detail'));
		const reference = mapForeignLine('track', summary, detail, urls);
		expect(reference).toEqual({
			name: 'Shared ridge run',
			source: { id: 'gt-9001', url: 'https://www.gaiagps.com/datasummary/track/gt-9001/' },
			coordinate: [expect.any(Number), expect.any(Number)]
		});
		expect(JSON.stringify(reference)).not.toMatch(/Otheruser|SENTINEL/);
	});

	it('folders keep many-to-many membership and nesting, and know whose they are', () => {
		const folders = listing('folder-listing', GaiaFolderSchema);
		const child = mapFolder(
			folders.find((folder) => folder.id === 'gf-8002')!,
			urls,
			new Map()
		);
		expect(child.parentSourceId).toBe('gf-8001');
		expect(child.name).toBe('Day 2 / côté est');
		const holders = folders
			.map((folder) => mapFolder(folder, urls, new Map()))
			.filter((record) =>
				record.members.some(
					(m) => m.kind === 'object' && m.type === 'track' && m.sourceId === 'gt-3001'
				)
			);
		expect(holders.map((record) => record.key).sort()).toEqual(['gf-8001', 'gf-8002']);
		expect(folders.filter((folder) => !isOwnFolder(folder)).map((folder) => folder.id)).toEqual([
			'gf-9004'
		]);
	});
});

describe('Gaia adapter (fixture-backed transport)', () => {
	const routes: [RegExp, unknown][] = [
		[/\/api\/v3\/user\/$/, loadFixture('gaia', 'user')],
		[/\/api\/objects\/track\/$/, loadFixture('gaia', 'track-listing')],
		[/\/api\/objects\/route\/$/, loadFixture('gaia', 'route-listing')],
		[/\/api\/objects\/waypoint\/$/, loadFixture('gaia', 'waypoint-listing')],
		[/\/api\/objects\/area\/$/, loadFixture('gaia', 'area-listing')],
		[/\/api\/objects\/area\/ga-\d+\/$/, loadFixture('gaia', 'area-detail')],
		[/\/api\/objects\/photo\/$/, loadFixture('gaia', 'photo-listing')],
		[/\/api\/objects\/folder\/$/, loadFixture('gaia', 'folder-listing')],
		[/\/api\/objects\/track\/gt-3001\/$/, loadFixture('gaia', 'track-detail')],
		[/\/api\/objects\/(track|route)\/g[tr]-900\d\/$/, loadFixture('gaia', 'foreign-track-detail')]
	];

	it('identifies the account by display name and never exposes the e-mail', async () => {
		const adapter = createGaiaAdapter(fixtureTransport(routes), 'e2e');
		expect(await adapter.identifyUser()).toEqual({ id: ME, displayName: 'Test H.' });
	});

	it('recognises the platform’s signed-out answers', () => {
		const adapter = createGaiaAdapter(fixtureTransport(routes), 'e2e');
		const signedOut = adapter.isSignedOut!;
		expect(signedOut({ status: 403, bodyKind: 'empty' })).toBe(true);
		expect(signedOut({ status: 200, bodyKind: 'json', json: { is_authenticated: false } })).toBe(
			true
		);
		expect(signedOut({ status: 200, bodyKind: 'json', json: loadFixture('gaia', 'user') })).toBe(
			false
		);
		// A challenge page is not a lost session.
		expect(signedOut({ status: 403, bodyKind: 'html' })).toBe(false);
		expect(signedOut({ status: 200, bodyKind: 'json', json: [] })).toBe(false);
	});

	it('skips deleted objects and other users’ lines; listing membership alone proves nothing', async () => {
		const requested: string[] = [];
		const adapter = createGaiaAdapter(fixtureTransport(routes, requested), 'e2e');
		const tracks = await collect(adapter.enumerateTracks());
		expect(tracks.map((track) => track.source.id)).toEqual([
			'gt-3001',
			'gt-3002',
			'gt-3003',
			'gt-3004',
			'gt-3005',
			'gt-3006'
		]);
		expect((await collect(adapter.enumerateRoutes())).map((route) => route.source.id)).toEqual([
			'gr-4001',
			'gr-4002',
			'gr-4003',
			'gr-4004'
		]);
		expect((await collect(adapter.enumeratePhotos())).map((photo) => photo.source.id)).toEqual([
			'gp-7001',
			'gp-7002',
			'gp-7003',
			'gp-7004'
		]);
		expect(await collect(adapter.enumerateWaypoints())).toHaveLength(5);
		expect(await collect(adapter.enumerateAreas())).toHaveLength(2);
		// Ownership is only checked — one detail request each — for what sits in a shared folder.
		const details = requested.filter((url) => /\/(track|route)\/g[tr]-\d+\/$/.test(url));
		expect(details.map((url) => url.split('/').at(-2)).sort()).toEqual(['gr-9002', 'gt-9001']);
	});

	it('requests native GPX first and only fetches JSON geometry on demand', async () => {
		const requested: string[] = [];
		const adapter = createGaiaAdapter(fixtureTransport(routes, requested), 'e2e');
		const [track] = await collect(adapter.enumerateTracks());
		expect(track!.nativeGpx).toEqual({
			method: 'GET',
			url: 'http://gaia.localhost:4610/api/objects/track/gt-3001.gpx',
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
		expect(wishlist.members).toEqual([
			{
				kind: 'reference',
				reference: {
					name: 'Shared ridge run',
					source: { id: 'gt-9001', url: expect.any(String) },
					coordinate: [expect.any(Number), expect.any(Number)]
				}
			}
		]);

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

	it('counts what is listed and not deleted', async () => {
		const adapter = createGaiaAdapter(fixtureTransport(routes), 'e2e');
		expect(await adapter.count('track')).toBe(7);
		expect(await adapter.count('waypoint')).toBe(5);
		expect(await adapter.count('collection')).toBe(4);
	});

	it('listing schema drift is fatal and names adapter + version; item drift is item-level', async () => {
		const drifted = { count: 5, results: loadFixture('gaia', 'waypoint-listing') };
		const adapter = createGaiaAdapter(
			fixtureTransport([
				[/\/user\/$/, loadFixture('gaia', 'user')],
				[/\/waypoint\/$/, drifted],
				[/\/folder\/$/, []],
				[/\/track\/$/, loadFixture('gaia', 'track-listing')],
				[/\/track\/gt-3001\/$/, { features: [{ properties: {}, geometry: { type: 'Surprise' } }] }]
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
});
