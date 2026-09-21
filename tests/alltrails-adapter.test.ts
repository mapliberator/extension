import { describe, expect, it } from 'vitest';
import { COMPLETED_KEY, createAllTrailsAdapter } from '../src/adapters/alltrails/index.ts';
import {
	displayName,
	mapActivity,
	mapCompleted,
	mapList,
	mapMap,
	mapMapWaypoint,
	mapPhoto,
	mapSegments,
	type AllTrailsUrls
} from '../src/adapters/alltrails/mapper.ts';
import { decodePolyline } from '../src/adapters/alltrails/polyline.ts';
import {
	AllTrailsActivitySchema,
	AllTrailsCompletedSchema,
	AllTrailsListSchema,
	AllTrailsMapSchema,
	AllTrailsPhotoSchema,
	AllTrailsSegmentsSchema,
	allTrailsListingSchema
} from '../src/adapters/alltrails/schemas.ts';
import { AdapterOutdatedError } from '../src/shared/errors.ts';
import { collect, fixtureTransport, loadFixture } from './helpers/fixture-transport.ts';

const origin = 'https://www.alltrails.com';
const urls: AllTrailsUrls = {
	activity: (id) => `${origin}/explore/recording/${id}`,
	map: (id) => `${origin}/explore/map/${id}`,
	list: (id) => `${origin}/lists/${id}`,
	trail: (trail) => `${origin}/trail/${trail.slug ?? trail.id}`,
	photo: (id) => `${origin}/photos/${id}`
};

const listing = <S extends Parameters<typeof allTrailsListingSchema>[0]>(name: string, schema: S) =>
	allTrailsListingSchema(schema).parse(loadFixture('alltrails', name)).items;

describe('decodePolyline', () => {
	it('decodes the reference example from the polyline algorithm documentation', () => {
		expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
			[38.5, -120.2],
			[40.7, -120.95],
			[43.252, -126.453]
		]);
	});

	it('stops cleanly on truncated or garbage input', () => {
		expect(decodePolyline('')).toEqual([]);
		expect(decodePolyline('_p~iF~ps|U_ul')).toEqual([[38.5, -120.2]]);
		expect(decodePolyline('\u0001\u0002')).toEqual([]);
	});
});

describe('AllTrails mappers (fixtures)', () => {
	it('maps an activity: epoch seconds → UTC, numeric IDs → strings', () => {
		const [activity] = listing('activities-listing', AllTrailsActivitySchema);
		const raw = loadFixture('alltrails', 'activities-listing').items[0];
		const record = mapActivity(activity!, urls);
		expect(record).toMatchObject({
			kind: 'track',
			name: raw.name,
			createdAt: new Date(raw.createdAt * 1000).toISOString().replace('.000Z', 'Z'),
			activityType: 'hiking',
			stats: {
				distanceMeters: raw.summaryStats.distanceTotal,
				ascentMeters: raw.summaryStats.elevationGain,
				durationSeconds: raw.summaryStats.timeTotal
			},
			source: { id: '810001', url: `${origin}/explore/recording/810001` }
		});
		expect(record.visibility).toBe(raw.private ? 'private' : 'public');
	});

	it('maps a custom map to a route without duration, keeping embedded waypoints out of raw', () => {
		const [map] = listing('maps-listing', AllTrailsMapSchema);
		const record = mapMap(map!, urls);
		expect(record.kind).toBe('route');
		expect(record.stats.durationSeconds).toBeNull();
		expect(record.source.raw).not.toHaveProperty('waypoints');
		const waypoint = mapMapWaypoint(map!.waypoints[0]!, map!, urls);
		expect(waypoint.position).toEqual([
			map!.waypoints[0]!.location.longitude,
			map!.waypoints[0]!.location.latitude
		]);
		expect(waypoint.source.id).toBe('830001');
	});

	it('decodes segments with parallel elevation and time arrays', () => {
		const detail = AllTrailsSegmentsSchema.parse(loadFixture('alltrails', 'activity-detail'));
		const segments = mapSegments(detail);
		const polyline = detail.segments[0]!.polyline;
		expect(segments[0]).toHaveLength(decodePolyline(polyline.pointsData).length);
		expect(segments[0]![0]).toMatchObject({
			ele: polyline.elevationData![0],
			time: new Date(polyline.timeData![0]! * 1000).toISOString().replace('.000Z', 'Z')
		});
		expect(Math.abs(segments[0]![0]!.lat)).toBeLessThanOrEqual(90);
	});

	it('ignores elevation/time arrays that do not line up with the points', () => {
		const detail = AllTrailsSegmentsSchema.parse(loadFixture('alltrails', 'map-detail'));
		detail.segments[0]!.polyline.elevationData = [1, 2];
		const [first] = mapSegments(detail)[0]!;
		expect(first).toMatchObject({ ele: null, time: null });
	});

	it('list items: trails become references, maps and activities stay object members', () => {
		const lists = listing('lists-listing', AllTrailsListSchema);
		const record = mapList(
			lists.find((list) => list.id === 840001)!,
			urls
		);
		expect(
			record.members.map((m) =>
				m.kind === 'object' ? `${m.type}:${m.sourceId}` : `ref:${m.reference.source.id}`
			)
		).toEqual(['ref:850001', 'ref:850002', 'route:820001', 'track:810001']);
		const reference = record.members[0]!;
		expect(reference).toMatchObject({
			kind: 'reference',
			reference: {
				source: { url: expect.stringMatching(/\/trail\//) },
				coordinate: [expect.any(Number), expect.any(Number)]
			}
		});
		// The parsed trail does not even carry description or polyline into the reference.
		expect(Object.keys((reference as any).reference).sort()).toEqual([
			'coordinate',
			'name',
			'source'
		]);
	});

	it('completed trails carry my rating, review, date and notes as annotations', () => {
		const [completed] = listing('completed-listing', AllTrailsCompletedSchema);
		const raw = loadFixture('alltrails', 'completed-listing').items[0];
		expect(mapCompleted(completed!, urls).annotations).toEqual({
			completedAt: raw.completedAt,
			rating: raw.rating,
			review: raw.review,
			notes: raw.privateNotes
		});
	});

	it('photos: original when offered, otherwise largest available; trail photos are unattached', () => {
		const photos = listing('photos-listing', AllTrailsPhotoSchema);
		const original = mapPhoto(
			photos.find((photo) => photo.id === 860001)!,
			urls
		);
		expect(original.rendition).toBe('original');
		expect(original.url).toContain('/original');
		const large = mapPhoto(
			photos.find((photo) => photo.id === 860002)!,
			urls
		);
		expect(large).toMatchObject({
			rendition: 'largest-available',
			coordinate: null,
			takenAt: null
		});
		expect(large.url).toContain('/large');
		expect(
			mapPhoto(
				photos.find((photo) => photo.id === 860003)!,
				urls
			).attachedTo
		).toBeNull();
	});

	it('derives a display name without the full surname', () => {
		expect(displayName({ firstName: 'Test', lastName: 'Hiker' })).toBe('Test H.');
		expect(displayName({ firstName: 'Solo' })).toBe('Solo');
		expect(displayName({})).toBe('AllTrails user');
	});
});

describe('AllTrails adapter (fixture-backed transport)', () => {
	const routes: [RegExp, unknown][] = [
		[/\/me$/, loadFixture('alltrails', 'me')],
		[/\/stats$/, { activities: 5, maps: 3, photos: 4, completed: 2 }],
		[/\/users\/7001\/activities\?/, loadFixture('alltrails', 'activities-listing')],
		[/\/users\/7001\/maps\?/, loadFixture('alltrails', 'maps-listing')],
		[/\/users\/7001\/lists\?/, loadFixture('alltrails', 'lists-listing')],
		[/\/users\/7001\/completed\?/, loadFixture('alltrails', 'completed-listing')],
		[/\/users\/7001\/photos\?/, loadFixture('alltrails', 'photos-listing')]
	];

	it('implements the same interface with gentler limits than Gaia', async () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(routes), 'production');
		expect(adapter.origins).toEqual(['https://www.alltrails.com']);
		expect(adapter.limits.apiConcurrency).toBeLessThanOrEqual(2);
		expect(adapter.limits.minIntervalMs).toBeGreaterThanOrEqual(150);
		expect(await adapter.identifyUser()).toEqual({ id: '7001', displayName: 'Test H.' });
	});

	it('exports only authored recordings, maps and photos', async () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(routes), 'e2e');
		expect((await collect(adapter.enumerateTracks())).map((t) => t.source.id)).toEqual([
			'810001',
			'810002',
			'810003',
			'810004'
		]);
		expect(await collect(adapter.enumerateRoutes())).toHaveLength(3);
		expect((await collect(adapter.enumerateWaypoints())).map((w) => w.source.id)).toEqual([
			'830001',
			'830002',
			'830003',
			'830004'
		]);
		expect(await collect(adapter.enumerateAreas())).toEqual([]);
		expect((await collect(adapter.enumeratePhotos())).map((p) => p.source.id)).toEqual([
			'860001',
			'860002',
			'860003'
		]);
	});

	it('emits lists plus a synthesized "Completed trails" collection', async () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(routes), 'e2e');
		const collections = await collect(adapter.enumerateCollections());
		expect(collections.map((c) => c.key)).toEqual(['840001', '840002', COMPLETED_KEY]);
		const completed = collections.at(-1)!;
		expect(completed.source).toBeNull();
		expect(completed.members).toHaveLength(2);
		expect(completed.members.every((m) => m.kind === 'reference')).toBe(true);
	});

	it('counts: cheap where the platform offers one, null where it does not, 0 for areas', async () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(routes), 'e2e');
		expect(await adapter.count('track')).toBe(5);
		expect(await adapter.count('route')).toBe(3);
		expect(await adapter.count('photo')).toBe(4);
		expect(await adapter.count('collection')).toBeNull();
		expect(await adapter.count('waypoint')).toBeNull();
		expect(await adapter.count('area')).toBe(0);
	});

	it('listing drift names the adapter and version', async () => {
		const drifted = { entries: [], meta: { nextCursor: null } };
		const adapter = createAllTrailsAdapter(
			fixtureTransport([
				[/\/me$/, loadFixture('alltrails', 'me')],
				[/photos\?/, drifted]
			]),
			'e2e'
		);
		const failure = await collect(adapter.enumeratePhotos()).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AdapterOutdatedError);
		expect((failure as Error).message).toContain('AllTrails adapter v1.0.0 is out of date');
	});

	it('recognises the sign-in page a session-less request is redirected to', () => {
		const adapter = createAllTrailsAdapter(fixtureTransport(routes), 'e2e');
		expect(adapter.isLoginUrl('http://alltrails.localhost:4610/login?next=%2Fapi')).toBe(true);
		expect(adapter.isLoginUrl('http://alltrails.localhost:4610/api/alltrails/v3/me')).toBe(false);
	});
});
